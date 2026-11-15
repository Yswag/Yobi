/**
 * 跨平台統一服務入口。
 *
 * 把 YouTube / BiliBili 的差異收斂在這一層，UI 只認 `Provider` 與統一模型。
 */

import type {
  ChannelDetail,
  CommentItem,
  Provider,
  StreamManifest,
  UnifiedVideoItem,
  VideoDetail,
  YoutubeStreamPreference,
} from "../types"
import {
  getYoutubeChannel,
  getYoutubeComments,
  getYoutubeSearchSuggestions,
  getYoutubeTrending,
  getYoutubeVideoDetail,
  parseYoutubeInput,
  resolveYoutubeStream,
  searchYoutubeVideos,
} from "./youtube"
import {
  getBiliChannel,
  getBiliComments,
  getBiliSearchSuggestions,
  getBiliTrending,
  getBiliVideoDetail,
  parseBiliInput,
  resolveBiliStream,
  searchBiliVideos,
} from "./bilibili"

export { parseYoutubeInput } from "./youtube"
export { parseBiliInput, fetchBiliDanmakuXml, resolveBiliShortUrl } from "./bilibili"
export * from "./storage"
export * from "./auth"
export * from "./sponsorblock"
export * from "./localProxy"
export * from "./downloads"

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

/** 判斷輸入是 YouTube 連結/ID 還是 BiliBili BV/AV 番號。 */
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

/** 首頁推薦；`all` 時兩平台平行抓取後交錯排列。 */
export async function getHomeFeed(filter: FeedFilter = "all"): Promise<UnifiedVideoItem[]> {
  if (filter === "yt") return getYoutubeTrending()
  if (filter === "bili") return getBiliTrending()

  const results: UnifiedVideoItem[][] = await Promise.all([
    safe<UnifiedVideoItem[]>(getYoutubeTrending(), []),
    safe<UnifiedVideoItem[]>(getBiliTrending(), []),
  ])
  return interleave(results)
}

/** 搜尋；`all` 時兩平台平行搜尋後交錯排列。 */
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

/** 搜尋建議（預設 YouTube）。 */
export async function getSearchSuggestions(query: string, provider: Provider = "yt"): Promise<string[]> {
  const trimmed: string = (query ?? "").trim()
  if (!trimmed) return []
  if (provider === "bili") return getBiliSearchSuggestions(trimmed)
  return getYoutubeSearchSuggestions(trimmed)
}

/** 影片詳情。 */
export async function getVideoDetail(provider: Provider, rawId: string): Promise<VideoDetail> {
  if (provider === "bili") return getBiliVideoDetail(rawId)
  return getYoutubeVideoDetail(rawId)
}

export interface ResolveStreamOptions {
  cid?: number
  mode?: YoutubeStreamPreference
  preferredHeight?: number
}

/** 解析可播放串流。 */
export async function resolveStream(
  provider: Provider,
  rawId: string,
  options: ResolveStreamOptions = {},
): Promise<StreamManifest> {
  if (provider === "bili") {
    return resolveBiliStream(rawId, options.cid, options.preferredHeight)
  }
  return resolveYoutubeStream(rawId, options.mode ?? "auto", options.preferredHeight ?? 0)
}

/** 留言。 */
export async function getComments(provider: Provider, rawId: string): Promise<CommentItem[]> {
  if (provider === "bili") return getBiliComments(rawId)
  return getYoutubeComments(rawId)
}

/** 頻道 / UP 主。 */
export async function getChannel(provider: Provider, rawId: string): Promise<ChannelDetail> {
  if (provider === "bili") return getBiliChannel(rawId)
  return getYoutubeChannel(rawId)
}
