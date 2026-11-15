import { Path } from "scripting"
import { registerVirtualManifest } from "../localProxy"

/**
 * Minimal shape of the `dash` object returned by
 * `https://api.bilibili.com/x/player/wbi/playurl?fnval=4048`.
 */
export interface BiliDashSegmentBase {
  indexRange?: string
  index_range?: string
  Initialization?: { range?: string }
  initialization?: { range?: string } | string
  initRange?: string
  init_range?: string
}

export interface BiliDashMedia {
  id: number
  baseUrl?: string
  base_url?: string
  backupUrl?: string[]
  backup_url?: string[]
  bandwidth: number
  mimeType?: string
  mime_type?: string
  codecs?: string
  codecid?: number
  width?: number
  height?: number
  frameRate?: string | number
  frame_rate?: string | number
  sar?: string
  startWithSap?: number
  start_with_sap?: number
  audioSamplingRate?: string | number
  SegmentBase?: BiliDashSegmentBase
  segment_base?: BiliDashSegmentBase
}

export interface BiliDashPayload {
  duration: number
  minBufferTime?: number
  min_buffer_time?: number
  video: BiliDashMedia[]
  audio?: BiliDashMedia[] | null
  dolby?: { type?: number; audio?: BiliDashMedia[] | null } | null
  flac?: { display?: boolean; audio?: BiliDashMedia | null } | null
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function durationToIso(seconds: number): string {
  const total = Math.max(0, Math.round(seconds || 0))
  return `PT${total}S`
}

function mediaUrl(media: BiliDashMedia): string {
  const direct = media.baseUrl || media.base_url
  if (direct) return direct
  const backups = media.backupUrl || media.backup_url
  if (backups && backups.length) return backups[0]
  return ""
}

function segmentBase(media: BiliDashMedia): BiliDashSegmentBase | undefined {
  return media.SegmentBase || media.segment_base
}

function indexRangeOf(media: BiliDashMedia): string | undefined {
  const base = segmentBase(media)
  if (!base) return undefined
  return base.indexRange || base.index_range
}

function initRangeOf(media: BiliDashMedia): string | undefined {
  const base = segmentBase(media)
  if (!base) return undefined
  const initialization = base.Initialization
  if (initialization && typeof initialization === "object" && initialization.range) {
    return initialization.range
  }
  if (typeof base.initialization === "string") return base.initialization
  if (base.initialization && typeof base.initialization === "object" && base.initialization.range) {
    return base.initialization.range
  }
  return base.initRange || base.init_range
}

function frameRateOf(media: BiliDashMedia): string | undefined {
  const raw = media.frameRate ?? media.frame_rate
  if (raw === undefined || raw === null || raw === "") return undefined
  if (typeof raw === "number") return String(raw)
  return raw.replace(/[^0-9/.]/g, "") || undefined
}

function mimeTypeOf(media: BiliDashMedia, fallback: string): string {
  return media.mimeType || media.mime_type || fallback
}

function representationXml(media: BiliDashMedia, mimeType: string, index: number): string {
  const url = mediaUrl(media)
  const attributes: string[] = [
    `id="${escapeXml(`${media.id}-${index}`)}"`,
    `bandwidth="${Math.max(1, Math.round(Number(media.bandwidth) || 1))}"`,
  ]
  if (media.codecs) attributes.push(`codecs="${escapeXml(media.codecs)}"`)
  if (mimeType.startsWith("video")) {
    if (media.width) attributes.push(`width="${Math.round(media.width)}"`)
    if (media.height) attributes.push(`height="${Math.round(media.height)}"`)
    const frameRate = frameRateOf(media)
    if (frameRate) attributes.push(`frameRate="${escapeXml(frameRate)}"`)
    if (media.sar) attributes.push(`sar="${escapeXml(media.sar)}"`)
  } else if (media.audioSamplingRate) {
    attributes.push(`audioSamplingRate="${escapeXml(String(media.audioSamplingRate))}"`)
  }

  const lines: string[] = [`      <Representation ${attributes.join(" ")}>`]
  if (url) lines.push(`        <BaseURL>${escapeXml(url)}</BaseURL>`)

  const indexRange = indexRangeOf(media)
  const initRange = initRangeOf(media)
  if (indexRange || initRange) {
    if (indexRange) {
      lines.push(`        <SegmentBase indexRange="${escapeXml(indexRange)}">`)
    } else {
      lines.push(`        <SegmentBase>`)
    }
    if (initRange) {
      lines.push(`          <Initialization range="${escapeXml(initRange)}"/>`)
    }
    lines.push(`        </SegmentBase>`)
  }

  lines.push(`      </Representation>`)
  return lines.join("\n")
}

function adaptationSetXml(
  mimeType: string,
  medias: BiliDashMedia[],
  contentType: "video" | "audio",
): string {
  const attributes = [
    `mimeType="${escapeXml(mimeType)}"`,
    `contentType="${contentType}"`,
    `segmentAlignment="true"`,
  ]
  if (contentType === "video") {
    attributes.push(`startWithSAP="1"`, `subsegmentAlignment="true"`, `subsegmentStartsWithSAP="1"`)
  }
  const lines: string[] = [`    <AdaptationSet ${attributes.join(" ")}>`]
  medias.forEach((media, index) => {
    lines.push(representationXml(media, mimeType, index))
  })
  lines.push(`    </AdaptationSet>`)
  return lines.join("\n")
}

function collectAudios(dash: BiliDashPayload): BiliDashMedia[] {
  const audios: BiliDashMedia[] = []
  const seen = new Set<string>()
  const push = (media: BiliDashMedia | null | undefined) => {
    if (!media || !mediaUrl(media)) return
    const key = `${media.id}:${media.bandwidth}`
    if (seen.has(key)) return
    seen.add(key)
    audios.push(media)
  }

  for (const media of dash.audio ?? []) push(media)
  for (const media of dash.dolby?.audio ?? []) push(media)
  push(dash.flac?.audio ?? null)
  return audios
}

/**
 * Converts Bilibili's `dash` payload into a standards-compliant MPEG-DASH
 * manifest. When `selectedVideoId` (a Bilibili `qn`) is given, only that
 * quality is included — otherwise every available quality is emitted.
 */
export function buildBiliDashMpdXml(dash: BiliDashPayload, selectedVideoId?: number): string {
  const allVideos = (dash.video ?? []).filter(media => !!mediaUrl(media))
  const videos =
    selectedVideoId === undefined
      ? allVideos
      : allVideos.filter(media => Number(media.id) === Number(selectedVideoId))
  const audios = collectAudios(dash)

  const duration = dash.duration || 0
  const minBufferTime = dash.minBufferTime ?? dash.min_buffer_time ?? 1.5

  const lines: string[] = [
    XML_HEADER,
    `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="${durationToIso(duration)}" minBufferTime="PT${minBufferTime}S">`,
    `  <Period duration="${durationToIso(duration)}">`,
  ]

  if (videos.length) {
    lines.push(adaptationSetXml("video/mp4", videos, "video"))
  }
  if (audios.length) {
    lines.push(adaptationSetXml("audio/mp4", audios, "audio"))
  }

  lines.push(`  </Period>`)
  lines.push(`</MPD>`)
  return lines.join("\n")
}

/**
 * Serves the manifest via in-memory `localProxy` (`http://127.0.0.1:<port>/manifest/.../stream.mpd`)
 * first so no filesystem permission is required; falls back to `FileManager.temporaryDirectory`
 * if the local HTTP server cannot be started.
 */
export function writeBiliDashMpdFile(
  bvid: string,
  cid: number,
  dash: BiliDashPayload,
  selectedVideoId?: number,
): string {
  const qn = selectedVideoId ?? 0
  const safeBvid = (bvid || "unknown").replace(/[^A-Za-z0-9_-]/g, "")
  const xml = buildBiliDashMpdXml(dash, selectedVideoId)
  try {
    return registerVirtualManifest(
      `bili_${safeBvid}_${cid}_${qn}`,
      xml,
      "application/dash+xml",
    )
  } catch {
    const filePath = Path.join(
      FileManager.temporaryDirectory,
      `yobi_bili_${safeBvid}_${cid}_${qn}.mpd`,
    )
    FileManager.writeAsStringSync(filePath, xml)
    return filePath
  }
}
