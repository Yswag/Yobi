
import type {
  ChannelDetail,
  CommentItem,
  CommentPage,
  CommentQuery,
  Provider,
  StreamManifest,
  UnifiedVideoItem,
  VideoDetail,
  VideoPage,
  YoutubeStreamPreference,
} from "../types/index"
import {
  getYoutubeChannel,
  getYoutubeChannelVideos,
  getYoutubeCommentPage,
  getYoutubeCommentReplies,
  getYoutubeLiveViewers,
  getYoutubeSearchSuggestions,
  getYoutubeTrending,
  getYoutubeVideoDetail,
  parseYoutubeInput,
  resolveYoutubeStream,
  searchYoutubeChannelVideos,
  searchYoutubeVideos,
} from "./youtube/index"
import {
  getBiliChannel,
  getBiliCommentPage,
  getBiliCommentReplies,
  getBiliSearchSuggestions,
  getBiliTrending,
  getBiliVideoDetail,
  parseBiliInput,
  resolveBiliStream,
  searchBiliChannelVideos,
  searchBiliVideos,
} from "./bilibili/index"

export { parseYoutubeInput } from "./youtube/input"
export { getYoutubeLiveViewers } from "./youtube/index"
export { invalidateYoutubeAuthCache } from "./youtube/innertube"
export { parseBiliInput } from "./bilibili/input"
export { fetchBiliDanmakuXml, resolveBiliShortUrl } from "./bilibili/index"
export { setBiliLineSwitchListener, warmBiliStartLazy as warmStreamStart } from "./bilibili/hooks"
export * from "./storage"
export * from "./auth"
export * from "./sponsorblock"
export * from "./localProxy"
export { clearHlsRelays } from "./hlsRelay"
export { prefetchedAheadBytes, prefetchWindow, releaseAllPrefetchers } from "./prefetch"
export { clearMediaSessions, lastMediaFailure, stopMediaServer } from "./mediaServer"
export { currentDownloadBps, lastDownloadHost } from "./netMeter"

let pageMinterModule: typeof import("./youtube/pageMinter") | null = null

export function warmYoutubePageMinter(seedVideoId?: string): void {
  void import("./youtube/pageMinter")
    .then((mod): void => {
      pageMinterModule = mod
      mod.warmYoutubePageMinter(seedVideoId)
    })
    .catch((): void => undefined)
}

export function disposeYoutubePageMinter(): void {
  pageMinterModule?.disposeYoutubePageMinter()
}

export type FeedFilter = "all" | Provider

export interface DetectedInputLink {
  provider: Provider
  rawId: string
}

function interleave(groups: UnifiedVideoItem[][]): UnifiedVideoItem[] {
  const merged: UnifiedVideoItem[] = []
  const seen: Set<string> = new Set()
  const longest: number = groups.reduce((max: number, group: UnifiedVideoItem[]): number => Math.max(max, group.length), 0)
  for (let i = 0; i < longest; i++) {
    for (const group of groups) {
      const item: UnifiedVideoItem | undefined = group[i]
      if (!item || seen.has(item.id)) continue
      seen.add(item.id)
      merged.push(item)
    }
  }
  return merged
}

type ProviderPager = (cursor?: string) => Promise<VideoPage>
type CombinedCursor = Partial<Record<Provider, string>>

interface ProviderPageResult {
  provider: Provider
  page: VideoPage
  error: unknown
}

const FEED_PROVIDERS: Provider[] = ["yt", "bili"]

function decodeCombinedCursor(raw: string): CombinedCursor {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    const cursor: CombinedCursor = {}
    for (const provider of FEED_PROVIDERS) {
      const value: unknown = (parsed as Record<string, unknown>)[provider]
      if (typeof value === "string" && value) cursor[provider] = value
    }
    return cursor
  } catch (_error) {
    return {}
  }
}

async function combinedPage(pagers: Record<Provider, ProviderPager>, cursor?: string): Promise<VideoPage> {
  const state: CombinedCursor | null = cursor ? decodeCombinedCursor(cursor) : null
  const active: Provider[] = FEED_PROVIDERS.filter((provider: Provider): boolean => !state || !!state[provider])
  if (active.length === 0) return { videos: [] }

  const results: ProviderPageResult[] = await Promise.all(
    active.map(async (provider: Provider): Promise<ProviderPageResult> => {
      const own: string | undefined = state?.[provider]
      try {
        return { provider, page: await pagers[provider](own), error: null }
      } catch (error) {
        return { provider, page: own ? { videos: [], nextPageToken: own } : { videos: [] }, error }
      }
    }),
  )
  const failed: ProviderPageResult | undefined = results.find((result: ProviderPageResult): boolean => result.error !== null)
  if (failed && results.every((result: ProviderPageResult): boolean => result.error !== null)) throw failed.error

  const next: CombinedCursor = {}
  for (const result of results) {
    if (result.page.nextPageToken) next[result.provider] = result.page.nextPageToken
  }
  const videos: UnifiedVideoItem[] = interleave(results.map((result: ProviderPageResult): UnifiedVideoItem[] => result.page.videos))
  return Object.keys(next).length > 0 ? { videos, nextPageToken: JSON.stringify(next) } : { videos }
}

export function detectInputLink(input: string): DetectedInputLink | null {
  const trimmed: string = (input ?? "").trim()
  if (!trimmed) return null

  const youtubeId: string | null = parseYoutubeInput(trimmed)
  if (youtubeId) return { provider: "yt", rawId: youtubeId }

  const bili: { bvid?: string; aid?: number } | null = parseBiliInput(trimmed)
  if (bili) {
    if (bili.bvid) return { provider: "bili", rawId: bili.bvid }
    if (bili.aid) return { provider: "bili", rawId: `av${bili.aid}` }
  }
  return null
}

export async function getHomeFeed(filter: FeedFilter = "all", cursor?: string): Promise<VideoPage> {
  const pagers: Record<Provider, ProviderPager> = { yt: getYoutubeTrending, bili: getBiliTrending }
  if (filter !== "all") return pagers[filter](cursor)
  return combinedPage(pagers, cursor)
}

export async function searchVideos(query: string, filter: FeedFilter = "all", cursor?: string): Promise<VideoPage> {
  const trimmed: string = (query ?? "").trim()
  if (!trimmed) return { videos: [] }
  const pagers: Record<Provider, ProviderPager> = {
    yt: (own?: string): Promise<VideoPage> => searchYoutubeVideos(trimmed, own),
    bili: (own?: string): Promise<VideoPage> => searchBiliVideos(trimmed, own),
  }
  if (filter !== "all") return pagers[filter](cursor)
  return combinedPage(pagers, cursor)
}

export async function getSearchSuggestions(query: string, provider: Provider = "yt"): Promise<string[]> {
  const trimmed: string = (query ?? "").trim()
  if (!trimmed) return []
  if (provider === "bili") return getBiliSearchSuggestions(trimmed)
  return getYoutubeSearchSuggestions(trimmed)
}

export async function getVideoDetail(provider: Provider, rawId: string): Promise<VideoDetail> {
  if (provider === "bili") return getBiliVideoDetail(rawId)
  return getYoutubeVideoDetail(rawId)
}

export interface ResolveStreamOptions {
  cid?: number
  mode?: YoutubeStreamPreference
  preferredHeight?: number
  isLive?: boolean
}

export async function resolveStream(
  provider: Provider,
  rawId: string,
  options: ResolveStreamOptions = {},
): Promise<StreamManifest> {
  if (provider === "bili") {
    return resolveBiliStream(rawId, options.cid, options.preferredHeight)
  }
  return resolveYoutubeStream(rawId, options.mode ?? "auto", options.preferredHeight ?? 0, options.isLive === true)
}

export async function getComments(provider: Provider, rawId: string): Promise<CommentItem[]> {
  const page: CommentPage = await getCommentPage(provider, rawId)
  return page.comments
}

export async function getCommentPage(
  provider: Provider,
  rawId: string,
  query: CommentQuery = {},
): Promise<CommentPage> {
  if (provider === "bili") return getBiliCommentPage(rawId, query)
  return getYoutubeCommentPage(rawId, query)
}

export async function getCommentReplies(
  provider: Provider,
  rawId: string,
  commentId: string,
  cursor: string,
): Promise<CommentPage> {
  if (provider === "bili") return getBiliCommentReplies(rawId, commentId, { cursor })
  return getYoutubeCommentReplies(rawId, cursor)
}

export async function getChannel(
  provider: Provider,
  rawId: string,
  options: { withAbout?: boolean } = {},
): Promise<ChannelDetail> {
  if (provider === "bili") return getBiliChannel(rawId)
  return getYoutubeChannel(rawId, options)
}

export type ChannelSort = "latest" | "popular" | "oldest"

export async function getChannelVideos(
  provider: Provider,
  rawId: string,
  cursor: string | undefined,
  sort: ChannelSort = "latest",
): Promise<VideoPage> {
  if (provider === "bili") {
    const detail: ChannelDetail = await getBiliChannel(rawId, Number.parseInt(cursor ?? "1", 10) || 1, sort)
    return detail.nextPageToken
      ? { videos: detail.videos, nextPageToken: detail.nextPageToken }
      : { videos: detail.videos }
  }
  return getYoutubeChannelVideos(rawId, cursor, sort)
}

export async function searchChannelVideos(
  provider: Provider,
  rawId: string,
  query: string,
  cursor: string | undefined,
): Promise<VideoPage> {
  if (provider === "bili") return searchBiliChannelVideos(rawId, query, cursor)
  return searchYoutubeChannelVideos(rawId, query, cursor)
}
