import { fetch } from "scripting"
import type {
  AudioStreamTrack,
  ChannelDetail,
  CommentItem,
  Provider,
  StreamManifest,
  UnifiedVideoItem,
  VideoDetail,
  VideoPagePart,
  VideoQualityTrack,
} from "../../types"
import {
  BILI_REFERER,
  BILI_USER_AGENT,
  biliFetchJson,
  getBiliRequestHeaders,
} from "./wbi"
import type { BiliDashMedia, BiliDashPayload } from "./dashMpd"
import { writeBiliDashMpdFile } from "./dashMpd"

const API = "https://api.bilibili.com"
const VIEW_URL = `${API}/x/web-interface/view`
const VIEW_DETAIL_URL = `${API}/x/web-interface/view/detail`
const RELATED_URL = `${API}/x/web-interface/archive/related`

const BILI_HEADERS: Record<string, string> = {
  Referer: BILI_REFERER,
  "User-Agent": BILI_USER_AGENT,
}

const QN_HEIGHTS: Record<number, number> = {
  6: 240,
  16: 360,
  32: 480,
  64: 720,
  74: 720,
  80: 1080,
  112: 1080,
  116: 1080,
  120: 2160,
  125: 2160,
  126: 2160,
  127: 2160,
}

const AUDIO_LABELS: Record<number, string> = {
  30216: "64k",
  30232: "132k",
  30280: "192k",
  30250: "Dolby Atmos",
  30251: "Hi-Res",
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function imageUrl(url?: string): string {
  if (typeof url !== "string" || !url) return ""
  if (url.startsWith("//")) return `https:${url}`
  if (url.startsWith("http://")) return `https://${url.slice(7)}`
  return url
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "")
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") return ""
  return decodeEntities(stripHtml(value)).trim()
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseDurationText(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || !value) return 0
  const parts = value.trim().split(":").map(part => Number(part))
  if (parts.some(part => !Number.isFinite(part))) return 0
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  return Math.max(0, Math.round(seconds))
}

function formatCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0"
  if (count >= 100000000) return `${(count / 100000000).toFixed(1)}億`
  if (count >= 10000) return `${(count / 10000).toFixed(1)}萬`
  return String(Math.round(count))
}

function publishedTextFromEpoch(seconds?: number): string | undefined {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return undefined
  const diff = Math.floor(Date.now() / 1000 - seconds)
  if (diff < 60) return "剛剛"
  if (diff < 3600) return `${Math.floor(diff / 60)} 分鐘前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小時前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  const date = new Date(seconds * 1000)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

function parseFrameRate(raw: string | number | undefined): number {
  if (raw === undefined || raw === null) return 0
  if (typeof raw === "number") return raw
  const text = String(raw)
  if (text.includes("/")) {
    const [numerator, denominator] = text.split("/").map(part => Number(part))
    if (denominator) return numerator / denominator
    return 0
  }
  const value = Number(text.replace(/[^0-9.]/g, ""))
  return Number.isFinite(value) ? value : 0
}

function mediaUrlOf(media: BiliDashMedia): string {
  return imageUrl(media.baseUrl || media.base_url || (media.backupUrl ?? media.backup_url ?? [])[0] || "")
}

function codecName(media: BiliDashMedia): string {
  const codecid = Number(media.codecid)
  if (codecid === 7) return "AVC"
  if (codecid === 12) return "HEVC"
  if (codecid === 13) return "AV1"
  const codecs = (media.codecs ?? "").toLowerCase()
  if (codecs.startsWith("avc") || codecs.startsWith("h264")) return "AVC"
  if (codecs.startsWith("hev") || codecs.startsWith("hvc")) return "HEVC"
  if (codecs.startsWith("av01")) return "AV1"
  return media.codecs || "unknown"
}

function codecScore(media: BiliDashMedia): number {
  const name = codecName(media)
  if (name === "AVC") return 3
  if (name === "HEVC") return 2
  if (name === "AV1") return 1
  return 0
}

function qualityLabel(media: BiliDashMedia): string {
  const height = Number(media.height) || QN_HEIGHTS[Number(media.id)] || 0
  const fps = parseFrameRate(media.frameRate ?? media.frame_rate)
  const fpsSuffix = fps >= 50 ? "60" : ""
  if (height >= 2160) return `4K${fpsSuffix}`
  if (height >= 1440) return `2K${fpsSuffix}`
  if (height > 0) return `${height}p${fpsSuffix}`
  return `${Number(media.id) || 0}p`
}

// ─── Input parsing ──────────────────────────────────────────────────────────

/** Parses a BV id, av number or bilibili.com link. Short links need `resolveBiliShortUrl`. */
export function parseBiliInput(input: string): { bvid?: string; aid?: number } | null {
  const text = (input ?? "").trim()
  if (!text) return null

  const bvMatch = text.match(/BV[0-9A-Za-z]{10}/)
  if (bvMatch) return { bvid: bvMatch[0] }

  const avMatch = text.match(/(?:^|[^0-9A-Za-z])av(\d+)/i)
  if (avMatch) {
    const aid = Number(avMatch[1])
    if (Number.isFinite(aid) && aid > 0) return { aid }
  }

  return null
}

/** Resolves `b23.tv` short links (and anything else `parseBiliInput` understands). */
export async function resolveBiliShortUrl(
  input: string,
): Promise<{ bvid?: string; aid?: number } | null> {
  const direct = parseBiliInput(input)
  if (direct) return direct

  const shortMatch = (input ?? "").match(/b23\.tv\/([0-9A-Za-z]+)/)
  if (!shortMatch) return null

  try {
    const res = await fetch(`https://b23.tv/${shortMatch[1]}`, {
      headers: { "User-Agent": BILI_USER_AGENT },
    })
    const parsed = parseBiliInput(res.url || "")
    if (parsed) return parsed
  } catch {
    // fall through
  }
  return null
}

async function resolveIds(input: string): Promise<{ bvid?: string; aid?: number }> {
  const ids = await resolveBiliShortUrl(input)
  if (!ids) throw new Error("無法解析 BiliBili 影片編號")
  return ids
}

async function resolveAid(ids: { bvid?: string; aid?: number }): Promise<number> {
  if (ids.aid) return ids.aid
  if (!ids.bvid) throw new Error("缺少影片編號")
  const result: any = await biliFetchJson<any>(VIEW_URL, { bvid: ids.bvid })
  if (result?.code !== 0 || !result.data?.aid) {
    throw new Error(result?.message || "無法取得影片資訊")
  }
  return Number(result.data.aid)
}

// ─── Mapping ────────────────────────────────────────────────────────────────

function mapItem(raw: any): UnifiedVideoItem | null {
  if (!raw || typeof raw !== "object") return null
  const bvid =
    typeof raw.bvid === "string" && raw.bvid.startsWith("BV")
      ? raw.bvid
      : typeof raw.id === "string" && raw.id.startsWith("BV")
        ? raw.id
        : ""
  if (!bvid) return null

  const owner = raw.owner ?? {}
  const stat = raw.stat ?? {}
  const pubdate = numberOrUndefined(raw.pubdate ?? raw.senddate ?? raw.created)
  const duration =
    typeof raw.duration === "number"
      ? raw.duration
      : parseDurationText(raw.duration ?? raw.length)

  return {
    id: `bili:${bvid}`,
    provider: "bili",
    rawId: bvid,
    title: cleanText(raw.title),
    thumbnailUrl: imageUrl(raw.pic ?? raw.cover),
    duration: duration || 0,
    viewCount: numberOrUndefined(stat.view ?? raw.play),
    danmakuCount: numberOrUndefined(stat.danmaku ?? raw.video_review),
    likeCount: numberOrUndefined(stat.like),
    publishedText: publishedTextFromEpoch(pubdate),
    publishedAt: pubdate ? pubdate * 1000 : undefined,
    authorId: String(owner.mid ?? raw.mid ?? ""),
    authorName: cleanText(owner.name ?? raw.author),
    authorAvatar: imageUrl(owner.face ?? raw.upic) || undefined,
    isLive: raw.isLive === true || raw.live_status === 1 ? true : undefined,
    cid: numberOrUndefined(raw.cid),
    aid: numberOrUndefined(raw.aid),
  }
}

function mapItems(rawList: unknown): UnifiedVideoItem[] {
  if (!Array.isArray(rawList)) return []
  const items: UnifiedVideoItem[] = []
  for (const raw of rawList) {
    const mapped = mapItem(raw)
    if (mapped) items.push(mapped)
  }
  return items
}

// ─── Trending / search ──────────────────────────────────────────────────────

export async function getBiliTrending(page = 1): Promise<UnifiedVideoItem[]> {
  try {
    const result: any = await biliFetchJson<any>(
      `${API}/x/web-interface/wbi/index/top/feed/rcmd`,
      {
        page_size: 20,
        fresh_type: 3,
        feed_version: "V8",
        fresh_idx: page,
        fresh_idx_1h: page,
        brush: page,
        web_location: 1430650,
      },
      true,
    )
    if (result?.code === 0) {
      const items = mapItems(result.data?.item)
      if (items.length) return items
    }
  } catch {
    // fall back to the popular endpoint
  }

  const popular: any = await biliFetchJson<any>(`${API}/x/web-interface/popular`, {
    ps: 20,
    pn: page,
  })
  if (popular?.code === 0) return mapItems(popular.data?.list)
  return []
}

export async function searchBiliVideos(
  keyword: string,
  page = 1,
): Promise<UnifiedVideoItem[]> {
  const trimmed = (keyword ?? "").trim()
  if (!trimmed) return []

  const result: any = await biliFetchJson<any>(
    `${API}/x/web-interface/wbi/search/type`,
    {
      search_type: "video",
      keyword: trimmed,
      page,
      page_size: 20,
      order: "totalrank",
      web_location: 1430654,
    },
    true,
  )
  if (result?.code !== 0) return []
  return mapItems(result.data?.result)
}

export async function getBiliSearchSuggestions(term: string): Promise<string[]> {
  const trimmed = (term ?? "").trim()
  if (!trimmed) return []
  try {
    const res = await fetch(
      `https://s.search.bilibili.com/main/suggest?term=${encodeURIComponent(trimmed)}&main_ver=v1`,
      { headers: await getBiliRequestHeaders() },
    )
    if (!res.ok) return []
    const json: any = await res.json()
    const tags = json?.result?.tag ?? json?.result ?? []
    if (!Array.isArray(tags)) return []
    const seen = new Set<string>()
    const suggestions: string[] = []
    for (const tag of tags) {
      const value = tag?.value ?? tag?.name ?? tag?.term
      if (typeof value !== "string") continue
      const cleaned = cleanText(value)
      if (!cleaned || seen.has(cleaned)) continue
      seen.add(cleaned)
      suggestions.push(cleaned)
      if (suggestions.length >= 10) break
    }
    return suggestions
  } catch {
    return []
  }
}

// ─── Video detail ───────────────────────────────────────────────────────────

export async function getBiliVideoDetail(bvidOrAid: string): Promise<VideoDetail> {
  const ids = await resolveIds(bvidOrAid)
  const params: Record<string, string | number> = {}
  if (ids.bvid) params.bvid = ids.bvid
  else if (ids.aid) params.aid = ids.aid

  let view: any = null
  let card: any = null
  let tags: any[] = []
  let related: any[] = []

  try {
    const detail: any = await biliFetchJson<any>(VIEW_DETAIL_URL, params)
    if (detail?.code === 0 && detail.data?.View) {
      view = detail.data.View
      card = detail.data.Card
      tags = Array.isArray(detail.data.Tags) ? detail.data.Tags : []
      related = Array.isArray(detail.data.Related) ? detail.data.Related : []
    }
  } catch {
    // fall back to /view
  }

  if (!view) {
    const result: any = await biliFetchJson<any>(VIEW_URL, params)
    if (result?.code !== 0 || !result.data) {
      throw new Error(result?.message || "無法取得影片資訊")
    }
    view = result.data
  }

  const bvid = typeof view.bvid === "string" ? view.bvid : ids.bvid
  if (!bvid) throw new Error("影片資料不完整")

  if (!related.length) {
    try {
      const result: any = await biliFetchJson<any>(RELATED_URL, { bvid })
      if (result?.code === 0 && Array.isArray(result.data)) related = result.data
    } catch {
      // related videos are optional
    }
  }

  const base = mapItem({ ...view, aid: view.aid })
  if (!base) throw new Error("影片資料不完整")

  const pages: VideoPagePart[] | undefined =
    Array.isArray(view.pages) && view.pages.length
      ? view.pages.map((page: any) => ({
          cid: Number(page.cid),
          page: Number(page.page) || 0,
          title: cleanText(page.part),
          duration: Number(page.duration) || 0,
        }))
      : undefined

  const fans = numberOrUndefined(card?.card?.fans ?? card?.fans)
  const tagNames = tags
    .map((tag: any) => cleanText(tag?.tag_name ?? tag?.name))
    .filter((name: string) => name.length > 0)

  return {
    ...base,
    cid: numberOrUndefined(view.cid) ?? base.cid,
    description: typeof view.desc === "string" ? view.desc : "",
    subscriberCountText: fans !== undefined ? `${formatCount(fans)} 粉絲` : undefined,
    pages,
    relatedVideos: mapItems(related).slice(0, 20),
    tags: tagNames.length ? tagNames : undefined,
  }
}

// ─── Streams ────────────────────────────────────────────────────────────────

function buildAudioTracks(dash: BiliDashPayload): AudioStreamTrack[] {
  const tracks: AudioStreamTrack[] = []
  const seen = new Set<string>()
  const push = (media: BiliDashMedia | null | undefined, labelOverride?: string) => {
    if (!media) return
    const url = mediaUrlOf(media)
    if (!url) return
    const id = String(media.id)
    if (seen.has(id)) return
    seen.add(id)
    const bitrate = Number(media.bandwidth) || 0
    tracks.push({
      id,
      label:
        labelOverride ??
        AUDIO_LABELS[Number(media.id)] ??
        `${Math.max(1, Math.round(bitrate / 1000))}kbps`,
      bitrate,
      codec: media.codecs ?? (media.mimeType ?? media.mime_type) ?? "mp4a.40.2",
      mimeType: media.mimeType ?? media.mime_type ?? "audio/mp4",
      url,
    })
  }

  for (const media of dash.audio ?? []) push(media)
  for (const media of dash.dolby?.audio ?? []) push(media, "Dolby Atmos")
  push(dash.flac?.audio ?? null, "Hi-Res")
  return tracks
}

function buildQualityTracks(dash: BiliDashPayload): VideoQualityTrack[] {
  const grouped = new Map<number, BiliDashMedia[]>()
  for (const media of dash.video ?? []) {
    const qn = Number(media.id)
    if (!Number.isFinite(qn)) continue
    if (!mediaUrlOf(media)) continue
    const list = grouped.get(qn) ?? []
    list.push(media)
    grouped.set(qn, list)
  }

  const tracks: VideoQualityTrack[] = []
  for (const [qn, list] of grouped) {
    const best = list
      .slice()
      .sort(
        (a, b) =>
          codecScore(b) - codecScore(a) || (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0),
      )[0]
    tracks.push({
      id: String(qn),
      label: qualityLabel(best),
      width: Number(best.width) || 0,
      height: Number(best.height) || QN_HEIGHTS[qn] || 0,
      fps: parseFrameRate(best.frameRate ?? best.frame_rate) || undefined,
      bitrate: Number(best.bandwidth) || undefined,
      codec: codecName(best),
      delivery: "dash",
      url: mediaUrlOf(best),
      headers: { ...BILI_HEADERS },
      qn,
    })
  }

  tracks.sort(
    (a, b) => b.height - a.height || (b.fps ?? 0) - (a.fps ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0),
  )
  return tracks
}

function pickDefaultQuality(
  qualities: VideoQualityTrack[],
  preferredHeight?: number,
): VideoQualityTrack | null {
  if (!qualities.length) return null
  const preferred = preferredHeight && preferredHeight > 0 ? preferredHeight : 1080
  const ascending = qualities
    .slice()
    .sort((a, b) => a.height - b.height || (a.fps ?? 0) - (b.fps ?? 0))

  const withinLimit = ascending.filter(track => track.height > 0 && track.height <= preferred)
  if (withinLimit.length) return withinLimit[withinLimit.length - 1]

  const known = ascending.filter(track => track.height > 0)
  if (known.length) return known[0]
  return ascending[0]
}

export async function resolveBiliStream(
  bvid: string,
  cid?: number,
  preferredHeight?: number,
): Promise<StreamManifest> {
  const ids = await resolveIds(bvid)
  const resolvedBvid = ids.bvid
  if (!resolvedBvid) throw new Error("缺少 BV 號")

  let resolvedCid = cid
  let fallbackDuration = 0
  let fallbackAid = ids.aid

  if (!resolvedCid) {
    const view: any = await biliFetchJson<any>(VIEW_URL, { bvid: resolvedBvid })
    if (view?.code !== 0 || !view.data?.cid) {
      throw new Error(view?.message || "無法取得影片資訊")
    }
    resolvedCid = Number(view.data.cid)
    fallbackDuration = Number(view.data.duration) || 0
    fallbackAid = Number(view.data.aid) || fallbackAid
  }

  const playParams: Record<string, string | number> = {
    bvid: resolvedBvid,
    cid: resolvedCid,
    fnval: 4048,
    fnver: 0,
    fourk: 1,
    qn: 120,
  }
  if (fallbackAid) playParams.aid = fallbackAid

  const play: any = await biliFetchJson<any>(
    `${API}/x/player/wbi/playurl`,
    playParams,
    true,
  )
  if (play?.code !== 0 || !play.data) {
    throw new Error(play?.message || "無法取得播放位址")
  }

  const data = play.data
  const streamCid = Number(resolvedCid)
  const danmakuXmlUrl = `https://comment.bilibili.com/${streamCid}.xml`
  const dash: BiliDashPayload | undefined = data.dash

  if (dash && Array.isArray(dash.video) && dash.video.length) {
    const duration =
      Number(dash.duration) ||
      (Number(data.timelength) ? Number(data.timelength) / 1000 : 0) ||
      fallbackDuration
    const qualities = buildQualityTracks(dash)
    const selected = pickDefaultQuality(qualities, preferredHeight)
    const defaultQn = selected?.qn ?? Number(selected?.id) ?? 0
    const primaryUrl = writeBiliDashMpdFile(resolvedBvid, streamCid, dash, defaultQn)
    const audioTracks = buildAudioTracks(dash)

    const manifest: StreamManifest = {
      provider: "bili",
      rawId: resolvedBvid,
      delivery: "dash",
      primaryUrl,
      backend: "native",
      headers: { ...BILI_HEADERS },
      qualities,
      audioTracks,
      subtitles: [],
      danmakuXmlUrl,
      cid: streamCid,
      isLive: false,
      duration,
      resolveQuality: async (qualityId: string) => {
        const parsed = Number.parseInt(qualityId, 10)
        const qn = Number.isFinite(parsed) && qualities.some(track => track.qn === parsed)
          ? parsed
          : defaultQn
        return {
          url: writeBiliDashMpdFile(resolvedBvid, streamCid, dash, qn),
          backend: "native",
          headers: { ...BILI_HEADERS },
        }
      },
    }
    return manifest
  }

  const durl: any[] | undefined = Array.isArray(data.durl) ? data.durl : undefined
  if (durl && durl.length && typeof durl[0]?.url === "string") {
    const duration =
      (Number(data.timelength) ? Number(data.timelength) / 1000 : 0) || fallbackDuration
    const qn = Number(data.quality) || Number((data.accept_quality ?? [])[0]) || 0
    const height = QN_HEIGHTS[qn] || 0
    const quality: VideoQualityTrack = {
      id: String(qn),
      label: height ? `${height}p` : `${qn || "Auto"}`,
      width: 0,
      height,
      delivery: "progressive",
      url: durl[0].url,
      headers: { ...BILI_HEADERS },
      qn,
    }
    return {
      provider: "bili",
      rawId: resolvedBvid,
      delivery: "progressive",
      primaryUrl: durl[0].url,
      backend: "native",
      headers: { ...BILI_HEADERS },
      qualities: [quality],
      audioTracks: [],
      subtitles: [],
      danmakuXmlUrl,
      cid: streamCid,
      isLive: false,
      duration,
    }
  }

  throw new Error("找不到可用的串流格式")
}

// ─── Danmaku ────────────────────────────────────────────────────────────────

interface HuffmanTable {
  counts: number[]
  symbols: number[]
}

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
  131, 163, 195, 227, 258,
]
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
  2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
  13, 13,
]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

class BitReader {
  private readonly data: Uint8Array
  private position = 0
  private bitOffset = 0

  constructor(data: Uint8Array) {
    this.data = data
  }

  read(count: number): number {
    let value = 0
    for (let i = 0; i < count; i++) {
      const byte = this.data[this.position]
      if (byte === undefined) throw new Error("deflate stream ended early")
      value |= ((byte >> this.bitOffset) & 1) << i
      this.bitOffset++
      if (this.bitOffset === 8) {
        this.bitOffset = 0
        this.position++
      }
    }
    return value
  }

  align(): void {
    if (this.bitOffset !== 0) {
      this.bitOffset = 0
      this.position++
    }
  }

  readBytes(count: number): Uint8Array {
    const start = this.position
    if (start + count > this.data.length) throw new Error("deflate stream ended early")
    this.position += count
    return this.data.subarray(start, start + count)
  }
}

function buildHuffman(lengths: number[]): HuffmanTable {
  let maxLength = 0
  for (const length of lengths) {
    if (length > maxLength) maxLength = length
  }
  const counts = new Array<number>(maxLength + 1).fill(0)
  for (const length of lengths) {
    if (length > 0) counts[length]++
  }
  const offsets = new Array<number>(maxLength + 1).fill(0)
  for (let length = 1; length < maxLength; length++) {
    offsets[length + 1] = offsets[length] + counts[length]
  }
  const symbols = new Array<number>(lengths.length).fill(0)
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol]
    if (length > 0) symbols[offsets[length]++] = symbol
  }
  return { counts, symbols }
}

function decodeSymbol(reader: BitReader, table: HuffmanTable): number {
  let code = 0
  let first = 0
  let index = 0
  for (let length = 1; length < table.counts.length; length++) {
    code |= reader.read(1)
    const count = table.counts[length] ?? 0
    if (code - first < count) return table.symbols[index + (code - first)]
    index += count
    first = (first + count) << 1
    code <<= 1
  }
  throw new Error("invalid huffman code")
}

let fixedLiteralTable: HuffmanTable | null = null
let fixedDistanceTable: HuffmanTable | null = null

function fixedTables(): { literal: HuffmanTable; distance: HuffmanTable } {
  if (!fixedLiteralTable) {
    const lengths: number[] = []
    for (let symbol = 0; symbol < 288; symbol++) {
      if (symbol < 144) lengths.push(8)
      else if (symbol < 256) lengths.push(9)
      else if (symbol < 280) lengths.push(7)
      else lengths.push(8)
    }
    fixedLiteralTable = buildHuffman(lengths)
  }
  if (!fixedDistanceTable) {
    fixedDistanceTable = buildHuffman(new Array<number>(32).fill(5))
  }
  return { literal: fixedLiteralTable, distance: fixedDistanceTable }
}

function inflateRaw(input: Uint8Array): Uint8Array {
  const reader = new BitReader(input)
  let output = new Uint8Array(Math.max(1024, input.length * 4))
  let outputLength = 0

  const ensure = (extra: number): void => {
    if (outputLength + extra <= output.length) return
    let size = output.length * 2
    while (size < outputLength + extra) size *= 2
    const next = new Uint8Array(size)
    next.set(output.subarray(0, outputLength))
    output = next
  }

  const push = (byte: number): void => {
    ensure(1)
    output[outputLength++] = byte
  }

  const decodeBlock = (literal: HuffmanTable, distance: HuffmanTable): void => {
    while (true) {
      const symbol = decodeSymbol(reader, literal)
      if (symbol < 256) {
        push(symbol)
        continue
      }
      if (symbol === 256) return

      const lengthIndex = symbol - 257
      if (lengthIndex < 0 || lengthIndex >= LEN_BASE.length) throw new Error("invalid length")
      const length = LEN_BASE[lengthIndex] + reader.read(LEN_EXTRA[lengthIndex])

      const distanceSymbol = decodeSymbol(reader, distance)
      if (distanceSymbol >= DIST_BASE.length) throw new Error("invalid distance")
      const back = DIST_BASE[distanceSymbol] + reader.read(DIST_EXTRA[distanceSymbol])
      if (back > outputLength) throw new Error("invalid distance reference")

      ensure(length)
      let source = outputLength - back
      for (let i = 0; i < length; i++) {
        output[outputLength++] = output[source++]
      }
    }
  }

  let final = 0
  while (!final) {
    final = reader.read(1)
    const type = reader.read(2)

    if (type === 0) {
      reader.align()
      const length = reader.read(16)
      reader.read(16)
      const bytes = reader.readBytes(length)
      ensure(length)
      output.set(bytes, outputLength)
      outputLength += length
      continue
    }

    if (type === 1) {
      const tables = fixedTables()
      decodeBlock(tables.literal, tables.distance)
      continue
    }

    if (type === 2) {
      const literalCount = reader.read(5) + 257
      const distanceCount = reader.read(5) + 1
      const codeLengthCount = reader.read(4) + 4

      const codeLengths = new Array<number>(19).fill(0)
      for (let i = 0; i < codeLengthCount; i++) {
        codeLengths[CODE_LENGTH_ORDER[i]] = reader.read(3)
      }
      const codeLengthTable = buildHuffman(codeLengths)

      const lengths: number[] = []
      while (lengths.length < literalCount + distanceCount) {
        const symbol = decodeSymbol(reader, codeLengthTable)
        if (symbol < 16) {
          lengths.push(symbol)
        } else if (symbol === 16) {
          if (!lengths.length) throw new Error("invalid code length repeat")
          const repeat = reader.read(2) + 3
          const previous = lengths[lengths.length - 1]
          for (let i = 0; i < repeat; i++) lengths.push(previous)
        } else if (symbol === 17) {
          const repeat = reader.read(3) + 3
          for (let i = 0; i < repeat; i++) lengths.push(0)
        } else if (symbol === 18) {
          const repeat = reader.read(7) + 11
          for (let i = 0; i < repeat; i++) lengths.push(0)
        } else {
          throw new Error("invalid code length symbol")
        }
      }

      const literal = buildHuffman(lengths.slice(0, literalCount))
      const distance = buildHuffman(lengths.slice(literalCount, literalCount + distanceCount))
      decodeBlock(literal, distance)
      continue
    }

    throw new Error("invalid deflate block type")
  }

  return output.subarray(0, outputLength)
}

function inflateDanmaku(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 3) throw new Error("too small to decompress")

  const candidates: Uint8Array[] = []
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b
  if (isGzip) {
    const flags = bytes[3]
    let offset = 10
    if (flags & 0x04) offset = 12 + (bytes[10] | (bytes[11] << 8))
    if (flags & 0x08) {
      while (offset < bytes.length && bytes[offset] !== 0) offset++
      offset++
    }
    if (flags & 0x10) {
      while (offset < bytes.length && bytes[offset] !== 0) offset++
      offset++
    }
    if (flags & 0x02) offset += 2
    candidates.push(bytes.subarray(offset))
  } else if ((bytes[0] & 0x0f) === 0x08 && ((bytes[0] << 8) | bytes[1]) % 31 === 0) {
    let offset = 2
    if (bytes[1] & 0x20) offset += 4
    candidates.push(bytes.subarray(offset))
    candidates.push(bytes)
  } else {
    candidates.push(bytes)
  }

  let lastError: unknown = null
  for (const candidate of candidates) {
    try {
      return inflateRaw(candidate)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error("無法解壓彈幕資料")
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return Data.fromUint8Array(bytes)?.toDecodedString("utf8") ?? ""
  } catch {
    return ""
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function looksLikeXml(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith("<?xml") || trimmed.startsWith("<i")
}

function decodeDanmakuBytes(bytes: Uint8Array): string {
  const plain = decodeUtf8(bytes)
  if (looksLikeXml(plain)) return stripBom(plain).trim()
  const inflated = decodeUtf8(inflateDanmaku(bytes))
  if (looksLikeXml(inflated)) return stripBom(inflated).trim()
  throw new Error("彈幕資料格式不正確")
}

export async function fetchBiliDanmakuXml(cid: number): Promise<string> {
  const urls = [
    `https://comment.bilibili.com/${cid}.xml`,
    `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`,
  ]

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { ...BILI_HEADERS } })
      if (!res.ok) continue
      const bytes = await res.bytes()
      return decodeDanmakuBytes(bytes)
    } catch {
      // try the next endpoint
    }
  }
  throw new Error("無法取得彈幕資料")
}

// ─── Comments ───────────────────────────────────────────────────────────────

function mapReply(raw: any): CommentItem {
  const member = raw?.member ?? {}
  const replies = Array.isArray(raw?.replies) ? raw.replies.slice(0, 3) : []
  return {
    id: String(raw?.rpid_str ?? raw?.rpid ?? ""),
    authorId: String(member.mid ?? ""),
    authorName: cleanText(member.uname),
    authorAvatar: imageUrl(member.avatar ?? member.avatar_url),
    content: typeof raw?.content?.message === "string" ? raw.content.message : "",
    likeCount: Number(raw?.like) || 0,
    publishedText: publishedTextFromEpoch(numberOrUndefined(raw?.ctime)) ?? "",
    replyCount: Number(raw?.rcount) || 0,
    replies: replies.length ? replies.map(mapReply) : undefined,
  }
}

export async function getBiliComments(
  bvidOrAid: string,
  page = 1,
): Promise<CommentItem[]> {
  const ids = await resolveIds(bvidOrAid)
  const oid = await resolveAid(ids)

  try {
    const main: any = await biliFetchJson<any>(`${API}/x/v2/reply/main`, {
      oid,
      type: 1,
      mode: 3,
      next: page,
      ps: 20,
    })
    const replies = main?.data?.replies
    if (Array.isArray(replies) && replies.length) return replies.map(mapReply)
  } catch {
    // fall back to the legacy endpoint
  }

  const legacy: any = await biliFetchJson<any>(`${API}/x/v2/reply`, {
    oid,
    type: 1,
    pn: page,
    ps: 20,
    sort: 2,
  })
  const replies = legacy?.data?.replies
  return Array.isArray(replies) ? replies.map(mapReply) : []
}

// ─── Channel / UP 主 ────────────────────────────────────────────────────────

interface ChannelProfile {
  name: string
  face: string
  sign: string
  fans?: number
}

async function fetchChannelProfile(mid: string): Promise<ChannelProfile | null> {
  try {
    const result: any = await biliFetchJson<any>(
      `${API}/x/space/wbi/acc/info`,
      { mid, platform: "web", web_location: 1550101 },
      true,
    )
    if (result?.code === 0 && result.data) {
      return {
        name: cleanText(result.data.name),
        face: imageUrl(result.data.face),
        sign: cleanText(result.data.sign),
        fans: numberOrUndefined(result.data.fans),
      }
    }
  } catch {
    // fall back to the public card endpoint
  }

  try {
    const card: any = await biliFetchJson<any>(`${API}/x/web-interface/card`, { mid })
    if (card?.code === 0 && card.data?.card) {
      const info = card.data.card
      return {
        name: cleanText(info.name),
        face: imageUrl(info.face),
        sign: cleanText(info.sign),
        fans: numberOrUndefined(info.fans),
      }
    }
  } catch {
    // give up below
  }
  return null
}

async function fetchChannelVideos(mid: string, page: number): Promise<UnifiedVideoItem[]> {
  const attempts: Array<() => Promise<any>> = [
    () =>
      biliFetchJson<any>(
        `${API}/x/space/wbi/arc/search`,
        {
          mid,
          ps: 30,
          pn: page,
          order: "pubdate",
          platform: "web",
          web_location: 1550101,
        },
        true,
      ),
    () =>
      biliFetchJson<any>(`${API}/x/space/arc/search`, {
        mid,
        ps: 30,
        pn: page,
        order: "pubdate",
      }),
  ]

  for (const attempt of attempts) {
    try {
      const result: any = await attempt()
      if (result?.code === 0) {
        const list = result.data?.list
        const items = mapItems(list?.vlist ?? list)
        if (items.length) return items
      }
    } catch {
      // try the next endpoint
    }
  }
  return []
}

export async function getBiliChannel(mid: string, page = 1): Promise<ChannelDetail> {
  const rawMid = String(mid ?? "").trim()
  if (!rawMid) throw new Error("缺少 UP 主 ID")

  const profile = await fetchChannelProfile(rawMid)
  let videos = await fetchChannelVideos(rawMid, page)

  if (!videos.length && profile?.name) {
    // Risk-control fallback: search the UP 主's published works by name.
    videos = await searchBiliVideos(profile.name, page)
  }

  return {
    id: `bili:${rawMid}`,
    provider: "bili" as Provider,
    rawId: rawMid,
    name: profile?.name ?? rawMid,
    avatarUrl: profile?.face ?? "",
    description: profile?.sign ?? "",
    subscriberCountText:
      profile?.fans !== undefined ? `${formatCount(profile.fans)} 粉絲` : undefined,
    videos,
    nextPageToken: videos.length ? String(page + 1) : undefined,
  }
}
