import { fetch } from "scripting"
import type { Provider, SponsorCategory, SponsorSegment } from "../types"

const YOUTUBE_ENDPOINT = "https://sponsor.ajay.app/api/skipSegments"
const BILIBILI_ENDPOINT = "https://bsbsb.top/api/skipSegments"
const CACHE_TTL = 10 * 60 * 1000

const DEFAULT_CATEGORIES: SponsorCategory[] = [
  "sponsor",
  "selfpromo",
  "interaction",
  "intro",
  "outro",
  "preview",
  "music_offtopic",
]

interface CacheEntry {
  at: number
  segments: SponsorSegment[]
}

const cache = new Map<string, CacheEntry>()

function isCategory(value: unknown): value is SponsorCategory {
  return (
    typeof value === "string" &&
    [
      "sponsor",
      "selfpromo",
      "interaction",
      "intro",
      "outro",
      "preview",
      "music_offtopic",
      "poi_highlight",
    ].includes(value)
  )
}

function isActionType(value: unknown): value is SponsorSegment["actionType"] {
  return value === "skip" || value === "mute" || value === "full" || value === "poi"
}

function normalizeItems(raw: unknown, allowed: SponsorCategory[]): SponsorSegment[] {
  const candidates: any[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any)?.segments)
      ? (raw as any).segments
      : Array.isArray((raw as any)?.data)
        ? (raw as any).data
        : Array.isArray((raw as any)?.data?.segments)
          ? (raw as any).data.segments
          : []

  const segments: SponsorSegment[] = []
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue
    const category = candidate.category
    const actionType = candidate.actionType ?? candidate.action_type ?? "skip"
    const pair = candidate.segment ?? candidate.segments ?? [candidate.startTime, candidate.endTime]
    if (!Array.isArray(pair) || pair.length < 2) continue
    const start = Number(pair[0])
    const end = Number(pair[1])
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    if (!isCategory(category) || !isActionType(actionType)) continue
    if (allowed.length && !allowed.includes(category)) continue
    segments.push({
      uuid: String(candidate.UUID ?? candidate.uuid ?? candidate.id ?? `${category}-${start}-${end}`),
      category,
      actionType,
      startTime: start,
      endTime: end,
    })
  }
  segments.sort((a, b) => a.startTime - b.startTime)
  return segments
}

function cacheKey(provider: Provider, rawId: string, categories: SponsorCategory[]): string {
  return `${provider}:${rawId}:${[...categories].sort().join(",")}`
}

export async function fetchSponsorSegments(
  provider: Provider,
  rawId: string,
  categories: SponsorCategory[] = DEFAULT_CATEGORIES,
): Promise<SponsorSegment[]> {
  const id = (rawId ?? "").trim()
  if (!id) return []

  const allowed = categories.length ? categories : DEFAULT_CATEGORIES
  const key = cacheKey(provider, id, allowed)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.segments

  const base = provider === "bili" ? BILIBILI_ENDPOINT : YOUTUBE_ENDPOINT
  const url =
    `${base}?videoID=${encodeURIComponent(id)}` +
    `&categories=${encodeURIComponent(JSON.stringify(allowed))}`

  try {
    const res = await fetch(url)
    if (res.status === 404) {
      cache.set(key, { at: Date.now(), segments: [] })
      return []
    }
    if (!res.ok) return []
    const json: any = await res.json()
    const segments = normalizeItems(json, allowed)
    cache.set(key, { at: Date.now(), segments })
    return segments
  } catch {
    return []
  }
}

/** Returns the segment covering `currentTimeSec`, ignoring `poi` highlights. */
export function findActiveSponsorSegment(
  segments: readonly SponsorSegment[],
  currentTimeSec: number,
): SponsorSegment | null {
  if (!segments || !segments.length || !Number.isFinite(currentTimeSec)) return null
  for (const segment of segments) {
    if (segment.actionType === "poi") continue
    if (currentTimeSec >= segment.startTime && currentTimeSec < segment.endTime) {
      return segment
    }
  }
  return null
}

export function clearSponsorCache(): void {
  cache.clear()
}
