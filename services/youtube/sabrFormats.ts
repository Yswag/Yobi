import type { AudioStreamTrack, VideoQualityTrack } from "../../types"
import { effectiveResolution } from "../../utils/format"
import type { JsonObject } from "./innertube"
import type { SabrByteRange } from "./sabrProto"

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

export interface SabrTimelineSource {
  durationMs(itag: number): number
  segmentCount(itag: number): number
  segmentTiming(itag: number, sequence: number): { startMs: number; durationMs: number }
}

export interface SabrManifestBuilderInput {
  sessionId: string
  session: SabrTimelineSource
  video: SabrFormat
  audio: SabrFormat
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

export function codecOf(mimeType: string): string {
  const index: number = mimeType.indexOf("codecs=")
  if (index < 0) return ""
  return mimeType
    .slice(index + 7)
    .replace(/["']/g, "")
    .trim()
}

export function containerOf(mimeType: string): string {
  return mimeType.split(";")[0].trim()
}

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

export function resolutionOf(format: Pick<SabrFormat, "width" | "height" | "qualityLabel">): number {
  const labeled: RegExpMatchArray | null = format.qualityLabel?.match(/(\d{3,4})p/i) ?? null
  if (labeled) return Number(labeled[1])
  return effectiveResolution(format.width, format.height)
}

function videoCodecScore(format: SabrFormat): number {
  const codec: string = codecOf(format.mimeType).toLowerCase()
  if (resolutionOf(format) >= 2160) {
    if (codec.startsWith("av01")) return 3
    return codec.startsWith("hvc") || codec.startsWith("hev") ? 2 : 0
  }
  return codec.startsWith("av01") ? 1 : 3
}

export function qualityLabelOf(format: SabrFormat): string {
  if (format.qualityLabel) {
    return format.fps && format.fps >= 50 && !format.qualityLabel.includes("60")
      ? `${format.qualityLabel}60`
      : format.qualityLabel
  }
  const resolution: number = effectiveResolution(format.width, format.height)
  if (resolution >= 2160) return "4K"
  if (resolution >= 1440) return "2K"
  return resolution > 0 ? `${resolution}p` : `${format.itag}`
}

export function pickVideoFormats(formats: SabrFormat[], includeAv1: boolean = true): SabrFormat[] {
  const videos: SabrFormat[] = formats.filter((format: SabrFormat): boolean => {
    if (!format.isVideo || !format.mimeType.startsWith("video/mp4")) return false
    if (!includeAv1 && format.mimeType.includes("av01")) return false
    return true
  })
  const byLabel: Map<string, SabrFormat> = new Map()
  for (const format of videos) {
    const label: string = qualityLabelOf(format)
    const current: SabrFormat | undefined = byLabel.get(label)
    if (
      !current ||
      videoCodecScore(format) > videoCodecScore(current) ||
      (videoCodecScore(format) === videoCodecScore(current) && format.bitrate > current.bitrate)
    ) {
      byLabel.set(label, format)
    }
  }
  return Array.from(byLabel.values()).sort(
    (a: SabrFormat, b: SabrFormat): number => resolutionOf(b) - resolutionOf(a) || (b.fps ?? 0) - (a.fps ?? 0),
  )
}

export function sabrQualityTrackOf(video: SabrFormat, url: string = ""): VideoQualityTrack {
  const quality: VideoQualityTrack = {
    id: `sabr-${video.itag}`,
    label: qualityLabelOf(video),
    width: video.width ?? 0,
    height: video.height ?? 0,
    delivery: "sabr",
    url,
    itag: video.itag,
  }
  if (video.fps) quality.fps = video.fps
  if (video.bitrate) quality.bitrate = video.bitrate
  if (codecOf(video.mimeType)) quality.codec = codecOf(video.mimeType)
  return quality
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

function targetDuration(session: SabrTimelineSource, itag: number): number {
  const count: number = session.segmentCount(itag)
  let maxMs: number = 0
  for (let seq = 1; seq <= count; seq++) {
    maxMs = Math.max(maxMs, session.segmentTiming(itag, seq).durationMs)
  }
  return Math.max(1, Math.ceil(maxMs / 1000))
}

export function stripSidxBoxes(bytes: Uint8Array | null): Uint8Array | null {
  if (!bytes) return bytes
  const readSize = (offset: number): number =>
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  const parts: Uint8Array[] = []
  let offset: number = 0
  let stripped: boolean = false
  while (offset + 8 <= bytes.length) {
    let size: number = readSize(offset)
    const type: string = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    if (size === 1) size = readSize(offset + 8)
    if (size < 8) break
    if (type === "sidx") stripped = true
    else parts.push(bytes.subarray(offset, offset + size))
    offset += size
  }
  if (!stripped) return bytes
  const out: Uint8Array = new Uint8Array(parts.reduce((sum: number, part: Uint8Array): number => sum + part.length, 0))
  let cursor: number = 0
  for (const part of parts) {
    out.set(part, cursor)
    cursor += part.length
  }
  return out
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
  session: SabrTimelineSource,
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
