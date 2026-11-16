import { HStack, Image, Text, VStack, useState } from "scripting"
import type { VirtualNode } from "scripting"
import type { CommentItem, CommentSort } from "../types"
import { formatCount } from "../utils/format"
import { Avatar, ChipBar, EmptyState, PillButton, Skeleton } from "../ui/primitives"
import { palette, space, type } from "../ui/theme"

const SORT_OPTIONS: { key: CommentSort; label: string }[] = [
  { key: "top", label: "最熱" },
  { key: "newest", label: "最新" },
]

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

function CommentBody(props: { comment: CommentItem; avatarSize: number; footer?: VirtualNode }): VirtualNode {
  const comment: CommentItem = props.comment
  return (
    <HStack alignment="top" spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <Avatar url={comment.authorAvatar || undefined} name={comment.authorName} size={props.avatarSize} />
      <VStack alignment="leading" spacing={5} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <HStack spacing={6}>
          <Text font={type.meta + 1} fontWeight="semibold" foregroundStyle="secondaryLabel" lineLimit={1}>
            {comment.authorName}
          </Text>
          {comment.publishedText ? (
            <Text font={type.meta} foregroundStyle="tertiaryLabel" lineLimit={1}>{comment.publishedText}</Text>
          ) : null}
        </HStack>
        <Text
          font={type.cardTitle}
          foregroundStyle="label"
          lineSpacing={3}
          multilineTextAlignment="leading"
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          {comment.content}
        </Text>
        <HStack spacing={18}>
          <HStack spacing={5}>
            <Image systemName="hand.thumbsup" font={13} foregroundStyle="secondaryLabel" />
            {comment.likeCount > 0 ? (
              <Text font={type.meta} monospacedDigit foregroundStyle="secondaryLabel">{formatCount(comment.likeCount)}</Text>
            ) : null}
          </HStack>
          {props.footer ?? null}
        </HStack>
      </VStack>
    </HStack>
  )
}

function CommentThread(props: {
  comment: CommentItem
  expanded: boolean
  loading: boolean
  onToggle: () => void
  onLoadMore: () => void
}): VirtualNode {
  const comment: CommentItem = props.comment
  const replies: CommentItem[] = comment.replies ?? []
  const total: number = Math.max(comment.replyCount ?? 0, replies.length)
  const hasMore: boolean = comment.replyCursor !== null && comment.replyCursor !== undefined && total > replies.length

  const trigger: VirtualNode | undefined = total > 0
    ? (
      <HStack spacing={4} contentShape="rect" onTapGesture={props.onToggle}>
        <Text font={type.meta + 1} fontWeight="semibold" foregroundStyle={palette.brand}>
          {`${total} 則回覆`}
        </Text>
        <Image
          systemName={props.expanded ? "chevron.up" : "chevron.down"}
          font={10}
          fontWeight="bold"
          foregroundStyle={palette.brand}
        />
      </HStack>
    )
    : undefined

  return (
    <VStack alignment="leading" spacing={14} padding={{ horizontal: space.page, vertical: 12 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <CommentBody comment={comment} avatarSize={34} footer={trigger} />
      {props.expanded ? (
        <VStack alignment="leading" spacing={14} padding={{ leading: 46 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          {props.loading && replies.length === 0 ? (
            <VStack spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Skeleton height={11} width={110} />
              <Skeleton height={11} />
            </VStack>
          ) : null}
          {replies.map((reply: CommentItem) => (
            <CommentBody key={reply.id} comment={reply} avatarSize={24} />
          ))}
          {hasMore ? (
            <HStack spacing={4} contentShape="rect" onTapGesture={props.onLoadMore}>
              <Text font={type.meta + 1} fontWeight="semibold" foregroundStyle="secondaryLabel">
                {props.loading ? "載入中…" : "載入更多回覆"}
              </Text>
              {props.loading ? null : (
                <Image systemName="chevron.down" font={10} fontWeight="bold" foregroundStyle="secondaryLabel" />
              )}
            </HStack>
          ) : null}
        </VStack>
      ) : null}
    </VStack>
  )
}

function CommentsSkeleton(): VirtualNode {
  return (
    <VStack spacing={22} padding={{ horizontal: space.page, vertical: 12 }}>
      {[0, 1, 2, 3].map((index: number) => (
        <HStack key={`sk-c-${index}`} alignment="top" spacing={12}>
          <Skeleton width={34} height={34} cornerRadius={17} />
          <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Skeleton width={120} height={11} />
            <Skeleton height={13} />
            <Skeleton width={200} height={13} />
          </VStack>
        </HStack>
      ))}
    </VStack>
  )
}

export function CommentsSheet(props: CommentsSheetProps): VirtualNode {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})

  const sortBar: VirtualNode = (
    <ChipBar
      options={SORT_OPTIONS}
      value={props.sort}
      onChange={props.onSort}
      trailing={
        <Text font={type.meta} foregroundStyle="tertiaryLabel">
          {`${props.comments.length} 則`}
        </Text>
      }
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

  const toggle = (comment: CommentItem): void => {
    const willExpand: boolean = expandedIds[comment.id] !== true
    setExpandedIds({ ...expandedIds, [comment.id]: willExpand })
    const loaded: number = (comment.replies ?? []).length
    if (willExpand && loaded === 0 && comment.replyCursor) props.onLoadReplies(comment.id)
  }

  const footer: VirtualNode = props.hasMore
    ? (
      <VStack padding={{ horizontal: space.page, vertical: 14 }} frame={{ maxWidth: "infinity" }}>
        <PillButton
          label={props.loadingMore ? "載入中…" : "載入更多留言"}
          icon={props.loadingMore ? "arrow.triangle.2.circlepath" : "chevron.down"}
          onTap={() => {
            if (!props.loadingMore) props.onLoadMore()
          }}
        />
      </VStack>
    )
    : (
      <Text font={type.meta} foregroundStyle="tertiaryLabel" padding={{ vertical: 14 }}>
        沒有更多留言
      </Text>
    )

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
      {sortBar}
      <VStack spacing={0} padding={{ top: 4 }} frame={{ maxWidth: "infinity" }}>
        {props.comments.map((comment: CommentItem) => (
          <CommentThread
            key={comment.id}
            comment={comment}
            expanded={expandedIds[comment.id] === true}
            loading={props.repliesLoading[comment.id] === true}
            onToggle={() => toggle(comment)}
            onLoadMore={() => props.onLoadReplies(comment.id)}
          />
        ))}
      </VStack>
      {footer}
    </VStack>
  )
}
