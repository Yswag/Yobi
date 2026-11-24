import { VStack, useCallback, useRef, useState } from "scripting"
import type { ScrollVisibilityChangeOptions, VirtualNode } from "scripting"
import type { CommentItem, CommentSort } from "../types/index"
import { ChipBar, EmptyState } from "../ui/primitives"
import { prefetchIndexFor } from "../utils/paging"
import { CommentThread, CommentsSkeleton } from "./comments/CommentThread"
import { LoadMoreFooter } from "./paging/LoadMoreFooter"
import { usePrefetchTrigger } from "./paging/usePrefetchTrigger"

const SORT_OPTIONS: { key: CommentSort; label: string }[] = [
  { key: "top", label: "最熱" },
  { key: "newest", label: "最新" },
]

const PREFETCH_LEAD_COUNT: number = 6

export interface CommentsSheetProps {
  comments: CommentItem[]
  loading: boolean
  loadingMore: boolean
  sort: CommentSort
  hasMore: boolean
  repliesLoading: Record<string, boolean>
  onSort: (sort: CommentSort) => void
  onLoadMore: () => void
  onLoadReplies: (commentId: string) => void
  onRefresh?: () => void
}

export function CommentsSheet(props: CommentsSheetProps): VirtualNode {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})
  const expandedIdsRef = useRef<Record<string, boolean>>(expandedIds)
  expandedIdsRef.current = expandedIds
  const onLoadRepliesRef = useRef(props.onLoadReplies)
  onLoadRepliesRef.current = props.onLoadReplies
  const prefetchObserver: ScrollVisibilityChangeOptions = usePrefetchTrigger(props.onLoadMore)

  const handleToggle = useCallback((comment: CommentItem): void => {
    const willExpand: boolean = expandedIdsRef.current[comment.id] !== true
    const next: Record<string, boolean> = { ...expandedIdsRef.current, [comment.id]: willExpand }
    expandedIdsRef.current = next
    setExpandedIds(next)
    const loaded: number = (comment.replies ?? []).length
    if (willExpand && loaded === 0 && comment.replyCursor) onLoadRepliesRef.current(comment.id)
  }, [])

  const handleLoadReplies = useCallback((commentId: string): void => {
    onLoadRepliesRef.current(commentId)
  }, [])

  const sortBar: VirtualNode = (
    <ChipBar
      options={SORT_OPTIONS}
      value={props.sort}
      onChange={props.onSort}
    />
  )

  if (props.loading) {
    return (
      <VStack spacing={12} frame={{ maxWidth: "infinity" }} padding={{ top: 4 }}>
        {sortBar}
        <CommentsSkeleton />
      </VStack>
    )
  }

  if (props.comments.length === 0) {
    return (
      <EmptyState
        icon="bubble.left.and.bubble.right"
        title="還沒有留言"
        actionLabel={props.onRefresh ? "重新載入" : undefined}
        onAction={props.onRefresh}
      />
    )
  }

  const footer: VirtualNode = (
    <LoadMoreFooter
      loading={props.loadingMore}
      hasMore={props.hasMore}
      label="載入更多留言"
      endText="沒有更多留言"
      onLoadMore={props.onLoadMore}
    />
  )

  const prefetchIndex: number = prefetchIndexFor(props.comments.length, props.hasMore, PREFETCH_LEAD_COUNT)

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
      {sortBar}
      <VStack spacing={0} padding={{ top: 4 }} frame={{ maxWidth: "infinity" }}>
        {props.comments.map((comment: CommentItem, index: number) => (
          <CommentThread
            key={comment.id}
            comment={comment}
            expanded={expandedIds[comment.id] === true}
            loading={props.repliesLoading[comment.id] === true}
            scrollVisibility={index === prefetchIndex ? prefetchObserver : undefined}
            onToggle={handleToggle}
            onLoadMore={handleLoadReplies}
          />
        ))}
        {footer}
      </VStack>
    </VStack>
  )
}
