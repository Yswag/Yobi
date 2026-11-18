/**
 * YouTube 服務入口：搜尋、熱門、詳情、頻道、留言、字幕、HLS / SABR 串流。
 */

import { fetch } from "scripting"
import type {
  AudioStreamTrack,
  ChannelDetail,
  CommentItem,
  CommentPage,
  CommentQuery,
  CommentSort,
  StreamManifest,
  UnifiedVideoItem,
  VideoDetail,
  VideoQualityTrack,
  YoutubeStreamPreference,
} from "../../types"
import {
  fetchBrowseContinuation,
  fetchBrowseResponse,
  fetchNextResponse,
  fetchPlayerResponse,
  fetchSearchResponse,
  getAnonymousVisitorData,
  getYoutubeAuth,
  INNERTUBE_CLIENTS,
  innertubePost,
  type InnertubeClientKey,
  type JsonObject,
} from "./innertube"
import { decipherStreamingUrl } from "./nsig"
import { getYoutubePageTokens, refreshYoutubePageToken } from "./pageMinter"
import { getYoutubePoTokens, type YoutubePoTokens } from "./potoken"
import {
  collectContinuationTokens,
  extractSortChips,
  extractVideoItems,
  findPageCursor,
  parseAboutChannel,
  parseChannelDetail,
  parseChannelVideosPage,
  parseComments,
  parseLiveViewerCount,
  parseRelatedVideos,
  parseSubtitleTracks,
  parseVideoDetail,
} from "./parsers"
import type { AboutChannelInfo } from "./parsers"
import { resolveHlsManifest } from "./hls"
import { resolveYoutubeLiveStream } from "./live"
import {
  audioTrackOf,
  createSabrQualitySession,
  makeClientPlaybackNonce,
  parseAdaptiveFormats,
  pickBestAudioFormat,
  pickVideoFormats,
  type SabrFormat,
  type SabrQualitySession,
  type SabrSessionConfig,
} from "./sabr"

const SUGGEST_ENDPOINT: string = "https://suggestqueries-clients6.youtube.com/complete/search"

/** 支援 youtu.be / watch?v= / shorts / live / embed 與 11 碼 ID。 */
export function parseYoutubeInput(input: string): string | null {
  const trimmed: string = input.trim()
  if (!trimmed) return null
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed

  const patterns: RegExp[] = [
    /(?:youtube\.com|youtube-nocookie\.com)\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/live\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/v\/([A-Za-z0-9_-]{11})/,
  ]
  for (const pattern of patterns) {
    const match: RegExpMatchArray | null = trimmed.match(pattern)
    if (match) return match[1]
  }
  return null
}

function asObject(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject
  return null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function dedupeItems(items: UnifiedVideoItem[]): UnifiedVideoItem[] {
  const seen: Set<string> = new Set()
  const result: UnifiedVideoItem[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    result.push(item)
  }
  return result
}

function playabilityFailure(player: JsonObject): string | null {
  const status: JsonObject | null = asObject(player["playabilityStatus"])
  if (!status) return null
  const value: string = String(status["status"] ?? "")
  if (!value || value === "OK") return null
  return String(status["reason"] ?? value)
}

export async function searchYoutubeVideos(query: string): Promise<UnifiedVideoItem[]> {
  const response: JsonObject = await fetchSearchResponse(query)
  return extractVideoItems(response)
}

/** 首頁熱門：先試 FEwhat_to_watch，空的話退回熱門關鍵字搜尋。 */
export async function getYoutubeTrending(): Promise<UnifiedVideoItem[]> {
  try {
    const response: JsonObject = await fetchBrowseResponse("FEwhat_to_watch")
    const items: UnifiedVideoItem[] = extractVideoItems(response)
    if (items.length > 0) return items
  } catch (_error) {
    // 未登入或個人化失敗時直接進 fallback
  }

  const fallbackQueries: string[] = ["music", "news", "gaming"]
  const batches: UnifiedVideoItem[][] = await Promise.all(
    fallbackQueries.map(async (query: string): Promise<UnifiedVideoItem[]> => {
      try {
        return await searchYoutubeVideos(query)
      } catch (_error) {
        return []
      }
    }),
  )

  const merged: UnifiedVideoItem[] = []
  const longest: number = batches.reduce((max: number, batch: UnifiedVideoItem[]): number => Math.max(max, batch.length), 0)
  for (let i = 0; i < longest; i++) {
    for (const batch of batches) {
      const item: UnifiedVideoItem | undefined = batch[i]
      if (item) merged.push(item)
    }
  }
  return dedupeItems(merged)
}

/** 搜尋建議。 */
export async function getYoutubeSearchSuggestions(query: string): Promise<string[]> {
  const trimmed: string = query.trim()
  if (!trimmed) return []
  const url: string = `${SUGGEST_ENDPOINT}?client=youtube&ds=yt&q=${encodeURIComponent(trimmed)}`
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_1 like Mac OS X)" },
      timeout: 12,
      debugLabel: "Yobi YouTube suggest",
    })
    if (!response.ok) return []
    const text: string = await response.text()
    const start: number = text.indexOf("(")
    const end: number = text.lastIndexOf(")")
    if (start < 0 || end <= start) return []
    const payload: unknown = JSON.parse(text.slice(start + 1, end))
    const entries: unknown[] = asArray(asArray(payload)[1])
    const suggestions: string[] = []
    for (const entry of entries) {
      const value: unknown = asArray(entry)[0]
      if (typeof value === "string" && value.length > 0) suggestions.push(value)
    }
    return suggestions
  } catch (_error) {
    return []
  }
}

/** 影片詳情（player + next）。 */
export async function getYoutubeVideoDetail(videoId: string): Promise<VideoDetail> {
  const player: JsonObject = await fetchPlayerResponse(videoId, "WEB_SABR")
  if (!asObject(player["videoDetails"])?.["title"]) {
    const failure: string | null = playabilityFailure(player)
    throw new Error(failure ? `YouTube 無法播放：${failure}` : "YouTube 沒有影片資訊")
  }

  let next: JsonObject | null = null
  try {
    next = await fetchWatchNext(videoId)
  } catch (_error) {
    next = null
  }

  return parseVideoDetail(videoId, player, next)
}

/** 直播的即時觀看人數；直播結束就沒有這個值。 */
export async function getYoutubeLiveViewers(videoId: string): Promise<number | undefined> {
  try {
    return parseLiveViewerCount(await fetchWatchNext(videoId))
  } catch (_error) {
    return undefined
  }
}

const COMMENTS_PANEL_ID: string = "engagement-panel-comments-section"

/** 子樹裡第一個 continuation token。 */
function firstContinuationToken(node: unknown): string | null {
  let token: string | null = null

  const visit = (current: unknown, depth: number): void => {
    if (!current || token || depth > 24) return
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry, depth + 1)
      return
    }
    const object: JsonObject | null = asObject(current)
    if (!object) return
    const command: JsonObject | null = asObject(asObject(object["continuationEndpoint"])?.["continuationCommand"])
    if (command && typeof command["token"] === "string") {
      token = String(command["token"])
      return
    }
    for (const key of Object.keys(object)) visit(object[key], depth + 1)
  }

  visit(node, 0)
  return token
}

/**
 * 留言的 continuation token。
 * 新版放在 `engagementPanels` 的 comments 面板裡，itemSection 版本則標成 `comment-item-section`，
 * 兩者都不會出現 `request: ...comments` 字樣。
 */
function findCommentsContinuation(next: JsonObject): string | null {
  for (const entry of asArray(next["engagementPanels"])) {
    const panel: JsonObject | null = asObject(asObject(entry)?.["engagementPanelSectionListRenderer"])
    if (!panel || String(panel["panelIdentifier"] ?? "") !== COMMENTS_PANEL_ID) continue
    const token: string | null = firstContinuationToken(panel["content"])
    if (token) return token
  }

  let sectionToken: string | null = null
  let legacyToken: string | null = null

  const visit = (node: unknown, depth: number): void => {
    if (!node || depth > 26 || sectionToken) return
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1)
      return
    }
    const object: JsonObject | null = asObject(node)
    if (!object) return

    const section: JsonObject | null = asObject(object["itemSectionRenderer"])
    if (section) {
      if (String(section["sectionIdentifier"] ?? "") === "comment-item-section") {
        sectionToken = firstContinuationToken(section)
      } else if (!legacyToken && /comment/i.test(JSON.stringify(section["header"] ?? ""))) {
        legacyToken = firstContinuationToken(section)
      }
    }

    for (const key of Object.keys(object)) visit(object[key], depth + 1)
  }

  visit(next, 0)
  return sectionToken ?? legacyToken
}

/** 留言（取第一頁）。 */
export async function getYoutubeComments(videoId: string): Promise<CommentItem[]> {
  const page: CommentPage = await getYoutubeCommentPage(videoId)
  return page.comments
}

let watchNextCache: { videoId: string; at: number; data: JsonObject } | null = null
const WATCH_NEXT_TTL_MS: number = 5 * 60 * 1000

/** 詳情與留言用同一份 next；換排序也不必重抓。 */
async function fetchWatchNext(videoId: string): Promise<JsonObject> {
  const now: number = Date.now()
  if (watchNextCache && watchNextCache.videoId === videoId && now - watchNextCache.at < WATCH_NEXT_TTL_MS) {
    return watchNextCache.data
  }
  const data: JsonObject = await fetchNextResponse(videoId)
  watchNextCache = { videoId, at: now, data }
  return data
}

/** 留言面板（含排序選單與第一頁 token）。 */
function commentsPanel(next: JsonObject): JsonObject | null {
  for (const entry of asArray(next["engagementPanels"])) {
    const panel: JsonObject | null = asObject(asObject(entry)?.["engagementPanelSectionListRenderer"])
    if (panel && String(panel["panelIdentifier"] ?? "") === COMMENTS_PANEL_ID) return panel
  }
  return null
}

/** 面板標頭的 `Top` / `Newest` 各自帶一個 continuation token。 */
function sortToken(panel: JsonObject | null, sort: CommentSort): string | null {
  const header: JsonObject | null = asObject(panel?.["header"])
  const menu: JsonObject | null = asObject(asObject(header?.["engagementPanelTitleHeaderRenderer"])?.["menu"])
  const items: unknown[] = asArray(asObject(menu?.["sortFilterSubMenuRenderer"])?.["subMenuItems"])
  const wanted: RegExp = sort === "newest" ? /new|最新/i : /top|熱門|热门|最熱|最热/i

  const matched: unknown = items.find((entry: unknown): boolean => wanted.test(String(asObject(entry)?.["title"] ?? "")))
  const chosen: JsonObject | null = asObject(matched) ?? asObject(items[sort === "newest" ? 1 : 0])
  const token: unknown = asObject(asObject(chosen?.["serviceEndpoint"])?.["continuationCommand"])?.["token"]
  return typeof token === "string" ? token : null
}

// 留言回應裡「下一頁」的 token 是 `continuationItems` 陣列的最後一項。 */

/**
 * 留言分頁。不給 cursor 就是第一頁（依 sort）；給 cursor 就接續下一批，
 * 回傳的 `cursor` 是 null 代表沒有更多。
 */
export async function getYoutubeCommentPage(videoId: string, query: CommentQuery = {}): Promise<CommentPage> {
  const sort: CommentSort = query.sort ?? "top"
  let token: string | null = query.cursor ?? null

  if (!token) {
    const next: JsonObject = await fetchWatchNext(videoId)
    const panel: JsonObject | null = commentsPanel(next)
    token =
      sortToken(panel, sort) ??
      (panel ? firstContinuationToken(panel["content"]) : null) ??
      findCommentsContinuation(next)
  }
  if (!token) return { comments: [], cursor: null }

  const response: JsonObject = await fetchNextResponse(videoId, token)
  return { comments: parseComments(response), cursor: findPageCursor(response) }
}

/** 一則留言的回覆分頁；cursor 來自 `CommentItem.replyCursor`。 */
export async function getYoutubeCommentReplies(videoId: string, cursor: string): Promise<CommentPage> {
  const response: JsonObject = await fetchNextResponse(videoId, cursor)
  return { comments: parseComments(response), cursor: findPageCursor(response) }
}

// 頻道的「影片」分頁；首頁分頁會混進別的頻道的播放清單。
const CHANNEL_VIDEOS_PARAMS: string = "EgZ2aWRlb3PyBgQKAjoA"

/** 頻道頁。 */
export async function getYoutubeChannel(
  channelId: string,
  options: { withAbout?: boolean } = {},
): Promise<ChannelDetail> {
  const withAbout: boolean = options.withAbout !== false
  // videos 分頁與 base 頁互不依賴，並行打：總共三支請求但只有兩次往返。
  const [response, base] = await Promise.all([
    fetchBrowseResponse(channelId, CHANNEL_VIDEOS_PARAMS),
    withAbout ? fetchBrowseResponse(channelId) : Promise.resolve(null),
  ])

  const detail: ChannelDetail = parseChannelDetail(channelId, response)
  const next: string | null = parseChannelVideosPage(response).next
  if (next) detail.nextPageToken = next
  if (!withAbout) return detail

  // header 那行已經精確（沒有 K/M/萬/億）就不用再打關於頁，例如小頻道的「23 videos」。
  if (detail.videoCountText && !/[KMB]|萬|億/i.test(detail.videoCountText)) return detail

  const info: AboutChannelInfo | null = await channelAboutInfo(channelId, base)
  if (info?.videoCountText) {
    const count: string = info.videoCountText.replace(/\s*(videos?|部影片|视频)\s*$/i, "").trim()
    if (count) detail.videoCountText = count
  }
  if (info?.subscriberCountText) {
    const subs: string = info.subscriberCountText
      .replace(/\s*(位)?(subscribers?|訂閱(者)?|订阅(者)?|粉絲|粉丝)\s*$/i, "")
      .trim()
    if (subs) detail.subscriberCountText = `${subs} 訂閱`
  }
  return detail
}

/** 關於頁的資訊；token 就在 base browse 的 continuation 裡（videos 分頁沒有）。 */
const aboutCache: Map<string, { info: AboutChannelInfo | null; at: number }> = new Map()
const ABOUT_TTL: number = 10 * 60 * 1000

async function channelAboutInfo(
  channelId: string,
  base: JsonObject | null,
): Promise<AboutChannelInfo | null> {
  const hit = aboutCache.get(channelId)
  if (hit && Date.now() - hit.at < ABOUT_TTL) return hit.info
  try {
    const source: JsonObject = base ?? (await fetchBrowseResponse(channelId))
    const tokens: string[] = collectContinuationTokens(source)
    // base 頁的 continuation 就是關於頁（實測兩個都是），只試第一個。
    for (const token of tokens.slice(0, 1)) {
      const page: JsonObject = await fetchBrowseContinuation(token)
      const info: AboutChannelInfo | null = parseAboutChannel(page)
      if (info) {
        aboutCache.set(channelId, { info, at: Date.now() })
        return info
      }
    }
  } catch {
    // 抓不到就讓 header 的縮寫值留著
  }
  aboutCache.set(channelId, { info: null, at: Date.now() })
  return null
}

/** 頻道影片的下一頁；cursor 是上一頁回來的 nextPageToken。 */
export async function getYoutubeChannelPage(
  cursor: string,
): Promise<{ videos: UnifiedVideoItem[]; nextPageToken?: string }> {
  const response: JsonObject = await fetchBrowseContinuation(cursor)
  const page = parseChannelVideosPage(response, cursor)
  return page.next ? { videos: page.videos, nextPageToken: page.next } : { videos: page.videos }
}

/** 排序 chip 的快取：省掉「熱門」每次第一頁都要先探測 chipBar。 */
const SORT_TOKEN_TTL: number = 10 * 60 * 1000
const sortTokenCache: Map<string, { chips: { label: string; token: string }[]; at: number }> = new Map()

async function channelSortChips(channelId: string): Promise<{ label: string; token: string }[]> {
  const hit = sortTokenCache.get(channelId)
  if (hit && Date.now() - hit.at < SORT_TOKEN_TTL) return hit.chips
  const base: JsonObject = await fetchBrowseResponse(channelId, CHANNEL_VIDEOS_PARAMS)
  const chips = extractSortChips(base)
  if (chips.some((chip: { token: string }): boolean => chip.token.length > 0)) {
    sortTokenCache.set(channelId, { chips, at: Date.now() })
  }
  return chips
}

/** 「熱門」「最早」那顆 chip；用標籤挑，找不到才退位置（實測順序是 Latest / Popular / Oldest）。 */
const SORT_CHIPS: Record<"popular" | "oldest", { pattern: RegExp; fallback: number }> = {
  popular: { pattern: /popular/i, fallback: 1 },
  oldest: { pattern: /oldest/i, fallback: 2 },
}

function sortChipToken(chips: { label: string; token: string }[], sort: "popular" | "oldest"): string {
  const rule = SORT_CHIPS[sort]
  const matched = chips.find((chip: { label: string }): boolean => rule.pattern.test(chip.label))
  const chosen = matched ?? chips[rule.fallback]
  return chosen?.token ?? ""
}

/**
 * 頻道影片的第一頁（依排序）或續頁。
 * 排序不是 browse params：用 chipBar 上那個 chip 自己的 continuation token 當第一頁。
 */
export async function getYoutubeChannelVideos(
  channelId: string,
  cursor: string | undefined,
  sort: "latest" | "popular" | "oldest",
): Promise<{ videos: UnifiedVideoItem[]; nextPageToken?: string }> {
  if (cursor) return getYoutubeChannelPage(cursor)

  if (sort !== "latest") {
    const token: string = sortChipToken(await channelSortChips(channelId), sort)
    if (token) {
      const response: JsonObject = await fetchBrowseContinuation(token)
      const page = parseChannelVideosPage(response, token)
      if (page.videos.length > 0 || page.next) {
        return page.next ? { videos: page.videos, nextPageToken: page.next } : { videos: page.videos }
      }
      sortTokenCache.delete(channelId)
    }
  }

  const response: JsonObject = await fetchBrowseResponse(channelId, CHANNEL_VIDEOS_PARAMS)
  const page = parseChannelVideosPage(response)
  return page.next ? { videos: page.videos, nextPageToken: page.next } : { videos: page.videos }
}

interface SabrPlayerInfo {
  clientKey: InnertubeClientKey
  serverAbrStreamingUrl: string
  ustreamerConfig: string
  formats: SabrFormat[]
  player: JsonObject
  poToken?: string
  clientVersion?: string
  visitorData?: string
  userAgent?: string
  /** Client playback nonce shared with the player request. */
  cpn?: string
}

/**
 * WEB or MWEB client over SABR with PO tokens. MWEB takes its tokens and web config from the
 * m.youtube.com page player (`pageMinter`), the only tokens the server accepts past the first minute;
 * WEB_SABR mints its own. IOS direct URLs ignore `pot` and get 403 past roughly the first minute.
 */
export async function loadWebSabrPlayer(
  videoId: string,
  clientKey: Extract<InnertubeClientKey, "WEB_SABR" | "MWEB"> = "WEB_SABR",
): Promise<SabrPlayerInfo> {
  const tokens: YoutubePoTokens =
    clientKey === "MWEB" ? await getYoutubePageTokens(videoId) : await getYoutubePoTokens(videoId, "WEB")
  const base: JsonObject = INNERTUBE_CLIENTS[clientKey].context
  const context: JsonObject = {
    ...base,
    client: { ...base["client"], clientVersion: tokens.clientVersion, visitorData: tokens.visitorData },
  }
  const cpn: string = makeClientPlaybackNonce()
  const player: JsonObject = await innertubePost(
    "player",
    {
      context,
      videoId,
      cpn,
      playbackContext: {
        adPlaybackContext: { pyv: true },
        contentPlaybackContext: {
          vis: 0,
          splay: false,
          lactMilliseconds: "-1",
          signatureTimestamp: tokens.signatureTimestamp,
        },
      },
      contentCheckOk: true,
      racyCheckOk: true,
      serviceIntegrityDimensions: { poToken: tokens.videoBoundPoToken },
    },
    {
      client: clientKey,
      visitorData: tokens.visitorData,
      headers: { "X-YouTube-Client-Version": tokens.clientVersion, "User-Agent": tokens.userAgent },
    },
  )
  const failure: string | null = playabilityFailure(player)
  if (failure) throw new Error(`YouTube 無法播放：${failure}`)
  const streamingData: JsonObject | null = asObject(player["streamingData"])
  const rawUrl: string = String(streamingData?.["serverAbrStreamingUrl"] ?? "")
  const playerConfig: JsonObject | null = asObject(player["playerConfig"])
  const ustreamerConfig: string = String(
    asObject(asObject(playerConfig?.["mediaCommonConfig"])?.["mediaUstreamerRequestConfig"])?.[
      "videoPlaybackUstreamerConfig"
    ] ?? "",
  )
  if (!rawUrl || !ustreamerConfig) throw new Error("WEB player 沒有 SABR 串流設定")
  const formats: SabrFormat[] = parseAdaptiveFormats(asArray(streamingData?.["adaptiveFormats"]))
  if (formats.length === 0) throw new Error("WEB player 沒有可用格式")
  return {
    clientKey,
    serverAbrStreamingUrl: await decipherStreamingUrl(rawUrl, tokens.jsUrl),
    ustreamerConfig,
    formats,
    player,
    poToken: tokens.visitorBoundPoToken,
    clientVersion: tokens.clientVersion,
    visitorData: tokens.visitorData,
    userAgent: tokens.userAgent,
    cpn,
  }
}

/** WEB_SABR first: it answers for guests and for signed-in restricted videos alike. */
const SABR_CLIENT_ORDER: InnertubeClientKey[] = ["WEB_SABR", "MWEB"]

async function loadSabrPlayer(videoId: string): Promise<SabrPlayerInfo | null> {
  for (const clientKey of SABR_CLIENT_ORDER) {
    try {
      const player: JsonObject = await fetchPlayerResponse(videoId, clientKey)
      if (playabilityFailure(player)) continue
      const streamingData: JsonObject | null = asObject(player["streamingData"])
      if (!streamingData) continue
      const serverAbrStreamingUrl: string = String(streamingData["serverAbrStreamingUrl"] ?? "")
      const playerConfig: JsonObject | null = asObject(player["playerConfig"])
      const ustreamerConfig: string = String(
        asObject(
          asObject(asObject(playerConfig?.["mediaCommonConfig"])?.["mediaUstreamerRequestConfig"]),
        )?.["videoPlaybackUstreamerConfig"] ?? "",
      )

      const formats: SabrFormat[] = parseAdaptiveFormats(asArray(streamingData["adaptiveFormats"]))
      if (formats.length === 0) continue
      const hasDirectUrls: boolean = formats.some((f: SabrFormat): boolean => Boolean(f.url))
      if (!hasDirectUrls && (!serverAbrStreamingUrl || !ustreamerConfig)) continue
      return {
        clientKey,
        serverAbrStreamingUrl: hasDirectUrls ? "" : serverAbrStreamingUrl,
        ustreamerConfig,
        formats,
        player,
      }
    } catch (_error) {
      // 換下一個 client
    }
  }
  return null
}

function closestQuality(qualities: VideoQualityTrack[], preferredHeight: number): VideoQualityTrack | undefined {
  let best: VideoQualityTrack | undefined
  let bestDelta: number = Number.MAX_SAFE_INTEGER
  for (const quality of qualities) {
    if (quality.delivery === "sabr" && quality.height === 0) continue
    const delta: number = Math.abs((quality.height || preferredHeight) - preferredHeight)
    if (delta < bestDelta) {
      bestDelta = delta
      best = quality
    }
  }
  return best
}

/** One playable route: its primary URL, switchable qualities and the player response for metadata. */
interface ResolvedRoute {
  delivery: "hls" | "sabr"
  primaryUrl: string
  qualities: VideoQualityTrack[]
  audioTracks: AudioStreamTrack[]
  player: JsonObject
  /** SABR：該畫質的影片與音訊時間軸都讀到索引才回 true。 */
  prepareQuality?: (qualityId: string) => Promise<boolean>
}

/** VISIONOS HLS: no PO token and seekable; without visitorData some videos come back LOGIN_REQUIRED. */
async function resolveHlsRoute(videoId: string): Promise<ResolvedRoute> {
  const visitorData: string | undefined = getYoutubeAuth().visitorData ?? (await getAnonymousVisitorData())
  const player: JsonObject = await fetchPlayerResponse(videoId, "VISIONOS", { visitorData })
  const failure: string | null = playabilityFailure(player)
  if (failure) throw new Error(`YouTube 無法播放：${failure}`)
  const manifestUrl: string = String(asObject(player["streamingData"])?.["hlsManifestUrl"] ?? "")
  if (!manifestUrl) throw new Error("YouTube 沒有 HLS 串流")
  const resolved = await resolveHlsManifest(manifestUrl)
  return { delivery: "hls", primaryUrl: resolved.primaryUrl, qualities: resolved.qualities, audioTracks: [], player }
}

/**
 * MWEB SABR with page-minted tokens, IOS direct URLs as the fallback. The IOS player also supplies
 * direct URLs for the init and index ranges of the MWEB formats.
 */
async function resolveSabrRoute(videoId: string): Promise<ResolvedRoute> {
  const web: SabrPlayerInfo | null = await loadWebSabrPlayer(videoId, "MWEB").catch(() => null)
  const info: SabrPlayerInfo | null = web ?? (await loadSabrPlayer(videoId))
  if (!info) throw new Error("YouTube 沒有 SABR 串流")
  const audio: SabrFormat | undefined = pickBestAudioFormat(info.formats)
  if (!audio) throw new Error("YouTube SABR 沒有音訊軌")
  const config: SabrSessionConfig = {
    videoId,
    serverAbrStreamingUrl: info.serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: info.ustreamerConfig,
    formats: info.formats,
    clientKey: info.clientKey,
    poToken: info.poToken,
    clientVersion: info.clientVersion,
    visitorData: info.visitorData,
    userAgent: info.userAgent,
    cpn: info.cpn,
    refreshPoToken: web
      ? (staleToken: string): Promise<string> => refreshYoutubePageToken(videoId, staleToken)
      : undefined,
  }
  const sessions: SabrQualitySession[] = pickVideoFormats(info.formats, true).map(
    (video: SabrFormat): SabrQualitySession => createSabrQualitySession(config, video, audio),
  )
  const qualities: VideoQualityTrack[] = sessions.map((entry: SabrQualitySession): VideoQualityTrack => entry.quality)
  if (qualities.length === 0) throw new Error("YouTube SABR 沒有影片軌")
  const prepareQuality = async (qualityId: string): Promise<boolean> => {
    const entry: SabrQualitySession | undefined = sessions.find((item: SabrQualitySession): boolean => item.quality.id === qualityId)
    return entry ? entry.prepare() : false
  }
  const audioTracks: AudioStreamTrack[] = info.formats
    .filter((format: SabrFormat): boolean => format.isAudio && format.mimeType.startsWith("audio/mp4"))
    .map((format: SabrFormat): AudioStreamTrack => audioTrackOf(format))
  return { delivery: "sabr", primaryUrl: qualities[0].url, qualities, audioTracks, player: info.player, prepareQuality }
}

/** 解析可播放串流。直播走自己的取流路線，不碰 HLS／SABR 的挑選流程。 */
export async function resolveYoutubeStream(
  videoId: string,
  mode: YoutubeStreamPreference = "auto",
  preferredHeight: number = 0,
  isLive: boolean = false,
): Promise<StreamManifest> {
  if (isLive) return resolveYoutubeLiveStream(videoId)

  const routes: Array<(id: string) => Promise<ResolvedRoute>> =
    mode === "sabr" ? [resolveSabrRoute, resolveHlsRoute] : [resolveHlsRoute, resolveSabrRoute]
  let route: ResolvedRoute | null = null
  let chosen: VideoQualityTrack | undefined
  let firstError: unknown = null
  for (const resolve of routes) {
    try {
      const candidate: ResolvedRoute = await resolve(videoId)
      const pick: VideoQualityTrack | undefined = preferredHeight > 0 ? closestQuality(candidate.qualities, preferredHeight) : undefined
      // SABR 沒有真正的分段時間軸就不播：估算的時間軸會讓字幕與拖動都對不上。
      if (candidate.prepareQuality && !(await candidate.prepareQuality(pick?.id ?? candidate.qualities[0].id))) {
        throw new Error("YouTube SABR 讀不到分段索引")
      }
      route = candidate
      chosen = pick
      break
    } catch (error) {
      if (firstError === null) firstError = error
    }
  }
  if (!route) {
    // 呼叫端不知道這是直播（例如貼上連結、推薦卡片沒帶 isLive）時，用直播路線再試一次。
    try {
      return await resolveYoutubeLiveStream(videoId)
    } catch {
      throw firstError instanceof Error ? firstError : new Error("找不到可播放的 YouTube 串流")
    }
  }

  const { primaryUrl, qualities, prepareQuality } = route
  const details: JsonObject = asObject(route.player["videoDetails"]) ?? {}

  return {
    provider: "yt",
    rawId: videoId,
    delivery: route.delivery,
    primaryUrl: chosen?.url ?? primaryUrl,
    // 交付的是本地 HLS；native 才能進子母畫面，先試能不能直接吃。
    backend: "native",
    qualities,
    audioTracks: route.audioTracks,
    subtitles: parseSubtitleTracks(route.player),
    isLive: Boolean(details["isLive"]),
    duration: Number(details["lengthSeconds"] ?? 0),
    resolveQuality: async (
      qualityId: string,
    ): Promise<{ url: string; backend: "auto" | "native" | "system" | "remux" }> => {
      const quality: VideoQualityTrack | undefined = qualities.find(
        (entry: VideoQualityTrack): boolean => entry.id === qualityId,
      )
      if (quality && prepareQuality && !(await prepareQuality(quality.id))) {
        throw new Error("這個畫質暫時無法播放")
      }
      return { url: quality?.url ?? primaryUrl, backend: "native" }
    },
  }
}
