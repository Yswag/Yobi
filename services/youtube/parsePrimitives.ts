import type { JsonObject } from "./innertube"
export { parseDurationText } from "../../utils/format"

export const VIDEO_RENDERER_KEYS: string[] = [
  "richItemRenderer",
  "videoRenderer",
  "compactVideoRenderer",
  "gridVideoRenderer",
  "reelItemRenderer",
  "lockupViewModel",
  "playlistVideoRenderer",
  "videoWithContextRenderer",
  "channelVideoPlayerRenderer",
]

export function asObject(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject
  return null
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function readText(node: unknown): string {
  if (node === null || node === undefined) return ""
  if (typeof node === "string") return node
  const object: JsonObject | null = asObject(node)
  if (!object) return ""
  if (typeof object["simpleText"] === "string") return object["simpleText"]
  if (typeof object["content"] === "string" && !object["runs"]) {
    return object["content"]
  }
  if (Array.isArray(object["runs"])) {
    return asArray(object["runs"])
      .map((run: unknown): string => readText(asObject(run)?.["text"] ?? run))
      .join("")
  }
  if (typeof object["text"] === "string") return object["text"]
  return ""
}

export function readThumbnailUrl(node: unknown): string {
  const object: JsonObject | null = asObject(node)
  if (!object) return ""
  const thumbnails: unknown[] = asArray(object["thumbnails"] ?? object["sources"])
  let best: JsonObject | null = null
  let bestWidth: number = -1
  for (const entry of thumbnails) {
    const thumbnail: JsonObject | null = asObject(entry)
    if (!thumbnail) continue
    const url: string = typeof thumbnail["url"] === "string" ? thumbnail["url"] : ""
    if (!url.startsWith("http") && !url.startsWith("//")) continue
    const width: number = Number(thumbnail["width"] ?? 0)
    if (width >= bestWidth) {
      best = thumbnail
      bestWidth = width
    }
  }
  if (best) {
    const url: string = String(best["url"])
    return url.startsWith("//") ? `https:${url}` : url
  }
  return ""
}

export function findThumbnailDeep(node: unknown, depth: number = 0): string {
  if (!node || depth > 8) return ""
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found: string = findThumbnailDeep(entry, depth + 1)
      if (found) return found
    }
    return ""
  }
  const object: JsonObject | null = asObject(node)
  if (!object) return ""
  const direct: string = readThumbnailUrl(object)
  if (direct) return direct
  for (const key of Object.keys(object)) {
    const found: string = findThumbnailDeep(object[key], depth + 1)
    if (found) return found
  }
  return ""
}

export function parseViewCountText(text: string): number | undefined {
  if (!text) return undefined
  const normalized: string = text.replace(/,/g, "").trim()
  const match: RegExpMatchArray | null = normalized.match(/([\d.]+)\s*([KMB萬億亿])?/i)
  if (!match) return undefined
  const value: number = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  const unit: string = (match[2] ?? "").toUpperCase()
  const multiplier: Record<string, number> = {
    K: 1_000,
    M: 1_000_000,
    B: 1_000_000_000,
    "萬": 10_000,
    "億": 100_000_000,
    "亿": 100_000_000,
  }
  return Math.round(value * (multiplier[unit] ?? 1))
}

export function parsePublishedAt(text: string): number | undefined {
  if (!text) return undefined
  const now: number = Date.now()
  const unitMs: Record<string, number> = {
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000,
    year: 31_536_000_000,
  }
  const lower: string = text.toLowerCase()
  const numberMatch: RegExpMatchArray | null = lower.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/)
  if (numberMatch) {
    return now - Number(numberMatch[1]) * (unitMs[numberMatch[2]] ?? 0)
  }
  const shortMatch: RegExpMatchArray | null = lower.match(/(\d+)\s*(s|m|h|d|w|y)\s+ago/)
  if (shortMatch) {
    const shorts: Record<string, string> = { s: "second", m: "minute", h: "hour", d: "day", w: "week", y: "year" }
    return now - Number(shortMatch[1]) * (unitMs[shorts[shortMatch[2]]] ?? 0)
  }
  const zhMatch: RegExpMatchArray | null = text.match(/(\d+)\s*(秒|分鐘|小時|天|週|個月|年)前/)
  if (zhMatch) {
    const amount: number = Number(zhMatch[1])
    const zhUnits: Record<string, number> = {
      "秒": 1000,
      "分鐘": 60_000,
      "小時": 3_600_000,
      "天": 86_400_000,
      "週": 604_800_000,
      "個月": 2_592_000_000,
      "年": 31_536_000_000,
    }
    return now - amount * (zhUnits[zhMatch[2]] ?? 0)
  }
  return undefined
}

export function runNavigationBrowseId(node: unknown): string {
  const object: JsonObject | null = asObject(node)
  if (!object) return ""
  const endpoint: JsonObject | null =
    asObject(object["navigationEndpoint"]) ??
    asObject(asObject(asArray(object["runs"])[0])?.["navigationEndpoint"])
  const browse: JsonObject | null = asObject(endpoint?.["browseEndpoint"])
  if (browse && typeof browse["browseId"] === "string") return browse["browseId"]
  return ""
}

export function browseIdOf(command: unknown): string {
  const browse: JsonObject | null = asObject(asObject(command)?.["browseEndpoint"])
  return browse && typeof browse["browseId"] === "string" ? browse["browseId"] : ""
}

export function commandRunBrowseId(node: unknown): string {
  const object: JsonObject | null = asObject(node)
  if (!object) return ""
  for (const run of asArray(object["commandRuns"])) {
    const command: JsonObject | null = asObject(asObject(asObject(run)?.["onTap"])?.["innertubeCommand"])
    const browse: JsonObject | null = asObject(command?.["browseEndpoint"])
    if (browse && typeof browse["browseId"] === "string") return browse["browseId"]
  }
  return runNavigationBrowseId(node)
}

export function isMembersBadge(style: string, label: string): boolean {
  if (style.toUpperCase().includes("MEMBERS")) return true
  return /members only|會員|会员/i.test(label)
}

export function isLiveRenderer(renderer: JsonObject, lengthText: string): boolean {
  const badges: unknown[] = asArray(renderer["badges"])
  for (const badge of badges) {
    const meta: JsonObject | null = asObject(asObject(badge)?.["metadataBadgeRenderer"])
    if (!meta) continue
    const style: string = String(meta["style"] ?? "")
    const label: string = readText(meta["label"])
    if (style.includes("LIVE") || label.toUpperCase() === "LIVE") return true
  }
  if (lengthText === "" && renderer["isLiveNow"] === true) return true
  return false
}
