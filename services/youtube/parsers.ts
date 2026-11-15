/**
 * Innertube 巢狀 JSON → 統一資料模型。
 *
 * 同時支援舊版 `videoRenderer` / `compactVideoRenderer` / `gridVideoRenderer`
 * 與新版首頁大量使用的 `lockupViewModel`。
 */

import type {
  ChannelDetail,
  CommentItem,
  SubtitleTrackInfo,
  UnifiedVideoItem,
  VideoChapter,
  VideoDetail,
} from "../../types"
import type { JsonObject } from "./innertube"

const VIDEO_RENDERER_KEYS: string[] = [
  "richItemRenderer",
  "videoRenderer",
  "compactVideoRenderer",
  "gridVideoRenderer",
  "reelItemRenderer",
  "lockupViewModel",
  "playlistVideoRenderer",
  "videoWithContextRenderer",
]

function asObject(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject
  return null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 讀出 simpleText / runs / content / 純字串。 */
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

function readThumbnailUrl(node: unknown): string {
  const object: JsonObject | null = asObject(node)
  if (!object) return ""
  const thumbnails: unknown[] = asArray(object["thumbnails"])
  let best: JsonObject | null = null
  let bestWidth: number = -1
  for (const entry of thumbnails) {
    const thumbnail: JsonObject | null = asObject(entry)
    if (!thumbnail) continue
    const url: string = typeof thumbnail["url"] === "string" ? thumbnail["url"] : ""
    if (!url.startsWith("http")) continue
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

/** 深度尋找第一個縮圖來源（lockupViewModel 的結構很浮動）。 */
function findThumbnailDeep(node: unknown, depth: number = 0): string {
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

/** `"12:34"` / `"1:02:03"` → 秒數。 */
export function parseDurationText(text: string): number {
  if (!text) return 0
  const trimmed: string = text.trim()
  const match: RegExpMatchArray | null = trimmed.match(/^(\d+):(\d{2})(?::(\d{2}))?$/)
  if (match) {
    const first: number = Number(match[1])
    const second: number = Number(match[2])
    const third: number | undefined = match[3] === undefined ? undefined : Number(match[3])
    if (third === undefined) return first * 60 + second
    return first * 3600 + second * 60 + third
  }
  // ISO 8601 形式（PT1H2M3S）
  const iso: RegExpMatchArray | null = trimmed.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  if (iso) {
    return Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0)
  }
  return 0
}

/** `"1.2M views"` / `"1,234 views"` / `"1.2萬次觀看"` → 數值。 */
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

function parsePublishedAt(text: string): number | undefined {
  if (!text) return undefined
  const now: number = Date.now()
  const lower: string = text.toLowerCase()
  const numberMatch: RegExpMatchArray | null = lower.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/)
  if (numberMatch) {
    const amount: number = Number(numberMatch[1])
    const unitMs: Record<string, number> = {
      second: 1000,
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 604_800_000,
      month: 2_592_000_000,
      year: 31_536_000_000,
    }
    return now - amount * (unitMs[numberMatch[2]] ?? 0)
  }
  const zhMatch: RegExpMatchArray | null = text.match(/(\d+)\s*(秒|分鐘|小時|天|週|個月|年)前/)
  if (zhMatch) {
    const amount: number = Number(zhMatch[1])
    const unitMs: Record<string, number> = {
      "秒": 1000,
      "分鐘": 60_000,
      "小時": 3_600_000,
      "天": 86_400_000,
      "週": 604_800_000,
      "個月": 2_592_000_000,
      "年": 31_536_000_000,
    }
    return now - amount * (unitMs[zhMatch[2]] ?? 0)
  }
  return undefined
}

function runNavigationBrowseId(node: unknown): string {
  const object: JsonObject | null = asObject(node)
  if (!object) return ""
  const endpoint: JsonObject | null =
    asObject(object["navigationEndpoint"]) ??
    asObject(asObject(asArray(object["runs"])[0])?.["navigationEndpoint"])
  const browse: JsonObject | null = asObject(endpoint?.["browseEndpoint"])
  if (browse && typeof browse["browseId"] === "string") return browse["browseId"]
  return ""
}

function isLiveRenderer(renderer: JsonObject, lengthText: string): boolean {
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

function baseItem(
  provider: "yt",
  rawId: string,
  title: string,
  thumbnailUrl: string,
  duration: number,
  viewCount: number | undefined,
  authorId: string,
  authorName: string,
  authorAvatar: string,
  publishedText: string,
  isLive: boolean,
): UnifiedVideoItem {
  const item: UnifiedVideoItem = {
    id: `yt:${rawId}`,
    provider: "yt",
    rawId,
    title,
    thumbnailUrl,
    duration,
    viewCount,
    publishedText: publishedText || undefined,
    publishedAt: parsePublishedAt(publishedText),
    authorId,
    authorName,
    isLive,
  }
  if (authorAvatar) item.authorAvatar = authorAvatar
  return item
}

function fromVideoRenderer(renderer: JsonObject): UnifiedVideoItem | null {
  const rawId: string = String(renderer["videoId"] ?? "")
  if (!rawId) return null
  const title: string = readText(renderer["title"]) || readText(renderer["headline"])
  const lengthText: string = readText(renderer["lengthText"])
  const viewText: string =
    readText(renderer["viewCountText"]) ||
    readText(renderer["shortViewCountText"]) ||
    readText(renderer["videoInfo"])
  const publishedText: string = readText(renderer["publishedTimeText"])
  const byline: unknown =
    renderer["ownerText"] ?? renderer["longBylineText"] ?? renderer["shortBylineText"] ?? renderer["publisher"]
  const authorName: string = readText(byline)
  const authorId: string = runNavigationBrowseId(byline)
  const avatar: string =
    readThumbnailUrl(asObject(asObject(renderer["channelThumbnailSupportedRenderers"])?.["channelThumbnailWithLinkRenderer"])?.["thumbnail"]) ||
    readThumbnailUrl(asObject(renderer["channelThumbnail"])?.["thumbnails"] ? renderer["channelThumbnail"] : null)
  const isLive: boolean = isLiveRenderer(renderer, lengthText) || viewText.toLowerCase().includes("watching")
  return baseItem(
    "yt",
    rawId,
    title,
    readThumbnailUrl(renderer["thumbnail"]),
    parseDurationText(lengthText),
    parseViewCountText(viewText),
    authorId,
    authorName,
    avatar,
    publishedText,
    isLive,
  )
}

function collectStrings(node: unknown, out: string[], depth: number = 0, maxDepth: number = 6): void {
  if (!node || depth > maxDepth) return
  if (typeof node === "string") {
    if (node.length > 0) out.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const entry of node) collectStrings(entry, out, depth + 1, maxDepth)
    return
  }
  const object: JsonObject | null = asObject(node)
  if (!object) return
  for (const key of Object.keys(object)) {
    collectStrings(object[key], out, depth + 1, maxDepth)
  }
}

function fromLockupViewModel(renderer: JsonObject): UnifiedVideoItem | null {
  const contentType: string = String(renderer["contentType"] ?? "")
  if (contentType && !contentType.includes("VIDEO")) return null
  const rawId: string = String(renderer["contentId"] ?? "")
  if (!rawId || rawId.length !== 11) return null

  const metadata: JsonObject | null = asObject(asObject(renderer["metadata"])?.["lockupMetadataViewModel"])
  const title: string = readText(metadata?.["title"])
  const rows: unknown[] = asArray(asObject(asObject(metadata?.["metadata"])?.["contentMetadataViewModel"])?.["metadataRows"])

  // Each row joins several facts ("8.5K views · 2 weeks ago"), so classify part by part.
  const parts: string[] = []
  for (const row of rows) {
    for (const part of asArray(asObject(row)?.["metadataParts"])) {
      const text: string = readText(asObject(part)?.["text"]).trim()
      if (text) parts.push(text)
    }
  }

  // Duration badges sit ~8 levels deep inside thumbnail overlays.
  const imageTexts: string[] = []
  collectStrings(renderer["contentImage"], imageTexts, 0, 14)
  const durationText: string = imageTexts.find((text: string): boolean => /^\d+:\d{2}(?::\d{2})?$/.test(text.trim())) ?? ""
  const duration: number = parseDurationText(durationText)
  const liveBadge: boolean = imageTexts.some((text: string): boolean => /^(live|直播(中)?)$/i.test(text.trim()))

  let viewCount: number | undefined
  let publishedText: string = ""
  let authorName: string = ""
  let watching: boolean = false
  for (const text of parts) {
    if (/watching|正在觀看|正在观看|人觀看中/i.test(text)) {
      watching = true
      continue
    }
    if (/view|觀看|观看|次/i.test(text) && /\d/.test(text)) {
      if (viewCount === undefined) viewCount = parseViewCountText(text)
      continue
    }
    if (/(ago|前)/i.test(text)) {
      if (!publishedText) publishedText = text
      continue
    }
    if (!authorName && text !== title) authorName = text
  }

  return baseItem(
    "yt",
    rawId,
    title,
    findThumbnailDeep(renderer["contentImage"]),
    duration,
    viewCount,
    "",
    authorName,
    "",
    publishedText,
    liveBadge || watching,
  )
}

function fromRenderer(renderer: JsonObject): UnifiedVideoItem | null {
  if (renderer["lockupViewModel"]) return fromLockupViewModel(asObject(renderer["lockupViewModel"]) ?? {})
  if (renderer["reelItemRenderer"]) {
    const reel: JsonObject = asObject(renderer["reelItemRenderer"]) ?? {}
    const rawId: string = String(reel["videoId"] ?? "")
    if (!rawId) return null
    return baseItem(
      "yt",
      rawId,
      readText(reel["headline"]),
      readThumbnailUrl(reel["thumbnail"]),
      0,
      parseViewCountText(readText(reel["viewCountText"])),
      "",
      readText(reel["headline"]),
      "",
      "",
      true,
    )
  }
  return fromVideoRenderer(renderer)
}

/** 從任意巢狀回應撈出所有影片項目（含 lockupViewModel）。 */
export function extractVideoItems(root: unknown): UnifiedVideoItem[] {
  const results: UnifiedVideoItem[] = []
  const seen: Set<string> = new Set()

  const visit = (node: unknown, depth: number): void => {
    if (!node || depth > 24) return
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1)
      return
    }
    const object: JsonObject | null = asObject(node)
    if (!object) return

    for (const key of VIDEO_RENDERER_KEYS) {
      const value: unknown = object[key]
      if (!value) continue
      const inner: JsonObject = asObject(value) ?? {}
      const item: UnifiedVideoItem | null =
        key === "lockupViewModel"
          ? fromLockupViewModel(inner)
          : fromRenderer(key === "richItemRenderer" ? asObject(inner["content"]) ?? inner : inner)
      if (item && !seen.has(item.id)) {
        seen.add(item.id)
        results.push(item)
      }
    }

    for (const key of Object.keys(object)) {
      if (VIDEO_RENDERER_KEYS.includes(key)) continue
      visit(object[key], depth + 1)
    }
  }

  visit(root, 0)
  return results
}

/** 解析 next response 的推薦影片。 */
export function parseRelatedVideos(next: JsonObject): UnifiedVideoItem[] {
  const results: unknown[] = asArray(asObject(asObject(next["secondaryResults"])?.["secondaryResults"])?.["results"])
  const items: UnifiedVideoItem[] = []
  const seen: Set<string> = new Set()
  for (const entry of results) {
    const object: JsonObject | null = asObject(entry)
    if (!object) continue
    const compact: JsonObject | null = asObject(object["compactVideoRenderer"])
    if (!compact) continue
    const item: UnifiedVideoItem | null = fromVideoRenderer(compact)
    if (item && !seen.has(item.id)) {
      seen.add(item.id)
      items.push(item)
    }
  }
  return items
}

/** 解析 player response 的字幕軌。 */
export function parseSubtitleTracks(player: JsonObject): SubtitleTrackInfo[] {
  const tracks: unknown[] = asArray(
    asObject(asObject(player["captions"])?.["playerCaptionsTracklistRenderer"])?.["captionTracks"],
  )
  const result: SubtitleTrackInfo[] = []
  for (const entry of tracks) {
    const track: JsonObject | null = asObject(entry)
    if (!track) continue
    const url: string = String(track["baseUrl"] ?? track["url"] ?? "")
    if (!url) continue
    const languageCode: string = String(track["languageCode"] ?? "")
    const kind: string = String(track["kind"] ?? "")
    result.push({
      id: String(track["vssId"] ?? languageCode),
      languageCode,
      label: readText(track["name"]) || languageCode,
      url: url.includes("fmt=") ? url : `${url}&fmt=vtt`,
      format: url.includes("fmt=vtt") ? "vtt" : "srv3",
      isAutoGenerated: kind === "asr",
    })
  }
  return result
}

function parseTimestamp(text: string): number {
  return parseDurationText(text)
}

/** 章節：支援 macroMarkersListRenderer 與 playerBar chapters。 */
export function parseChapters(next: JsonObject): VideoChapter[] {
  const found: VideoChapter[] = []
  const seen: Set<string> = new Set()

  const visit = (node: unknown, depth: number): void => {
    if (!node || depth > 22) return
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1)
      return
    }
    const object: JsonObject | null = asObject(node)
    if (!object) return

    const item: JsonObject | null = asObject(object["macroMarkersListItemRenderer"])
    if (item) {
      const title: string = readText(item["title"])
      const start: number = parseTimestamp(readText(item["timeDescription"]))
      if (title && !seen.has(`${title}:${start}`)) {
        seen.add(`${title}:${start}`)
        found.push({
          title,
          startTime: start,
          endTime: start,
          thumbnailUrl: readThumbnailUrl(item["thumbnail"]),
        })
      }
    }

    const chapter: JsonObject | null = asObject(object["chapterRenderer"])
    if (chapter) {
      const title: string = readText(chapter["title"])
      const startMs: number = Number(chapter["timeRangeStartMillis"] ?? 0)
      if (title && !seen.has(`${title}:${startMs}`)) {
        seen.add(`${title}:${startMs}`)
        found.push({
          title,
          startTime: Math.round(startMs / 1000),
          endTime: Math.round(startMs / 1000),
          thumbnailUrl: readThumbnailUrl(chapter["thumbnail"]),
        })
      }
    }

    for (const key of Object.keys(object)) visit(object[key], depth + 1)
  }

  visit(next, 0)
  found.sort((a: VideoChapter, b: VideoChapter): number => a.startTime - b.startTime)
  for (let i = 0; i < found.length; i++) {
    const nextChapter: VideoChapter | undefined = found[i + 1]
    if (nextChapter) {
      found[i].endTime = nextChapter.startTime
    } else {
      found[i].endTime = Math.max(found[i].startTime, found[i].endTime)
    }
  }
  return found
}

function parseCommentRenderer(renderer: JsonObject): CommentItem | null {
  const commentId: string = String(renderer["commentId"] ?? "")
  if (!commentId) return null
  const authorText: string = readText(renderer["authorText"])
  const avatar: string = readThumbnailUrl(renderer["authorThumbnail"])
  const content: string = readText(renderer["contentText"])
  const likeText: string = readText(renderer["voteCount"])
  const replyText: string = readText(renderer["replyCount"])
  const item: CommentItem = {
    id: commentId,
    authorId: runNavigationBrowseId(renderer["authorEndpoint"]),
    authorName: authorText,
    authorAvatar: avatar,
    content,
    likeCount: Number(likeText.replace(/[^\d]/g, "")) || 0,
    publishedText: readText(renderer["publishedTimeText"]),
  }
  const replyCount: number = Number((replyText.match(/\d+/) ?? ["0"])[0])
  if (replyCount > 0) item.replyCount = replyCount
  return item
}

function parseCommentEntity(payload: JsonObject): CommentItem | null {
  const properties: JsonObject | null = asObject(payload["properties"])
  if (!properties) return null
  const toolbar: JsonObject | null = asObject(properties["toolbarStateKey"])
  const commentId: string =
    typeof toolbar?.["commentId"] === "string" ? String(toolbar["commentId"]) : String(payload["commentId"] ?? "")
  const content: string = readText(asObject(properties["content"])?.["content"]) || readText(properties["content"])
  if (!commentId || !content) return null
  return {
    id: commentId,
    authorId: "",
    authorName: readText(properties["authorButtonA11y"]).replace(/^Photo of\s+/, "").replace(/^@/, ""),
    authorAvatar: readThumbnailUrl(asObject(payload["avatar"])?.["image"]),
    content,
    likeCount: Number(readText(properties["likeCountNotliked"]).replace(/[^\d]/g, "")) || 0,
    publishedText: readText(properties["publishedTime"]),
  }
}

/** 解析留言（舊版 commentRenderer 與新版 commentEntityPayload 皆支援）。 */
export function parseComments(next: JsonObject): CommentItem[] {
  const comments: CommentItem[] = []
  const seen: Set<string> = new Set()

  const visit = (node: unknown, depth: number): void => {
    if (!node || depth > 24) return
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1)
      return
    }
    const object: JsonObject | null = asObject(node)
    if (!object) return

    const legacy: JsonObject | null = asObject(object["commentRenderer"])
    if (legacy) {
      const item: CommentItem | null = parseCommentRenderer(legacy)
      if (item && !seen.has(item.id)) {
        seen.add(item.id)
        comments.push(item)
      }
    }

    const entity: JsonObject | null = asObject(object["commentEntityPayload"])
    if (entity) {
      const item: CommentItem | null = parseCommentEntity(entity)
      if (item && !seen.has(item.id)) {
        seen.add(item.id)
        comments.push(item)
      }
    }

    for (const key of Object.keys(object)) visit(object[key], depth + 1)
  }

  visit(next, 0)
  return comments
}

/** 解析 player + next 成 VideoDetail。 */
export function parseVideoDetail(videoId: string, player: JsonObject, next: JsonObject | null): VideoDetail {
  const details: JsonObject = asObject(player["videoDetails"]) ?? {}
  const microformat: JsonObject =
    asObject(asObject(player["microformat"])?.["playerMicroformatRenderer"]) ?? {}
  const title: string = String(details["title"] ?? readText(microformat["title"]) ?? "")
  const duration: number = Number(details["lengthSeconds"] ?? 0)
  const viewCount: number = Number(details["viewCount"] ?? 0)
  const author: string = String(details["author"] ?? "")
  const channelId: string = String(details["channelId"] ?? "")
  const thumbnailUrl: string = readThumbnailUrl(asObject(details["thumbnail"]) ?? microformat["thumbnail"])
  const keywords: unknown[] = asArray(details["keywords"])
  const publishedText: string = String(microformat["publishDate"] ?? "")

  const item: VideoDetail = {
    id: `yt:${videoId}`,
    provider: "yt",
    rawId: videoId,
    title,
    thumbnailUrl,
    duration,
    viewCount,
    publishedText,
    publishedAt: publishedText ? Date.parse(publishedText) || undefined : undefined,
    authorId: channelId,
    authorName: author,
    isLive: Boolean(details["isLive"]),
    description: String(details["shortDescription"] ?? microformat["description"] ?? ""),
    relatedVideos: next ? parseRelatedVideos(next) : [],
    tags: keywords.map((keyword: unknown): string => String(keyword)),
  }

  const chapters: VideoChapter[] = next ? parseChapters(next) : []
  if (chapters.length > 0) item.chapters = chapters
  return item
}

/** 解析頻道頁。 */
export function parseChannelDetail(channelId: string, browse: JsonObject): ChannelDetail {
  const metadata: JsonObject = asObject(browse["metadata"]) ?? {}
  const channelMetadata: JsonObject = asObject(metadata["channelMetadataRenderer"]) ?? {}
  const microformat: JsonObject =
    asObject(asObject(browse["microformat"])?.["microformatDataRenderer"]) ?? {}
  const pageHeader: JsonObject =
    asObject(asObject(asObject(browse["header"])?.["pageHeaderRenderer"])?.["content"])?.["pageHeaderViewModel"] != null
      ? asObject(asObject(asObject(asObject(browse["header"])?.["pageHeaderRenderer"])?.["content"])?.["pageHeaderViewModel"]) ?? {}
      : {}

  const name: string =
    String(channelMetadata["title"] ?? "") ||
    readText(asObject(pageHeader["title"])?.["dynamicTextViewModel"]) ||
    String(microformat["title"] ?? "")
  const avatar: string =
    readThumbnailUrl(asObject(pageHeader["image"])?.["decoratedAvatarViewModel"]) ||
    readThumbnailUrl(asObject(asObject(asObject(pageHeader["image"])?.["decoratedAvatarViewModel"])?.["avatar"])?.["avatarViewModel"]) ||
    readThumbnailUrl(channelMetadata["avatar"]) ||
    readThumbnailUrl(asObject(microformat["thumbnail"]))
  const banner: string =
    readThumbnailUrl(asObject(channelMetadata["banner"])) ||
    readThumbnailUrl(asObject(asObject(asObject(pageHeader["banner"])?.["imageBannerViewModel"])?.["image"]))

  const videos: UnifiedVideoItem[] = extractVideoItems(browse)

  return {
    id: `yt:${channelId}`,
    provider: "yt",
    rawId: channelId,
    name,
    avatarUrl: avatar,
    bannerUrl: banner || undefined,
    description: String(channelMetadata["description"] ?? microformat["description"] ?? ""),
    subscriberCountText: readText(pageHeader["metadata"]) || undefined,
    videos,
  }
}
