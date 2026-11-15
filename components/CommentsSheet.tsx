import { Button, HStack, Image, ProgressView, Spacer, Text, VStack, useState } from "scripting"
import type { VirtualNode } from "scripting"
import type { CommentItem } from "../types"
import { formatCount } from "../utils/format"

export interface CommentsSheetProps {
  comments: CommentItem[]
  loading: boolean
  onRefresh?: () => void
}

function avatarView(comment: CommentItem, size: number): VirtualNode {
  if (comment.authorAvatar) {
    return (
      <Image
        imageUrl={comment.authorAvatar}
        resizable
        scaleToFill
        frame={{ width: size, height: size }}
        clipShape="circle"
      />
    )
  }
  return <Image systemName="person.circle.fill" font={size} foregroundStyle="tertiaryLabel" />
}

function replyRow(reply: CommentItem): VirtualNode {
  return (
    <HStack alignment="top" spacing={8} padding={{ horizontal: 10, vertical: 8 }}>
      {avatarView(reply, 24)}
      <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity" }}>
        <HStack spacing={6}>
          <Text font={12} fontWeight="semibold" foregroundStyle="secondaryLabel" lineLimit={1}>
            {reply.authorName}
          </Text>
          <Text font={10} foregroundStyle="tertiaryLabel" lineLimit={1}>{reply.publishedText}</Text>
          <Spacer />
          <HStack spacing={3}>
            <Image systemName="hand.thumbsup" font={10} foregroundStyle="tertiaryLabel" />
            <Text font={10} foregroundStyle="tertiaryLabel">{formatCount(reply.likeCount)}</Text>
          </HStack>
        </HStack>
        <Text font={13} foregroundStyle="label" lineSpacing={2}>{reply.content}</Text>
      </VStack>
    </HStack>
  )
}

function commentRow(comment: CommentItem, expanded: boolean, onToggle: () => void): VirtualNode {
  const replies: CommentItem[] = comment.replies ?? []

  return (
    <VStack alignment="leading" spacing={6} padding={{ horizontal: 14, vertical: 10 }}>
      <HStack spacing={10}>
        {avatarView(comment, 32)}
        <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity" }}>
          <Text font={13} fontWeight="semibold" foregroundStyle="secondaryLabel" lineLimit={1}>
            {comment.authorName}
          </Text>
          <Text font={11} foregroundStyle="tertiaryLabel" lineLimit={1}>{comment.publishedText}</Text>
        </VStack>
        <Spacer />
        <HStack spacing={4}>
          <Image systemName="hand.thumbsup" font={11} foregroundStyle="secondaryLabel" />
          <Text font={11} foregroundStyle="secondaryLabel">{formatCount(comment.likeCount)}</Text>
        </HStack>
      </HStack>

      <Text font={14} foregroundStyle="label" lineSpacing={2}>{comment.content}</Text>

      {replies.length > 0
        ? (
          <VStack alignment="leading" spacing={6}>
            <Button
              title={expanded ? `收合 ${replies.length} 則回覆` : `查看 ${replies.length} 則回覆`}
              font={12}
              foregroundStyle="rgba(10,132,255,1)"
              buttonStyle="plain"
              action={onToggle}
            />
            {expanded
              ? (
                <VStack
                  spacing={0}
                  frame={{ maxWidth: "infinity" }}
                  padding={{ leading: 28, trailing: 4, vertical: 4 }}
                >
                  <VStack
                    spacing={0}
                    frame={{ maxWidth: "infinity" }}
                    background="tertiarySystemFill"
                    clipShape={{ type: "rect", cornerRadius: 8 }}
                  >
                    {replies.map((reply: CommentItem) => (
                      <VStack key={reply.id} spacing={0} frame={{ maxWidth: "infinity" }}>
                        {replyRow(reply)}
                      </VStack>
                    ))}
                  </VStack>
                </VStack>
              )
              : null}
          </VStack>
        )
        : null}
    </VStack>
  )
}

export function CommentsSheet(props: CommentsSheetProps): VirtualNode {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})

  if (props.loading) {
    return (
      <VStack spacing={10} padding={{ vertical: 42 }} frame={{ maxWidth: "infinity" }}>
        <ProgressView />
        <Text font={12} foregroundStyle="secondaryLabel">正在載入留言…</Text>
      </VStack>
    )
  }

  if (props.comments.length === 0) {
    return (
      <VStack spacing={10} padding={{ vertical: 42 }} frame={{ maxWidth: "infinity" }}>
        <Image systemName="bubble.left.and.bubble.right" font={30} foregroundStyle="tertiaryLabel" />
        <Text font={13} foregroundStyle="secondaryLabel">目前尚無留言</Text>
      </VStack>
    )
  }

  const toggle = (id: string): void => {
    setExpandedIds({ ...expandedIds, [id]: !expandedIds[id] })
  }

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
      {props.onRefresh
        ? (
          <HStack spacing={0} padding={{ horizontal: 14, vertical: 4 }} frame={{ maxWidth: "infinity" }}>
            <Spacer />
            <Button
              title="重新整理"
              systemImage="arrow.clockwise"
              font={11}
              foregroundStyle="secondaryLabel"
              buttonStyle="plain"
              action={props.onRefresh}
            />
          </HStack>
        )
        : null}
      {props.comments.map((comment: CommentItem) => (
        <VStack key={comment.id} spacing={0} frame={{ maxWidth: "infinity" }}>
          {commentRow(comment, expandedIds[comment.id] === true, () => toggle(comment.id))}
        </VStack>
      ))}
    </VStack>
  )
}
