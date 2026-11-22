import type { CommentItem, CommentPage, CommentQuery, CommentRun } from "../../types/index"
import {
  BILI_API,
  cleanText,
  imageUrl,
  mayTryNextEndpoint,
  numberOrUndefined,
  publishedTextFromEpoch,
  raiseIfBanned,
  resolveAid,
  resolveIds,
} from "./meta"
import { biliFetchJson } from "./wbi"

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function emoteRuns(message: string, emotes: unknown): CommentRun[] | undefined {
  if (!message || !emotes || typeof emotes !== "object") return undefined
  const table: Record<string, any> = emotes as Record<string, any>
  const keys: string[] = Object.keys(table).filter(
    (key: string): boolean => typeof table[key]?.url === "string",
  )
  if (keys.length === 0) return undefined
  keys.sort((a: string, b: string): number => b.length - a.length)
  const pattern: RegExp = new RegExp(keys.map(escapeRegExp).join("|"), "g")
  const runs: CommentRun[] = []
  let last: number = 0
  let matched: boolean = false
  let match: RegExpExecArray | null
  while ((match = pattern.exec(message)) !== null) {
    if (!match[0]) break
    matched = true
    if (match.index > last) runs.push({ text: message.slice(last, match.index) })
    const emote: any = table[match[0]]
    const run: CommentRun = { imageUrl: emote.url, alt: match[0] }
    if (Number(emote?.meta?.size) === 2) run.scale = 2
    runs.push(run)
    last = match.index + match[0].length
  }
  if (!matched) return undefined
  if (last < message.length) runs.push({ text: message.slice(last) })
  return runs
}

function mapReply(raw: any): CommentItem {
  const member = raw?.member ?? {}
  const replies = Array.isArray(raw?.replies) ? raw.replies.slice(0, 3) : []
  const inline: CommentItem[] | undefined = replies.length ? replies.map(mapReply) : undefined
  const replyCount: number = Number(raw?.rcount) || 0
  const content: string = typeof raw?.content?.message === "string" ? raw.content.message : ""
  const item: CommentItem = {
    id: String(raw?.rpid_str ?? raw?.rpid ?? ""),
    authorId: String(member.mid ?? ""),
    authorName: cleanText(member.uname),
    authorAvatar: imageUrl(member.avatar ?? member.avatar_url),
    content,
    likeCount: Number(raw?.like) || 0,
    publishedText: publishedTextFromEpoch(numberOrUndefined(raw?.ctime)) ?? "",
    replyCount,
    replies: inline,
  }
  if (replyCount > 0) item.replyCursor = "1"
  const runs: CommentRun[] | undefined = emoteRuns(content, raw?.content?.emote)
  if (runs) item.runs = runs
  return item
}

export async function getBiliCommentPage(
  bvidOrAid: string,
  query: CommentQuery = {},
): Promise<CommentPage> {
  const ids = await resolveIds(bvidOrAid)
  const oid: number = await resolveAid(ids)
  const raw: string = String(query.cursor ?? "p1")
  const isOffset: boolean = raw.startsWith("o")
  const offset: string = isOffset ? raw.slice(1) : ""
  const page: number = isOffset ? 1 : Math.max(1, Number(raw.replace(/^p/, "")) || 1)
  const mode: number = query.sort === "newest" ? 2 : 3

  try {
    const main: any = await biliFetchJson<any>(`${BILI_API}/x/v2/reply/main`, {
      oid,
      type: 1,
      mode,
      next: page,
      ps: 20,
      pagination_str: JSON.stringify({ offset }),
    })
    raiseIfBanned(main, "comments.main")
    const replies = main?.data?.replies
    if (Array.isArray(replies)) {
      const cursorInfo = main?.data?.cursor
      const nextOffset: string = String(cursorInfo?.pagination_reply?.next_offset ?? "")
      const hasIsEnd: boolean = typeof cursorInfo?.is_end === "boolean"
      const ended: boolean =
        cursorInfo?.is_end === true ||
        (nextOffset === "" && (hasIsEnd ? replies.length === 0 : replies.length < 20))
      return {
        comments: replies.map(mapReply),
        cursor: ended ? null : nextOffset ? `o${nextOffset}` : `p${page + 1}`,
      }
    }
  } catch (error) {
    if (!mayTryNextEndpoint("comments.main", error)) throw error
  }

  const legacy: any = await biliFetchJson<any>(`${BILI_API}/x/v2/reply`, {
    oid,
    type: 1,
    pn: page,
    ps: 20,
    sort: mode === 2 ? 0 : 2,
  })
  const legacyReplies = legacy?.data?.replies
  const comments: CommentItem[] = Array.isArray(legacyReplies) ? legacyReplies.map(mapReply) : []
  const legacyCount: number = Number(legacy?.data?.page?.count ?? 0)
  const legacyEnded: boolean =
    comments.length === 0 || (legacyCount > 0 ? page * 20 >= legacyCount : comments.length < 20)
  return { comments, cursor: legacyEnded ? null : `p${page + 1}` }
}

export async function getBiliCommentReplies(
  bvidOrAid: string,
  rootId: string,
  query: CommentQuery = {},
): Promise<CommentPage> {
  const ids = await resolveIds(bvidOrAid)
  const oid: number = await resolveAid(ids)
  const page: number = Math.max(1, Number(query.cursor ?? "1") || 1)
  const result: any = await biliFetchJson<any>(`${BILI_API}/x/v2/reply/reply`, {
    oid,
    type: 1,
    root: rootId,
    pn: page,
    ps: 20,
  })
  const replies = result?.data?.replies
  const comments: CommentItem[] = Array.isArray(replies) ? replies.map(mapReply) : []
  return { comments, cursor: comments.length < 20 ? null : String(page + 1) }
}
