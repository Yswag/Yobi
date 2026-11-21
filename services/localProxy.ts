import { AbortController, fetch } from "scripting"
import type { AbortSignal } from "scripting"
import { Prefetcher } from "./prefetch"
import { recordDownload } from "./netMeter"
import { getSettings } from "./storage"
import {
  isLineBanned,
  lineScore,
  noteLineFailure,
  noteLineSample,
  pickLineToExplore,
  rankLines,
  shouldPromote,
} from "./bilibili/lines"

export interface SabrProxyUrls {
  hlsUrl: string
  dashUrl: string
}

export interface SabrProxySessionHandler {
  hlsMasterPlaylist(): string
  mediaPlaylist(itag: number): string | Promise<string>
  dashManifest(): string | Promise<string>
  initializationSegment(itag: number): Promise<Uint8Array | null>
  mediaSegment(itag: number, sequence: number): Promise<Uint8Array | null>
  contentType?(itag: number): string | undefined
}

export interface HlsRelayHandler {
  playlist(segmentUrl: (index: number) => string, initUrl: string): Promise<string>
  initialization(): Promise<Uint8Array | null>
  segment(index: number): Promise<Uint8Array | null>
}

interface VirtualManifest {
  content: string
  contentType: string
  file: string
}

const TRY_PORTS: number[] = [18920, 18921, 18922, 18923, 0]

let server: HttpServer | null = null
let serverPort: number = 0
let starting: boolean = false

const virtualManifests: Map<string, VirtualManifest> = new Map()
const sabrSessions: Map<string, SabrProxySessionHandler> = new Map()
const hlsRelays: Map<string, HlsRelayHandler> = new Map()

interface BiliFileSource {
  urls: string[]
  primary: string
  primarySince: number
  playhead: number
  exploring: Map<number, { host: string; controller: AbortController }>
  head: Uint8Array | null
  contentType: string
  total: number | null
  prefetcher: Prefetcher
}

const biliFileSources: Map<string, BiliFileSource> = new Map()
const BILI_WINDOW_BYTES: number = 1024 * 1024
const BILI_PREFETCH_AHEAD_DEFAULT: number = 32
const BILI_PREFETCH_SECONDS: number = 15
const BILI_PREFETCH_MIN_AHEAD: number = 16
const BILI_PREFETCH_MAX_AHEAD: number = 64
const BILI_PREFETCH_CONCURRENCY: number = 4
const BILI_PREFETCH_CONCURRENCY_HEAVY: number = 6
const BILI_HEAVY_BITRATE: number = 12_000_000

function prefetchAheadFor(bitrate: number): number {
  if (!(bitrate > 0)) return BILI_PREFETCH_AHEAD_DEFAULT
  const bytesPerSecond: number = bitrate / 8
  const grids: number = Math.ceil((bytesPerSecond * BILI_PREFETCH_SECONDS) / BILI_WINDOW_BYTES)
  return Math.min(BILI_PREFETCH_MAX_AHEAD, Math.max(BILI_PREFETCH_MIN_AHEAD, grids))
}
const BILI_MAX_RESPONSE_BYTES: number = 16 * 1024 * 1024
const BILI_CHUNK_TIMEOUT_MS: number = 12000
const BILI_EXPLORE_EVERY: number = 8
const BILI_EXPLORE_MIN_AHEAD: number = 6
const BILI_EXPLORE_TIMEOUT_MS: number = 4000
const BILI_HEDGE_MIN_MS: number = 800
const BILI_HEDGE_MAX_MS: number = 4000
const BILI_HEDGE_DEFAULT_MS: number = 1500
const BILI_HEDGE_POLL_MS: number = 250
const BILI_HEDGE_WAITING_MIN_MS: number = 350
const BILI_HEDGE_WAITING_FACTOR: number = 1.5
const BILI_PRIMARY_DWELL_MS: number = 60_000
const BILI_MAX_TRIES: number = 3
const BILI_CANDIDATE_POOL: string[] = [
  "upos-sz-mirrorcosov.bilivideo.com",
  "upos-sz-mirroraliov.bilivideo.com",
  "upos-sz-mirrorhwov.bilivideo.com",
  "upos-sz-mirrorali.bilivideo.com",
  "upos-tf-all-hw.bilivideo.com",
  "upos-sz-mirrorhw.bilivideo.com",
  "upos-sz-mirrorcos.bilivideo.com",
  "upos-tf-all-tx.bilivideo.com",
]
const BILI_MAX_SOURCES: number = 48

const BILI_REQUEST_HEADERS: Record<string, string> = {
  Referer: "https://www.bilibili.com/",
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
}

const BASE_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Cache-Control": "no-store",
}

function ensureManifestFile(contentType: string): string {
  const lower: string = contentType.toLowerCase()
  if (lower.includes("mpegurl") || lower.includes("m3u8")) return "stream.m3u8"
  if (lower.includes("dash") || lower.includes("mpd")) return "stream.mpd"
  return "stream.m3u8"
}

function textResponse(content: string, contentType: string): HttpResponse {
  const body: Data | null = Data.fromRawString(content, "utf-8")
  const headers: Record<string, string> = { ...BASE_HEADERS, "Content-Type": contentType }
  if (body) headers["Content-Length"] = String(body.toArrayBuffer().byteLength)
  return HttpResponse.raw(200, "OK", {
    headers,
    body: body ?? undefined,
  })
}

function binaryResponse(bytes: Uint8Array, contentType: string): HttpResponse {
  const body: Data | null = Data.fromUint8Array(bytes)
  return HttpResponse.raw(200, "OK", {
    headers: {
      ...BASE_HEADERS,
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
    },
    body: body ?? undefined,
  })
}

function notFound(message: string): HttpResponse {
  const body: Data | null = Data.fromRawString(message, "utf-8")
  return HttpResponse.raw(404, "Not Found", {
    headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    body: body ?? undefined,
  })
}

function badGateway(message: string): HttpResponse {
  const body: Data | null = Data.fromRawString(message, "utf-8")
  return HttpResponse.raw(502, "Bad Gateway", {
    headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    body: body ?? undefined,
  })
}

function parseByteRange(header: string | undefined): { start: number; end: number | null } {
  const match: RegExpMatchArray | null =
    typeof header === "string" ? header.match(/bytes=(\d+)-(\d*)/) : null
  if (!match) return { start: 0, end: null }
  const start: number = Number(match[1])
  const endText: string = match[2]
  const end: number | null = endText ? Number(endText) : null
  return {
    start: Number.isFinite(start) ? start : 0,
    end: end !== null && Number.isFinite(end) ? end : null,
  }
}

function registerRoutes(target: HttpServer): void {
  target.registerAsyncHandler("/manifest/:id/:file", async (req: HttpRequest): Promise<HttpResponse> => {
    const manifest: VirtualManifest | undefined = virtualManifests.get(req.params["id"])
    if (!manifest) return notFound("unknown manifest")
    return textResponse(manifest.content, manifest.contentType)
  })

  target.registerAsyncHandler(
    "/bili-file/:id/file.m4s",
    async (req: HttpRequest): Promise<HttpResponse> => {
      const source: BiliFileSource | undefined = biliFileSources.get(req.params["id"])
      if (!source) return notFound("unknown stream")

      if (req.method === "HEAD") {
        return HttpResponse.raw(200, "OK", {
          headers: {
            ...BASE_HEADERS,
            "Content-Type": source.contentType,
            "Accept-Ranges": "bytes",
          },
        })
      }

      const requested = parseByteRange(req.headers["range"] ?? req.headers["Range"])
      const start: number = requested.start
      if (source.head && requested.end !== null && requested.end < source.head.byteLength) {
        const bytes: Uint8Array = source.head.slice(start, requested.end + 1)
        return HttpResponse.raw(206, "Partial Content", {
          headers: {
            ...BASE_HEADERS,
            "Content-Type": source.contentType,
            "Accept-Ranges": "bytes",
            "Content-Length": String(bytes.byteLength),
            "Content-Range": `bytes ${start}-${requested.end}/${source.total ?? "*"}`,
          },
          body: Data.fromUint8Array(bytes) ?? undefined,
        })
      }
      const first: number = Math.floor(start / BILI_WINDOW_BYTES)
      markWaiting(source, first)
      const head: Uint8Array | null = await source.prefetcher.get(first)
      const offset: number = start - first * BILI_WINDOW_BYTES
      if (!head || offset >= head.byteLength) {
        if (source.total !== null && start >= source.total) {
          return HttpResponse.raw(416, "Range Not Satisfiable", {
            headers: { ...BASE_HEADERS, "Content-Range": `bytes */${source.total}` },
          })
        }
        return badGateway("upstream failed")
      }

      const limit: number = requested.end !== null ? BILI_MAX_RESPONSE_BYTES : BILI_WINDOW_BYTES
      let end: number = Math.min(requested.end ?? Number.POSITIVE_INFINITY, start + limit - 1)
      if (source.total !== null) end = Math.min(end, source.total - 1)
      const parts: Uint8Array[] = [head.subarray(offset)]
      let have: number = head.byteLength - offset
      for (let index = first + 1; start + have - 1 < end; index++) {
        markWaiting(source, index)
        const next: Uint8Array | null = await source.prefetcher.get(index)
        if (!next || next.byteLength === 0) break
        parts.push(next)
        have += next.byteLength
      }
      const length: number = Math.min(have, end - start + 1)
      let bytes: Uint8Array
      if (parts.length === 1 && offset === 0 && length === head.byteLength) {
        bytes = head
      } else {
        bytes = new Uint8Array(length)
        let written: number = 0
        for (const part of parts) {
          if (written >= length) break
          const take: number = Math.min(part.byteLength, length - written)
          bytes.set(part.subarray(0, take), written)
          written += take
        }
      }
      return HttpResponse.raw(206, "Partial Content", {
        headers: {
          ...BASE_HEADERS,
          "Content-Type": source.contentType,
          "Accept-Ranges": "bytes",
          "Content-Length": String(bytes.byteLength),
          "Content-Range": `bytes ${start}-${start + bytes.byteLength - 1}/${source.total ?? "*"}`,
        },
        body: Data.fromUint8Array(bytes) ?? undefined,
      })
    },
  )

  target.registerAsyncHandler("/hls-master/:sessionId/master.m3u8", async (req: HttpRequest): Promise<HttpResponse> => {
    const handler: SabrProxySessionHandler | undefined = sabrSessions.get(req.params["sessionId"])
    if (!handler) return notFound("unknown session")
    return textResponse(handler.hlsMasterPlaylist(), "application/vnd.apple.mpegurl")
  })

  target.registerAsyncHandler("/sabr/:sessionId/master.m3u8", async (req: HttpRequest): Promise<HttpResponse> => {
    const handler: SabrProxySessionHandler | undefined = sabrSessions.get(req.params["sessionId"])
    if (!handler) return notFound("unknown session")
    return textResponse(handler.hlsMasterPlaylist(), "application/vnd.apple.mpegurl")
  })

  target.registerAsyncHandler("/sabr/:sessionId/manifest.mpd", async (req: HttpRequest): Promise<HttpResponse> => {
    const handler: SabrProxySessionHandler | undefined = sabrSessions.get(req.params["sessionId"])
    if (!handler) return notFound("unknown session")
    return textResponse(await handler.dashManifest(), "application/dash+xml")
  })

  target.registerAsyncHandler(
    "/hls-media/:sessionId/:itag/playlist.m3u8",
    async (req: HttpRequest): Promise<HttpResponse> => {
      const handler: SabrProxySessionHandler | undefined = sabrSessions.get(req.params["sessionId"])
      const itag: number = Number(req.params["itag"])
      if (!handler || !Number.isFinite(itag)) return notFound("unknown session")
      return textResponse(await handler.mediaPlaylist(itag), "application/vnd.apple.mpegurl")
    },
  )

  target.registerAsyncHandler(
    "/sabr-init/:sessionId/:itag/init.mp4",
    async (req: HttpRequest): Promise<HttpResponse> => {
      const handler: SabrProxySessionHandler | undefined = sabrSessions.get(req.params["sessionId"])
      const itag: number = Number(req.params["itag"])
      if (!handler || !Number.isFinite(itag)) return notFound("unknown session")
      const bytes: Uint8Array | null = await handler.initializationSegment(itag)
      if (!bytes) return notFound("initialization segment unavailable")
      return binaryResponse(bytes, handler.contentType?.(itag) ?? "video/mp4")
    },
  )

  target.registerAsyncHandler("/relay/:id/playlist.m3u8", async (req: HttpRequest): Promise<HttpResponse> => {
    const id: string = req.params["id"]
    const handler: HlsRelayHandler | undefined = hlsRelays.get(id)
    if (!handler) return notFound("unknown relay")
    try {
      const text: string = await handler.playlist(
        (index: number): string => `http://127.0.0.1:${serverPort}/relay/${id}/${index}/seg.ts`,
        `http://127.0.0.1:${serverPort}/relay/${id}/init/seg.ts`,
      )
      return textResponse(text, "application/vnd.apple.mpegurl")
    } catch (error) {
      return badGateway(error instanceof Error ? error.message : "playlist failed")
    }
  })

  target.registerAsyncHandler("/relay/:id/:index/seg.ts", async (req: HttpRequest): Promise<HttpResponse> => {
    const handler: HlsRelayHandler | undefined = hlsRelays.get(req.params["id"])
    if (!handler) return notFound("unknown relay")
    const isInit: boolean = req.params["index"] === "init"
    const index: number = Number(req.params["index"])
    if (!isInit && !Number.isInteger(index)) return notFound("unknown segment")
    const bytes: Uint8Array | null = await (isInit ? handler.initialization() : handler.segment(index)).catch(() => null)
    return bytes ? binaryResponse(bytes, "application/octet-stream") : badGateway("segment unavailable")
  })

  target.registerAsyncHandler(
    "/sabr-seg/:sessionId/:itag/:seq/seg.mp4",
    async (req: HttpRequest): Promise<HttpResponse> => {
      const handler: SabrProxySessionHandler | undefined = sabrSessions.get(req.params["sessionId"])
      const itag: number = Number(req.params["itag"])
      const sequence: number = Number(req.params["seq"])
      if (!handler || !Number.isFinite(itag) || !Number.isFinite(sequence)) {
        return notFound("unknown session")
      }
      const bytes: Uint8Array | null = await handler.mediaSegment(itag, sequence)
      if (!bytes) return notFound("segment unavailable")
      return binaryResponse(bytes, handler.contentType?.(itag) ?? "video/mp4")
    },
  )
}

export function ensureLocalProxyStarted(): number {
  if (server && server.state === "running" && server.port) {
    return server.port
  }
  if (starting && serverPort > 0) {
    return serverPort
  }

  starting = true
  try {
    const instance: HttpServer = new HttpServer()
    registerRoutes(instance)

    let lastError: string | null = null
    for (let i = 0; i < TRY_PORTS.length; i++) {
      const port: number = TRY_PORTS[i]
      const error: string | null = instance.start({ port, forceIPv4: true })
      if (!error) {
        server = instance
        serverPort = instance.port ?? port
        return serverPort
      }
      lastError = error
      if (port === 0) break
    }
    throw new Error(`本機代理啟動失敗：${lastError ?? "unknown error"}`)
  } finally {
    starting = false
  }
}

function hostOfUrl(value: string): string {
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return ""
  }
}

function isUposHost(host: string): boolean {
  return /^upos-[a-z0-9-]+\.bilivideo\.com$/.test(host)
}

function swappedUrl(url: string, host: string): string | null {
  try {
    const next = new URL(url)
    next.host = host
    return next.toString()
  } catch {
    return null
  }
}

function buildBiliCandidates(issued: string[]): string[] {
  if (!getSettings().biliLineSwitch) return issued.length ? [issued[0]] : []
  const out: string[] = []
  for (const url of issued) {
    if (url && !out.includes(url)) out.push(url)
  }
  const uposUrl: string | undefined = issued.find((url: string): boolean => isUposHost(hostOfUrl(url)))
  if (uposUrl) {
    for (const host of BILI_CANDIDATE_POOL) {
      const url: string | null = swappedUrl(uposUrl, host)
      if (url && !out.includes(url)) out.push(url)
    }
  }
  return out
}

export function registerBiliFileSource(
  id: string,
  urls: string | string[],
  contentType: string,
  bitrate?: number,
): string {
  const port: number = ensureLocalProxyStarted()
  const issued: string[] = (Array.isArray(urls) ? urls : [urls]).filter((value: string): boolean => !!value)
  const candidates: string[] = buildBiliCandidates(issued)
  const existing: BiliFileSource | undefined = biliFileSources.get(id)
  if (existing && existing.urls.join(" ") === candidates.join(" ")) {
    return `http://127.0.0.1:${port}/bili-file/${id}/file.m4s`
  }
  existing?.prefetcher.dispose()
  if (!existing && biliFileSources.size >= BILI_MAX_SOURCES) {
    const oldest: string | undefined = biliFileSources.keys().next().value
    if (oldest) {
      biliFileSources.get(oldest)?.prefetcher.dispose()
      biliFileSources.delete(oldest)
    }
  }
  const heavy: boolean = (bitrate ?? 0) >= BILI_HEAVY_BITRATE
  const source: BiliFileSource = {
    urls: candidates,
    primary: hostOfUrl(candidates[0] ?? ""),
    primarySince: 0,
    playhead: 0,
    exploring: new Map(),
    head: null,
    contentType,
    total: null,
    prefetcher: new Prefetcher(
      {
        count: (): number | null => (source.total === null ? null : Math.ceil(source.total / BILI_WINDOW_BYTES)),
        fetch: (index: number, signal: AbortSignal): Promise<Uint8Array | null> => fetchBiliChunk(source, index, signal),
      },
      {
        ahead: prefetchAheadFor(bitrate ?? 0),
        concurrency: heavy ? BILI_PREFETCH_CONCURRENCY_HEAVY : BILI_PREFETCH_CONCURRENCY,
        chunkBytes: BILI_WINDOW_BYTES,
      },
    ),
  }
  refreshPrimary(source, false)
  biliFileSources.set(id, source)
  return `http://127.0.0.1:${port}/bili-file/${id}/file.m4s`
}

export interface BiliStreamAccess {
  readonly id: string
  readonly contentType: string
  readonly windowBytes: number
  readonly prefetcher: Prefetcher
  total(): number | null
  markWaiting(index: number): void
}

export function getBiliStreamAccess(id: string): BiliStreamAccess | null {
  const source: BiliFileSource | undefined = biliFileSources.get(id)
  if (!source) return null
  return {
    id,
    contentType: source.contentType,
    windowBytes: BILI_WINDOW_BYTES,
    prefetcher: source.prefetcher,
    total: (): number | null => source.total,
    markWaiting: (index: number): void => markWaiting(source, index),
  }
}

function armTimeout(callback: () => void, ms: number): number {
  try {
    return setTimeout(callback, ms)
  } catch {
    return -1
  }
}

function disarmTimeout(id: number): void {
  if (id < 0) return
  try {
    clearTimeout(id)
  } catch {
  }
}

type BiliAttemptResult =
  | { ok: true; bytes: Uint8Array; ms: number; total: number | null }
  | { ok: false; ms: number; reason: string }

async function fetchBiliAttempt(
  url: string,
  start: number,
  budgetMs: number,
  signal: AbortSignal,
  trackHost: boolean,
): Promise<BiliAttemptResult> {
  const controller: AbortController = new AbortController()
  const relayAbort = (): void => controller.abort()
  signal.addEventListener("abort", relayAbort)
  let timedOut: boolean = false
  const timer: number = armTimeout((): void => {
    timedOut = true
    controller.abort()
  }, budgetMs)
  const startedAt: number = Date.now()

  try {
    const response: Awaited<ReturnType<typeof fetch>> = await fetch(url, {
      headers: { ...BILI_REQUEST_HEADERS, Range: `bytes=${start}-${start + BILI_WINDOW_BYTES - 1}` },
      signal: controller.signal,
      debugLabel: "Yobi bili chunk",
    })
    if (response.status === 416) return { ok: false, ms: Date.now() - startedAt, reason: "416" }
    if (!response.ok) return { ok: false, ms: Date.now() - startedAt, reason: `HTTP ${response.status}` }
    const contentType: string = (response.headers.get("content-type") ?? "").toLowerCase()
    if (contentType.includes("text/") || contentType.includes("json") || contentType.includes("xml")) {
      return { ok: false, ms: Date.now() - startedAt, reason: `content-type ${contentType}` }
    }
    const total: number = Number(response.headers.get("content-range")?.split("/")[1])
    const bytes: Uint8Array = new Uint8Array(await response.arrayBuffer())
    const known: boolean = Number.isFinite(total) && total > 0
    const atEof: boolean = known && start + bytes.byteLength >= total
    if (response.status === 206 && bytes.byteLength < BILI_WINDOW_BYTES && !atEof) {
      return { ok: false, ms: Date.now() - startedAt, reason: `short ${bytes.byteLength}/${BILI_WINDOW_BYTES}` }
    }
    recordDownload(bytes.byteLength, trackHost ? url : "")
    const sliced: Uint8Array =
      response.status === 200 && start > 0
        ? bytes.slice(start, start + BILI_WINDOW_BYTES)
        : bytes.byteLength > BILI_WINDOW_BYTES
          ? bytes.slice(0, BILI_WINDOW_BYTES)
          : bytes
    return { ok: true, bytes: sliced, ms: Date.now() - startedAt, total: known ? total : null }
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - startedAt,
      reason: signal.aborted ? "aborted" : timedOut ? `timeout ${budgetMs}ms` : String(error),
    }
  } finally {
    disarmTimeout(timer)
    try {
      signal.removeEventListener("abort", relayAbort)
    } catch {
    }
  }
}

let biliLineSwitchListener: ((host: string) => void) | null = null

export function setBiliLineSwitchListener(listener: ((host: string) => void) | null): void {
  biliLineSwitchListener = listener
}

function markWaiting(source: BiliFileSource, index: number): void {
  source.playhead = index
  for (const [chunk, entry] of source.exploring) {
    if (chunk <= index + 1) entry.controller.abort()
  }
}

function hostsOf(source: BiliFileSource): string[] {
  return source.urls.map(hostOfUrl)
}

function urlOfHost(source: BiliFileSource, host: string): string {
  return source.urls.find((url: string): boolean => hostOfUrl(url) === host) ?? source.urls[0]
}

function refreshPrimary(source: BiliFileSource, announce: boolean): void {
  const best: string | undefined = rankLines(hostsOf(source))[0]
  if (!best || !shouldPromote(best, source.primary)) return
  const forced: boolean = isLineBanned(source.primary)
  if (!forced && Date.now() - source.primarySince < BILI_PRIMARY_DWELL_MS) return
  source.primary = best
  source.primarySince = Date.now()
  if (!announce || !biliLineSwitchListener) return
  try {
    biliLineSwitchListener(best)
  } catch {
  }
}

interface BiliOutcome {
  host: string
  result: BiliAttemptResult
}

async function attemptBiliLine(
  source: BiliFileSource,
  host: string,
  start: number,
  budgetMs: number,
  signal: AbortSignal,
  trackHost: boolean,
): Promise<BiliOutcome> {
  const result: BiliAttemptResult = await fetchBiliAttempt(urlOfHost(source, host), start, budgetMs, signal, trackHost)
  if (result.ok) {
    if (result.total !== null) source.total = result.total
    noteLineSample(host, result.ms, result.bytes.byteLength, BILI_WINDOW_BYTES)
  } else if (result.reason !== "aborted" && result.reason !== "416") {
    noteLineFailure(host)
  }
  return { host, result }
}

async function fetchBiliHedged(
  source: BiliFileSource,
  index: number,
  primary: string,
  backup: string,
  start: number,
  signal: AbortSignal,
): Promise<BiliOutcome[]> {
  const waiting: boolean = index - source.playhead <= 1
  const expected: number = lineScore(primary) ?? BILI_HEDGE_DEFAULT_MS
  const delay: number = waiting
    ? Math.min(BILI_HEDGE_MAX_MS, Math.max(BILI_HEDGE_WAITING_MIN_MS, expected * BILI_HEDGE_WAITING_FACTOR))
    : Math.min(BILI_HEDGE_MAX_MS, Math.max(BILI_HEDGE_MIN_MS, expected * 2))
  const first: AbortController = new AbortController()
  const second: AbortController = new AbortController()
  const relayAbort = (): void => {
    first.abort()
    second.abort()
  }
  signal.addEventListener("abort", relayAbort)
  const startedAt: number = Date.now()
  const outcomes: BiliOutcome[] = []
  const fromBackup: Set<BiliOutcome> = new Set()
  let timer: number = -1

  try {
    const winner: BiliOutcome = await new Promise<BiliOutcome>((resolve: (outcome: BiliOutcome) => void): void => {
      let launched: number = 1
      let failures: number = 0
      let done: boolean = false
      const settle = (outcome: BiliOutcome): void => {
        outcomes.push(outcome)
        if (done) return
        if (outcome.result.ok) {
          done = true
          resolve(outcome)
          return
        }
        failures++
        if (failures >= launched) {
          done = true
          resolve(outcome)
        }
      }
      void attemptBiliLine(source, primary, start, BILI_CHUNK_TIMEOUT_MS, first.signal, true).then(settle)
      const check = (): void => {
        if (done) return
        if (index - source.playhead > 1) {
          timer = armTimeout(check, BILI_HEDGE_POLL_MS)
          return
        }
        launched++
        void attemptBiliLine(source, backup, start, BILI_CHUNK_TIMEOUT_MS, second.signal, true).then(
          (outcome: BiliOutcome): void => {
            fromBackup.add(outcome)
            settle(outcome)
          },
        )
      }
      timer = armTimeout(check, delay)
    })
    if (winner.result.ok && fromBackup.has(winner)) {
      noteLineSample(primary, Date.now() - startedAt, BILI_WINDOW_BYTES, BILI_WINDOW_BYTES)
      first.abort()
    } else {
      second.abort()
    }
    return [winner, ...outcomes.filter((outcome: BiliOutcome): boolean => outcome !== winner)]
  } finally {
    disarmTimeout(timer)
    try {
      signal.removeEventListener("abort", relayAbort)
    } catch {
    }
  }
}

async function fetchBiliChunk(source: BiliFileSource, index: number, signal: AbortSignal): Promise<Uint8Array | null> {
  const start: number = index * BILI_WINDOW_BYTES
  if (source.total !== null && start >= source.total) return null
  if (!source.urls.length) return null
  const hosts: string[] = hostsOf(source)
  const distance: number = index - source.playhead
  const tried: Set<string> = new Set()

  if (hosts.length > 1 && distance >= BILI_EXPLORE_MIN_AHEAD && index % BILI_EXPLORE_EVERY === 0) {
    const busy: string[] = [...source.exploring.values()].map((entry): string => entry.host)
    const host: string | null = pickLineToExplore(hosts, source.primary, busy)
    if (host) {
      const controller: AbortController = new AbortController()
      const relayAbort = (): void => controller.abort()
      signal.addEventListener("abort", relayAbort)
      source.exploring.set(index, { host, controller })
      let outcome: BiliOutcome
      try {
        outcome = await attemptBiliLine(source, host, start, BILI_EXPLORE_TIMEOUT_MS, controller.signal, false)
      } finally {
        source.exploring.delete(index)
        try {
          signal.removeEventListener("abort", relayAbort)
        } catch {
        }
      }
      if (outcome.result.ok) {
        refreshPrimary(source, true)
        return outcome.result.bytes
      }
      if (signal.aborted || outcome.result.reason === "416") return null
      tried.add(host)
    }
  }

  refreshPrimary(source, true)
  const order: string[] = [source.primary, ...rankLines(hosts).filter((host: string): boolean => host !== source.primary)]
    .filter((host: string): boolean => !tried.has(host))
    .slice(0, BILI_MAX_TRIES)
  let lastReason: string = "no line"
  for (let i = 0; i < order.length; i++) {
    const host: string = order[i]
    if (tried.has(host)) continue
    const waiting: boolean = index - source.playhead <= 1
    const scored: string | undefined = order
      .slice(i + 1)
      .find((next: string): boolean => !tried.has(next) && lineScore(next) !== null)
    const untouched: string | undefined = waiting
      ? order.slice(i + 1).find((next: string): boolean => !tried.has(next))
      : undefined
    const backup: string = scored ?? untouched ?? host
    const outcomes: BiliOutcome[] = await fetchBiliHedged(source, index, host, backup, start, signal)
    const winner: BiliOutcome = outcomes[0]
    if (winner.result.ok) {
      refreshPrimary(source, true)
      return winner.result.bytes
    }
    if (signal.aborted || winner.result.reason === "416") return null
    for (const outcome of outcomes) tried.add(outcome.host)
    tried.add(host)
    lastReason = winner.result.reason
  }
  throw new Error(`bili chunk ${index}: ${lastReason}`)
}

export function seedBiliHead(id: string, bytes: Uint8Array, total: number | null): void {
  const source: BiliFileSource | undefined = biliFileSources.get(id)
  if (!source) return
  source.head = bytes
  if (total !== null && total > 0) source.total = total
}

export function warmBiliRange(id: string, start: number, end: number): void {
  const source: BiliFileSource | undefined = biliFileSources.get(id)
  if (!source || end < start) return
  const first: number = Math.floor(start / BILI_WINDOW_BYTES)
  const last: number = Math.floor(end / BILI_WINDOW_BYTES)
  source.playhead = last
  for (let index = first; index <= last; index++) source.prefetcher.warm(index)
}

export function registerVirtualManifest(id: string, content: string, contentType: string): string {
  const port: number = ensureLocalProxyStarted()
  const file: string = ensureManifestFile(contentType)
  virtualManifests.set(id, { content, contentType, file })
  return `http://127.0.0.1:${port}/manifest/${id}/${file}`
}

export function updateVirtualManifest(id: string, content: string): void {
  const existing: VirtualManifest | undefined = virtualManifests.get(id)
  if (existing) {
    existing.content = content
  }
}

export function registerSabrSessionHandler(sessionId: string, handler: SabrProxySessionHandler): SabrProxyUrls {
  const port: number = ensureLocalProxyStarted()
  sabrSessions.set(sessionId, handler)
  return {
    hlsUrl: `http://127.0.0.1:${port}/sabr/${sessionId}/master.m3u8`,
    dashUrl: `http://127.0.0.1:${port}/sabr/${sessionId}/manifest.mpd`,
  }
}

export function getSabrProxyUrls(sessionId: string): SabrProxyUrls | null {
  if (!sabrSessions.has(sessionId) || !serverPort) return null
  return {
    hlsUrl: `http://127.0.0.1:${serverPort}/sabr/${sessionId}/master.m3u8`,
    dashUrl: `http://127.0.0.1:${serverPort}/sabr/${sessionId}/manifest.mpd`,
  }
}

export function registerHlsRelayHandler(id: string, handler: HlsRelayHandler): string {
  const port: number = ensureLocalProxyStarted()
  hlsRelays.set(id, handler)
  return `http://127.0.0.1:${port}/relay/${id}/playlist.m3u8`
}

export function unregisterHlsRelayHandler(id: string): void {
  hlsRelays.delete(id)
}

export function unregisterSabrSessionHandler(sessionId: string): void {
  sabrSessions.delete(sessionId)
}

export function isLocalProxyRunning(): boolean {
  return server !== null && server.state === "running"
}

export function getLocalProxyPort(): number {
  return serverPort
}

export function stopLocalProxy(): void {
  virtualManifests.clear()
  sabrSessions.clear()
  hlsRelays.clear()
  for (const source of biliFileSources.values()) source.prefetcher.dispose()
  biliFileSources.clear()
  if (server) {
    try {
      server.stop()
    } catch (_error) {
    }
  }
  server = null
  serverPort = 0
}
