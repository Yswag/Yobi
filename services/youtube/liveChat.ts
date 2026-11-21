
import { fetch } from "scripting"
import {
  fetchNextResponse,
  getAnonymousVisitorData,
  getYoutubeAuth,
  INNERTUBE_CLIENTS,
  type JsonObject,
} from "./innertube"
import { getYoutubeLocale } from "./locale"

const CHAT_ENDPOINT: string = "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat"
const DEFAULT_POLL_MS: number = 2500
const MIN_POLL_MS: number = 500
const MAX_POLL_MS: number = 30_000

export type LiveChatKind = "text" | "paid" | "membership" | "sticker"

export interface LiveChatRun {
  text?: string
  imageUrl?: string
}

export interface LiveChatMessage {
  id: string
  authorId: string
  authorName: string
  avatarUrl?: string
  text: string
  runs: LiveChatRun[]
  kind: LiveChatKind
  color?: string
  at: number
}

export interface LiveChatCursor {
  continuation: string
  clickTrackingParams: string
  pollMs: number
}

export interface LiveChatBatch {
  messages: LiveChatMessage[]
  cursor: LiveChatCursor | null
}

function asObject(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject
  return null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function readText(node: unknown): string {
  const object: JsonObject | null = asObject(node)
  if (!object) return typeof node === "string" ? node : ""
  if (typeof object["simpleText"] === "string") return object["simpleText"]
  return asArray(object["runs"])
    .map((run: unknown): string => {
      const entry: JsonObject | null = asObject(run)
      if (!entry) return ""
      const text: unknown = entry["text"]
      if (typeof text === "string") return text
      const emoji: JsonObject | null = asObject(entry["emoji"])
      if (!emoji) return ""
      const shortcuts: unknown[] = asArray(emoji["shortcuts"])
      return typeof shortcuts[0] === "string" ? shortcuts[0] : ""
    })
    .join("")
}

function hexColor(value: unknown): string | undefined {
  const raw: number = Number(value)
  if (!Number.isFinite(raw) || raw <= 0 || raw >= 0xffffffff) return undefined
  return `#${(raw & 0xffffff).toString(16).padStart(6, "0")}`
}

function thumbnailUrl(node: unknown): string | undefined {
  const first: JsonObject | null = asObject(asArray(asObject(node)?.["thumbnails"])[0])
  const url: unknown = first?.["url"]
  return typeof url === "string" && url ? url : undefined
}

interface RendererEntry {
  kind: LiveChatKind
  renderer: JsonObject
}

function rendererOf(item: JsonObject): RendererEntry | null {
  const mapping: { key: string; kind: LiveChatKind }[] = [
    { key: "liveChatTextMessageRenderer", kind: "text" },
    { key: "liveChatPaidMessageRenderer", kind: "paid" },
    { key: "liveChatPaidStickerRenderer", kind: "sticker" },
    { key: "liveChatMembershipItemRenderer", kind: "membership" },
  ]
  for (const entry of mapping) {
    const renderer: JsonObject | null = asObject(item[entry.key])
    if (renderer) return { kind: entry.kind, renderer }
  }
  return null
}

function textOf(renderer: JsonObject): string {
  const keys: string[] = ["message", "headerSubtext", "headerPrimaryText", "purchaseAmountText"]
  for (const key of keys) {
    const text: string = readText(renderer[key]).trim()
    if (text) return text
  }
  return ""
}

function emojiIsCharacter(emojiId: string): boolean {
  return emojiId.length > 0 && emojiId.length <= 8 && /[^\x00-\x7f]/.test(emojiId)
}

function emojiImageUrl(emoji: JsonObject): string | undefined {
  const thumbnails: unknown[] = asArray(asObject(emoji["image"])?.["thumbnails"])
  let best: JsonObject | null = null
  for (const entry of thumbnails) {
    const thumb: JsonObject | null = asObject(entry)
    if (!thumb || typeof thumb["url"] !== "string") continue
    if (!best || Number(thumb["width"] ?? 0) > Number(best["width"] ?? 0)) best = thumb
  }
  return typeof best?.["url"] === "string" ? String(best["url"]) : undefined
}

function pushText(runs: LiveChatRun[], text: string): void {
  if (!text) return
  const last: LiveChatRun | undefined = runs[runs.length - 1]
  if (last && last.imageUrl === undefined) {
    last.text = `${last.text ?? ""}${text}`
    return
  }
  runs.push({ text })
}

function runsOf(renderer: JsonObject): LiveChatRun[] {
  const runs: LiveChatRun[] = []
  for (const raw of asArray(asObject(renderer["message"])?.["runs"])) {
    if (runs.length >= 60) break
    const entry: JsonObject | null = asObject(raw)
    if (!entry) continue
    const text: unknown = entry["text"]
    if (typeof text === "string") {
      pushText(runs, text)
      continue
    }
    const emoji: JsonObject | null = asObject(entry["emoji"])
    if (!emoji) continue
    const emojiId: string = String(emoji["emojiId"] ?? "")
    if (emojiIsCharacter(emojiId)) {
      pushText(runs, emojiId)
      continue
    }
    const imageUrl: string | undefined = emojiImageUrl(emoji)
    if (imageUrl) {
      runs.push({ imageUrl })
      continue
    }
    const shortcuts: unknown[] = asArray(emoji["shortcuts"])
    if (typeof shortcuts[0] === "string") pushText(runs, shortcuts[0])
  }
  return runs
}

function cursorOf(liveChat: JsonObject): LiveChatCursor | null {
  const keys: string[] = ["invalidationContinuationData", "timedContinuationData", "reloadContinuationData"]
  for (const key of keys) {
    for (const entry of asArray(liveChat["continuations"])) {
      const data: JsonObject | null = asObject(asObject(entry)?.[key])
      const continuation: unknown = data?.["continuation"]
      if (typeof continuation !== "string" || !continuation) continue
      const timeout: number = Number(data?.["timeoutMs"] ?? DEFAULT_POLL_MS)
      return {
        continuation,
        clickTrackingParams: String(data?.["clickTrackingParams"] ?? ""),
        pollMs: Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Number.isFinite(timeout) ? timeout : DEFAULT_POLL_MS)),
      }
    }
  }
  return null
}

function parseChatResponse(response: JsonObject): LiveChatBatch {
  const liveChat: JsonObject | null = asObject(asObject(response["continuationContents"])?.["liveChatContinuation"])
  if (!liveChat) return { messages: [], cursor: null }

  const messages: LiveChatMessage[] = []
  for (const action of asArray(liveChat["actions"])) {
    const object: JsonObject | null = asObject(action)
    if (!object) continue
    const item: JsonObject | null =
      asObject(asObject(object["addChatItemAction"])?.["item"]) ??
      asObject(asObject(object["replaceChatItemAction"])?.["replacementItem"])
    if (!item) continue
    const entry: RendererEntry | null = rendererOf(item)
    if (!entry) continue
    const runs: LiveChatRun[] = runsOf(entry.renderer)
    const head: LiveChatRun | undefined = runs[0]
    if (head && head.text) head.text = head.text.replace(/^\s+/, "")
    const tail: LiveChatRun | undefined = runs[runs.length - 1]
    if (tail && tail.text) tail.text = tail.text.replace(/\s+$/, "")
    const text: string = runs.length > 0 ? runs.map((run: LiveChatRun): string => run.text ?? "").join("") : textOf(entry.renderer)
    if (!text && runs.every((run: LiveChatRun): boolean => !run.imageUrl)) continue
    const id: string =
      String(entry.renderer["id"] ?? "") ||
      `${String(entry.renderer["timestampUsec"] ?? "")}:${String(asObject(entry.renderer["authorName"])?.["simpleText"] ?? "")}:${text}`
    const message: LiveChatMessage = {
      id,
      authorId: String(entry.renderer["authorExternalChannelId"] ?? ""),
      authorName: readText(entry.renderer["authorName"]) || String(entry.renderer["authorExternalChannelId"] ?? ""),
      text,
      runs: runs.length > 0 ? runs : [{ text }],
      kind: entry.kind,
      at: Number(String(entry.renderer["timestampUsec"] ?? "0")) / 1000 || Date.now(),
    }
    const avatar: string | undefined = thumbnailUrl(entry.renderer["authorPhoto"])
    if (avatar) message.avatarUrl = avatar
    const color: string | undefined = hexColor(entry.renderer["authorNameTextColor"])
    if (color) message.color = color
    messages.push(message)
  }

  return { messages, cursor: cursorOf(liveChat) }
}

export async function fetchLiveChatStart(videoId: string): Promise<LiveChatCursor | null> {
  const next: JsonObject = await fetchNextResponse(videoId)
  const conversationBar: JsonObject | null = asObject(
    asObject(asObject(next["contents"])?.["twoColumnWatchNextResults"])?.["conversationBar"],
  )
  const liveChat: JsonObject | null = asObject(conversationBar?.["liveChatRenderer"])
  return liveChat ? cursorOf(liveChat) : null
}

export async function fetchLiveChatBatch(videoId: string, cursor: LiveChatCursor): Promise<LiveChatBatch> {
  const locale = getYoutubeLocale()
  const auth = getYoutubeAuth()
  const visitorData: string | undefined = auth.visitorData ?? (await getAnonymousVisitorData())
  const config = INNERTUBE_CLIENTS.WEB
  const client: JsonObject = {
    ...config.context["client"],
    hl: locale.hl,
    gl: locale.gl,
  }
  if (visitorData) client["visitorData"] = visitorData

  const body: JsonObject = {
    context: {
      client,
      user: { lockedSafetyMode: false },
      request: { useSsl: true, internalExperimentFlags: [] },
    },
    continuation: cursor.continuation,
  }
  if (cursor.clickTrackingParams) {
    body["context"] = { ...body["context"], clickTracking: { clickTrackingParams: cursor.clickTrackingParams } }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-YouTube-Client-Name": String(config.clientName),
    "X-YouTube-Client-Version": config.clientVersion,
    "User-Agent": config.userAgent,
    Origin: "https://www.youtube.com",
    Referer: `https://www.youtube.com/watch?v=${videoId}`,
  }
  if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData
  if (auth.cookie) {
    headers["Cookie"] = auth.cookie
    headers["X-Goog-AuthUser"] = "0"
  }
  if (auth.authorization) {
    headers["Authorization"] = auth.authorization
    headers["X-Origin"] = "https://www.youtube.com"
  }

  const response = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeout: 15,
    debugLabel: "Yobi YouTube live chat",
  })
  if (!response.ok) throw new Error(`聊天室回應 HTTP ${response.status}`)
  return parseChatResponse((await response.json()) as JsonObject)
}
