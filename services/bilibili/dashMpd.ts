import { Path, fetch } from "scripting"
import { registerBiliFileSource, registerVirtualManifest } from "../localProxy"
import { parseSidx, type SidxIndex } from "../sidx"

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

type BaseUrlResolver = (media: BiliDashMedia, mimeType: string, index: number) => string

/** 每個子片段的位元組範圍與時長，取自 sidx。 */
export interface BiliSegmentIndex {
  initRange: string
  sidx: SidxIndex
}

type SegmentIndexLookup = (media: BiliDashMedia) => BiliSegmentIndex | undefined

const SIDX_TIMESCALE: number = 1_000_000
/** 片段長短差超過這個比例就不用 SegmentList：單一 duration 會讓 seek 跳錯位置。 */
const MAX_SEGMENT_SPREAD: number = 1.1

/** 去掉最後一段（通常較短）後的平均時長。 */
function segmentDurationOf(index: BiliSegmentIndex): number {
  const body = index.sidx.entries.slice(0, -1)
  return Math.round(body.reduce((sum, entry) => sum + entry.durationUs, 0) / body.length)
}

function hasUniformSegments(sidx: SidxIndex): boolean {
  const body: number[] = sidx.entries.slice(0, -1).map(entry => entry.durationUs)
  if (body.length < 1) return false
  return Math.max(...body) <= Math.min(...body) * MAX_SEGMENT_SPREAD
}

/** bilibili 不給 Initialization range，慣例是 0 到 indexRange 起點前一個位元組。 */
function implicitInitRange(indexRange: string | undefined): string | undefined {
  if (!indexRange) return undefined
  const start: number = Number(indexRange.split("-")[0])
  if (!Number.isFinite(start) || start <= 0) return undefined
  return `0-${start - 1}`
}

function mediaUrl(media: BiliDashMedia): string {
  const direct = media.baseUrl || media.base_url
  if (direct) return direct
  const backups = media.backupUrl || media.backup_url
  if (backups && backups.length) return backups[0]
  return ""
}

/** baseUrl 加上 backupUrl，順序就是 bili 自己的優先序。 */
function mediaUrls(media: BiliDashMedia): string[] {
  const out: string[] = []
  const push = (value: string | undefined): void => {
    if (typeof value !== "string" || !value) return
    const normalized: string = value.startsWith("//") ? `https:${value}` : value.replace(/^http:/, "https:")
    if (!out.includes(normalized)) out.push(normalized)
  }
  push(media.baseUrl || media.base_url)
  for (const value of media.backupUrl || media.backup_url || []) push(value)
  return out
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

/**
 * 播放器對 SegmentBase 把整個檔當一段讀，seek 只能從檔頭線性讀到目標（4K 中段要讀上百 MB）。
 * 拆成 SegmentList 後每個子片段有明確範圍，seek 直接跳過去。
 * 播放器不認 SegmentList 裡的 SegmentTimeline（會從頭走並報 preroll 錯誤），只能給單一 duration；
 * bili 影片片段固定 5 秒、音訊 4.992／5.013 交替，取平均不會累積誤差。
 */
function segmentListXml(index: BiliSegmentIndex): string[] {
  const entries = index.sidx.entries
  const lines: string[] = [
    `        <SegmentList timescale="${SIDX_TIMESCALE}" duration="${segmentDurationOf(index)}">`,
    `          <Initialization range="${escapeXml(index.initRange)}"/>`,
  ]
  for (const entry of entries) {
    lines.push(`          <SegmentURL mediaRange="${entry.offset}-${entry.offset + entry.size - 1}"/>`)
  }
  lines.push(`        </SegmentList>`)
  return lines
}

function representationXml(
  media: BiliDashMedia,
  mimeType: string,
  index: number,
  urlFor: BaseUrlResolver,
  indexFor: SegmentIndexLookup,
): string {
  const url = urlFor(media, mimeType, index)
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

  const segmentIndex: BiliSegmentIndex | undefined = indexFor(media)
  const indexRange = indexRangeOf(media)
  const initRange = initRangeOf(media) ?? implicitInitRange(indexRange)
  if (segmentIndex) {
    lines.push(...segmentListXml(segmentIndex))
  } else if (indexRange || initRange) {
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
  urlFor: BaseUrlResolver,
  indexFor: SegmentIndexLookup,
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
    lines.push(representationXml(media, mimeType, index, urlFor, indexFor))
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
 * 播放器會把同一組 AdaptationSet 裡每個 Representation 都當一條軌去讀，
 * bilibili 同一個畫質固定給 AVC/HEVC/AV1 三份，4K 時等於三倍流量把頻寬喫滿。
 * 這裡只留一份：優先 AVC，再來 HEVC、AV1。
 */
function preferCodec(medias: BiliDashMedia[]): BiliDashMedia[] {
  if (medias.length <= 1) return medias
  const rank = (media: BiliDashMedia): number => {
    const codecs: string = (media.codecs ?? "").toLowerCase()
    if (codecs.startsWith("avc") || codecs.startsWith("h264")) return 3
    if (codecs.startsWith("hev") || codecs.startsWith("hvc")) return 2
    if (codecs.startsWith("av01") || codecs.startsWith("av1")) return 1
    return 0
  }
  const best: BiliDashMedia = medias
    .slice()
    .sort((a, b) => rank(b) - rank(a) || (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0]
  return [best]
}

/** 音訊也只留一條：優先原生 AAC（Dolby／FLAC 在 4K 只是多餘流量）。 */
function preferAudio(dash: BiliDashPayload): BiliDashMedia[] {
  const natives: BiliDashMedia[] = (dash.audio ?? []).filter(media => !!mediaUrl(media))
  const pool: BiliDashMedia[] = natives.length ? natives : collectAudios(dash)
  if (pool.length <= 1) return pool
  let best: BiliDashMedia = pool[0]
  for (const media of pool) {
    if ((Number(media.bandwidth) || 0) > (Number(best.bandwidth) || 0)) best = media
  }
  return [best]
}

/**
 * Converts Bilibili's `dash` payload into a standards-compliant MPEG-DASH
 * manifest. When `selectedVideoId` (a Bilibili `qn`) is given, only that
 * quality is included — otherwise the highest codec of every quality.
 */
function selectMedias(dash: BiliDashPayload, selectedVideoId?: number): { videos: BiliDashMedia[]; audios: BiliDashMedia[] } {
  const allVideos = (dash.video ?? []).filter(media => !!mediaUrl(media))
  const matching =
    selectedVideoId === undefined
      ? allVideos
      : allVideos.filter(media => Number(media.id) === Number(selectedVideoId))
  return { videos: preferCodec(matching), audios: preferAudio(dash) }
}

export function buildBiliDashMpdXml(
  dash: BiliDashPayload,
  selectedVideoId?: number,
  urlFor: BaseUrlResolver = mediaUrl,
  indexFor: SegmentIndexLookup = (): undefined => undefined,
): string {
  const { videos, audios } = selectMedias(dash, selectedVideoId)

  const duration = dash.duration || 0
  const minBufferTime = dash.minBufferTime ?? dash.min_buffer_time ?? 1.5

  const lines: string[] = [
    XML_HEADER,
    `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="${durationToIso(duration)}" minBufferTime="PT${minBufferTime}S">`,
    `  <Period duration="${durationToIso(duration)}">`,
  ]

  if (videos.length) {
    lines.push(adaptationSetXml("video/mp4", videos, "video", urlFor, indexFor))
  }
  if (audios.length) {
    lines.push(adaptationSetXml("audio/mp4", audios, "audio", urlFor, indexFor))
  }

  lines.push(`  </Period>`)
  lines.push(`</MPD>`)
  return lines.join("\n")
}

/** 舊的 MPD 沒人讀了就刪，避免 tmp 一直累積。 */
function pruneDashFiles(keep: string): void {
  try {
    const entries: string[] = FileManager.readDirectorySync(FileManager.temporaryDirectory)
    for (const name of entries) {
      if (!name.startsWith("yobi_bili_") || !name.endsWith(".mpd")) continue
      const path: string = Path.join(FileManager.temporaryDirectory, name)
      if (path === keep) continue
      try {
        FileManager.removeSync(path)
      } catch {
        // 刪不掉就不用管
      }
    }
  } catch {
    // 列目錄失敗就跳過清理
  }
}

/**
 * bilibili 的片段需要 `Referer`，但播放器對本機 manifest 的片段請求不會帶 header，
 * 因此 BaseURL 一律指向本機位元組代理；MPD 則交給 localProxy 供檔（回應必須帶
 * `Content-Length`，DASH 解析器才讀得懂）。
 */
/**
 * 透過本機代理讀 sidx：它在第一格裡，播放器開片本來就要抓，這裡只是先抓進預抓快取。
 * 讀不到就回 undefined，退回 SegmentBase。
 */
async function loadSegmentIndex(localUrl: string, media: BiliDashMedia): Promise<BiliSegmentIndex | undefined> {
  const indexRange: string | undefined = indexRangeOf(media)
  const initRange: string | undefined = initRangeOf(media) ?? implicitInitRange(indexRange)
  if (!indexRange || !initRange || !localUrl.startsWith("http://127.0.0.1")) return undefined
  const [start, end] = indexRange.split("-").map(Number)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  try {
    const response = await fetch(localUrl, { headers: { Range: `bytes=${start}-${end}` }, timeout: 15 })
    if (!response.ok) return undefined
    const sidx: SidxIndex | null = parseSidx(new Uint8Array(await response.arrayBuffer()), start)
    if (!sidx || sidx.entries.length < 2 || !hasUniformSegments(sidx)) return undefined
    return { initRange, sidx }
  } catch {
    return undefined
  }
}

export async function writeBiliDashMpdFile(
  bvid: string,
  cid: number,
  dash: BiliDashPayload,
  selectedVideoId?: number,
): Promise<string> {
  const qn: number = selectedVideoId ?? 0
  const safeBvid: string = (bvid || "unknown").replace(/[^A-Za-z0-9_-]/g, "")

  const localUrls: Map<BiliDashMedia, string> = new Map()
  const urlFor: BaseUrlResolver = (media: BiliDashMedia, mimeType: string, index: number): string => {
    const known: string | undefined = localUrls.get(media)
    if (known !== undefined) return known
    const urls: string[] = mediaUrls(media)
    let url: string = urls[0] ?? ""
    if (urls.length) {
      try {
        url = registerBiliFileSource(`bili_${safeBvid}_${cid}_${qn}_${media.id}_${index}`, urls, mimeType)
      } catch {
        // 代理起不來就直連
      }
    }
    localUrls.set(media, url)
    return url
  }

  const { videos, audios } = selectMedias(dash, selectedVideoId)
  const indexes: Map<BiliDashMedia, BiliSegmentIndex> = new Map()
  const entries: Array<[BiliDashMedia, string]> = [
    ...videos.map((media: BiliDashMedia, index: number): [BiliDashMedia, string] => [media, urlFor(media, "video/mp4", index)]),
    ...audios.map((media: BiliDashMedia, index: number): [BiliDashMedia, string] => [media, urlFor(media, "audio/mp4", index)]),
  ]
  await Promise.all(
    entries.map(async ([media, url]): Promise<void> => {
      const index: BiliSegmentIndex | undefined = await loadSegmentIndex(url, media)
      if (index) indexes.set(media, index)
    }),
  )

  const xml: string = buildBiliDashMpdXml(dash, selectedVideoId, urlFor, (media: BiliDashMedia) => indexes.get(media))
  try {
    return registerVirtualManifest(`bili_${safeBvid}_${cid}_${qn}`, xml, "application/dash+xml")
  } catch {
    const filePath: string = Path.join(
      FileManager.temporaryDirectory,
      `yobi_bili_${safeBvid}_${cid}_${qn}.mpd`,
    )
    FileManager.writeAsStringSync(filePath, xml)
    pruneDashFiles(filePath)
    return filePath
  }
}
