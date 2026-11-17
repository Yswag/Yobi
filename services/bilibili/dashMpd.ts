import { Path, fetch } from "scripting"
import { registerBiliFileSource, registerVirtualManifest, seedBiliHead, warmBiliRange } from "../localProxy"
import { parseSidx, type SidxIndex } from "../sidx"
import { BILI_REFERER, BILI_USER_AGENT } from "./wbi"

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
/**
 * 去掉最後一段後最長的片段時長。播放器用「目標時間 ÷ duration」算段號，
 * 取最長的只會把段號算小：讀到的那段一定從目標之前開始，播放器再往後解到目標。
 * bili 偶爾夾一段短片段（例如 5s 之間一段 1.6s），取平均會把段號算大、跳過目標。
 */
function segmentDurationOf(index: BiliSegmentIndex): number {
  const body = index.sidx.entries.slice(0, -1)
  return Math.max(...body.map(entry => entry.durationUs))
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
 * 播放器不認 SegmentList 裡的 SegmentTimeline（會從頭走並報 preroll 錯誤），只能給單一 duration。
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
interface WarmTrack {
  sourceId: string
  index: BiliSegmentIndex
}

/** 每份 MPD 的片段表，給 warmBiliStart 算「跳到某秒時播放器會先要哪段」。 */
const warmTracks: Map<string, WarmTrack[]> = new Map()
const WARM_MAX_MANIFESTS: number = 16

/**
 * 開片前就把跳過去會用到的片段抓起來（影片與音訊各自目標段＋下一段）。
 * 段號用跟 MPD 一樣的 duration 算，才會跟播放器實際要的一致。不是 bili MPD 就不做事。
 */
export function warmBiliStart(manifestUrl: string, seconds: number): void {
  const tracks: WarmTrack[] | undefined = warmTracks.get(manifestUrl)
  if (!tracks || !(seconds > 0)) return
  for (const track of tracks) {
    const entries = track.index.sidx.entries
    const n: number = Math.min(entries.length - 1, Math.floor((seconds * 1_000_000) / segmentDurationOf(track.index)))
    const last = entries[Math.min(entries.length - 1, n + 1)]
    warmBiliRange(track.sourceId, entries[n].offset, last.offset + last.size - 1)
  }
}

/**
 * 直接向 CDN 抓檔頭（0 到 indexRange 結尾，init＋sidx 約 2 KB）。走代理要先下載整個 1 MB 的第 0 格。
 * 抓到的位元組種進代理，播放器開片要 init 時直接回。讀不到就回 undefined，退回 SegmentBase。
 */
async function loadSegmentIndex(
  cdnUrl: string,
  media: BiliDashMedia,
  sourceId: string | undefined,
): Promise<BiliSegmentIndex | undefined> {
  const indexRange: string | undefined = indexRangeOf(media)
  const initRange: string | undefined = initRangeOf(media) ?? implicitInitRange(indexRange)
  if (!indexRange || !initRange || !cdnUrl) return undefined
  const [start, end] = indexRange.split("-").map(Number)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  try {
    const response = await fetch(cdnUrl, {
      headers: { Referer: BILI_REFERER, "User-Agent": BILI_USER_AGENT, Range: `bytes=0-${end}` },
      timeout: 15,
    })
    if (!response.ok) return undefined
    const head: Uint8Array = new Uint8Array(await response.arrayBuffer())
    if (head.byteLength !== end + 1) return undefined
    const total: number = Number(response.headers.get("content-range")?.split("/")[1])
    if (sourceId) seedBiliHead(sourceId, head, Number.isFinite(total) ? total : null)
    const sidx: SidxIndex | null = parseSidx(head.subarray(start), start)
    if (!sidx || sidx.entries.length < 2) return undefined
    return { initRange, sidx }
  } catch {
    return undefined
  }
}

export interface PreparedTrack {
  media: BiliDashMedia
  mimeType: string
  sourceId: string
  localUrl: string
  /** sidx 讀不到時為 null；HLS 需要它，MPD 可以退回 SegmentBase。 */
  index: BiliSegmentIndex | null
}

/**
 * 把 dash payload 準備成可播放的軌：註冊本機代理、載入 sidx、預熟第一段。
 * MPD 與 HLS 共用同一份準備結果，避免兩邊選到不同 track。
 */
export async function prepareBiliPlayback(
  bvid: string,
  cid: number,
  dash: BiliDashPayload,
  selectedVideoId?: number,
): Promise<{ videos: PreparedTrack[]; audio: PreparedTrack | null }> {
  const qn: number = selectedVideoId ?? 0
  const safeBvid: string = (bvid || "unknown").replace(/[^A-Za-z0-9_-]/g, "")
  const { videos: videoMedias, audios } = selectMedias(dash, selectedVideoId)

  const build = async (
    media: BiliDashMedia,
    mimeType: string,
    index: number,
  ): Promise<PreparedTrack> => {
    const urls: string[] = mediaUrls(media)
    let localUrl: string = urls[0] ?? ""
    let sourceId: string = ""
    if (urls.length) {
      const id: string = `bili_${safeBvid}_${cid}_${qn}_${media.id}_${index}`
      try {
        localUrl = registerBiliFileSource(id, urls, mimeType, Number(media.bandwidth) || 0)
        sourceId = id
      } catch {
        // 代理起不來就直連
      }
    }
    const loaded: BiliSegmentIndex | undefined = await loadSegmentIndex(
      urls[0] ?? "",
      media,
      sourceId || undefined,
    )
    if (loaded && sourceId) {
      // 播放器 open() 一定先依序讀完影片與音訊的第一段（就算接著要跳走），這裡先一起抓。
      const first = loaded.sidx.entries[0]
      warmBiliRange(sourceId, first.offset, first.offset + first.size - 1)
    }
    return { media, mimeType, sourceId, localUrl, index: loaded ?? null }
  }

  const videos: PreparedTrack[] = []
  for (let index = 0; index < videoMedias.length; index++) {
    videos.push(await build(videoMedias[index], "video/mp4", index))
  }
  const audio: PreparedTrack | null = audios[0]
    ? await build(audios[0], "audio/mp4", 0)
    : null
  return { videos, audio }
}

export async function writeBiliDashMpdFile(
  bvid: string,
  cid: number,
  dash: BiliDashPayload,
  selectedVideoId?: number,
): Promise<string> {
  const prepared = await prepareBiliPlayback(bvid, cid, dash, selectedVideoId)
  return writeBiliDashMpdFromPrepared(bvid, cid, dash, selectedVideoId, prepared)
}

/** 用已準備好的軌道產 MPD；避免與 HLS 互為後備時重複準備。 */
export async function writeBiliDashMpdFromPrepared(
  bvid: string,
  cid: number,
  dash: BiliDashPayload,
  selectedVideoId: number | undefined,
  prepared: { videos: PreparedTrack[]; audio: PreparedTrack | null },
): Promise<string> {
  const qn: number = selectedVideoId ?? 0
  const safeBvid: string = (bvid || "unknown").replace(/[^A-Za-z0-9_-]/g, "")
  const urls: Map<BiliDashMedia, string> = new Map()
  const indexes: Map<BiliDashMedia, BiliSegmentIndex> = new Map()
  const tracks: WarmTrack[] = []
  for (const track of [...prepared.videos, prepared.audio]) {
    if (!track) continue
    urls.set(track.media, track.localUrl)
    if (!track.index) continue
    indexes.set(track.media, track.index)
    if (track.sourceId) tracks.push({ sourceId: track.sourceId, index: track.index })
  }
  const urlFor: BaseUrlResolver = (media: BiliDashMedia): string => urls.get(media) ?? ""
  const xml: string = buildBiliDashMpdXml(dash, selectedVideoId, urlFor, (media: BiliDashMedia) => indexes.get(media))
  try {
    const manifestUrl: string = registerVirtualManifest(`bili_${safeBvid}_${cid}_${qn}`, xml, "application/dash+xml")
    warmTracks.delete(manifestUrl)
    if (warmTracks.size >= WARM_MAX_MANIFESTS) {
      const oldest: string | undefined = warmTracks.keys().next().value
      if (oldest !== undefined) warmTracks.delete(oldest)
    }
    if (tracks.length) warmTracks.set(manifestUrl, tracks)
    return manifestUrl
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
