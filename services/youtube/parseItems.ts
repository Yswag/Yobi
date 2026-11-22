import type { SubtitleTrackInfo, UnifiedVideoItem, VideoChapter } from "../../types/index"
import type { JsonObject } from "./innertube"
import {
  asArray,
  asObject,
  browseIdOf,
  commandRunBrowseId,
  findThumbnailDeep,
  isLiveRenderer,
  isMembersBadge,
  parseDurationText,
  parsePublishedAt,
  parseViewCountText,
  readText,
  readThumbnailUrl,
  runNavigationBrowseId,
  VIDEO_RENDERER_KEYS,
} from "./parsePrimitives"

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
    provider,
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
  const membersOnly: boolean = asArray(renderer["badges"]).some((badge: unknown): boolean => {
    const meta: JsonObject | null = asObject(asObject(badge)?.["metadataBadgeRenderer"])
    return meta !== null && isMembersBadge(String(meta["style"] ?? ""), readText(meta["label"]))
  })
  const item: UnifiedVideoItem = baseItem(
    "yt",
    rawId,
    title,
    readThumbnailUrl(renderer["thumbnail"]) || `https://i.ytimg.com/vi/${rawId}/mqdefault.jpg`,
    parseDurationText(lengthText),
    parseViewCountText(viewText),
    authorId,
    authorName,
    avatar,
    publishedText,
    isLive,
  )
  if (membersOnly) item.membersOnly = true
  return item
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

  const decorated: JsonObject | null = asObject(asObject(metadata?.["image"])?.["decoratedAvatarViewModel"])
  const ownerAvatar: string =
    readThumbnailUrl(asObject(asObject(decorated?.["avatar"])?.["avatarViewModel"])?.["image"]) ||
    findThumbnailDeep(metadata?.["image"])
  const ownerId: string = browseIdOf(
    asObject(asObject(asObject(decorated?.["rendererContext"])?.["commandContext"])?.["onTap"])?.["innertubeCommand"],
  )

  const parts: string[] = []
  const partNodes: unknown[] = []
  let membersOnly: boolean = false
  for (const row of rows) {
    for (const badge of asArray(asObject(row)?.["badges"])) {
      const model: JsonObject | null = asObject(asObject(badge)?.["badgeViewModel"])
      if (model && isMembersBadge(String(model["badgeStyle"] ?? ""), readText(model["badgeText"]))) {
        membersOnly = true
      }
    }
    for (const part of asArray(asObject(row)?.["metadataParts"])) {
      const text: string = readText(asObject(part)?.["text"]).trim()
      if (text) {
        parts.push(text)
        partNodes.push(asObject(part)?.["text"])
      }
    }
  }

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
      if (viewCount === undefined) viewCount = parseViewCountText(text)
      continue
    }
    if (/\d/.test(text) && /(ago|前)/i.test(text) && !/view|觀看|观看/i.test(text)) {
      if (!publishedText) publishedText = text
      continue
    }
    if (/\d/.test(text) && (/view|觀看|观看|次/i.test(text) || bareCount.test(text))) {
      if (viewCount === undefined) viewCount = parseViewCountText(text)
      continue
    }
    if (!authorName && text !== title) {
      authorName = text
      if (!authorId) authorId = commandRunBrowseId(partNodes[index])
    }
  }

  const item: UnifiedVideoItem = baseItem(
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
  if (membersOnly) item.membersOnly = true
  return item
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

export function parseRelatedVideos(next: JsonObject): UnifiedVideoItem[] {
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

  return extractVideoItems(holder ?? next)
}

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

export function parseChapters(next: JsonObject): VideoChapter[] {
  const found: VideoChapter[] = []
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
      const start: number = parseDurationText(readText(item["timeDescription"]))
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
