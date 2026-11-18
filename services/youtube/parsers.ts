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
  VideoCollaborator,
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
  // Renderers list `thumbnails`; view models (lockupViewModel) list `sources`.
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
  // lockup 的縮寫寫法：1y ago / 4w ago / 3d ago
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

function browseIdOf(command: unknown): string {
  const browse: JsonObject | null = asObject(asObject(command)?.["browseEndpoint"])
  return browse && typeof browse["browseId"] === "string" ? browse["browseId"] : ""
}

/** Channel id off a lockup metadata part, which hides its endpoint in `commandRuns`. */
function commandRunBrowseId(node: unknown): string {
  const object: JsonObject | null = asObject(node)
  if (!object) return ""
  for (const run of asArray(object["commandRuns"])) {
    const command: JsonObject | null = asObject(asObject(asObject(run)?.["onTap"])?.["innertubeCommand"])
    const browse: JsonObject | null = asObject(command?.["browseEndpoint"])
    if (browse && typeof browse["browseId"] === "string") return browse["browseId"]
  }
  return runNavigationBrowseId(node)
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

  // Home and next carry the owner avatar under `metadata.image`; channel pages leave it out.
  const decorated: JsonObject | null = asObject(asObject(metadata?.["image"])?.["decoratedAvatarViewModel"])
  const ownerAvatar: string =
    readThumbnailUrl(asObject(asObject(decorated?.["avatar"])?.["avatarViewModel"])?.["image"]) ||
    findThumbnailDeep(metadata?.["image"])
  const ownerId: string = browseIdOf(
    asObject(asObject(asObject(decorated?.["rendererContext"])?.["commandContext"])?.["onTap"])?.["innertubeCommand"],
  )

  // Each row joins several facts ("8.5K views · 2 weeks ago"), so classify part by part.
  const parts: string[] = []
  const partNodes: unknown[] = []
  for (const row of rows) {
    for (const part of asArray(asObject(row)?.["metadataParts"])) {
      const text: string = readText(asObject(part)?.["text"]).trim()
      if (text) {
        parts.push(text)
        partNodes.push(asObject(part)?.["text"])
      }
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
  let authorId: string = ownerId
  let watching: boolean = false
  const bareCount: RegExp = /^[\d.,]+\s*[KMB萬億亿]?$/i
  for (let index = 0; index < parts.length; index++) {
    const text: string = parts[index]
    if (/watching|正在觀看|正在观看|人觀看中/i.test(text)) {
      watching = true
      continue
    }
    // 「1y ago」「3 週前」這類才是發佈時間，不要拿單個「前」去認。
    if (/\d/.test(text) && /(ago|前)/i.test(text) && !/view|觀看|观看/i.test(text)) {
      if (!publishedText) publishedText = text
      continue
    }
    // 觀看數可能是「72M」這種純數量，不一定帶 "views"。
    if (/\d/.test(text) && (/view|觀看|观看|次/i.test(text) || bareCount.test(text))) {
      if (viewCount === undefined) viewCount = parseViewCountText(text)
      continue
    }
    if (!authorName && text !== title) {
      authorName = text
      if (!authorId) authorId = commandRunBrowseId(partNodes[index])
    }
  }

  return baseItem(
    "yt",
    rawId,
    title,
    findThumbnailDeep(renderer["contentImage"]),
    duration,
    viewCount,
    authorId,
    authorName,
    ownerAvatar,
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

/** 解析 next response 的推薦影片（`compactVideoRenderer` 與新版 `lockupViewModel` 都吃）。 */
export function parseRelatedVideos(next: JsonObject): UnifiedVideoItem[] {
  // 推薦清單在 contents.twoColumnWatchNextResults.secondaryResults 裡，外層再包一層同名節點。
  const watch: JsonObject | null = asObject(asObject(next["contents"])?.["twoColumnWatchNextResults"])
  const holder: JsonObject | null = asObject(watch?.["secondaryResults"] ?? next["secondaryResults"])
  const nested: unknown[] = asArray(asObject(holder?.["secondaryResults"])?.["results"])
  const results: unknown[] = nested.length > 0 ? nested : asArray(holder?.["results"])

  const items: UnifiedVideoItem[] = []
  const seen: Set<string> = new Set()
  for (const entry of results) {
    const object: JsonObject | null = asObject(entry)
    if (!object) continue
    const lockup: JsonObject | null = asObject(object["lockupViewModel"])
    const renderer: JsonObject | null = asObject(object["compactVideoRenderer"] ?? object["videoRenderer"])
    const item: UnifiedVideoItem | null = lockup
      ? fromLockupViewModel(lockup)
      : renderer
        ? fromVideoRenderer(renderer)
        : null
    if (item && !seen.has(item.id)) {
      seen.add(item.id)
      items.push(item)
    }
  }
  if (items.length > 0) return items

  // 其他版型（例如 reel / 精選）直接掃整塊推薦區。
  return extractVideoItems(holder ?? next)
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
    const rawUrl: string = String(track["baseUrl"] ?? track["url"] ?? "")
    if (!rawUrl) continue
    // 有些 client （SABR 路線）給的是「/api/timedtext?…」這種相對路徑。
    const url: string = rawUrl.startsWith("//")
      ? `https:${rawUrl}`
      : rawUrl.startsWith("/") ? `https://www.youtube.com${rawUrl}` : rawUrl
    const languageCode: string = String(track["languageCode"] ?? "")
    const kind: string = String(track["kind"] ?? "")
    result.push({
      id: String(track["vssId"] ?? languageCode),
      languageCode,
      label: readText(track["name"]) || languageCode,
      url: /[?&]fmt=/.test(url) ? url.replace(/([?&]fmt=)[^&]*/, "$1vtt") : `${url}&fmt=vtt`,
      format: "vtt",
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
  // 兩個 renderer 帶的是同一份章節清單（各自還會出現兩遍），所以用「開始秒數」當唯一鍵；
  // 原本拿 title + 毫秒去比，跟 macro 的秒數永遠對不上，整排就重複了。
  const seen: Set<number> = new Set()

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
      if (title && !seen.has(start)) {
        seen.add(start)
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
      const start: number = Math.round(Number(chapter["timeRangeStartMillis"] ?? 0) / 1000)
      if (title && !seen.has(start)) {
        seen.add(start)
        found.push({
          title,
          startTime: start,
          endTime: start,
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

function parseCommentEntity(entity: JsonObject): CommentItem | null {
  const properties: JsonObject | null = asObject(entity["properties"])
  if (!properties) return null
  const commentId: string = String(properties["commentId"] ?? entity["key"] ?? "")
  const content: string = readText(properties["content"])
  if (!commentId || !content) return null

  // author / toolbar 是同一層的兄弟節點，不在 properties 裡。
  const author: JsonObject | null = asObject(entity["author"])
  const toolbar: JsonObject | null = asObject(entity["toolbar"])
  const likeText: string = readText(toolbar?.["likeCountNotliked"]) || readText(toolbar?.["likeCountLiked"])
  const replyText: string = readText(toolbar?.["replyCount"])
  const item: CommentItem = {
    id: commentId,
    authorId: String(author?.["channelId"] ?? ""),
    authorName: String(author?.["displayName"] ?? "") || readText(properties["authorButtonA11y"]).replace(/^@/, ""),
    authorAvatar:
      String(author?.["avatarThumbnailUrl"] ?? "") ||
      readThumbnailUrl(asObject(entity["avatar"])?.["image"] ?? entity["avatar"]),
    content,
    likeCount: Number(likeText.replace(/[^\d]/g, "")) || 0,
    publishedText: readText(properties["publishedTime"]),
  }
  const replyCount: number = Number((replyText.match(/\d+/) ?? ["0"])[0])
  if (replyCount > 0) item.replyCount = replyCount
  return item
}

/** 續頁 token：continuationItemRenderer 可能直挂 endpoint，也可能是「Show more replies」按鈕。 */
function continuationTokenOf(item: JsonObject | null): string | null {
  if (!item) return null
  const renderer: JsonObject | null = asObject(item["continuationItemRenderer"])
  const button: JsonObject | null = asObject(asObject(renderer?.["button"])?.["buttonRenderer"])
  const command: JsonObject | null =
    asObject(asObject(renderer?.["continuationEndpoint"])?.["continuationCommand"]) ??
    asObject(asObject(button?.["command"])?.["continuationCommand"])
  return typeof command?.["token"] === "string" ? String(command["token"]) : null
}

/** 一組項目陣列最後一項若是續頁項目，取出它的 token。 */
export function lastItemToken(items: unknown[]): string | null {
  return continuationTokenOf(asObject(items[items.length - 1]))
}

/**
 * 續頁 token：把整棵樹的 token 都收起來，排除剛用掉的那個，取**最長**的。
 * browse 的主 feed token 最長；取第一個／最深的那個會拿到子貨架的 token，YouTube 會回 400。
 */
function collectTokens(node: unknown, out: string[], depth: number = 0): void {
  if (!node || typeof node !== "object" || depth > 30) return
  if (Array.isArray(node)) {
    for (const entry of node) collectTokens(entry, out, depth + 1)
    return
  }
  const object = node as JsonObject
  const token: string =
    String(asObject(object["continuationCommand"])?.["token"] ?? "") ||
    String(asObject(object["nextContinuationData"])?.["continuation"] ?? "") ||
    String(asObject(object["reloadContinuationData"])?.["continuation"] ?? "") ||
    String(asObject(asObject(object["continuationEndpoint"])?.["continuationCommand"])?.["token"] ?? "") ||
    String(continuationTokenOf(object) ?? "")
  if (token) out.push(token)
  for (const key of Object.keys(object)) collectTokens(object[key], out, depth + 1)
}

export function findContinuationToken(response: JsonObject, currentToken: string = ""): string | null {
  const tokens: string[] = []
  collectTokens(response, tokens)
  let best: string = ""
  for (const token of tokens) {
    if (!token || token === currentToken) continue
    if (token.length > best.length) best = token
  }
  return best || null
}

/**
 * 排序 chip 的清單（標題＋它自己的 continuation token）。
 * 順序通常是 Latest / Popular / Oldest，但依標籤挑才不會因語系或頻道差異挑錯。
 */
export function extractSortChips(response: JsonObject): { label: string; token: string }[] {
  const chips: JsonObject[] = []

  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 30) return
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1)
      return
    }
    const object = node as JsonObject
    const chip: JsonObject | null = asObject(object["chipViewModel"])
    if (chip) chips.push(chip)
    for (const key of Object.keys(object)) walk(object[key], depth + 1)
  }

  walk(response, 0)
  return chips.map((chip: JsonObject): { label: string; token: string } => {
    const rawText: unknown = chip["text"]
    const label: string =
      typeof rawText === "string"
        ? rawText
        : String(asObject(rawText)?.["content"] ?? "")
    const token: string = String(
      asObject(asObject(asObject(chip["tapCommand"])?.["innertubeCommand"])?.["continuationCommand"])?.[
        "token"
      ] ?? "",
    )
    return { label, token }
  })
}

/**
 * 排序 chip 的 continuation token。保留給只需要 token 的呼叫端。
 */
export function extractSortTokens(response: JsonObject): string[] {
  return extractSortChips(response).map((chip: { label: string; token: string }): string => chip.token)
}

/** 回應裡所有 continuation token（依出現順序）。 */
export function collectContinuationTokens(response: JsonObject): string[] {
  const tokens: string[] = []

  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 24) return
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1)
      return
    }
    const object = node as JsonObject
    const command: JsonObject | null = asObject(object["continuationCommand"])
    const token: unknown = command?.["token"]
    if (typeof token === "string" && token && !tokens.includes(token)) tokens.push(token)
    for (const key of Object.keys(object)) walk(object[key], depth + 1)
  }

  walk(response, 0)
  return tokens
}

/**
 * 頻道「關於」頁的資訊；`videoCountText` 是精確數字（例：`1,014 videos`）。
 * header 上那行會被縮寫（mrbeast 顯示 `1K videos`），所以總數要從這裡拿。
 */
export interface AboutChannelInfo {
  videoCountText?: string
  subscriberCountText?: string
  viewCountText?: string
}

export function parseAboutChannel(response: JsonObject): AboutChannelInfo | null {
  let about: JsonObject | null = null

  const walk = (node: unknown, depth: number): void => {
    if (about || !node || typeof node !== "object" || depth > 24) return
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1)
      return
    }
    const object = node as JsonObject
    const found: JsonObject | null = asObject(object["aboutChannelViewModel"])
    if (found) {
      about = found
      return
    }
    for (const key of Object.keys(object)) walk(object[key], depth + 1)
  }

  walk(response, 0)
  if (!about) return null
  const info: JsonObject = about as JsonObject
  const read = (key: string): string | undefined => {
    const value: unknown = info[key]
    return typeof value === "string" && value ? value : undefined
  }
  return {
    videoCountText: read("videoCountText"),
    subscriberCountText: read("subscriberCountText"),
    viewCountText: read("viewCountText"),
  }
}

/** 頻道影片分頁：續頁回應只要影片與下一個 token。 */
export function parseChannelVideosPage(
  response: JsonObject,
  currentToken: string = "",
): { videos: UnifiedVideoItem[]; next: string | null } {
  return { videos: extractVideoItems(response), next: findContinuationToken(response, currentToken) }
}

/** 回應裡最後一組項目陣列的續頁 token（留言頁與回覆頁共用）。 */
export function findPageCursor(response: JsonObject): string | null {
  let cursor: string | null = null

  const visit = (node: unknown, depth: number): void => {
    if (!node || depth > 26) return
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1)
      return
    }
    const object: JsonObject | null = asObject(node)
    if (!object) return
    for (const key of Object.keys(object)) {
      // 整塊跳過：展開回覆的 token 也長在一樣的陣列裡，遞迴下去會認錯。
      if (key === "continuationItems") {
        const token: string | null = lastItemToken(asArray(object[key]))
        if (token) cursor = token
        continue
      }
      visit(object[key], depth + 1)
    }
  }

  visit(response, 0)
  return cursor
}

/** 解析留言（舊版 commentRenderer 與新版 commentEntityPayload 皆支援）。 */
export function parseComments(next: JsonObject): CommentItem[] {
  const comments: CommentItem[] = []
  const seen: Set<string> = new Set()
  const replyTokens: Map<string, string> = new Map()

  const visit = (node: unknown, depth: number): void => {
    if (!node || depth > 24) return
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1)
      return
    }
    const object: JsonObject | null = asObject(node)
    if (!object) return

    // 每則留言的回覆 token 掛在 thread 上，留言本體卻在 frameworkUpdates，先記下來再配對。
    const thread: JsonObject | null = asObject(object["commentThreadRenderer"])
    if (thread) {
      const viewModel: JsonObject | null = asObject(thread["commentViewModel"])
      const inner: JsonObject | null = asObject(viewModel?.["commentViewModel"])
      const commentId: string = String(inner?.["commentId"] ?? viewModel?.["commentId"] ?? "")
      const replies: JsonObject | null = asObject(asObject(thread["replies"])?.["commentRepliesRenderer"])
      const token: string | null = lastItemToken(asArray(replies?.["contents"]))
      if (commentId && token) replyTokens.set(commentId, token)
    }

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

  for (const comment of comments) {
    const token: string | undefined = replyTokens.get(comment.id)
    if (token && (comment.replyCount ?? 0) > 0) comment.replyCursor = token
  }
  return comments
}

/** 播放頁的頻道區塊：next 的 videoSecondaryInfoRenderer.owner.videoOwnerRenderer。 */
interface VideoOwnerInfo {
  name: string
  avatar: string
  subscriberText: string
  collaborators: VideoCollaborator[]
}

// 合作頻道的副標題長這樣：「‎⁨@handle⁩ • ⁨6.73M subscribers⁩」。
function collaboratorSubscribers(subtitle: string): string {
  const parts: string[] = subtitle.replace(/[\u200e\u200f\u2066-\u2069]/g, "").split("•")
  return parts.length > 1 ? parts[parts.length - 1].trim() : ""
}

/** 合作影片：owner 點下去的 Collaborators 對話框列出每個頻道。 */
function parseCollaborators(owner: JsonObject): VideoCollaborator[] {
  const dialog: JsonObject | null = asObject(
    asObject(asObject(asObject(owner["navigationEndpoint"])?.["showDialogCommand"])?.["panelLoadingStrategy"])?.["inlineContent"],
  )
  const list: JsonObject | null = asObject(
    asObject(asObject(asObject(dialog?.["dialogViewModel"])?.["customContent"])?.["listViewModel"]),
  )
  const collaborators: VideoCollaborator[] = []
  for (const entry of asArray(list?.["listItems"])) {
    const item: JsonObject | null = asObject(asObject(entry)?.["listItemViewModel"])
    if (!item) continue
    const title: JsonObject | null = asObject(item["title"])
    const name: string = readText(title)
    const command: JsonObject | null = asObject(
      asObject(asObject(asArray(title?.["commandRuns"])[0])?.["onTap"])?.["innertubeCommand"],
    )
    const id: string = String(asObject(command?.["browseEndpoint"])?.["browseId"] ?? "")
    if (!name || !id) continue
    const avatar: JsonObject | null = asObject(asObject(asObject(item["leadingAccessory"])?.["avatarViewModel"])?.["image"])
    const collaborator: VideoCollaborator = { id, name }
    const avatarUrl: string = readThumbnailUrl(avatar)
    if (avatarUrl) collaborator.avatarUrl = avatarUrl
    const subscribers: string = collaboratorSubscribers(readText(item["subtitle"]))
    if (subscribers) collaborator.subscriberCountText = subscribers
    collaborators.push(collaborator)
  }
  return collaborators
}

function parseVideoOwner(next: JsonObject): VideoOwnerInfo | null {
  const results: JsonObject | null = asObject(
    asObject(asObject(asObject(next["contents"])?.["twoColumnWatchNextResults"])?.["results"])?.["results"],
  )
  for (const entry of asArray(results?.["contents"])) {
    const secondary: JsonObject | null = asObject(asObject(entry)?.["videoSecondaryInfoRenderer"])
    const owner: JsonObject | null = asObject(asObject(secondary?.["owner"])?.["videoOwnerRenderer"])
    if (!owner) continue
    const collaborators: VideoCollaborator[] = parseCollaborators(owner)
    return {
      name: readText(owner["attributedTitle"]) || readText(owner["title"]),
      avatar: readThumbnailUrl(owner["thumbnail"]) || collaborators[0]?.avatarUrl || "",
      subscriberText: readText(owner["subscriberCountText"]),
      collaborators,
    }
  }
  return null
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
  const owner: VideoOwnerInfo | null = next ? parseVideoOwner(next) : null
  if (owner?.avatar) item.authorAvatar = owner.avatar
  if (owner?.subscriberText) item.subscriberCountText = owner.subscriberText
  if (owner && owner.collaborators.length > 1) {
    item.collaborators = owner.collaborators
    if (owner.name) item.authorName = owner.name
  }
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

  // 頻道的影片分頁不帶作者；合作影片則帶「A and B」，保留。
  const videos: UnifiedVideoItem[] = extractVideoItems(browse).map((video: UnifiedVideoItem): UnifiedVideoItem => {
    if (video.authorName && video.authorId) return video
    return {
      ...video,
      authorName: video.authorName || name,
      authorId: video.authorId || channelId,
      authorAvatar: video.authorAvatar || avatar || undefined,
    }
  })

  // metadata 那行是「527M subscribers · 1K videos」，拆成訂閱數與影片總數。
  const headerMetadata: JsonObject | null = asObject(pageHeader["metadata"])
  const metaParts: string[] = []
  for (const row of asArray(asObject(headerMetadata?.["contentMetadataViewModel"])?.["metadataRows"])) {
    for (const part of asArray(asObject(row)?.["metadataParts"])) {
      const text: string = readText(asObject(part)?.["text"]).trim()
      if (text) metaParts.push(text)
    }
  }
  const subscriberText: string =
    metaParts.find((part: string): boolean => /subscriber|訂閱|订阅|粉絲|粉丝/i.test(part)) ?? ""
  const videosText: string = metaParts.find((part: string): boolean => /videos?|影片|视频/i.test(part)) ?? ""
  const subscriberCount: string = subscriberText
    .replace(/\s*(位)?(subscribers?|訂閱(者)?|订阅(者)?|粉絲|粉丝)\s*$/i, "")
    .trim()
  const videoCountText: string = videosText.replace(/\s*(videos?|影片|视频)\s*$/i, "").trim()

  return {
    id: `yt:${channelId}`,
    provider: "yt",
    rawId: channelId,
    name,
    avatarUrl: avatar,
    bannerUrl: banner || undefined,
    description: String(channelMetadata["description"] ?? microformat["description"] ?? ""),
    subscriberCountText: subscriberCount ? `${subscriberCount} 訂閱` : readText(pageHeader["metadata"]) || undefined,
    videoCountText: videoCountText || undefined,
    videos,
  }
}
