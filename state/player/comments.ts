import { useEffect, useState } from "scripting"
import type { CommentItem, CommentPage, CommentSort, UnifiedVideoItem } from "../../types/index"
import { getCommentPage, getCommentReplies } from "../../services/index"
import { reportError } from "../../services/errors"
import { appendUnique } from "../../utils/paging"
import type { CommentsStoreSnapshot } from "./types"
import { readDraftStore, runtime, shallowEqual } from "./store"

const commentsListeners: Set<() => void> = new Set()

let commentsState: CommentsStoreSnapshot = {
  comments: [],
  loading: false,
  sort: "top",
  cursor: null,
  loadingMore: false,
  repliesLoading: {},
}

let lastEmittedComments: CommentsStoreSnapshot | null = null

function emitComments(): void {
  const next: CommentsStoreSnapshot = { ...commentsState }
  if (lastEmittedComments !== null && shallowEqual(next, lastEmittedComments)) return
  lastEmittedComments = next
  commentsState = { ...next }
  for (const listener of Array.from(commentsListeners)) {
    try {
      listener()
    } catch (error) {
      reportError("player", "comments.listener", error)
    }
  }
}

export function resetCommentsState(loading: boolean): void {
  commentsState = {
    comments: [],
    loading,
    sort: "top",
    cursor: null,
    loadingMore: false,
    repliesLoading: {},
  }
  emitComments()
}

export function loadInitialComments(item: UnifiedVideoItem, requestId: number): void {
  if (item.isLive) return
  void getCommentPage(item.provider, item.rawId, { sort: commentsState.sort })
    .then((page: CommentPage) => {
      if (requestId !== runtime.openRequestSeq) return
      commentsState.comments = page.comments
      commentsState.cursor = page.cursor
      commentsState.loading = false
      emitComments()
    })
    .catch((error: unknown) => {
      if (requestId !== runtime.openRequestSeq) return
      reportError("player", "comments.load", error)
      commentsState.loading = false
      emitComments()
    })
}

export function getCommentsStoreSnapshot(): CommentsStoreSnapshot {
  return lastEmittedComments ?? commentsState
}

export function subscribeCommentsStore(listener: () => void): () => void {
  commentsListeners.add(listener)
  return (): void => {
    commentsListeners.delete(listener)
  }
}

export function useCommentsStore(): CommentsStoreSnapshot {
  const [snap, setSnap] = useState<CommentsStoreSnapshot>(() => getCommentsStoreSnapshot())
  useEffect(() => {
    setSnap(getCommentsStoreSnapshot())
    return subscribeCommentsStore(() => {
      setSnap(getCommentsStoreSnapshot())
    })
  }, [])
  return snap
}

export async function reloadComments(): Promise<void> {
  const item: UnifiedVideoItem | null = readDraftStore().currentItem
  if (!item) return
  const sort: CommentSort = commentsState.sort
  commentsState.loading = true
  commentsState.cursor = null
  emitComments()
  try {
    const page: CommentPage = await getCommentPage(item.provider, item.rawId, { sort })
    if (readDraftStore().currentItem?.id !== item.id || commentsState.sort !== sort) return
    commentsState.comments = page.comments
    commentsState.cursor = page.cursor
  } catch (error) {
    reportError("player", "comments.reload", error)
  } finally {
    if (readDraftStore().currentItem?.id === item.id) {
      commentsState.loading = false
      emitComments()
    }
  }
}

export async function setCommentsSort(sort: CommentSort): Promise<void> {
  if (commentsState.sort === sort) return
  commentsState.sort = sort
  await reloadComments()
}

export async function loadMoreComments(): Promise<void> {
  const item: UnifiedVideoItem | null = readDraftStore().currentItem
  const cursor: string | null = commentsState.cursor
  if (!item || !cursor || commentsState.loading || commentsState.loadingMore) return

  const sort: CommentSort = commentsState.sort
  commentsState.loadingMore = true
  emitComments()
  try {
    const page: CommentPage = await getCommentPage(item.provider, item.rawId, { sort, cursor })
    if (readDraftStore().currentItem?.id !== item.id || commentsState.sort !== sort) return
    commentsState.comments = appendUnique(commentsState.comments, page.comments)
    commentsState.cursor = page.cursor
  } catch (error) {
    reportError("player", "comments.more", error)
  } finally {
    commentsState.loadingMore = false
    emitComments()
  }
}

export async function loadCommentReplies(commentId: string): Promise<void> {
  const item: UnifiedVideoItem | null = readDraftStore().currentItem
  const target: CommentItem | undefined = commentsState.comments.find(
    (comment: CommentItem): boolean => comment.id === commentId,
  )
  const cursor: string | null | undefined = target?.replyCursor
  if (!item || !target || !cursor) return
  if (commentsState.repliesLoading[commentId] === true) return

  commentsState.repliesLoading = { ...commentsState.repliesLoading, [commentId]: true }
  emitComments()
  try {
    const page: CommentPage = await getCommentReplies(item.provider, item.rawId, commentId, cursor)
    if (readDraftStore().currentItem?.id !== item.id) return
    commentsState.comments = commentsState.comments.map((comment: CommentItem): CommentItem => {
      if (comment.id !== commentId) return comment
      return { ...comment, replies: appendUnique(comment.replies ?? [], page.comments), replyCursor: page.cursor }
    })
  } catch (error) {
    reportError("player", "comments.replies", error)
  } finally {
    commentsState.repliesLoading = { ...commentsState.repliesLoading, [commentId]: false }
    emitComments()
  }
}
