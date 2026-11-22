
import type {
  ChannelDetail,
  CommentItem,
  CommentPage,
  CommentQuery,
  Provider,
  StreamManifest,
  UnifiedVideoItem,
  VideoDetail,
  YoutubeStreamPreference,
} from "../types"
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

export { parseYoutubeInput } from "./youtube"
export { getYoutubeLiveViewers } from "./youtube"
export { invalidateYoutubeAuthCache } from "./youtube/innertube"
export { disposeYoutubePageMinter, warmYoutubePageMinter } from "./youtube/pageMinter"
export { parseBiliInput, fetchBiliDanmakuXml, resolveBiliShortUrl } from "./bilibili/index"
export { setBiliLineSwitchListener } from "./bilibili/chunkSource"
export { warmBiliStart as warmStreamStart } from "./bilibili/dashMpd"
export * from "./storage"
export * from "./auth"
export * from "./sponsorblock"
export * from "./localProxy"
export { clearHlsRelays } from "./hlsRelay"
export { prefetchedAheadBytes, prefetchWindow, releaseAllPrefetchers } from "./prefetch"
export { clearMediaSessions, lastMediaFailure, stopMediaServer } from "./mediaServer"
export { currentDownloadBps, lastDownloadHost } from "./netMeter"

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

async function safe<T>(task: Promise<T>, fallback: T): Promise<T> {
  try {
    return await task
  } catch (_error) {
    return fallback
  }
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

export async function getHomeFeed(filter: FeedFilter = "all"): Promise<UnifiedVideoItem[]> {
  if (filter === "yt") return getYoutubeTrending()
  if (filter === "bili") return getBiliTrending()

  const results: UnifiedVideoItem[][] = await Promise.all([
    safe<UnifiedVideoItem[]>(getYoutubeTrending(), []),
    safe<UnifiedVideoItem[]>(getBiliTrending(), []),
  ])
  return interleave(results)
}

export async function searchVideos(query: string, filter: FeedFilter = "all"): Promise<UnifiedVideoItem[]> {
  const trimmed: string = (query ?? "").trim()
  if (!trimmed) return []
  if (filter === "yt") return searchYoutubeVideos(trimmed)
  if (filter === "bili") return searchBiliVideos(trimmed)

  const results: UnifiedVideoItem[][] = await Promise.all([
    safe<UnifiedVideoItem[]>(searchYoutubeVideos(trimmed), []),
    safe<UnifiedVideoItem[]>(searchBiliVideos(trimmed), []),
  ])
  return interleave(results)
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

export interface ChannelVideoPage {
  videos: UnifiedVideoItem[]
  nextPageToken?: string
}

export type ChannelSort = "latest" | "popular" | "oldest"

export async function getChannelVideos(
  provider: Provider,
  rawId: string,
  cursor: string | undefined,
  sort: ChannelSort = "latest",
): Promise<ChannelVideoPage> {
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
): Promise<ChannelVideoPage> {
  if (provider === "bili") return searchBiliChannelVideos(rawId, query, cursor)
  return searchYoutubeChannelVideos(rawId, query, cursor)
}
