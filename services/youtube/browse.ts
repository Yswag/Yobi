import { fetch } from "scripting"
import type {
  ChannelDetail,
  CommentItem,
  CommentPage,
  CommentQuery,
  CommentSort,
  UnifiedVideoItem,
  VideoDetail,
  VideoPage,
} from "../../types/index"
import {
  fetchBrowseContinuation,
  fetchBrowseResponse,
  fetchNextResponse,
  fetchPlayerResponse,
  fetchSearchContinuation,
  fetchSearchResponse,
  type JsonObject,
} from "./innertube"
import {
  collectContinuationTokens,
  extractSortChips,
  extractVideoItems,
  findFeedContinuation,
  findPageCursor,
  parseAboutChannel,
  parseChannelDetail,
  parseChannelVideosPage,
  parseComments,
  parseLiveViewerCount,
  parseVideoDetail,
  type AboutChannelInfo,
} from "./parsers"
import { asArray, asObject } from "./parsePrimitives"
import { fetchWatchNext } from "./watchNext"

const SUGGEST_ENDPOINT: string = "https://suggestqueries-clients6.youtube.com/complete/search"
const COMMENTS_PANEL_ID: string = "engagement-panel-comments-section"
const CHANNEL_VIDEOS_PARAMS: string = "EgZ2aWRlb3PyBgQKAjoA"
const CHANNEL_SEARCH_PARAMS: string = "EgZzZWFyY2jyBgQKAloA"
const LIVE_VIEWERS_MAX_AGE_MS: number = 25_000
const ABOUT_TTL: number = 10 * 60 * 1000
const SORT_TOKEN_TTL: number = 10 * 60 * 1000
const MAX_CHANNEL_CACHE: number = 32
const TRENDING_FALLBACK_QUERIES: string[] = ["music", "news", "gaming"]

interface TrendingCursor {
  browse?: string
  searches?: string[]
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

export function playabilityFailure(player: JsonObject): string | null {
  const status: JsonObject | null = asObject(player["playabilityStatus"])
  if (!status) return null
  const value: string = String(status["status"] ?? "")
  if (!value || value === "OK") return null
  return String(status["reason"] ?? value)
}

function putBounded<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  if (!cache.has(key) && cache.size >= limit) {
    const oldest: string | undefined = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

function pageOf(videos: UnifiedVideoItem[], next: string | null): VideoPage {
  return next ? { videos, nextPageToken: next } : { videos }
}

export async function searchYoutubeVideos(query: string, cursor?: string): Promise<VideoPage> {
  const response: JsonObject = cursor
    ? await fetchSearchContinuation(cursor)
    : await fetchSearchResponse(query)
  return pageOf(extractVideoItems(response), findFeedContinuation(response))
}

function encodeTrendingCursor(cursor: TrendingCursor): string {
  return JSON.stringify(cursor)
}

function decodeTrendingCursor(raw: string): TrendingCursor {
  try {
    const parsed: unknown = JSON.parse(raw)
    const object: JsonObject | null = asObject(parsed)
    if (typeof object?.["browse"] === "string") return { browse: object["browse"] }
    const searches: unknown[] = asArray(object?.["searches"])
    if (searches.length === TRENDING_FALLBACK_QUERIES.length) {
      return { searches: searches.map((entry: unknown): string => (typeof entry === "string" ? entry : "")) }
    }
  } catch (_error) {
  }
  return {}
}

async function trendingFromSearches(cursors: string[] | null): Promise<VideoPage> {
  const pages: VideoPage[] = await Promise.all(
    TRENDING_FALLBACK_QUERIES.map(async (query: string, index: number): Promise<VideoPage> => {
      const cursor: string | undefined = cursors ? cursors[index] : undefined
      if (cursors && !cursor) return { videos: [] }
      try {
        return await searchYoutubeVideos(query, cursor)
      } catch (_error) {
        return cursor ? { videos: [], nextPageToken: cursor } : { videos: [] }
      }
    }),
  )

  const merged: UnifiedVideoItem[] = []
  const longest: number = pages.reduce(
    (max: number, page: VideoPage): number => Math.max(max, page.videos.length),
    0,
  )
  for (let i = 0; i < longest; i++) {
    for (const page of pages) {
      const item: UnifiedVideoItem | undefined = page.videos[i]
      if (item) merged.push(item)
    }
  }

  const nextCursors: string[] = pages.map((page: VideoPage): string => page.nextPageToken ?? "")
  const hasNext: boolean = nextCursors.some((token: string): boolean => token.length > 0)
  return pageOf(dedupeItems(merged), hasNext ? encodeTrendingCursor({ searches: nextCursors }) : null)
}

function trendingBrowsePage(response: JsonObject): VideoPage {
  const next: string | null = findFeedContinuation(response)
  return pageOf(extractVideoItems(response), next ? encodeTrendingCursor({ browse: next }) : null)
}

export async function getYoutubeTrending(cursor?: string): Promise<VideoPage> {
  if (cursor) {
    const state: TrendingCursor = decodeTrendingCursor(cursor)
    if (state.browse) return trendingBrowsePage(await fetchBrowseContinuation(state.browse))
    if (state.searches) return trendingFromSearches(state.searches)
    return { videos: [] }
  }

  try {
    const page: VideoPage = trendingBrowsePage(await fetchBrowseResponse("FEwhat_to_watch"))
    if (page.videos.length > 0) return page
  } catch (_error) {
  }
  return trendingFromSearches(null)
}

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

export async function getYoutubeVideoDetail(videoId: string): Promise<VideoDetail> {
  const [player, next] = await Promise.all([
    fetchPlayerResponse(videoId, "WEB_SABR"),
    fetchWatchNext(videoId).catch((): null => null),
  ])
  if (!asObject(player["videoDetails"])?.["title"]) {
    const failure: string | null = playabilityFailure(player)
    throw new Error(failure ? `YouTube 無法播放：${failure}` : "YouTube 沒有影片資訊")
  }
  return parseVideoDetail(videoId, player, next)
}

export async function getYoutubeLiveViewers(videoId: string): Promise<number | undefined> {
  try {
    return parseLiveViewerCount(await fetchWatchNext(videoId, { maxAgeMs: LIVE_VIEWERS_MAX_AGE_MS }))
  } catch (_error) {
    return undefined
  }
}

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
    const command: JsonObject | null = asObject(
      asObject(object["continuationEndpoint"])?.["continuationCommand"],
    )
    if (command && typeof command["token"] === "string") {
      token = String(command["token"])
      return
    }
    for (const key of Object.keys(object)) visit(object[key], depth + 1)
  }

  visit(node, 0)
  return token
}

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

export async function getYoutubeComments(videoId: string): Promise<CommentItem[]> {
  const page: CommentPage = await getYoutubeCommentPage(videoId)
  return page.comments
}

function commentsPanel(next: JsonObject): JsonObject | null {
  for (const entry of asArray(next["engagementPanels"])) {
    const panel: JsonObject | null = asObject(asObject(entry)?.["engagementPanelSectionListRenderer"])
    if (panel && String(panel["panelIdentifier"] ?? "") === COMMENTS_PANEL_ID) return panel
  }
  return null
}

function sortToken(panel: JsonObject | null, sort: CommentSort): string | null {
  const header: JsonObject | null = asObject(panel?.["header"])
  const menu: JsonObject | null = asObject(
    asObject(header?.["engagementPanelTitleHeaderRenderer"])?.["menu"],
  )
  const items: unknown[] = asArray(asObject(menu?.["sortFilterSubMenuRenderer"])?.["subMenuItems"])
  const wanted: RegExp = sort === "newest" ? /new|最新/i : /top|熱門|热门|最熱|最热/i

  const matched: unknown = items.find((entry: unknown): boolean =>
    wanted.test(String(asObject(entry)?.["title"] ?? "")),
  )
  const chosen: JsonObject | null = asObject(matched) ?? asObject(items[sort === "newest" ? 1 : 0])
  const token: unknown = asObject(asObject(chosen?.["serviceEndpoint"])?.["continuationCommand"])?.["token"]
  return typeof token === "string" ? token : null
}

export async function getYoutubeCommentPage(
  videoId: string,
  query: CommentQuery = {},
): Promise<CommentPage> {
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

export async function getYoutubeCommentReplies(videoId: string, cursor: string): Promise<CommentPage> {
  const response: JsonObject = await fetchNextResponse(videoId, cursor)
  return { comments: parseComments(response), cursor: findPageCursor(response) }
}

const aboutCache: Map<string, { info: AboutChannelInfo | null; at: number }> = new Map()
const sortTokenCache: Map<string, { chips: { label: string; token: string }[]; at: number }> = new Map()

function rememberSortChips(channelId: string, response: JsonObject): { label: string; token: string }[] {
  const chips = extractSortChips(response)
  if (chips.some((chip: { token: string }): boolean => chip.token.length > 0)) {
    putBounded(sortTokenCache, channelId, { chips, at: Date.now() }, MAX_CHANNEL_CACHE)
  }
  return chips
}

async function channelAboutInfo(channelId: string): Promise<AboutChannelInfo | null> {
  const hit = aboutCache.get(channelId)
  if (hit && Date.now() - hit.at < ABOUT_TTL) return hit.info
  try {
    const source: JsonObject = await fetchBrowseResponse(channelId)
    const tokens: string[] = collectContinuationTokens(source)
    for (const token of tokens.slice(0, 1)) {
      const page: JsonObject = await fetchBrowseContinuation(token)
      const info: AboutChannelInfo | null = parseAboutChannel(page)
      if (info) {
        putBounded(aboutCache, channelId, { info, at: Date.now() }, MAX_CHANNEL_CACHE)
        return info
      }
    }
  } catch {
  }
  putBounded(aboutCache, channelId, { info: null, at: Date.now() }, MAX_CHANNEL_CACHE)
  return null
}

export async function getYoutubeChannel(
  channelId: string,
  options: { withAbout?: boolean } = {},
): Promise<ChannelDetail> {
  const withAbout: boolean = options.withAbout !== false
  const response: JsonObject = await fetchBrowseResponse(channelId, CHANNEL_VIDEOS_PARAMS)
  rememberSortChips(channelId, response)

  const detail: ChannelDetail = parseChannelDetail(channelId, response)
  const next: string | null = parseChannelVideosPage(response).next
  if (next) detail.nextPageToken = next
  if (!withAbout) return detail

  if (detail.videoCountText && !/[KMB]|萬|億/i.test(detail.videoCountText)) return detail

  const info: AboutChannelInfo | null = await channelAboutInfo(channelId)
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

export async function getYoutubeChannelPage(
  cursor: string,
): Promise<{ videos: UnifiedVideoItem[]; nextPageToken?: string }> {
  const response: JsonObject = await fetchBrowseContinuation(cursor)
  const page = parseChannelVideosPage(response, cursor)
  return page.next ? { videos: page.videos, nextPageToken: page.next } : { videos: page.videos }
}

async function channelSortChips(channelId: string): Promise<{ label: string; token: string }[]> {
  const hit = sortTokenCache.get(channelId)
  if (hit && Date.now() - hit.at < SORT_TOKEN_TTL) return hit.chips
  const base: JsonObject = await fetchBrowseResponse(channelId, CHANNEL_VIDEOS_PARAMS)
  return rememberSortChips(channelId, base)
}

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
  rememberSortChips(channelId, response)
  const page = parseChannelVideosPage(response)
  return page.next ? { videos: page.videos, nextPageToken: page.next } : { videos: page.videos }
}

export async function searchYoutubeChannelVideos(
  channelId: string,
  query: string,
  cursor: string | undefined,
): Promise<{ videos: UnifiedVideoItem[]; nextPageToken?: string }> {
  if (cursor) return getYoutubeChannelPage(cursor)
  const response: JsonObject = await fetchBrowseResponse(channelId, CHANNEL_SEARCH_PARAMS, query)
  const page = parseChannelVideosPage(response)
  return page.next ? { videos: page.videos, nextPageToken: page.next } : { videos: page.videos }
}
