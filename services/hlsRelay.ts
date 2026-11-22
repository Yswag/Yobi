import { fetch } from "scripting"
import type { AbortSignal } from "scripting"
import { registerHlsRelayHandler, unregisterHlsRelayHandler, type HlsRelayHandler } from "./localProxy"
import { Prefetcher } from "./prefetch"
import { recordDownload } from "./netMeter"

const FETCH_TIMEOUT_SECONDS: number = 30

interface ParsedPlaylist {
  lines: string[]
  initUrl: string | null
  segmentLines: number[]
  segmentUrls: string[]
}

const relays: Map<string, HlsRelay> = new Map()
let activeGroup: string = ""

function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).toString()
  } catch {
    return relative
  }
}

function parsePlaylist(text: string, baseUrl: string): ParsedPlaylist {
  const lines: string[] = text.split("\n").map((line: string): string => line.trimEnd())
  let initUrl: string | null = null
  const segmentLines: number[] = []
  const segmentUrls: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line: string = lines[i]
    if (line.startsWith("#EXT-X-MAP:")) {
      const match: RegExpMatchArray | null = line.match(/URI="([^"]+)"/)
      if (match) initUrl = resolveUrl(baseUrl, match[1])
      continue
    }
    if (!line || line.startsWith("#")) continue
    segmentLines.push(i)
    segmentUrls.push(resolveUrl(baseUrl, line))
  }
  return { lines, initUrl, segmentLines, segmentUrls }
}

async function download(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal, timeout: FETCH_TIMEOUT_SECONDS, debugLabel: "Yobi HLS relay segment" })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const bytes: Uint8Array = new Uint8Array(await response.arrayBuffer())
  recordDownload(bytes.byteLength, url)
  return bytes
}

class HlsRelay implements HlsRelayHandler {
  readonly id: string
  private readonly upstreamUrl: string
  private parsed: ParsedPlaylist | null = null
  private loading: Promise<ParsedPlaylist> | null = null
  private initBytes: Promise<Uint8Array | null> | null = null
  private readonly prefetcher: Prefetcher

  constructor(id: string, upstreamUrl: string) {
    this.id = id
    this.upstreamUrl = upstreamUrl
    this.prefetcher = new Prefetcher(
      {
        count: (): number | null => this.parsed?.segmentUrls.length ?? null,
        fetch: async (index: number, signal: AbortSignal): Promise<Uint8Array | null> => {
          const url: string | undefined = (await this.loadPlaylist()).segmentUrls[index]
          return url ? download(url, signal) : null
        },
      },
      { ahead: 4, concurrency: 4 },
    )
  }

  private loadPlaylist(): Promise<ParsedPlaylist> {
    if (this.parsed) return Promise.resolve(this.parsed)
    if (!this.loading) {
      this.loading = fetch(this.upstreamUrl, { timeout: FETCH_TIMEOUT_SECONDS, debugLabel: "Yobi HLS relay playlist" })
        .then(async (response): Promise<ParsedPlaylist> => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          this.parsed = parsePlaylist(await response.text(), this.upstreamUrl)
          return this.parsed
        })
        .finally(() => {
          this.loading = null
        })
    }
    return this.loading
  }

  async playlist(segmentUrl: (index: number) => string, initUrl: string): Promise<string> {
    const parsed: ParsedPlaylist = await this.loadPlaylist()
    const lines: string[] = parsed.lines.slice()
    parsed.segmentLines.forEach((lineIndex: number, segment: number) => {
      lines[lineIndex] = segmentUrl(segment)
    })
    if (parsed.initUrl) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("#EXT-X-MAP:")) lines[i] = lines[i].replace(/URI="[^"]+"/, `URI="${initUrl}"`)
      }
    }
    return `${lines.join("\n")}\n`
  }

  async initialization(): Promise<Uint8Array | null> {
    const parsed: ParsedPlaylist = await this.loadPlaylist()
    const url: string | null = parsed.initUrl
    if (!url) return null
    if (!this.initBytes) {
      this.initBytes = download(url).catch((): null => {
        this.initBytes = null
        return null
      })
    }
    return this.initBytes
  }

  async segment(index: number): Promise<Uint8Array | null> {
    await this.loadPlaylist()
    return this.prefetcher.get(index)
  }

  dispose(): void {
    this.prefetcher.dispose()
    this.initBytes = null
  }
}

export function createHlsRelay(group: string, key: string, upstreamUrl: string): string {
  if (group !== activeGroup) {
    clearHlsRelays()
    activeGroup = group
  }
  const id: string = `${group}-${key}`
  let relay: HlsRelay | undefined = relays.get(id)
  if (!relay) {
    relay = new HlsRelay(id, upstreamUrl)
    relays.set(id, relay)
  }
  return registerHlsRelayHandler(id, relay)
}

export function clearHlsRelays(group?: string): void {
  if (group !== undefined && group !== activeGroup) return
  for (const relay of relays.values()) {
    relay.dispose()
    unregisterHlsRelayHandler(relay.id)
  }
  relays.clear()
  activeGroup = ""
}
