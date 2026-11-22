import type { CommentItem, CommentRun, UnifiedVideoItem } from "../../types"
import type { JsonObject } from "./innertube"
import { extractVideoItems } from "./parseItems"
import { asArray, asObject, readText, readThumbnailUrl, runNavigationBrowseId } from "./parsePrimitives"

const MAX_COMMENT_EMOJIS: number = 500
const commentEmojiUrls: Map<string, string> = new Map()

function rememberCommentEmojis(node: unknown, depth: number = 0): void {
  if (!node || typeof node !== "object" || depth > 30) return
  if (Array.isArray(node)) {
    for (const entry of node) rememberCommentEmojis(entry, depth + 1)
    return
  }
  const object = node as JsonObject
  const shortcuts: unknown[] = asArray(object["shortcuts"])
  if (shortcuts.length > 0) {
    const image: JsonObject | null = asObject(object["image"])
    const url: string = image ? readThumbnailUrl(image) : ""
    if (url) {
      for (const shortcut of shortcuts) {
        if (typeof shortcut === "string" && shortcut) {
          if (!commentEmojiUrls.has(shortcut) && commentEmojiUrls.size >= MAX_COMMENT_EMOJIS) {
            const oldest: string | undefined = commentEmojiUrls.keys().next().value
            if (oldest !== undefined) commentEmojiUrls.delete(oldest)
          }
          commentEmojiUrls.set(shortcut, url)
        }
      }
    }
  }
  for (const key of Object.keys(object)) rememberCommentEmojis(object[key], depth + 1)
}

function commentRuns(text: string): CommentRun[] | undefined {
  if (!text || commentEmojiUrls.size === 0) return undefined
  const runs: CommentRun[] = []
  const pattern: RegExp = /:[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}:/g
  let last: number = 0
  let matched: boolean = false
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const url: string | undefined = commentEmojiUrls.get(match[0])
    if (!url) continue
    matched = true
    if (match.index > last) runs.push({ text: text.slice(last, match.index) })
    runs.push({ imageUrl: url, alt: match[0] })
    last = match.index + match[0].length
  }
  if (!matched) return undefined
  if (last < text.length) runs.push({ text: text.slice(last) })
  return runs
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
  const runs: CommentRun[] | undefined = commentRuns(content)
  if (runs) item.runs = runs
  return item
}

function parseCommentEntity(entity: JsonObject): CommentItem | null {
  const properties: JsonObject | null = asObject(entity["properties"])
  if (!properties) return null
  const commentId: string = String(properties["commentId"] ?? entity["key"] ?? "")
  const content: string = readText(properties["content"])
  if (!commentId || !content) return null

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
  const runs: CommentRun[] | undefined = commentRuns(content)
  if (runs) item.runs = runs
  return item
}

function continuationTokenOf(item: JsonObject | null): string | null {
  if (!item) return null
  const renderer: JsonObject | null = asObject(item["continuationItemRenderer"])
  const button: JsonObject | null = asObject(asObject(renderer?.["button"])?.["buttonRenderer"])
  const command: JsonObject | null =
    asObject(asObject(renderer?.["continuationEndpoint"])?.["continuationCommand"]) ??
    asObject(asObject(button?.["command"])?.["continuationCommand"])
  return typeof command?.["token"] === "string" ? String(command["token"]) : null
}

export function lastItemToken(items: unknown[]): string | null {
  return continuationTokenOf(asObject(items[items.length - 1]))
}

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

export function extractSortTokens(response: JsonObject): string[] {
  return extractSortChips(response).map((chip: { label: string; token: string }): string => chip.token)
}

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

export function parseChannelVideosPage(
  response: JsonObject,
  currentToken: string = "",
): { videos: UnifiedVideoItem[]; next: string | null } {
  return { videos: extractVideoItems(response), next: findContinuationToken(response, currentToken) }
}

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

export function parseComments(next: JsonObject): CommentItem[] {
  rememberCommentEmojis(next)
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
