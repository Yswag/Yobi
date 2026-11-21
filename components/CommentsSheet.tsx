import { FlowLayout, HStack, Image, ProgressView, Text, VStack, useState } from "scripting"
import type { VirtualNode } from "scripting"
import type { CommentItem, CommentRun, CommentSort } from "../types"
import { formatCount } from "../utils/format"
import { Avatar, ChipBar, EmptyState, PillButton, Skeleton } from "../ui/primitives"
import { palette, space, type } from "../ui/theme"

const SORT_OPTIONS: { key: CommentSort; label: string }[] = [
  { key: "top", label: "最熱" },
  { key: "newest", label: "最新" },
]

const EMOJI_SIZE: number = 18
const EMOJI_GAP: number = 3
const WIDE_CHAR: RegExp = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/

function textChunks(text: string): string[] {
  const chunks: string[] = []
  let buffer: string = ""
  const flush = (): void => {
    if (!buffer) return
    chunks.push(buffer)
    buffer = ""
  }
  for (const char of text) {
    if (WIDE_CHAR.test(char)) {
      flush()
      chunks.push(char)
      continue
    }
    buffer += char
    if (char === " ") flush()
  }
  flush()
  return chunks
}

function splitLines(runs: CommentRun[]): CommentRun[][] {
  const lines: CommentRun[][] = [[]]
  for (const run of runs) {
    if (run.imageUrl) {
      lines[lines.length - 1].push(run)
      continue
    }
    const parts: string[] = (run.text ?? "").split("\n")
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) lines.push([])
      if (parts[index]) lines[lines.length - 1].push({ text: parts[index] })
    }
  }
  return lines.filter((line: CommentRun[]): boolean => line.length > 0)
}

function gapNode(key: string): VirtualNode {
  return <HStack key={key} frame={{ width: EMOJI_GAP, height: 1 }} />
}

interface LineItem {
  key: string
  imageUrl?: string
  text?: string
}

function lineNodes(line: CommentRun[]): VirtualNode[] {
  const items: LineItem[] = []
  line.forEach((run: CommentRun, runIndex: number): void => {
    if (run.imageUrl) {
      items.push({ key: `img-${runIndex}`, imageUrl: run.imageUrl })
      return
    }
    textChunks(run.text ?? "").forEach((chunk: string, chunkIndex: number): void => {
      items.push({ key: `txt-${runIndex}-${chunkIndex}`, text: chunk })
    })
  })

  const nodes: VirtualNode[] = []
  items.forEach((item: LineItem, index: number): void => {
    const previous: LineItem | undefined = items[index - 1]
    if (previous && (previous.imageUrl || item.imageUrl)) nodes.push(gapNode(`gap-${index}`))
    if (item.imageUrl) {
      nodes.push(
        <Image
          key={item.key}
          imageUrl={item.imageUrl}
          resizable
          scaleToFit
          frame={{ width: EMOJI_SIZE, height: EMOJI_SIZE }}
        />,
      )
      return
    }
    nodes.push(
      <Text key={item.key} font={type.cardTitle} foregroundStyle="label">
        {item.text ?? ""}
      </Text>,
    )
  })
  return nodes
}

function CommentText(props: { comment: CommentItem }): VirtualNode {
  const runs: CommentRun[] | undefined = props.comment.runs
  const hasImage: boolean = runs?.some((run: CommentRun): boolean => Boolean(run.imageUrl)) === true
  if (!runs || !hasImage) {
    return (
      <Text
        font={type.cardTitle}
        foregroundStyle="label"
        lineSpacing={3}
        multilineTextAlignment="leading"
        frame={{ maxWidth: "infinity", alignment: "leading" }}
      >
        {props.comment.content}
      </Text>
    )
  }

  const lines: CommentRun[][] = splitLines(runs)
  return (
    <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      {lines.map((line: CommentRun[], lineIndex: number) => (
        <FlowLayout
          key={`line-${lineIndex}`}
          spacing={0}
          horizontalSpacing={0}
          verticalSpacing={3}
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          {lineNodes(line)}
        </FlowLayout>
      ))}
    </VStack>
  )
}

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

  const footer: VirtualNode = (
    <VStack
      padding={{ horizontal: space.page, vertical: 14 }}
      frame={{ maxWidth: "infinity" }}
    >
      {props.loadingMore ? (
        <ProgressView />
      ) : props.hasMore ? (
        <PillButton label="載入更多留言" icon="chevron.down" onTap={props.onLoadMore} />
      ) : (
        <Text font={type.meta} foregroundStyle="tertiaryLabel">沒有更多留言</Text>
      )}
    </VStack>
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
        {footer}
      </VStack>
    </VStack>
  )
}
