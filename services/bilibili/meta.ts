import { fetch } from "scripting"
import type { UnifiedVideoItem } from "../../types"
import { reportError } from "../errors"
import { parseBiliInput } from "./input"
import {
  BILI_REFERER,
  BILI_USER_AGENT,
  biliCodeError,
  biliErrorKind,
  biliFetchJson,
} from "./wbi"

export const BILI_API: string = "https://api.bilibili.com"
export const VIEW_URL: string = `${BILI_API}/x/web-interface/view`
export const VIEW_DETAIL_URL: string = `${BILI_API}/x/web-interface/view/detail`
export const RELATED_URL: string = `${BILI_API}/x/web-interface/archive/related`

export const BILI_HEADERS: Record<string, string> = {
  Referer: BILI_REFERER,
  "User-Agent": BILI_USER_AGENT,
}

export const QN_HEIGHTS: Record<number, number> = {
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
  127: 4320,
}

export const AUDIO_LABELS: Record<number, string> = {
  30216: "64k",
  30232: "132k",
  30280: "192k",
  30250: "Dolby Atmos",
  30251: "Hi-Res",
}

const VIEW_CACHE_MS: number = 20_000
const MAX_CACHE_ENTRIES: number = 24

interface CacheEntry<T> {
  at: number
  promise: Promise<T>
}

const viewCache: Map<string, CacheEntry<any>> = new Map()
const viewDetailCache: Map<string, CacheEntry<any>> = new Map()

function putBounded<T>(cache: Map<string, CacheEntry<T>>, key: string, entry: CacheEntry<T>): void {
  if (!cache.has(key) && cache.size >= MAX_CACHE_ENTRIES) {
    const oldest: string | undefined = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, entry)
}

export function mayTryNextEndpoint(context: string, error: unknown): boolean {
  reportError("bili", context, error)
  return biliErrorKind(error) !== "banned"
}

export function raiseIfBanned(payload: any, context: string): void {
  const code: number = Number(payload?.code)
  if (!Number.isFinite(code) || code === 0) return
  const error = biliCodeError(code, typeof payload?.message === "string" ? payload.message : "")
  if (error.kind === "banned") throw error
  reportError("bili", context, error)
}

function viewKeyOf(ids: { bvid?: string; aid?: number }): string {
  return ids.bvid ? ids.bvid : ids.aid ? `av${ids.aid}` : ""
}

export function fetchViewDetail(ids: { bvid?: string; aid?: number }): Promise<any> {
  const key: string = viewKeyOf(ids)
  const params: Record<string, string | number> = {}
  if (ids.bvid) params.bvid = ids.bvid
  else if (ids.aid) params.aid = ids.aid

  const now: number = Date.now()
  if (key) {
    const cached: CacheEntry<any> | undefined = viewDetailCache.get(key)
    if (cached && now - cached.at < VIEW_CACHE_MS) return cached.promise
  }

  const promise: Promise<any> = biliFetchJson<any>(VIEW_DETAIL_URL, params).then((detail: any): any => {
    const view: any = detail?.code === 0 ? detail.data?.View : null
    if (view) {
      const wrapped: Promise<any> = Promise.resolve({ code: 0, data: view })
      const stamped: number = Date.now()
      if (typeof view.bvid === "string" && view.bvid) {
        putBounded(viewCache, view.bvid, { at: stamped, promise: wrapped })
      }
      const aid: number = Number(view.aid)
      if (Number.isFinite(aid) && aid > 0) {
        putBounded(viewCache, `av${aid}`, { at: stamped, promise: wrapped })
      }
    }
    return detail
  })

  if (key) {
    putBounded(viewDetailCache, key, { at: now, promise })
    promise.catch((): void => {
      if (viewDetailCache.get(key)?.promise === promise) viewDetailCache.delete(key)
    })
  }
  return promise
}

export async function fetchView(
  key: string,
  params?: Record<string, string | number>,
): Promise<any> {
  const now: number = Date.now()
  const cached: CacheEntry<any> | undefined = viewCache.get(key)
  if (cached && now - cached.at < VIEW_CACHE_MS) return cached.promise

  const pendingDetail: CacheEntry<any> | undefined = viewDetailCache.get(key)
  if (pendingDetail && now - pendingDetail.at < VIEW_CACHE_MS) {
    try {
      const detail: any = await pendingDetail.promise
      if (detail?.code === 0 && detail.data?.View) {
        return { code: 0, data: detail.data.View }
      }
    } catch {
    }
  }

  const rechecked: CacheEntry<any> | undefined = viewCache.get(key)
  if (rechecked && Date.now() - rechecked.at < VIEW_CACHE_MS) return rechecked.promise

  const requestParams: Record<string, string | number> =
    params ?? (key.startsWith("av") ? { aid: Number(key.slice(2)) } : { bvid: key })
  const promise: Promise<any> = biliFetchJson<any>(VIEW_URL, requestParams)
  putBounded(viewCache, key, { at: Date.now(), promise })
  promise.catch((): void => {
    if (viewCache.get(key)?.promise === promise) viewCache.delete(key)
  })
  return promise
}

export function imageUrl(url?: string): string {
  if (typeof url !== "string" || !url) return ""
  if (url.startsWith("//")) return `https:${url}`
  if (url.startsWith("http://")) return `https://${url.slice(7)}`
  return url
}

export function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "")
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
}

export function cleanText(value: unknown): string {
  if (typeof value !== "string") return ""
  return decodeEntities(stripHtml(value)).trim()
}

export function numberOrUndefined(value: unknown): number | undefined {
  const parsed: number = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function parseDurationText(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || !value) return 0
  const parts: number[] = value.trim().split(":").map((part: string): number => Number(part))
  if (parts.some((part: number): boolean => !Number.isFinite(part))) return 0
  let seconds: number = 0
  for (const part of parts) seconds = seconds * 60 + part
  return Math.max(0, Math.round(seconds))
}

export function formatCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0"
  if (count >= 100000000) return `${(count / 100000000).toFixed(1)}億`
  if (count >= 10000) return `${(count / 10000).toFixed(1)}萬`
  return String(Math.round(count))
}

export function publishedTextFromEpoch(seconds?: number): string | undefined {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return undefined
  const diff: number = Math.floor(Date.now() / 1000 - seconds)
  if (diff < 60) return "剛剛"
  if (diff < 3600) return `${Math.floor(diff / 60)} 分鐘前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小時前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  const date: Date = new Date(seconds * 1000)
  const month: string = String(date.getMonth() + 1).padStart(2, "0")
  const day: string = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

export function parseFrameRate(raw: string | number | undefined): number {
  if (raw === undefined || raw === null) return 0
  if (typeof raw === "number") return raw
  const text: string = String(raw)
  if (text.includes("/")) {
    const [numerator, denominator] = text.split("/").map((part: string): number => Number(part))
    if (denominator) return numerator / denominator
    return 0
  }
  const value: number = Number(text.replace(/[^0-9.]/g, ""))
  return Number.isFinite(value) ? value : 0
}

export async function resolveBiliShortUrl(
  input: string,
): Promise<{ bvid?: string; aid?: number } | null> {
  const direct = parseBiliInput(input)
  if (direct) return direct

  const shortMatch: RegExpMatchArray | null = (input ?? "").match(/b23\.tv\/([0-9A-Za-z]+)/)
  if (!shortMatch) return null

  try {
    const res = await fetch(`https://b23.tv/${shortMatch[1]}`, {
      headers: { "User-Agent": BILI_USER_AGENT },
    })
    const parsed = parseBiliInput(res.url || "")
    if (parsed) return parsed
  } catch (error) {
    reportError("bili", "shortUrl.resolve", error)
  }
  return null
}

export async function resolveIds(input: string): Promise<{ bvid?: string; aid?: number }> {
  const ids = await resolveBiliShortUrl(input)
  if (!ids) throw new Error("無法解析 BiliBili 影片編號")
  return ids
}

export async function resolveAid(ids: { bvid?: string; aid?: number }): Promise<number> {
  if (ids.aid) return ids.aid
  if (!ids.bvid) throw new Error("缺少影片編號")
  const result: any = await fetchView(ids.bvid)
  if (result?.code !== 0 || !result.data?.aid) {
    throw new Error(result?.message || "無法取得影片資訊")
  }
  return Number(result.data.aid)
}

export function mapItem(raw: any): UnifiedVideoItem | null {
  if (!raw || typeof raw !== "object") return null
  const bvid: string =
    typeof raw.bvid === "string" && raw.bvid.startsWith("BV")
      ? raw.bvid
      : typeof raw.id === "string" && raw.id.startsWith("BV")
        ? raw.id
        : ""
  if (!bvid) return null

  const owner = raw.owner ?? {}
  const stat = raw.stat ?? {}
  const pubdate: number | undefined = numberOrUndefined(raw.pubdate ?? raw.senddate ?? raw.created)
  const duration: number =
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

export function mapItems(rawList: unknown): UnifiedVideoItem[] {
  if (!Array.isArray(rawList)) return []
  const items: UnifiedVideoItem[] = []
  for (const raw of rawList) {
    const mapped: UnifiedVideoItem | null = mapItem(raw)
    if (mapped) items.push(mapped)
  }
  return items
}
