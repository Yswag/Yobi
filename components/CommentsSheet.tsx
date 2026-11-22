import { FlowLayout, HStack, Image, ProgressView, Text, VStack, useCallback, useMemo, useRef, useState } from "scripting"
import type { ScrollVisibilityChangeOptions, VirtualNode } from "scripting"
import type { CommentItem, CommentRun, CommentSort } from "../types"
import { formatCount } from "../utils/format"
import { emojiImageUrl } from "../utils/image"
import { Avatar, ChipBar, EmptyState, PillButton, Skeleton } from "../ui/primitives"
import { palette, space, type } from "../ui/theme"

const SORT_OPTIONS: { key: CommentSort; label: string }[] = [
  { key: "top", label: "最熱" },
  { key: "newest", label: "最新" },
]

const EMOJI_SIZE: number = 18
const EMOJI_LARGE: number = 28
const EMOJI_GAP: number = 3
const WIDE_CHAR: RegExp = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/
const WIDE_BREAK: RegExp = /[，。！？、；：）」』】》—…]/
const WIDE_CHUNK_SIZE: number = 3
const PREFETCH_LEAD_COUNT: number = 6

function textChunks(text: string): string[] {
  const chunks: string[] = []
  let buffer: string = ""
  let wideCount: number = 0
  const flush = (): void => {
    if (!buffer) return
    chunks.push(buffer)
    buffer = ""
    wideCount = 0
  }
  for (const char of text) {
    if (WIDE_BREAK.test(char)) {
      if (buffer) {
        buffer += char
        flush()
      } else if (chunks.length > 0) {
        chunks[chunks.length - 1] += char
      } else {
        chunks.push(char)
      }
      continue
    }
    if (WIDE_CHAR.test(char)) {
      if (buffer && wideCount === 0) flush()
      buffer += char
      wideCount++
      if (wideCount >= WIDE_CHUNK_SIZE) flush()
      continue
    }
    if (wideCount > 0) flush()
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
  scale?: number
}

function lineNodes(line: CommentRun[]): VirtualNode[] {
  const items: LineItem[] = []
  line.forEach((run: CommentRun, runIndex: number): void => {
    if (run.imageUrl) {
      items.push({ key: `img-${runIndex}`, imageUrl: run.imageUrl, scale: run.scale })
      return
    }
    textChunks(run.text ?? "").forEach((chunk: string, chunkIndex: number): void => {
      items.push({ key: `txt-${runIndex}-${chunkIndex}`, text: chunk })
    })
  })

  const hasLarge: boolean = items.some((item: LineItem): boolean => (item.scale ?? 1) > 1)
  const rowHeight: number = hasLarge ? EMOJI_LARGE : EMOJI_SIZE

  const nodes: VirtualNode[] = []
  items.forEach((item: LineItem, index: number): void => {
    const previous: LineItem | undefined = items[index - 1]
    if (previous && (previous.imageUrl || item.imageUrl)) nodes.push(gapNode(`gap-${index}`))
    if (item.imageUrl) {
      const size: number = (item.scale ?? 1) > 1 ? EMOJI_LARGE : EMOJI_SIZE
      const sizedUrl: string = emojiImageUrl(item.imageUrl, size) ?? item.imageUrl
      nodes.push(
        <Image
          key={item.key}
          imageUrl={sizedUrl}
          resizable
          scaleToFit
          frame={{ width: size, height: size }}
        />,
      )
      return
    }
    nodes.push(
      <Text
        key={item.key}
        font={type.cardTitle}
        foregroundStyle="label"
        frame={hasLarge ? { height: rowHeight, alignment: "bottom" } : undefined}
      >
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
      {lines.map((line: CommentRun[], lineIndex: number) => {
        const lineHasImage: boolean = line.some((run: CommentRun): boolean => Boolean(run.imageUrl))
        if (!lineHasImage) {
          const text: string = line.map((run: CommentRun): string => run.text ?? "").join("")
          return (
            <Text
              key={`line-${lineIndex}`}
              font={type.cardTitle}
              foregroundStyle="label"
              lineSpacing={3}
              multilineTextAlignment="leading"
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            >
              {text}
            </Text>
          )
        }
        return (
          <FlowLayout
            key={`line-${lineIndex}`}
            spacing={0}
            horizontalSpacing={0}
            verticalSpacing={3}
            frame={{ maxWidth: "infinity", alignment: "leading" }}
          >
            {lineNodes(line)}
          </FlowLayout>
        )
      })}
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
  const expandedIdsRef = useRef<Record<string, boolean>>(expandedIds)
  expandedIdsRef.current = expandedIds
  const onLoadRepliesRef = useRef(props.onLoadReplies)
  onLoadRepliesRef.current = props.onLoadReplies
  const onLoadMoreRef = useRef(props.onLoadMore)
  onLoadMoreRef.current = props.onLoadMore

  const prefetchObserver: ScrollVisibilityChangeOptions = useMemo(
    () => ({
      threshold: 0.01,
      onChanged: (visible: boolean): void => {
        if (visible) onLoadMoreRef.current()
      },
    }),
    [],
  )

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

  const prefetchIndex: number =
    props.hasMore && props.comments.length > 0
      ? Math.max(0, props.comments.length - PREFETCH_LEAD_COUNT)
      : -1

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
