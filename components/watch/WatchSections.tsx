import {
  HStack,
  Image,
  LazyVStack,
  ScrollView,
  Text,
  VStack,
  useEffect,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { OpenChannel, UnifiedVideoItem, VideoChapter, VideoPagePart } from "../../types/index"
import { CommentsSheet } from "../CommentsSheet"
import { VideoCard } from "../VideoCard"
import {
  getPlayerProgressSnapshot,
  loadCommentReplies,
  loadMoreComments,
  reloadComments,
  seekTo,
  selectPage,
  setCommentsSort,
  subscribePlayerProgress,
  useCommentsStore,
  useLiveViewers,
} from "../../state/playerStore"
import { EmptyState, SectionHeader } from "../../ui/primitives"
import { palette, radius, space, type } from "../../ui/theme"
import { formatCount, formatDuration } from "../../utils/format"

const SEGMENT_CARD_WIDTH: number = 156
const SEGMENT_CARD_HEIGHT: number = 70

export function LiveViewerLabel(props: { videoId: string; publishedText?: string }): VirtualNode {
  const viewers = useLiveViewers()
  const count: number | null = viewers.videoId === props.videoId ? viewers.count : null
  const parts: string[] = []
  if (count !== null && count > 0) parts.push(`${formatCount(count)} 人正在觀看`)
  if (props.publishedText) parts.push(props.publishedText)
  return (
    <Text font={type.meta + 1} foregroundStyle="secondaryLabel" lineLimit={1}>
      {parts.join(" · ")}
    </Text>
  )
}

export function ActionChip(props: { icon: string; label: string; active?: boolean; onTap: () => void }): VirtualNode {
  return (
    <HStack
      spacing={6}
      padding={{ horizontal: 14, vertical: 9 }}
      background={{ style: "tertiarySystemFill", shape: "capsule" }}
      contentShape="capsule"
      fixedSize
      onTapGesture={props.onTap}
    >
      <Image
        systemName={props.icon}
        font={14}
        fontWeight="semibold"
        foregroundStyle={props.active ? palette.brand : "label"}
        contentTransition="symbolEffectReplace"
      />
      <Text font={type.meta + 1} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>{props.label}</Text>
    </HStack>
  )
}

export function SegmentCard(props: { caption: string; title: string; active: boolean; onTap: () => void }): VirtualNode {
  return (
    <VStack
      alignment="leading"
      spacing={4}
      padding={{ horizontal: 12, vertical: 10 }}
      frame={{ width: SEGMENT_CARD_WIDTH, height: SEGMENT_CARD_HEIGHT, alignment: "topLeading" }}
      background={{
        style: props.active ? palette.brandSoft : "tertiarySystemFill",
        shape: { type: "rect", cornerRadius: radius.md, style: "continuous" },
      }}
      contentShape="rect"
      onTapGesture={props.onTap}
    >
      <Text font={type.caption} monospacedDigit foregroundStyle={props.active ? palette.brand : "tertiaryLabel"} lineLimit={1}>
        {props.caption}
      </Text>
      <Text
        font={type.meta + 1}
        fontWeight={props.active ? "semibold" : "regular"}
        foregroundStyle="label"
        lineLimit={2}
        multilineTextAlignment="leading"
        frame={{ maxWidth: "infinity", alignment: "leading" }}
      >
        {props.title}
      </Text>
    </VStack>
  )
}

function useActiveChapterIndex(chapters: VideoChapter[]): number {
  const [index, setIndex] = useState<number>(-1)
  useEffect(() => {
    const apply = (): void => {
      const position: number = getPlayerProgressSnapshot().position
      const next: number = chapters.findIndex(
        (chapter: VideoChapter): boolean => position >= chapter.startTime && position < chapter.endTime,
      )
      setIndex((previous: number): number => (previous === next ? previous : next))
    }
    apply()
    return subscribePlayerProgress(apply)
  }, [chapters])
  return index
}

export function WatchChaptersSection(props: { chapters: VideoChapter[] }): VirtualNode {
  const activeIndex: number = useActiveChapterIndex(props.chapters)
  return (
    <VStack alignment="leading" spacing={10}>
      <SectionHeader title="章節" />
      <ScrollView axes="horizontal" scrollIndicator="hidden">
        <HStack spacing={8} padding={{ horizontal: space.page }}>
          {props.chapters.map((chapter: VideoChapter, index: number) => (
            <SegmentCard
              key={`chapter-${index}-${chapter.startTime}`}
              caption={formatDuration(chapter.startTime)}
              title={chapter.title}
              active={index === activeIndex}
              onTap={() => void seekTo(chapter.startTime)}
            />
          ))}
        </HStack>
      </ScrollView>
    </VStack>
  )
}

export function WatchPagesSection(props: {
  pages: VideoPagePart[]
  activeCid?: number
  activePage: number
}): VirtualNode {
  return (
    <VStack alignment="leading" spacing={10}>
      <SectionHeader title="選集" detail={`${props.activePage} / ${props.pages.length}`} />
      <ScrollView axes="horizontal" scrollIndicator="hidden">
        <HStack spacing={8} padding={{ horizontal: space.page }}>
          {props.pages.map((page: VideoPagePart) => (
            <SegmentCard
              key={`page-${page.cid}`}
              caption={`P${page.page} · ${formatDuration(page.duration)}`}
              title={page.title}
              active={page.cid === props.activeCid}
              onTap={() => void selectPage(page)}
            />
          ))}
        </HStack>
      </ScrollView>
    </VStack>
  )
}

export function WatchRelatedList(props: {
  related: UnifiedVideoItem[]
  onSelect: (video: UnifiedVideoItem) => void
  onOpenChannel?: OpenChannel
}): VirtualNode {
  if (props.related.length === 0) {
    return <EmptyState icon="rectangle.stack" title="沒有相關影片" />
  }
  return (
    <LazyVStack spacing={4} frame={{ maxWidth: "infinity" }}>
      {props.related.map((video: UnifiedVideoItem) => (
        <VideoCard
          key={`related-${video.id}`}
          item={video}
          layout="row"
          onSelect={props.onSelect}
          onOpenChannel={props.onOpenChannel}
        />
      ))}
    </LazyVStack>
  )
}

export function WatchCommentsSection(): VirtualNode {
  const commentsStore = useCommentsStore()
  return (
    <CommentsSheet
      comments={commentsStore.comments}
      loading={commentsStore.loading}
      loadingMore={commentsStore.loadingMore}
      sort={commentsStore.sort}
      hasMore={commentsStore.cursor !== null}
      repliesLoading={commentsStore.repliesLoading}
      onSort={(sort) => {
        void setCommentsSort(sort)
      }}
      onLoadMore={() => {
        void loadMoreComments()
      }}
      onLoadReplies={(commentId) => {
        void loadCommentReplies(commentId)
      }}
      onRefresh={() => {
        void reloadComments()
      }}
    />
  )
}
