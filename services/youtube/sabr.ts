/**
 * YouTube SABR (Server-enforced Adaptive Bitrate) 橋接。
 *
 * - UMP (Unified Media Protocol) 二進位封包解析（VarInt 長度前綴）。
 * - 輕量 protobuf 編碼 / 解碼（VideoPlaybackAbrRequest、MediaHeader、NextRequestPolicy）。
 * - 依 SabrHlsManifestBuilder / SabrDashManifestBuilder 產生本機 HLS / DASH manifest。
 * - 直連 `url` 的格式（IOS / ANDROID_VR）可用 HTTP Range + sidx 抓切片。
 */

import { fetch } from "scripting"
import type { AudioStreamTrack, VideoQualityTrack } from "../../types"
import {
  INNERTUBE_CLIENTS,
  getYoutubeAuth,
  type InnertubeClientKey,
  type JsonObject,
} from "./innertube"
import {
  registerSabrSessionHandler,
  type SabrProxySessionHandler,
  type SabrProxyUrls,
} from "../localProxy"
import { Prefetcher } from "../prefetch"

export const UMP_PART = {  MEDIA_HEADER: 20,
  MEDIA: 21,
  MEDIA_END: 22,
  NEXT_REQUEST_POLICY: 35,
  FORMAT_INITIALIZATION_METADATA: 42,
  SABR_REDIRECT: 43,
  SABR_ERROR: 44,
  SABR_CONTEXT_UPDATE: 57,
  STREAM_PROTECTION_STATUS: 58,
  SABR_CONTEXT_SENDING_POLICY: 59,
} as const

const SABR_CONTEXT_KEEP_EXISTING: number = 2
const SABR_MAX_ATTEMPTS: number = 4
const SABR_MAX_BACKOFF_MS: number = 10_000

const SEGMENT_DURATION_MS: number = 5000

/* ------------------------------------------------------------------ *
 * 格式
 * ------------------------------------------------------------------ */

export interface SabrByteRange {
  start: number
  end: number
}

export interface SabrFormat {
  itag: number
  mimeType: string
  lastModified: string
  xtags?: string
  bitrate: number
  isAudio: boolean
  isVideo: boolean
  width?: number
  height?: number
  fps?: number
  qualityLabel?: string
  audioQuality?: string
  approxDurationMs?: number
  contentLength?: number
  url?: string
  initRange?: SabrByteRange
  indexRange?: SabrByteRange
  audioTrackId?: string
  audioTrackName?: string
  isDrc?: boolean
}

function asObject(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject
  return null
}

function parseRange(value: unknown): SabrByteRange | undefined {
  const range: JsonObject | null = asObject(value)
  if (!range) return undefined
  const start: unknown = range["start"]
  const end: unknown = range["end"]
  if (start === undefined || end === undefined) return undefined
  return { start: Number(start), end: Number(end) }
}

function lastModifiedOf(format: JsonObject): string {
  const direct: unknown = format["lastModified"] ?? format["last_modified"] ?? format["last_modified_ms"]
  if (direct === undefined || direct === null) return "0"
  const text: string = String(direct)
  return text.replace(/[^\d]/g, "") || "0"
}

/** 解析 adaptiveFormats。 */
export function parseAdaptiveFormats(formats: unknown[], fpsMap: Map<number, number> = new Map()): SabrFormat[] {
  const result: SabrFormat[] = []
  for (const entry of formats) {
    const format: JsonObject | null = asObject(entry)
    if (!format) continue
    const itag: number = Number(format["itag"] ?? 0)
    const mimeType: string = String(format["mimeType"] ?? format["mime_type"] ?? "")
    if (!itag || !mimeType) continue
    const audioTrack: JsonObject | null = asObject(format["audioTrack"])
    const parsed: SabrFormat = {
      itag,
      mimeType,
      lastModified: lastModifiedOf(format),
      bitrate: Number(format["bitrate"] ?? format["averageBitrate"] ?? 0),
      isAudio: mimeType.includes("audio"),
      isVideo: mimeType.includes("video"),
    }
    if (format["xtags"] !== undefined) parsed.xtags = String(format["xtags"])
    if (format["width"] !== undefined) parsed.width = Number(format["width"])
    if (format["height"] !== undefined) parsed.height = Number(format["height"])
    if (format["fps"]) parsed.fps = Number(format["fps"])
    else if (fpsMap.has(itag)) parsed.fps = fpsMap.get(itag)
    if (format["qualityLabel"]) parsed.qualityLabel = String(format["qualityLabel"])
    if (format["audioQuality"]) parsed.audioQuality = String(format["audioQuality"])
    if (format["approxDurationMs"] !== undefined) parsed.approxDurationMs = Number(format["approxDurationMs"])
    if (format["contentLength"] !== undefined) parsed.contentLength = Number(format["contentLength"])
    if (typeof format["url"] === "string") parsed.url = String(format["url"])
    if (audioTrack) {
      if (audioTrack["id"] !== undefined) parsed.audioTrackId = String(audioTrack["id"])
      if (audioTrack["displayName"] !== undefined) parsed.audioTrackName = String(audioTrack["displayName"])
    }
    if (format["isDrc"] === true) parsed.isDrc = true
    const initRange: SabrByteRange | undefined = parseRange(format["initRange"])
    if (initRange) parsed.initRange = initRange
    const indexRange: SabrByteRange | undefined = parseRange(format["indexRange"])
    if (indexRange) parsed.indexRange = indexRange
    result.push(parsed)
  }
  return result
}

/** 選擇最佳音訊（偏好 m4a / 非 DRC / 高碼率）。 */
export function pickBestAudioFormat(formats: SabrFormat[]): SabrFormat | undefined {
  const audios: SabrFormat[] = formats.filter((format: SabrFormat): boolean => format.isAudio)
  if (audios.length === 0) return undefined
  const score = (format: SabrFormat): number => {
    let value: number = format.bitrate
    if (format.mimeType.includes("mp4")) value += 1_000_000
    if (!format.isDrc) value += 500_000
    return value
  }
  return audios.sort((a: SabrFormat, b: SabrFormat): number => score(b) - score(a))[0]
}

/** 視訊軌（可切換畫質清單）。只取 MP4：時間軸靠 sidx，webm 的 Cues 不支援。 */
export function pickVideoFormats(formats: SabrFormat[], includeAv1: boolean = true): SabrFormat[] {
  const videos: SabrFormat[] = formats.filter((format: SabrFormat): boolean => {
    if (!format.isVideo || !format.mimeType.startsWith("video/mp4")) return false
    if (!includeAv1 && format.mimeType.includes("av01")) return false
    return true
  })
  const byItag: Map<number, SabrFormat> = new Map()
  for (const format of videos) byItag.set(format.itag, format)
  return Array.from(byItag.values()).sort(
    (a: SabrFormat, b: SabrFormat): number => (b.height ?? 0) - (a.height ?? 0) || (b.fps ?? 0) - (a.fps ?? 0),
  )
}

/* ------------------------------------------------------------------ *
 * UMP
 * ------------------------------------------------------------------ */

export interface UmpPart {
  type: number
  data: Uint8Array
}

function readVarInt(bytes: Uint8Array, offset: number): [number, number] {
  if (offset >= bytes.length) return [-1, offset]
  const first: number = bytes[offset]
  const byteLength: number =
    first < 128 ? 1 : first < 192 ? 2 : first < 224 ? 3 : first < 240 ? 4 : 5
  if (offset + byteLength > bytes.length) return [-1, offset]

  if (byteLength === 1) return [first, offset + 1]
  if (byteLength === 2) {
    return [(first & 0x3f) | (bytes[offset + 1] << 6), offset + 2]
  }
  if (byteLength === 3) {
    return [(first & 0x1f) | (bytes[offset + 1] << 5) | (bytes[offset + 2] << 13), offset + 3]
  }
  if (byteLength === 4) {
    return [
      (first & 0x0f) | (bytes[offset + 1] << 4) | (bytes[offset + 2] << 12) | (bytes[offset + 3] << 20),
      offset + 4,
    ]
  }
  const value: number =
    (bytes[offset + 1] | (bytes[offset + 2] << 8) | (bytes[offset + 3] << 16) | (bytes[offset + 4] << 24)) >>> 0
  return [value, offset + 5]
}

function writeVarInt(value: number, out: number[]): void {
  if (value < 0) throw new Error("UMP VarInt 不可為負")
  if (value < 128) {
    out.push(value)
  } else if (value < 16384) {
    out.push((value & 0x3f) | 0x80, value >> 6)
  } else if (value < 2097152) {
    out.push((value & 0x1f) | 0xc0, (value >> 5) & 0xff, value >> 13)
  } else if (value < 268435456) {
    out.push((value & 0x0f) | 0xe0, (value >> 4) & 0xff, (value >> 12) & 0xff, value >> 20)
  } else {
    out.push(0xf0, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff)
  }
}

/** 解析完整 UMP 封包（無串流狀態）。 */
export function parseUmpParts(bytes: Uint8Array): UmpPart[] {
  const parts: UmpPart[] = []
  let offset: number = 0
  while (offset < bytes.length) {
    const typeResult: [number, number] = readVarInt(bytes, offset)
    if (typeResult[0] < 0) break
    offset = typeResult[1]
    const sizeResult: [number, number] = readVarInt(bytes, offset)
    if (sizeResult[0] < 0) break
    offset = sizeResult[1]
    const size: number = sizeResult[0]
    if (offset + size > bytes.length) break
    parts.push({ type: typeResult[0], data: bytes.subarray(offset, offset + size) })
    offset += size
  }
  return parts
}

/* ------------------------------------------------------------------ *
 * Protobuf
 * ------------------------------------------------------------------ */

export type ProtoValue = number | Uint8Array

export interface ProtoField {
  field: number
  wire: number
  value: ProtoValue
}

class ProtoWriter {
  private buffer: number[] = []

  private varint(value: number): void {
    let remaining: number = Math.max(0, Math.floor(value))
    while (remaining > 0x7f) {
      this.buffer.push((remaining & 0x7f) | 0x80)
      remaining = Math.floor(remaining / 128)
    }
    this.buffer.push(remaining & 0x7f)
  }

  private tag(field: number, wire: number): void {
    this.varint((field << 3) | wire)
  }

  uint32(field: number, value: number): ProtoWriter {
    this.tag(field, 0)
    this.varint(value)
    return this
  }

  int64(field: number, value: number): ProtoWriter {
    this.tag(field, 0)
    this.varint(value)
    return this
  }

  float(field: number, value: number): ProtoWriter {
    this.tag(field, 5)
    const buffer: ArrayBuffer = new ArrayBuffer(4)
    new DataView(buffer).setFloat32(0, value, true)
    const view: Uint8Array = new Uint8Array(buffer)
    for (let i = 0; i < 4; i++) this.buffer.push(view[i])
    return this
  }

  string(field: number, value: string): ProtoWriter {
    const encoded: Uint8Array = new TextEncoder().encode(value)
    this.tag(field, 2)
    this.varint(encoded.length)
    for (let i = 0; i < encoded.length; i++) this.buffer.push(encoded[i])
    return this
  }

  bytes(field: number, value: Uint8Array): ProtoWriter {
    this.tag(field, 2)
    this.varint(value.length)
    for (let i = 0; i < value.length; i++) this.buffer.push(value[i])
    return this
  }

  message(field: number, builder: ProtoWriter): ProtoWriter {
    return this.bytes(field, builder.finish())
  }

  finish(): Uint8Array {
    return new Uint8Array(this.buffer)
  }
}

function readProtoVarint(bytes: Uint8Array, offset: number): [number, number] {
  let result: number = 0
  let shift: number = 0
  let cursor: number = offset
  while (cursor < bytes.length) {
    const byte: number = bytes[cursor]
    result += (byte & 0x7f) * Math.pow(2, shift)
    cursor++
    if ((byte & 0x80) === 0) return [result, cursor]
    shift += 7
    if (shift > 49) break
  }
  return [0, offset]
}

/** 解出 protobuf 欄位（僅保留 last-write / repeated）。 */
export function decodeProto(bytes: Uint8Array): Map<number, ProtoField[]> {
  const fields: Map<number, ProtoField[]> = new Map()
  let offset: number = 0
  while (offset < bytes.length) {
    const tagResult: [number, number] = readProtoVarint(bytes, offset)
    const tag: number = tagResult[0]
    if (tagResult[1] === offset) break
    offset = tagResult[1]
    if (tag === 0) break
    const field: number = tag >>> 3
    const wire: number = tag & 7
    let value: ProtoValue = 0

    if (wire === 0) {
      const varintResult: [number, number] = readProtoVarint(bytes, offset)
      value = varintResult[0]
      offset = varintResult[1]
    } else if (wire === 2) {
      const lengthResult: [number, number] = readProtoVarint(bytes, offset)
      const length: number = lengthResult[0]
      offset = lengthResult[1]
      const end: number = Math.min(offset + length, bytes.length)
      value = bytes.subarray(offset, end)
      offset = end
    } else if (wire === 1) {
      offset += 8
      continue
    } else if (wire === 5) {
      if (offset + 4 <= bytes.length) {
        const view: DataView = new DataView(bytes.buffer, bytes.byteOffset + offset, 4)
        value = view.getFloat32(0, true)
      }
      offset += 4
    } else {
      break
    }

    const list: ProtoField[] = fields.get(field) ?? []
    list.push({ field, wire, value })
    fields.set(field, list)
  }
  return fields
}

function protoNumber(fields: Map<number, ProtoField[]>, field: number): number | undefined {
  const entry: ProtoField | undefined = fields.get(field)?.[0]
  if (!entry) return undefined
  return typeof entry.value === "number" ? entry.value : undefined
}

function protoBytes(fields: Map<number, ProtoField[]>, field: number): Uint8Array | undefined {
  const entry: ProtoField | undefined = fields.get(field)?.[0]
  if (!entry || typeof entry.value === "number") return undefined
  return entry.value
}

/** Repeated int32 values, packed or not. */
function protoInts(fields: Map<number, ProtoField[]>, field: number): number[] {
  const out: number[] = []
  for (const entry of fields.get(field) ?? []) {
    if (typeof entry.value === "number") {
      out.push(entry.value)
      continue
    }
    let offset: number = 0
    while (offset < entry.value.length) {
      const [value, next] = readProtoVarint(entry.value, offset)
      if (next === offset) break
      out.push(value)
      offset = next
    }
  }
  return out
}

function protoString(fields: Map<number, ProtoField[]>, field: number): string | undefined {
  const value: Uint8Array | undefined = protoBytes(fields, field)
  return value ? new TextDecoder().decode(value) : undefined
}

/* ------------------------------------------------------------------ *
 * 媒體標頭 / 政策
 * ------------------------------------------------------------------ */

export interface SabrMediaHeader {
  headerId: number
  itag?: number
  segmentNum?: number
  isInitializationSegment?: boolean
  startMs?: number
  durationMs?: number
  byteRangeStart?: number
}

export function decodeMediaHeader(bytes: Uint8Array): SabrMediaHeader {
  const fields: Map<number, ProtoField[]> = decodeProto(bytes)
  const header: SabrMediaHeader = { headerId: protoNumber(fields, 1) ?? 0 }
  const itag: number | undefined = protoNumber(fields, 3)
  if (itag !== undefined) header.itag = itag
  const segmentNum: number | undefined = protoNumber(fields, 9)
  if (segmentNum !== undefined) header.segmentNum = segmentNum
  const isInit: number | undefined = protoNumber(fields, 8)
  if (isInit !== undefined) header.isInitializationSegment = isInit === 1
  const startMs: number | undefined = protoNumber(fields, 11)
  if (startMs !== undefined) header.startMs = startMs
  const durationMs: number | undefined = protoNumber(fields, 12)
  if (durationMs !== undefined) header.durationMs = durationMs
  const byteRangeStart: number | undefined = protoNumber(fields, 6)
  if (byteRangeStart !== undefined) header.byteRangeStart = byteRangeStart
  return header
}

/**
 * UMP part 42 (`FormatInitializationMetadata`): which encode of the itag the server is actually
 * sending (`lastModified`) and where its init and index boxes sit. The same itag can exist in two
 * encodes, so this, not the player response, describes the file the segments come from.
 */
export interface SabrFormatInitMetadata {
  itag: number
  lastModified: string
  endSegmentNumber?: number
  indexRange?: SabrByteRange
}

function decodeRange(bytes: Uint8Array | undefined): SabrByteRange | undefined {
  if (!bytes) return undefined
  const fields: Map<number, ProtoField[]> = decodeProto(bytes)
  const start: number | undefined = protoNumber(fields, 1)
  const end: number | undefined = protoNumber(fields, 2)
  return start !== undefined && end !== undefined ? { start, end } : undefined
}

export function decodeFormatInitMetadata(bytes: Uint8Array): SabrFormatInitMetadata | null {
  const fields: Map<number, ProtoField[]> = decodeProto(bytes)
  const formatId: Uint8Array | undefined = protoBytes(fields, 2)
  if (!formatId) return null
  const idFields: Map<number, ProtoField[]> = decodeProto(formatId)
  const itag: number | undefined = protoNumber(idFields, 1)
  if (itag === undefined) return null
  const metadata: SabrFormatInitMetadata = { itag, lastModified: String(protoNumber(idFields, 2) ?? 0) }
  const endSegmentNumber: number | undefined = protoNumber(fields, 4)
  if (endSegmentNumber !== undefined) metadata.endSegmentNumber = endSegmentNumber
  const indexRange: SabrByteRange | undefined = decodeRange(protoBytes(fields, 7))
  if (indexRange) metadata.indexRange = indexRange
  return metadata
}

export interface SabrNextRequestPolicy {
  playbackCookie?: Uint8Array
  targetVideoReadaheadMs?: number
  targetAudioReadaheadMs?: number
  backoffTimeMs?: number
}

export function decodeNextRequestPolicy(bytes: Uint8Array): SabrNextRequestPolicy {
  const fields: Map<number, ProtoField[]> = decodeProto(bytes)
  const policy: SabrNextRequestPolicy = {}
  const cookie: Uint8Array | undefined = protoBytes(fields, 7)
  if (cookie) policy.playbackCookie = cookie
  const video: number | undefined = protoNumber(fields, 2)
  if (video !== undefined) policy.targetVideoReadaheadMs = video
  const audio: number | undefined = protoNumber(fields, 1)
  if (audio !== undefined) policy.targetAudioReadaheadMs = audio
  const backoff: number | undefined = protoNumber(fields, 4)
  if (backoff !== undefined) policy.backoffTimeMs = backoff
  return policy
}

export function decodeSabrError(bytes: Uint8Array): string {
  const fields: Map<number, ProtoField[]> = decodeProto(bytes)
  return protoString(fields, 2) ?? protoString(fields, 1) ?? "SABR error"
}

export function decodeSabrRedirect(bytes: Uint8Array): string | undefined {
  const fields: Map<number, ProtoField[]> = decodeProto(bytes)
  return protoString(fields, 1)
}

/* ------------------------------------------------------------------ *
 * 直連 Range + sidx
 * ------------------------------------------------------------------ */

interface SidxEntry {
  offset: number
  size: number
  durationUs: number
}

interface SidxIndex {
  timescale: number
  entries: SidxEntry[]
}

/** 解析 ISO BMFF `sidx` box（indexRange 開頭的位元組）。 */
export function parseSidx(bytes: Uint8Array, baseOffset: number): SidxIndex | null {
  if (bytes.length < 16) return null
  const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let cursor: number = 0
  let sidxStart: number = -1
  while (cursor + 8 <= bytes.length) {
    const size: number = view.getUint32(cursor)
    const type: string = String.fromCharCode(
      bytes[cursor + 4],
      bytes[cursor + 5],
      bytes[cursor + 6],
      bytes[cursor + 7],
    )
    if (type === "sidx") {
      sidxStart = cursor
      break
    }
    if (size <= 0) break
    cursor += size
  }
  if (sidxStart < 0) return null

  let offset: number = sidxStart + 8
  const version: number = bytes[offset]
  offset += 4 // version + flags
  offset += 4 // reference_ID
  const timescale: number = view.getUint32(offset)
  offset += 4
  if (version === 0) {
    offset += 8 // earliest_presentation_time + first_offset
  } else {
    offset += 16
  }
  offset += 2 // reserved
  const referenceCount: number = view.getUint16(offset)
  offset += 2

  const boxSize: number = view.getUint32(sidxStart)
  const firstOffset: number = version === 0 ? view.getUint32(sidxStart + 8 + 4 + 4 + 4 + 4) : 0
  let mediaOffset: number = baseOffset + sidxStart + boxSize + firstOffset

  const entries: SidxEntry[] = []
  for (let i = 0; i < referenceCount; i++) {
    if (offset + 12 > bytes.length) break
    const reference: number = view.getUint32(offset)
    const duration: number = view.getUint32(offset + 4)
    offset += 12
    const referenceType: number = reference >>> 31
    const size: number = reference & 0x7fffffff
    if (referenceType === 0) {
      entries.push({ offset: mediaOffset, size, durationUs: Math.round((duration / timescale) * 1_000_000) })
      mediaOffset += size
    }
  }
  return { timescale, entries }
}

/* ------------------------------------------------------------------ *
 * Session 設定
 * ------------------------------------------------------------------ */

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
  /**
   * Direct URLs (e.g. from the IOS player) used only to read init and index ranges, which sit at the
   * start of the file and stay reachable without a PO token. SABR segments match the sidx entries.
   */
  indexUrls?: Record<number, string>
  /** The video/audio pair this session plays; SABR responses carry both tracks. */
  /** Session nonce; also sent in the player request so the SABR URL and the player agree. */
  cpn?: string
  pairedItags?: { video: number; audio: number }
  /** Replacement token when the server answers "attestation required" (stream protection 3) without media. */
  refreshPoToken?: (staleToken: string) => Promise<string>
}

/** Accepts URL-safe base64 without padding, which is how ustreamer configs and PO tokens arrive. */function base64ToBytes(value: string): Uint8Array | null {
  if (!value) return null
  let normalized: string = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\./g, "=")
  while (normalized.length % 4 !== 0) normalized += "="
  const data: Data | null = Data.fromBase64String(normalized)
  return data ? data.toUint8Array() : null
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total: number = 0
  for (const chunk of chunks) total += chunk.length
  const out: Uint8Array = new Uint8Array(total)
  let offset: number = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** 16-char client playback nonce (`cpn`), same alphabet the player uses. */
export function makeClientPlaybackNonce(): string {
  const alphabet: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
  let nonce: string = ""
  for (let i = 0; i < 16; i++) nonce += alphabet[Math.floor(Math.random() * alphabet.length)]
  return nonce
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
  /** Client playback nonce, sent as `cpn` the way the official player does. */
  private readonly cpn: string
  /** Last `StreamProtectionStatus.status`: 1 = ok, 2 = attestation pending, 3 = attestation required. */
  lastProtectionStatus?: number
  /** UMP part ids and segment keys of the most recent response, for diagnostics. */
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

  /**
   * Load the segment index before a playlist is built so its count and durations match the media
   * (same as upstream ingesting initialization data). Without it the 5 s grid points seeks at the wrong segments.
   */
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

  /**
   * The segment index of the file the server actually sends. Like the official player, take it from
   * the server's own init response (`ftyp`/`moov`/`sidx`); a direct URL from another client only
   * counts when part 42 says it is the same encode.
   */
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

  /** `NextRequestPolicy` readahead the server asked for, reported back as `rbuf`. */
  private readaheadMs: number = 0
  private endpoint(): string {
    const separator: string = this.streamingUrl.includes("?") ? "&" : "?"
    // Query params the official player puts on the SABR URL (mweb player: rn/rbuf/ump/srfvp/alr/pot).
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
    // Field numbers follow googlevideo's StreamerContext.ClientInfo.
    const result: ProtoWriter = new ProtoWriter()
    result.string(1, String(client["hl"] ?? "en"))
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

  /**
   * Same adaptation set as the target: container and codec family (the server otherwise switches
   * e.g. avc1 to av01, or mp4a to opus), plus the audio track for audio.
   */
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
    // enabledTrackTypesBitfield: 0 = audio and video, 1 = audio only, 2 = video only.
    abrState.uint32(40, video && audio ? 0 : format.isAudio ? 1 : 2)
    // Playback capabilities the server weighs in its ABR decisions.
    abrState.uint32(22, 0).uint32(46, 0).int64(68, 0)
    const target: SabrFormat | undefined = format.isAudio ? audio : video
    if (target?.bitrate) abrState.int64(23, target.bitrate)
    if (target?.isVideo && target.height) abrState.uint32(21, target.height).uint32(16, target.height)
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

    // VideoPlaybackAbrRequest as the mweb player serializes it (`Lja`).
    const request: ProtoWriter = new ProtoWriter().message(1, this.abrStateMessage(format, playerTimeMs))
    // Formats the client already has init for; the server sends init for the rest.
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
    return headers
  }

  /** 發送一次 ABR 請求，回傳本次收到的切片。 */
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
          this.segmentCache.set(`${itag}:${header.segmentNum}`, media)
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

  /**
   * Repeats the request while the server answers with new SABR contexts or a backoff instead of media,
   * as the player does. The first request of a session typically waits out a ~5 s backoff.
   */
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

  /** Swaps in a fresh PO token once per session. */
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

  /** 初始化切片。 */
  async fetchInitialization(itag: number): Promise<Uint8Array | null> {
    const cached: Uint8Array | undefined = this.initCache.get(itag)
    if (cached) return cached
    const format: SabrFormat | undefined = this.formatsByItag.get(itag)
    if (!format) return null
    const indexUrl: string | undefined = this.indexUrlFor(format)
    // With SABR the init must come from the server too: a direct URL may point at the other encode.
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

  /** 第 sequence 個媒體切片（1 起算）。 */
  async fetchSegment(itag: number, sequence: number): Promise<Uint8Array | null> {
    const key: string = `${itag}:${sequence}`
    const cached: Uint8Array | undefined = this.segmentCache.get(key)
    if (cached) return cached

    const format: SabrFormat | undefined = this.formatsByItag.get(itag)
    if (!format) return null

    if (!this.config.serverAbrStreamingUrl && format.url) {
      const direct: Uint8Array | null = await this.fetchDirectSegment(format, sequence)
      if (direct) this.segmentCache.set(key, direct)
      return direct
    }

    await this.requestWithContext(format, sequence, key)
    return this.segmentCache.get(key) ?? null
  }

  /** `indexUrls` win: a SABR client's own `url` still needs `n` decoding and a PO token. */
  private indexUrlFor(format: SabrFormat): string | undefined {
    return this.config.indexUrls?.[format.itag] ?? format.url
  }

  // 只快取成功的結果，失敗的下次還能再讀。
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
  return new Uint8Array(buffer)
}

/* ------------------------------------------------------------------ *
 * Manifest 產生器（對齊 SabrHlsManifestBuilder / SabrDashManifestBuilder）
 * ------------------------------------------------------------------ */

function codecOf(mimeType: string): string {
  const index: number = mimeType.indexOf("codecs=")
  if (index < 0) return ""
  return mimeType
    .slice(index + 7)
    .replace(/["']/g, "")
    .trim()
}

function containerOf(mimeType: string): string {
  return mimeType.split(";")[0].trim()
}

function targetDuration(session: SabrSession, itag: number): number {
  const count: number = session.segmentCount(itag)
  let maxMs: number = 0
  for (let seq = 1; seq <= count; seq++) {
    maxMs = Math.max(maxMs, session.segmentTiming(itag, seq).durationMs)
  }
  return Math.max(1, Math.ceil(maxMs / 1000))
}

export interface SabrManifestBuilderInput {
  sessionId: string
  session: SabrSession
  video: SabrFormat
  audio: SabrFormat
}

export function buildHlsMasterPlaylist(input: SabrManifestBuilderInput): string {
  const { sessionId, video, audio } = input
  const bandwidth: number = Math.max(1, video.bitrate + audio.bitrate)
  const videoCodec: string = codecOf(video.mimeType)
  const audioCodec: string = codecOf(audio.mimeType)
  const codecs: string = [videoCodec, audioCodec].filter((codec: string): boolean => codec.length > 0).join(",")
  const resolution: string = video.width && video.height ? `RESOLUTION=${video.width}x${video.height},` : ""
  const frameRate: string = video.fps ? `FRAME-RATE=${video.fps},` : ""

  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="/hls-media/${sessionId}/${audio.itag}/playlist.m3u8"`,
    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},${resolution}${frameRate}${codecs ? `CODECS="${codecs}",` : ""}AUDIO="audio"`,
    `/hls-media/${sessionId}/${video.itag}/playlist.m3u8`,
    "",
  ].join("\n")
}

export function buildMediaPlaylist(input: SabrManifestBuilderInput, itag: number): string {
  const { sessionId, session } = input
  const count: number = session.segmentCount(itag)
  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${targetDuration(session, itag)}`,
    "#EXT-X-MEDIA-SEQUENCE:1",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-MAP:URI="/sabr-init/${sessionId}/${itag}/init.mp4"`,
  ]
  for (let seq = 1; seq <= count; seq++) {
    const timing: { startMs: number; durationMs: number } = session.segmentTiming(itag, seq)
    const seconds: string = (timing.durationMs / 1000).toFixed(3)
    lines.push(`#EXTINF:${seconds},`, `/sabr-seg/${sessionId}/${itag}/${seq}/seg.mp4`)
  }
  lines.push("#EXT-X-ENDLIST", "")
  return lines.join("\n")
}

function appendDashRepresentation(
  lines: string[],
  sessionId: string,
  session: SabrSession,
  format: SabrFormat,
  representationId: string,
  includeSize: boolean,
): void {
  const container: string = containerOf(format.mimeType)
  const codecs: string = codecOf(format.mimeType)
  const bandwidth: number = Math.max(1, format.bitrate)
  const sizeAttributes: string =
    includeSize && format.width && format.height
      ? ` width="${format.width}" height="${format.height}"`
      : ""
  lines.push(
    `      <Representation id="${representationId}" bandwidth="${bandwidth}"${sizeAttributes}${
      codecs ? ` codecs="${codecs}"` : ""
    }>`,
    `        <SegmentList timescale="1000">`,
    `          <Initialization sourceURL="/sabr-init/${sessionId}/${format.itag}/init.mp4"/>`,
    "          <SegmentTimeline>",
  )
  let start: number = 0
  const count: number = session.segmentCount(format.itag)
  for (let seq = 1; seq <= count; seq++) {
    const timing: { startMs: number; durationMs: number } = session.segmentTiming(format.itag, seq)
    lines.push(`            <S t="${start}" d="${Math.max(1, timing.durationMs)}"/>`)
    start += Math.max(1, timing.durationMs)
  }
  lines.push("          </SegmentTimeline>")
  for (let seq = 1; seq <= count; seq++) {
    lines.push(`          <SegmentURL media="/sabr-seg/${sessionId}/${format.itag}/${seq}/seg.mp4"/>`)
  }
  lines.push("        </SegmentList>", "      </Representation>")
  void container
}

export function buildDashManifest(input: SabrManifestBuilderInput): string {
  const { sessionId, session, video, audio } = input
  const durationSec: number = Math.max(1, Math.ceil((session.durationMs(video.itag) || 0) / 1000))
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"',
    '     profiles="urn:mpeg:dash:profile:full:2011"',
    '     type="static"',
    `     mediaPresentationDuration="PT${durationSec}S"`,
    '     minBufferTime="PT2S">',
    "  <Period>",
    `    <AdaptationSet mimeType="${containerOf(video.mimeType)}" startWithSAP="1">`,
  ]
  appendDashRepresentation(lines, sessionId, session, video, "v", true)
  lines.push("    </AdaptationSet>", `    <AdaptationSet mimeType="${containerOf(audio.mimeType)}">`)
  appendDashRepresentation(lines, sessionId, session, audio, "a", false)
  lines.push("    </AdaptationSet>", "  </Period>", "</MPD>", "")
  return lines.join("\n")
}

/* ------------------------------------------------------------------ *
 * 對外：建立 SABR 畫質 session
 * ------------------------------------------------------------------ */

export interface SabrQualitySession {
  session: SabrSession
  urls: SabrProxyUrls
  video: SabrFormat
  audio: SabrFormat
  quality: VideoQualityTrack
  /** 影片與音訊都讀到真正的分段時間軸時為 true；false 時不該拿來播。 */
  prepare: () => Promise<boolean>
}

export function qualityLabelOf(format: SabrFormat): string {
  if (format.qualityLabel) {
    return format.fps && format.fps >= 50 && !format.qualityLabel.includes("60")
      ? `${format.qualityLabel}60`
      : format.qualityLabel
  }
  const height: number = format.height ?? 0
  if (height >= 2160) return "4K"
  if (height >= 1440) return "2K"
  return height > 0 ? `${height}p` : `${format.itag}`
}

export function audioTrackOf(format: SabrFormat): AudioStreamTrack {
  const track: AudioStreamTrack = {
    id: `sabr-audio-${format.itag}`,
    label: format.audioTrackName ?? format.audioQuality ?? `${Math.round(format.bitrate / 1000)}kbps`,
    bitrate: format.bitrate,
    codec: codecOf(format.mimeType),
    mimeType: format.mimeType,
    url: "",
    itag: format.itag,
  }
  if (format.initRange) track.initRange = `${format.initRange.start}-${format.initRange.end}`
  if (format.indexRange) track.indexRange = `${format.indexRange.start}-${format.indexRange.end}`
  return track
}

/**
 * 為單一視訊畫質建立本機 SABR 代理 session。
 * 每個畫質各自一個 session id，切畫質時直接換 Master URL。
 */
export function createSabrQualitySession(
  config: SabrSessionConfig,
  video: SabrFormat,
  audio: SabrFormat,
): SabrQualitySession {
  const session: SabrSession = new SabrSession({ ...config, pairedItags: { video: video.itag, audio: audio.itag } })
  const sessionId: string = `sabr-${config.videoId}-${video.itag}-${audio.itag}`
  const input: SabrManifestBuilderInput = { sessionId, session, video, audio }

  // 每個 itag 一個預抓器；session 有狀態（context、backoff、token），所以一次只抓一段。
  const prefetchers: Map<number, Prefetcher> = new Map()
  const prefetcherFor = (itag: number): Prefetcher => {
    let prefetcher: Prefetcher | undefined = prefetchers.get(itag)
    if (!prefetcher) {
      prefetcher = new Prefetcher(
        {
          // 序號從 1 開始，就拿序號當塊號。
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
    initializationSegment: (itag: number): Promise<Uint8Array | null> => session.fetchInitialization(itag),
    mediaSegment: (itag: number, sequence: number): Promise<Uint8Array | null> => prefetcherFor(itag).get(sequence),
    contentType: (itag: number): string => {
      const format: SabrFormat | undefined = session.formatByItag(itag)
      return format ? containerOf(format.mimeType) : "video/mp4"
    },
  }

  const urls: SabrProxyUrls = registerSabrSessionHandler(sessionId, handler)

  const quality: VideoQualityTrack = {
    id: `sabr-${video.itag}`,
    label: qualityLabelOf(video),
    width: video.width ?? 0,
    height: video.height ?? 0,
    delivery: "sabr",
    url: urls.hlsUrl,
    itag: video.itag,
  }
  if (video.fps) quality.fps = video.fps
  if (video.bitrate) quality.bitrate = video.bitrate
  if (codecOf(video.mimeType)) quality.codec = codecOf(video.mimeType)

  const prepare = async (): Promise<boolean> => {
    const [videoReady, audioReady] = await Promise.all([
      session.prepareTimeline(video.itag),
      session.prepareTimeline(audio.itag),
    ])
    return videoReady && audioReady
  }

  return { session, urls, video, audio, quality, prepare }
}
