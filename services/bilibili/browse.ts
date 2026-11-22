import { fetch } from "scripting"
import type {
  ChannelDetail,
  Provider,
  UnifiedVideoItem,
  VideoDetail,
  VideoPagePart,
} from "../../types"
import { reportError } from "../errors"
import {
  BILI_API,
  cleanText,
  fetchView,
  fetchViewDetail,
  formatCount,
  imageUrl,
  mapItem,
  mapItems,
  mayTryNextEndpoint,
  numberOrUndefined,
  raiseIfBanned,
  RELATED_URL,
  resolveIds,
} from "./meta"
import { biliFetchJson, getBiliRequestHeaders } from "./wbi"

export async function getBiliTrending(page: number = 1): Promise<UnifiedVideoItem[]> {
  try {
    const result: any = await biliFetchJson<any>(
      `${BILI_API}/x/web-interface/wbi/index/top/feed/rcmd`,
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
      const items: UnifiedVideoItem[] = mapItems(result.data?.item)
      if (items.length) return items
    }
    raiseIfBanned(result, "trending.rcmd")
  } catch (error) {
    if (!mayTryNextEndpoint("trending.rcmd", error)) throw error
  }

  const popular: any = await biliFetchJson<any>(`${BILI_API}/x/web-interface/popular`, {
    ps: 20,
    pn: page,
  })
  if (popular?.code === 0) return mapItems(popular.data?.list)
  return []
}

export async function searchBiliVideos(
  keyword: string,
  page: number = 1,
): Promise<UnifiedVideoItem[]> {
  const trimmed: string = (keyword ?? "").trim()
  if (!trimmed) return []

  const result: any = await biliFetchJson<any>(
    `${BILI_API}/x/web-interface/wbi/search/type`,
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
  if (result?.code !== 0) {
    raiseIfBanned(result, "search.type")
    return []
  }
  return mapItems(result.data?.result)
}

export async function getBiliSearchSuggestions(term: string): Promise<string[]> {
  const trimmed: string = (term ?? "").trim()
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
    const seen: Set<string> = new Set()
    const suggestions: string[] = []
    for (const tag of tags) {
      const value = tag?.value ?? tag?.name ?? tag?.term
      if (typeof value !== "string") continue
      const cleaned: string = cleanText(value)
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
    const detail: any = await fetchViewDetail(ids)
    if (detail?.code === 0 && detail.data?.View) {
      view = detail.data.View
      card = detail.data.Card
      tags = Array.isArray(detail.data.Tags) ? detail.data.Tags : []
      related = Array.isArray(detail.data.Related) ? detail.data.Related : []
    }
  } catch (error) {
    if (!mayTryNextEndpoint("view.detail", error)) throw error
  }

  if (!view) {
    const cacheKey: string = ids.bvid ?? `av${ids.aid}`
    const result: any = await fetchView(cacheKey, params)
    if (result?.code !== 0 || !result.data) {
      raiseIfBanned(result, "view")
      throw new Error(result?.message || "無法取得影片資訊")
    }
    view = result.data
  }

  const bvid: string | undefined = typeof view.bvid === "string" ? view.bvid : ids.bvid
  if (!bvid) throw new Error("影片資料不完整")

  if (!related.length) {
    try {
      const result: any = await biliFetchJson<any>(RELATED_URL, { bvid })
      if (result?.code === 0 && Array.isArray(result.data)) related = result.data
      else raiseIfBanned(result, "related")
    } catch (error) {
      reportError("bili", "related", error)
    }
  }

  const base: UnifiedVideoItem | null = mapItem({ ...view, aid: view.aid })
  if (!base) throw new Error("影片資料不完整")

  const pages: VideoPagePart[] | undefined =
    Array.isArray(view.pages) && view.pages.length
      ? view.pages.map((page: any): VideoPagePart => ({
          cid: Number(page.cid),
          page: Number(page.page) || 0,
          title: cleanText(page.part),
          duration: Number(page.duration) || 0,
        }))
      : undefined

  const fans: number | undefined = numberOrUndefined(card?.card?.fans ?? card?.fans)
  const tagNames: string[] = tags
    .map((tag: any): string => cleanText(tag?.tag_name ?? tag?.name))
    .filter((name: string): boolean => name.length > 0)

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

interface ChannelProfile {
  name: string
  face: string
  sign: string
  fans?: number
}

async function fetchChannelProfile(mid: string): Promise<ChannelProfile | null> {
  try {
    const result: any = await biliFetchJson<any>(
      `${BILI_API}/x/space/wbi/acc/info`,
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
    raiseIfBanned(result, "channel.accInfo")
  } catch (error) {
    if (!mayTryNextEndpoint("channel.accInfo", error)) throw error
  }

  try {
    const card: any = await biliFetchJson<any>(`${BILI_API}/x/web-interface/card`, { mid })
    if (card?.code === 0 && card.data?.card) {
      const info = card.data.card
      return {
        name: cleanText(info.name),
        face: imageUrl(info.face),
        sign: cleanText(info.sign),
        fans: numberOrUndefined(info.fans),
      }
    }
    raiseIfBanned(card, "channel.card")
  } catch (error) {
    if (!mayTryNextEndpoint("channel.card", error)) throw error
  }
  return null
}

async function fetchChannelVideos(
  mid: string,
  page: number,
  order: string,
  keyword: string = "",
): Promise<{ videos: UnifiedVideoItem[]; total: number }> {
  const attempts: Array<() => Promise<any>> = [
    () =>
      biliFetchJson<any>(
        `${BILI_API}/x/space/wbi/arc/search`,
        {
          mid,
          ps: 30,
          pn: page,
          order,
          ...(keyword ? { keyword } : {}),
          platform: "web",
          web_location: 1550101,
        },
        true,
      ),
    () =>
      biliFetchJson<any>(`${BILI_API}/x/space/arc/search`, {
        mid,
        ps: 30,
        pn: page,
        order,
        ...(keyword ? { keyword } : {}),
      }),
  ]

  for (const attempt of attempts) {
    try {
      const result: any = await attempt()
      if (result?.code === 0) {
        const list = result.data?.list
        const items: UnifiedVideoItem[] = mapItems(list?.vlist ?? list)
        const total: number = Number(result.data?.page?.count) || 0
        if (items.length) return { videos: items, total }
      }
      raiseIfBanned(result, "channel.videos")
    } catch (error) {
      reportError("bili", "channel.videos", error)
    }
  }
  return { videos: [], total: 0 }
}

export async function searchBiliChannelVideos(
  mid: string,
  keyword: string,
  cursor: string | undefined,
): Promise<{ videos: UnifiedVideoItem[]; nextPageToken?: string }> {
  const page: number = Number.parseInt(cursor ?? "1", 10) || 1
  const result = await fetchChannelVideos(String(mid).trim(), page, "pubdate", keyword)
  return result.videos.length >= 30
    ? { videos: result.videos, nextPageToken: String(page + 1) }
    : { videos: result.videos }
}

export async function getBiliChannel(
  mid: string,
  page: number = 1,
  sort: "latest" | "popular" | "oldest" = "latest",
): Promise<ChannelDetail> {
  const rawMid: string = String(mid ?? "").trim()
  if (!rawMid) throw new Error("缺少 UP 主 ID")
  const order: string = sort === "popular" ? "click" : "pubdate"

  const [profile, firstPage] = await Promise.all([
    fetchChannelProfile(rawMid),
    fetchChannelVideos(rawMid, page, order),
  ])
  let videos: UnifiedVideoItem[] = firstPage.videos
  let total: number = firstPage.total

  if (!videos.length && profile?.name) {
    videos = await searchBiliVideos(profile.name, page)
    total = 0
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
    videoCountText: total > 0 ? formatCount(total) : undefined,
    videos,
    nextPageToken: videos.length >= 30 ? String(page + 1) : undefined,
  }
}
