import {
  HStack,
  LazyVStack,
  ScrollView,
  Text,
  VStack,
  useEffect,
  useRef,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { LayoutMode, OpenChannel, UnifiedVideoItem, VideoPage, WatchHistoryEntry } from "../types/index"
import { openLinkFromClipboardOrPrompt } from "../actions/index"
import { VideoCard, VideoCardSkeleton } from "../components/VideoCard"
import { LoadMoreFooter } from "../components/paging/LoadMoreFooter"
import { usePagedVideos, type PagedVideos, type VideoPageLoader } from "../components/paging/usePagedVideos"
import type { FeedFilter } from "../services/index"
import {
  getHomeFeed,
  getSavedPosition,
  getWatchHistory,
  subscribeStorageChanges,
} from "../services/index"
import { formatDuration } from "../utils/format"
import { openVideo } from "../state/playerStore"
import {
  ChipBar,
  EmptyState,
  GlassIconButton,
  LayoutToggle,
  PageHeader,
  PROVIDER_FILTERS,
  SectionHeader,
  Thumbnail,
} from "../ui/primitives"
import { radius, space, type } from "../ui/theme"

export interface HomeViewProps {
  onOpenChannel?: OpenChannel
  onOpenSettings?: () => void
}

const CONTINUE_CARD_WIDTH: number = 220
const CONTINUE_LIMIT: number = 8
const FINISHED_RATIO: number = 0.95

function entryRatio(entry: WatchHistoryEntry): number {
  const total: number = entry.duration || entry.item.duration || 0
  return total > 0 ? entry.position / total : 0
}

function continueEntriesOf(history: WatchHistoryEntry[]): WatchHistoryEntry[] {
  return history
    .filter((entry: WatchHistoryEntry): boolean => entry.position > 5 && entryRatio(entry) < FINISHED_RATIO)
    .slice(0, CONTINUE_LIMIT)
}

function continueSignature(entries: WatchHistoryEntry[]): string {
  return entries
    .map((entry: WatchHistoryEntry): string => `${entry.item.id}:${entry.cid ?? entry.page ?? 0}:${Math.floor(entryRatio(entry) * 20)}`)
    .join("|")
}

function ContinueCard(props: { entry: WatchHistoryEntry; onSelect: () => void }): VirtualNode {
  const entry: WatchHistoryEntry = props.entry
  const total: number = entry.duration || entry.item.duration || 0
  const ratio: number = entryRatio(entry)
  const remaining: number = Math.max(0, total - entry.position)

  return (
    <VStack
      alignment="leading"
      spacing={8}
      frame={{ width: CONTINUE_CARD_WIDTH }}
      contentShape="rect"
      onTapGesture={props.onSelect}
    >
      <Thumbnail
        url={entry.item.thumbnailUrl}
        width={CONTINUE_CARD_WIDTH}
        cornerRadius={radius.md}
        provider={entry.item.provider}
        durationText={total > 0 ? `剩 ${formatDuration(remaining)}` : undefined}
        progress={ratio}
      />
      <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={type.body - 1} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>
          {entry.item.title}
        </Text>
        <Text font={type.meta} foregroundStyle="secondaryLabel" lineLimit={1}>
          {entry.item.authorName}
        </Text>
      </VStack>
    </VStack>
  )
}

export function HomeView(props: HomeViewProps): VirtualNode {
  const [filter, setFilter] = useState<FeedFilter>("all")
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("grid")
  const feed: PagedVideos = usePagedVideos({ initialLoading: true })
  const items: UnifiedVideoItem[] = feed.items
  const loading: boolean = feed.loading
  const errorText: string | null = feed.failed ? "載入失敗，請檢查網路連線" : null
  const [continueEntries, setContinueEntries] = useState<WatchHistoryEntry[]>(() => continueEntriesOf(getWatchHistory()))
  const continueSigRef = useRef<string>(continueSignature(continueEntries))

  const loadFeed = (target: FeedFilter): Promise<void> => {
    const loader: VideoPageLoader = (cursor?: string): Promise<VideoPage> => getHomeFeed(target, cursor)
    return feed.reload(loader)
  }

  useEffect(() => {
    void loadFeed(filter)
  }, [filter])

  useEffect(() => {
    const sync = (): void => {
      const next: WatchHistoryEntry[] = continueEntriesOf(getWatchHistory())
      const signature: string = continueSignature(next)
      if (signature === continueSigRef.current) return
      continueSigRef.current = signature
      setContinueEntries(next)
    }
    sync()
    return subscribeStorageChanges(sync, ["history"])
  }, [])

  const handleSelect = (item: UnifiedVideoItem): void => {
    void openVideo(item, { queue: items })
  }

  const header: VirtualNode = (
    <PageHeader
      title="Yobi"
      trailing={
        <HStack spacing={10}>
          <GlassIconButton icon="link" onTap={() => void openLinkFromClipboardOrPrompt()} />
          {props.onOpenSettings ? (
            <GlassIconButton icon="gearshape" onTap={() => props.onOpenSettings?.()} />
          ) : null}
        </HStack>
      }
    />
  )

  const filterBar: VirtualNode = (
    <ChipBar
      options={PROVIDER_FILTERS}
      value={filter}
      onChange={setFilter}
      trailing={<LayoutToggle layout={layoutMode} onChange={setLayoutMode} />}
    />
  )

  const continueSection: VirtualNode | null = continueEntries.length > 0
    ? (
      <VStack spacing={12} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <SectionHeader title="繼續觀看" />
        <ScrollView axes="horizontal" scrollIndicator="hidden">
          <HStack spacing={14} alignment="top" padding={{ horizontal: space.page }}>
            {continueEntries.map((entry: WatchHistoryEntry) => (
              <ContinueCard
                key={`${entry.item.id}-${entry.cid ?? entry.page ?? 0}`}
                entry={entry}
                onSelect={() => {
                  void openVideo(entry.item, { cid: entry.cid, page: entry.page })
                }}
              />
            ))}
          </HStack>
        </ScrollView>
      </VStack>
    )
    : null

  let feedContent: VirtualNode
  if (loading && items.length === 0) {
    feedContent = <VideoCardSkeleton layout={layoutMode} />
  } else if (!loading && items.length === 0) {
    feedContent = (
      <EmptyState
        icon={errorText ? "wifi.exclamationmark" : "sparkles.tv"}
        title={errorText ? "連不上伺服器" : "目前沒有推薦影片"}
        message={errorText ?? "下拉即可重新整理"}
        actionLabel="重試"
        onAction={() => void loadFeed(filter)}
      />
    )
  } else {
    feedContent = (
      <LazyVStack spacing={layoutMode === "grid" ? space.cardGap : 4} frame={{ maxWidth: "infinity" }}>
        {items.map((item: UnifiedVideoItem, index: number) => (
          <VideoCard
            key={item.id}
            item={item}
            layout={layoutMode}
            progressSeconds={getSavedPosition(item.id, item.cid)}
            scrollVisibility={index === feed.prefetchIndex ? feed.prefetchObserver : undefined}
            onSelect={handleSelect}
            onOpenChannel={props.onOpenChannel}
          />
        ))}
      </LazyVStack>
    )
  }

  const footer: VirtualNode | null = feed.hasMore
    ? <LoadMoreFooter loading={feed.loadingMore} hasMore label="載入更多影片" onLoadMore={() => void feed.loadMore()} />
    : null

  return (
    <ScrollView
      axes="vertical"
      scrollIndicator="hidden"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      refreshable={() => loadFeed(filter)}
      onScrollPhaseChange={feed.onScrollPhaseChange}
    >
      <VStack spacing={space.section - 8} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }} padding={{ bottom: 16 }}>
        <VStack spacing={4} frame={{ maxWidth: "infinity" }}>
          {header}
          {filterBar}
        </VStack>
        {continueSection}
        <VStack spacing={12} frame={{ maxWidth: "infinity" }}>
          {continueSection ? <SectionHeader title="熱門" /> : null}
          {feedContent}
          {footer}
        </VStack>
      </VStack>
    </ScrollView>
  )
}
