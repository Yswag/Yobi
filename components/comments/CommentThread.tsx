import { HStack, Image, Text, VStack } from "scripting"
import type { ScrollVisibilityChangeOptions, VirtualNode } from "scripting"
import type { CommentItem } from "../../types/index"
import { formatCount } from "../../utils/format"
import { Avatar, Skeleton } from "../../ui/primitives"
import { palette, space, type } from "../../ui/theme"
import { CommentText } from "./CommentRichText"

export function CommentBody(props: { comment: CommentItem; avatarSize: number; footer?: VirtualNode }): VirtualNode {
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
        <CommentText comment={comment} />
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

export function CommentThread(props: {
  comment: CommentItem
  expanded: boolean
  loading: boolean
  scrollVisibility?: ScrollVisibilityChangeOptions
  onToggle: (comment: CommentItem) => void
  onLoadMore: (commentId: string) => void
}): VirtualNode {
  const comment: CommentItem = props.comment
  const replies: CommentItem[] = comment.replies ?? []
  const total: number = Math.max(comment.replyCount ?? 0, replies.length)
  const hasMore: boolean = comment.replyCursor !== null && comment.replyCursor !== undefined && total > replies.length

  const trigger: VirtualNode | undefined = total > 0
    ? (
      <HStack spacing={4} contentShape="rect" onTapGesture={() => props.onToggle(comment)}>
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
    <VStack
      alignment="leading"
      spacing={14}
      padding={{ horizontal: space.page, vertical: 12 }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      onScrollVisibilityChange={props.scrollVisibility}
    >
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
            <HStack spacing={4} contentShape="rect" onTapGesture={() => props.onLoadMore(comment.id)}>
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

export function CommentsSkeleton(): VirtualNode {
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
