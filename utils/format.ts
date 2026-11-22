import type { Color } from "scripting"
import type { Provider, SponsorCategory, UnifiedVideoItem } from "../types/index"

export function formatDuration(seconds?: number | null): string {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return "00:00"
  }
  const total: number = Math.max(0, Math.floor(seconds))
  const hours: number = Math.floor(total / 3600)
  const minutes: number = Math.floor((total % 3600) / 60)
  const secs: number = total % 60
  const mm: string = String(minutes).padStart(2, "0")
  const ss: string = String(secs).padStart(2, "0")
  if (hours > 0) {
    return `${hours}:${mm}:${ss}`
  }
  return `${mm}:${ss}`
}

export function formatCount(count?: number | null): string {
  if (count === undefined || count === null || !Number.isFinite(count) || count < 0) {
    return "0"
  }
  if (count >= 100_000_000) {
    return `${(count / 100_000_000).toFixed(1).replace(/\.0$/, "")}億`
  }
  if (count >= 10_000) {
    return `${(count / 10_000).toFixed(1).replace(/\.0$/, "")}萬`
  }
  return Math.floor(count).toLocaleString("en-US")
}

export function providerBadgeLabel(provider: Provider): string {
  return provider === "bili" ? "BILI" : "YT"
}

export function providerFullName(provider: Provider): string {
  return provider === "bili" ? "BiliBili" : "YouTube"
}

export const SPONSOR_CATEGORY_LABELS: Record<SponsorCategory, string> = {
  sponsor: "業配廣告",
  selfpromo: "自我宣傳",
  interaction: "互動提醒",
  intro: "片頭動畫",
  outro: "片尾畫面",
  preview: "預告回顧",
  music_offtopic: "非音樂片段",
  poi_highlight: "精彩時刻",
}

export const SPONSOR_CATEGORY_COLORS: Record<SponsorCategory, Color> = {
  sponsor: "rgba(0,212,0,0.85)",
  selfpromo: "rgba(255,255,0,0.85)",
  interaction: "rgba(204,0,255,0.85)",
  intro: "rgba(0,255,255,0.85)",
  outro: "rgba(2,2,237,0.85)",
  preview: "rgba(0,143,214,0.85)",
  music_offtopic: "rgba(255,153,0,0.85)",
  poi_highlight: "rgba(255,22,132,0.85)",
}

export function effectiveResolution(width?: number | null, height?: number | null): number {
  const w: number = width && Number.isFinite(width) && width > 0 ? width : 0
  const h: number = height && Number.isFinite(height) && height > 0 ? height : 0
  if (w > 0 && h > 0) return Math.min(w, h)
  return h || w
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_: string, code: string): string => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
}

export function parseDurationText(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value))
  if (typeof value !== "string" || !value) return 0
  const trimmed: string = value.trim()
  const colon: RegExpMatchArray | null = trimmed.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/)
  if (colon) {
    const first: number = Number(colon[1])
    const second: number = Number(colon[2])
    const third: number | undefined = colon[3] === undefined ? undefined : Number(colon[3])
    if (third === undefined) return first * 60 + second
    return first * 3600 + second * 60 + third
  }
  const iso: RegExpMatchArray | null = trimmed.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  if (iso) {
    return Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0)
  }
  const numeric: number = Number(trimmed)
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0
}

export function getVideoShareUrl(item: Pick<UnifiedVideoItem, "provider" | "rawId" | "cid">): string {
  if (item.provider === "bili") {
    return `https://www.bilibili.com/video/${item.rawId}`
  }
  return `https://www.youtube.com/watch?v=${encodeURIComponent(item.rawId)}`
}
