import { HStack, Image, Text, VStack, useState } from "scripting"
import type { VirtualNode } from "scripting"
import type { CommentItem } from "../types"
import { formatCount } from "../utils/format"
import { Avatar, EmptyState, Skeleton } from "../ui/primitives"
import { palette, space, type } from "../ui/theme"

export interface CommentsSheetProps {
  comments: CommentItem[]
  loading: boolean
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

function CommentThread(props: { comment: CommentItem; expanded: boolean; onToggle: () => void }): VirtualNode {
  const replies: CommentItem[] = props.comment.replies ?? []
  return (
    <VStack alignment="leading" spacing={14} padding={{ horizontal: space.page, vertical: 12 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <CommentBody
        comment={props.comment}
        avatarSize={34}
        footer={replies.length > 0 ? (
          <HStack spacing={4} contentShape="rect" onTapGesture={props.onToggle}>
            <Text font={type.meta + 1} fontWeight="semibold" foregroundStyle={palette.brand}>
              {`${replies.length} 則回覆`}
            </Text>
            <Image
              systemName={props.expanded ? "chevron.up" : "chevron.down"}
              font={10}
              fontWeight="bold"
              foregroundStyle={palette.brand}
            />
          </HStack>
        ) : undefined}
      />
      {props.expanded ? (
        <VStack alignment="leading" spacing={14} padding={{ leading: 46 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          {replies.map((reply: CommentItem) => (
            <CommentBody key={reply.id} comment={reply} avatarSize={24} />
          ))}
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

  if (props.loading) return <CommentsSkeleton />

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

  const toggle = (id: string): void => {
    setExpandedIds({ ...expandedIds, [id]: !expandedIds[id] })
  }

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
      {props.comments.map((comment: CommentItem) => (
        <CommentThread
          key={comment.id}
          comment={comment}
          expanded={expandedIds[comment.id] === true}
          onToggle={() => toggle(comment.id)}
        />
      ))}
    </VStack>
  )
}
