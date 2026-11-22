
import { fetch } from "scripting"
import type { VideoQualityTrack } from "../../types"
import { recordDownload } from "../netMeter"
import { parseSidx, type SidxEntry, type SidxIndex } from "../sidx"
import {
  INNERTUBE_CLIENTS,
  getYoutubeAuth,
  type InnertubeClientKey,
  type JsonObject,
} from "./innertube"
import { getYoutubeLocale } from "./locale"
import {
  registerSabrSessionHandler,
  unregisterSabrSessionHandler,
  type SabrProxySessionHandler,
  type SabrProxyUrls,
} from "../localProxy"
import { Prefetcher } from "../prefetch"
import {
  UMP_PART,
  ProtoWriter,
  base64ToBytes,
  concatBytes,
  decodeFormatInitMetadata,
  decodeMediaHeader,
  decodeNextRequestPolicy,
  decodeProto,
  decodeSabrError,
  decodeSabrRedirect,
  makeClientPlaybackNonce,
  parseUmpParts,
  protoBytes,
  protoInts,
  protoNumber,
  type ProtoField,
  type SabrFormatInitMetadata,
  type SabrMediaHeader,
  type SabrNextRequestPolicy,
  type UmpPart,
} from "./sabrProto"
import {
  buildDashManifest,
  buildHlsMasterPlaylist,
  buildMediaPlaylist,
  containerOf,
  resolutionOf,
  sabrQualityTrackOf,
  stripSidxBoxes,
  type SabrFormat,
  type SabrManifestBuilderInput,
} from "./sabrFormats"

export {
  UMP_PART,
  decodeFormatInitMetadata,
  decodeMediaHeader,
  decodeNextRequestPolicy,
  decodeProto,
  decodeSabrError,
  decodeSabrRedirect,
  makeClientPlaybackNonce,
  parseUmpParts,
  type ProtoField,
  type ProtoValue,
  type SabrByteRange,
  type SabrFormatInitMetadata,
  type SabrMediaHeader,
  type SabrNextRequestPolicy,
  type UmpPart,
} from "./sabrProto"
export {
  audioTrackOf,
  buildDashManifest,
  buildHlsMasterPlaylist,
  buildMediaPlaylist,
  parseAdaptiveFormats,
  pickBestAudioFormat,
  pickVideoFormats,
  qualityLabelOf,
  sabrQualityTrackOf,
  type SabrFormat,
  type SabrManifestBuilderInput,
  type SabrTimelineSource,
} from "./sabrFormats"

const SABR_CONTEXT_KEEP_EXISTING: number = 2
const SABR_MAX_ATTEMPTS: number = 4
const SABR_MAX_BACKOFF_MS: number = 10_000

const SEGMENT_DURATION_MS: number = 5000
const MAX_SEGMENT_CACHE_BYTES: number = 24 * 1024 * 1024

function asObject(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject
  return null
}

export interface SabrSessionConfig {
  videoId: string
  serverAbrStreamingUrl: string
  videoPlaybackUstreamerConfig: string
  formats: SabrFormat[]
  clientKey?: InnertubeClientKey
  poToken?: string
  visitorData?: string
  clientVersion?: string
  cookie?: string
  userAgent?: string
  indexUrls?: Record<number, string>
  cpn?: string
  pairedItags?: { video: number; audio: number }
  refreshPoToken?: (staleToken: string) => Promise<string>
}

export class SabrSession {
  readonly videoId: string
  private readonly config: SabrSessionConfig
  private readonly formatsByItag: Map<number, SabrFormat> = new Map()
  private streamingUrl: string
  private playbackCookie?: Uint8Array
  private requestNumber: number = 1
  private initCache: Map<number, Uint8Array> = new Map()
  private segmentCache: Map<string, Uint8Array> = new Map()
  private segmentCacheBytes: number = 0
  private timings: Map<string, { startMs: number; durationMs: number }> = new Map()
  private sidxCache: Map<number, SidxIndex | null> = new Map()
  private initMetadata: Map<number, SabrFormatInitMetadata> = new Map()
  private indexedCounts: Map<number, number> = new Map()
  private sabrContexts: Map<number, Uint8Array> = new Map()
  private activeContextTypes: Set<number> = new Set()
  private contextChanged: boolean = false
  private backoffMs: number = 0
  private nextRequestAt: number = 0
  private tokenRefreshed: boolean = false
  private readonly cpn: string
  lastProtectionStatus?: number
  lastParts: number[] = []
  lastKeys: string[] = []
  lastError?: string

  constructor(config: SabrSessionConfig) {
    this.config = config
    this.cpn = config.cpn ?? makeClientPlaybackNonce()
    this.videoId = config.videoId
    this.streamingUrl = config.serverAbrStreamingUrl
    for (const format of config.formats) this.formatsByItag.set(format.itag, format)
  }

  formatByItag(itag: number): SabrFormat | undefined {
    return this.formatsByItag.get(itag)
  }

  durationMs(itag: number): number {
    return this.formatsByItag.get(itag)?.approxDurationMs ?? 0
  }

  segmentCount(itag: number): number {
    const indexed: number | undefined = this.indexedCounts.get(itag)
    if (indexed !== undefined) return indexed
    const durationMs: number = this.durationMs(itag)
    if (durationMs <= 0) return 1
    return Math.max(1, Math.ceil(durationMs / SEGMENT_DURATION_MS))
  }

  segmentTiming(itag: number, sequence: number): { startMs: number; durationMs: number } {
    const cached: { startMs: number; durationMs: number } | undefined = this.timings.get(`${itag}:${sequence}`)
    if (cached) return cached
    const count: number = this.segmentCount(itag)
    const durationMs: number = this.durationMs(itag)
    const startMs: number = (sequence - 1) * SEGMENT_DURATION_MS
    const remaining: number = Math.max(0, durationMs - startMs)
    const segmentMs: number = Math.min(SEGMENT_DURATION_MS, remaining > 0 ? remaining : SEGMENT_DURATION_MS)
    return { startMs, durationMs: segmentMs }
  }

  async prepareTimeline(itag: number): Promise<boolean> {
    if (this.indexedCounts.has(itag)) return true
    const format: SabrFormat | undefined = this.formatsByItag.get(itag)
    if (!format) return false
    const index: SidxIndex | null = await this.timelineIndex(format)
    if (!index || index.entries.length === 0) return false
    let startMs: number = 0
    index.entries.forEach((entry: SidxEntry, i: number) => {
      const durationMs: number = entry.durationUs / 1000
      this.timings.set(`${itag}:${i + 1}`, { startMs, durationMs })
      startMs += durationMs
    })
    this.indexedCounts.set(itag, index.entries.length)
    return true
  }

  private async timelineIndex(format: SabrFormat): Promise<SidxIndex | null> {
    if (!this.config.serverAbrStreamingUrl) return this.sidxFor(format)
    const init: Uint8Array | null = await this.fetchInitialization(format.itag).catch(() => null)
    const fromInit: SidxIndex | null = init ? parseSidx(init, 0) : null
    if (fromInit && fromInit.entries.length > 0) return fromInit
    const served: SabrFormatInitMetadata | undefined = this.initMetadata.get(format.itag)
    if (served && served.lastModified === format.lastModified) return this.sidxFor(format)
    return null
  }

  private recordTiming(itag: number, header: SabrMediaHeader): void {
    if (header.segmentNum === undefined) return
    if (header.startMs === undefined || header.durationMs === undefined) return
    this.timings.set(`${itag}:${header.segmentNum}`, {
      startMs: header.startMs,
      durationMs: header.durationMs,
    })
  }

  private readaheadMs: number = 0
  private endpoint(): string {
    const separator: string = this.streamingUrl.includes("?") ? "&" : "?"
    const params: string[] = [
      `rn=${this.requestNumber}`,
      `rbuf=${this.readaheadMs}`,
      `cpn=${this.cpn}`,
      `cver=${encodeURIComponent(String(this.config.clientVersion ?? ""))}`,
      "ump=1",
      "srfvp=1",
      "alr=yes",
    ]
    if (this.config.poToken) params.push(`pot=${encodeURIComponent(this.config.poToken)}`)
    return `${this.streamingUrl}${separator}${params.join("&")}`
  }

  private formatIdMessage(format: SabrFormat): ProtoWriter {
    const writer: ProtoWriter = new ProtoWriter().uint32(1, format.itag)
    if (format.lastModified && format.lastModified !== "0") {
      writer.int64(2, Number(format.lastModified))
    }
    if (format.xtags) writer.string(3, format.xtags)
    return writer
  }

  private clientInfoMessage(): ProtoWriter {
    const clientKey: InnertubeClientKey = this.config.clientKey ?? "WEB_SABR"
    const profile = INNERTUBE_CLIENTS[clientKey]
    const client: JsonObject = asObject(profile.context["client"]) ?? {}
    const result: ProtoWriter = new ProtoWriter()
    result.string(1, getYoutubeLocale().hl)
    if (client["deviceMake"]) result.string(12, String(client["deviceMake"]))
    if (client["deviceModel"]) result.string(13, String(client["deviceModel"]))
    result.uint32(16, profile.clientName)
    result.string(17, this.config.clientVersion ?? profile.clientVersion)
    if (client["osName"]) result.string(18, String(client["osName"]))
    if (client["osVersion"]) result.string(19, String(client["osVersion"]))
    return result
  }

  private pairedFormats(format: SabrFormat): { video?: SabrFormat; audio?: SabrFormat } {
    const pair = this.config.pairedItags
    const video: SabrFormat | undefined = format.isAudio
      ? (pair ? this.formatsByItag.get(pair.video) : undefined)
      : format
    const audio: SabrFormat | undefined = format.isAudio
      ? format
      : (pair ? this.formatsByItag.get(pair.audio) : undefined)
    return { video, audio }
  }

  private preferredFormats(target: SabrFormat): SabrFormat[] {
    const family = (format: SabrFormat): string => {
      const [container, codecs] = format.mimeType.split(";")
      return `${container}|${(/codecs="?([a-z0-9]{4})/i.exec(codecs ?? "")?.[1] ?? "").toLowerCase()}`
    }
    const targetFamily: string = family(target)
    const result: SabrFormat[] = []
    for (const format of this.formatsByItag.values()) {
      if (target.isVideo !== format.isVideo) continue
      if (family(format) !== targetFamily) continue
      if (target.isAudio && target.audioTrackId && format.audioTrackId !== target.audioTrackId) continue
      result.push(format)
    }
    return result
  }

  private abrStateMessage(format: SabrFormat, playerTimeMs: number): ProtoWriter {
    const { video, audio } = this.pairedFormats(format)
    const abrState: ProtoWriter = new ProtoWriter().int64(28, playerTimeMs)
    abrState.int64(29, 0).uint32(34, 1).float(35, 1).int64(39, 0)
    abrState.uint32(40, video && audio ? 0 : format.isAudio ? 1 : 2)
    abrState.uint32(22, 0).uint32(46, 0).int64(68, 0)
    const target: SabrFormat | undefined = format.isAudio ? audio : video
    if (target?.bitrate) abrState.int64(23, target.bitrate)
    const targetResolution: number = target?.isVideo ? resolutionOf(target) : 0
    if (targetResolution > 0) abrState.uint32(21, targetResolution).uint32(16, targetResolution)
    if (audio?.audioTrackId) abrState.string(69, audio.audioTrackId)
    return abrState
  }

  private streamerContextMessage(): ProtoWriter {
    const context: ProtoWriter = new ProtoWriter().message(1, this.clientInfoMessage())
    if (this.config.poToken) {
      const tokenBytes: Uint8Array | null = base64ToBytes(this.config.poToken)
      context.bytes(2, tokenBytes ?? new TextEncoder().encode(this.config.poToken))
    }
    if (this.playbackCookie) context.bytes(3, this.playbackCookie)
    for (const type of this.activeContextTypes) {
      const value: Uint8Array | undefined = this.sabrContexts.get(type)
      if (value) context.message(5, new ProtoWriter().uint32(1, type).bytes(2, value))
    }
    for (const type of this.sabrContexts.keys()) {
      if (!this.activeContextTypes.has(type)) context.uint32(6, type)
    }
    return context
  }

  private buildRequestBody(format: SabrFormat, sequence: number | "init"): Uint8Array {
    const ustreamerConfig: Uint8Array | null = base64ToBytes(this.config.videoPlaybackUstreamerConfig)
    const playerTimeMs: number = sequence === "init"
      ? 0
      : Math.max(0, Math.floor(this.segmentTiming(format.itag, sequence).startMs))
    const { video, audio } = this.pairedFormats(format)

    const request: ProtoWriter = new ProtoWriter().message(1, this.abrStateMessage(format, playerTimeMs))
    for (const selected of [video, audio]) {
      if (selected && this.initCache.has(selected.itag)) request.message(2, this.formatIdMessage(selected))
    }
    request.int64(4, playerTimeMs)
    if (ustreamerConfig) request.bytes(5, ustreamerConfig)
    for (const preferred of video ? this.preferredFormats(video) : []) request.message(17, this.formatIdMessage(preferred))
    for (const preferred of audio ? this.preferredFormats(audio) : []) request.message(16, this.formatIdMessage(preferred))
    request.message(19, this.streamerContextMessage())
    return request.finish()
  }

  private headers(): Record<string, string> {
    const auth = getYoutubeAuth()
    const clientKey: InnertubeClientKey = this.config.clientKey ?? "WEB_SABR"
    const profile = INNERTUBE_CLIENTS[clientKey]
    const headers: Record<string, string> = {
      "Content-Type": "application/x-protobuf",
      Accept: "application/vnd.yt-ump",
      "Accept-Encoding": "identity",
      "User-Agent": this.config.userAgent ?? profile.userAgent,
    }
    const visitorData: string | undefined = this.config.visitorData ?? auth.visitorData
    if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData
    if (this.config.cookie ?? auth.cookie) headers["Cookie"] = String(this.config.cookie ?? auth.cookie)
    if (auth.authorization && (clientKey === "MWEB" || clientKey === "WEB_SABR")) {
      headers["Authorization"] = auth.authorization
      headers["X-Origin"] = "https://www.youtube.com"
      headers["X-Goog-AuthUser"] = "0"
    }
    return headers
  }

  private async requestOnce(format: SabrFormat, sequence: number | "init"): Promise<Map<string, Uint8Array>> {
    const wait: number = this.nextRequestAt - Date.now()
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, Math.min(wait, SABR_MAX_BACKOFF_MS)))
    this.backoffMs = 0
    const body: Uint8Array = this.buildRequestBody(format, sequence)
    const bodyData: Data | null = Data.fromUint8Array(body)
    const response = await fetch(this.endpoint(), {
      method: "POST",
      headers: this.headers(),
      body: bodyData ?? undefined,
      timeout: 25,
      debugLabel: "Yobi SABR UMP",
    })
    this.requestNumber++

    if (!response.ok) {
      const text: string = await response.text()
      throw new Error(`SABR 請求失敗：HTTP ${response.status} ${text.slice(0, 160)}`)
    }

    const buffer: ArrayBuffer = await response.arrayBuffer()
    recordDownload(buffer.byteLength, this.endpoint())
    const parts: UmpPart[] = parseUmpParts(new Uint8Array(buffer))
    this.lastParts = parts.map((part: UmpPart): number => part.type)
    const headers: Map<number, SabrMediaHeader> = new Map()
    const chunks: Map<number, Uint8Array[]> = new Map()
    const finished: Set<number> = new Set()
    const segments: Map<string, Uint8Array> = new Map()

    for (const part of parts) {
      if (part.type === UMP_PART.MEDIA_HEADER) {
        const header: SabrMediaHeader = decodeMediaHeader(part.data)
        headers.set(header.headerId, header)
        if (header.itag !== undefined) this.recordTiming(header.itag, header)
      } else if (part.type === UMP_PART.MEDIA) {
        if (part.data.length === 0) continue
        const headerId: number = part.data[0]
        const payload: Uint8Array = part.data.subarray(1)
        const list: Uint8Array[] = chunks.get(headerId) ?? []
        list.push(payload)
        chunks.set(headerId, list)
      } else if (part.type === UMP_PART.MEDIA_END) {
        if (part.data.length === 0) continue
        const headerId: number = part.data[0]
        finished.add(headerId)
        const header: SabrMediaHeader | undefined = headers.get(headerId)
        const list: Uint8Array[] = chunks.get(headerId) ?? []
        if (!header || list.length === 0) continue
        const media: Uint8Array = concatBytes(list)
        const itag: number = header.itag ?? format.itag
        if (header.isInitializationSegment || header.segmentNum === undefined) {
          this.initCache.set(itag, media)
          segments.set(`${itag}:init`, media)
        } else {
          this.cacheSegment(`${itag}:${header.segmentNum}`, media)
          segments.set(`${itag}:${header.segmentNum}`, media)
        }
      } else if (part.type === UMP_PART.FORMAT_INITIALIZATION_METADATA) {
        const metadata: SabrFormatInitMetadata | null = decodeFormatInitMetadata(part.data)
        if (metadata) this.initMetadata.set(metadata.itag, metadata)
      } else if (part.type === UMP_PART.NEXT_REQUEST_POLICY) {
        const policy: SabrNextRequestPolicy = decodeNextRequestPolicy(part.data)
        if (policy.playbackCookie && policy.playbackCookie.length > 0) this.playbackCookie = policy.playbackCookie
        this.readaheadMs = policy.targetVideoReadaheadMs ?? policy.targetAudioReadaheadMs ?? this.readaheadMs
        this.backoffMs = policy.backoffTimeMs ?? 0
        this.nextRequestAt = Date.now() + this.backoffMs
      } else if (part.type === UMP_PART.SABR_REDIRECT) {
        const redirect: string | undefined = decodeSabrRedirect(part.data)
        if (redirect && /^https?:/i.test(redirect)) this.streamingUrl = redirect
      } else if (part.type === UMP_PART.SABR_ERROR) {
        this.lastError = decodeSabrError(part.data)
      } else if (part.type === UMP_PART.STREAM_PROTECTION_STATUS) {
        this.lastProtectionStatus = protoNumber(decodeProto(part.data), 1)
      } else if (part.type === UMP_PART.SABR_CONTEXT_UPDATE) {
        this.applyContextUpdate(part.data)
      } else if (part.type === UMP_PART.SABR_CONTEXT_SENDING_POLICY) {
        const policy: Map<number, ProtoField[]> = decodeProto(part.data)
        for (const type of protoInts(policy, 1)) this.activeContextTypes.add(type)
        for (const type of protoInts(policy, 2)) this.activeContextTypes.delete(type)
        for (const type of protoInts(policy, 3)) this.sabrContexts.delete(type)
      }
    }

    void finished
    this.lastKeys = [...segments.keys()]
    return segments
  }

  private applyContextUpdate(data: Uint8Array): void {
    const fields: Map<number, ProtoField[]> = decodeProto(data)
    const type: number | undefined = protoNumber(fields, 1)
    const value: Uint8Array | undefined = protoBytes(fields, 3)
    if (type === undefined || !value) return
    if (protoNumber(fields, 5) === SABR_CONTEXT_KEEP_EXISTING && this.sabrContexts.has(type)) return
    this.sabrContexts.set(type, value)
    if (protoNumber(fields, 4) === 1) this.activeContextTypes.add(type)
    this.contextChanged = true
  }

  private async requestWithContext(format: SabrFormat, sequence: number | "init", key: string): Promise<Map<string, Uint8Array>> {
    let segments: Map<string, Uint8Array> = new Map()
    for (let attempt = 0; attempt < SABR_MAX_ATTEMPTS; attempt++) {
      this.contextChanged = false
      segments = await this.requestOnce(format, sequence)
      if (segments.has(key) || this.segmentCache.has(key) || this.initCache.has(format.itag) && sequence === "init") break
      if (this.lastProtectionStatus === 3 && (await this.refreshToken())) continue
      if (!this.contextChanged && this.backoffMs <= 0) break
    }
    return segments
  }

  private async refreshToken(): Promise<boolean> {
    if (this.tokenRefreshed || !this.config.refreshPoToken) return false
    this.tokenRefreshed = true
    try {
      this.config.poToken = await this.config.refreshPoToken(this.config.poToken ?? "")
      return true
    } catch (_error) {
      return false
    }
  }

  async fetchInitialization(itag: number): Promise<Uint8Array | null> {
    const cached: Uint8Array | undefined = this.initCache.get(itag)
    if (cached) return cached
    const format: SabrFormat | undefined = this.formatsByItag.get(itag)
    if (!format) return null
    const indexUrl: string | undefined = this.indexUrlFor(format)
    if (!this.config.serverAbrStreamingUrl) {
      if (!indexUrl || !format.initRange) return null
      const direct: Uint8Array | null = await fetchRange(indexUrl, format.initRange.start, format.initRange.end, this.headers())
      if (direct) this.initCache.set(itag, direct)
      return direct
    }

    try {
      const segments: Map<string, Uint8Array> = await this.requestWithContext(format, "init", `${itag}:init`)
      const media: Uint8Array | undefined = segments.get(`${itag}:init`) ?? this.initCache.get(itag)
      return media ?? null
    } catch (error) {
      if (indexUrl && format.initRange && this.initMetadata.get(itag)?.lastModified === format.lastModified) {
        const direct: Uint8Array | null = await fetchRange(
          indexUrl,
          format.initRange.start,
          format.initRange.end,
          this.headers(),
        )
        if (direct) this.initCache.set(itag, direct)
        return direct
      }
      throw error
    }
  }

  async fetchSegment(itag: number, sequence: number): Promise<Uint8Array | null> {
    const key: string = `${itag}:${sequence}`
    const cached: Uint8Array | undefined = this.segmentCache.get(key)
    if (cached) return cached

    const format: SabrFormat | undefined = this.formatsByItag.get(itag)
    if (!format) return null

    if (!this.config.serverAbrStreamingUrl && format.url) {
      const direct: Uint8Array | null = await this.fetchDirectSegment(format, sequence)
      if (direct) this.cacheSegment(key, direct)
      return direct
    }

    await this.requestWithContext(format, sequence, key)
    return this.segmentCache.get(key) ?? null
  }

  private cacheSegment(key: string, media: Uint8Array): void {
    const previous: Uint8Array | undefined = this.segmentCache.get(key)
    if (previous) {
      this.segmentCacheBytes -= previous.byteLength
      this.segmentCache.delete(key)
    }
    this.segmentCache.set(key, media)
    this.segmentCacheBytes += media.byteLength
    while (this.segmentCacheBytes > MAX_SEGMENT_CACHE_BYTES && this.segmentCache.size > 1) {
      const oldestKey: string | undefined = this.segmentCache.keys().next().value
      if (oldestKey === undefined) break
      const oldest: Uint8Array | undefined = this.segmentCache.get(oldestKey)
      this.segmentCache.delete(oldestKey)
      if (oldest) this.segmentCacheBytes -= oldest.byteLength
    }
  }

  dispose(): void {
    this.segmentCache.clear()
    this.segmentCacheBytes = 0
    this.initCache.clear()
    this.timings.clear()
    this.sidxCache.clear()
    this.initMetadata.clear()
    this.indexedCounts.clear()
    this.sabrContexts.clear()
    this.activeContextTypes.clear()
  }

  private indexUrlFor(format: SabrFormat): string | undefined {
    return this.config.indexUrls?.[format.itag] ?? format.url
  }

  private async sidxFor(format: SabrFormat): Promise<SidxIndex | null> {
    const cached: SidxIndex | undefined = this.sidxCache.get(format.itag) ?? undefined
    if (cached) return cached
    const indexUrl: string | undefined = this.indexUrlFor(format)
    if (!indexUrl || !format.indexRange) return null
    const bytes: Uint8Array | null = await fetchRange(indexUrl, format.indexRange.start, format.indexRange.end, this.headers()).catch(() => null)
    const index: SidxIndex | null = bytes ? parseSidx(bytes, format.indexRange.start) : null
    if (index && index.entries.length > 0) this.sidxCache.set(format.itag, index)
    return index
  }

  private async fetchDirectSegment(format: SabrFormat, sequence: number): Promise<Uint8Array | null> {
    if (!format.url) return null
    if (format.initRange && sequence === 0) {
      return fetchRange(format.url, format.initRange.start, format.initRange.end, this.headers())
    }
    const index: SidxIndex | null = await this.sidxFor(format)
    if (!index) return null
    const entry: SidxEntry | undefined = index.entries[sequence - 1]
    if (!entry) return null
    return fetchRange(format.url, entry.offset, entry.offset + entry.size - 1, this.headers())
  }
}

async function fetchRange(
  url: string,
  start: number,
  end: number,
  headers: Record<string, string>,
): Promise<Uint8Array | null> {
  const requestHeaders: Record<string, string> = { ...headers, Range: `bytes=${start}-${end}` }
  delete requestHeaders["Content-Type"]
  const response = await fetch(url, {
    headers: requestHeaders,
    timeout: 25,
    debugLabel: "Yobi SABR range",
  })
  if (!response.ok && response.status !== 206) return null
  const buffer: ArrayBuffer = await response.arrayBuffer()
  recordDownload(buffer.byteLength, url)
  return new Uint8Array(buffer)
}

export interface SabrQualitySession {
  session: SabrSession
  urls: SabrProxyUrls
  video: SabrFormat
  audio: SabrFormat
  quality: VideoQualityTrack
  prepare: () => Promise<boolean>
  dispose: () => void
}

export function createSabrQualitySession(
  config: SabrSessionConfig,
  video: SabrFormat,
  audio: SabrFormat,
): SabrQualitySession {
  const session: SabrSession = new SabrSession({ ...config, pairedItags: { video: video.itag, audio: audio.itag } })
  const sessionId: string = `sabr-${config.videoId}-${video.itag}-${audio.itag}`
  const input: SabrManifestBuilderInput = { sessionId, session, video, audio }

  const prefetchers: Map<number, Prefetcher> = new Map()
  const prefetcherFor = (itag: number): Prefetcher => {
    let prefetcher: Prefetcher | undefined = prefetchers.get(itag)
    if (!prefetcher) {
      prefetcher = new Prefetcher(
        {
          count: (): number => session.segmentCount(itag) + 1,
          fetch: (sequence: number): Promise<Uint8Array | null> => session.fetchSegment(itag, sequence),
        },
        { ahead: 4, concurrency: 1 },
      )
      prefetchers.set(itag, prefetcher)
    }
    return prefetcher
  }

  const handler: SabrProxySessionHandler = {
    hlsMasterPlaylist: (): string => buildHlsMasterPlaylist(input),
    mediaPlaylist: async (itag: number): Promise<string> => {
      await session.prepareTimeline(itag)
      return buildMediaPlaylist(input, itag)
    },
    dashManifest: async (): Promise<string> => {
      await Promise.all([session.prepareTimeline(video.itag), session.prepareTimeline(audio.itag)])
      return buildDashManifest(input)
    },
    initializationSegment: async (itag: number): Promise<Uint8Array | null> =>
      stripSidxBoxes(await session.fetchInitialization(itag)),
    mediaSegment: (itag: number, sequence: number): Promise<Uint8Array | null> => prefetcherFor(itag).get(sequence),
    contentType: (itag: number): string => {
      const format: SabrFormat | undefined = session.formatByItag(itag)
      return format ? containerOf(format.mimeType) : "video/mp4"
    },
  }

  const urls: SabrProxyUrls = registerSabrSessionHandler(sessionId, handler)
  const quality: VideoQualityTrack = sabrQualityTrackOf(video, urls.hlsUrl)

  const prepare = async (): Promise<boolean> => {
    const [videoReady, audioReady] = await Promise.all([
      session.prepareTimeline(video.itag),
      session.prepareTimeline(audio.itag),
    ])
    return videoReady && audioReady
  }

  let disposed: boolean = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    unregisterSabrSessionHandler(sessionId)
    for (const prefetcher of prefetchers.values()) prefetcher.dispose()
    prefetchers.clear()
    session.dispose()
  }

  return { session, urls, video, audio, quality, prepare, dispose }
}
