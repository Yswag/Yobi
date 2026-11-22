import {
  LazyVStack,
  ProgressView,
  ScrollView,
  Text,
  VStack,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "scripting"
import type { Point, ScrollGeometry, ScrollPhase, ScrollPhaseChangeContext, ScrollVisibilityChangeOptions, VirtualNode } from "scripting"
import type { ChannelDetail, LayoutMode, OpenChannel, Provider, UnifiedVideoItem } from "../types/index"
import { VideoCard, VideoCardSkeleton } from "../components/VideoCard"
import {
  ChannelBanner,
  ChannelHero,
  ChannelToolbar,
  type ChannelSortMode,
} from "../components/channel/ChannelHeader"
import {
  getChannel,
  getChannelVideos,
  getSavedPosition,
  isSubscribed,
  searchChannelVideos,
  subscribeStorageChanges,
} from "../services/index"
import { playVideoQueue, toggleChannelSubscription } from "../actions/index"
import { EmptyState, PillButton } from "../ui/primitives"
import { motion, space, type } from "../ui/theme"

export interface ChannelViewProps {
  provider: Provider
  channelId: string
  initialName?: string
  initialAvatar?: string
  onClose?: () => void
  onOpenChannel?: OpenChannel
}

const LOAD_MORE_DISTANCE: number = 600
const DECEL_LOOKAHEAD_S: number = 0.4
const MAX_LOOKAHEAD_PX: number = 900
const PREFETCH_LEAD_COUNT: number = 5
const TITLE_REVEAL_OFFSET: number = 140

export function ChannelView(props: ChannelViewProps): VirtualNode {
  const [detail, setDetail] = useState<ChannelDetail | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [subscribed, setSubscribed] = useState<boolean>(false)
  const [query, setQuery] = useState<string>("")
  const [sortMode, setSortMode] = useState<ChannelSortMode>("latest")
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("row")
  const [descriptionExpanded, setDescriptionExpanded] = useState<boolean>(false)
  const [titleVisible, setTitleVisible] = useState<boolean>(false)
  const titleShownRef = useRef<boolean>(false)
  const [videos, setVideos] = useState<UnifiedVideoItem[]>([])
  const [listLoading, setListLoading] = useState<boolean>(false)
  const [nextToken, setNextToken] = useState<string | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState<boolean>(false)
  const loadingMoreRef = useRef<boolean>(false)
  const requestSeq = useRef<number>(0)
  const [searchedQuery, setSearchedQuery] = useState<string>("")
  const [results, setResults] = useState<UnifiedVideoItem[]>([])
  const [resultsToken, setResultsToken] = useState<string | undefined>(undefined)
  const [resultsLoading, setResultsLoading] = useState<boolean>(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const searchSeq = useRef<number>(0)

  const subscriptionId: string = `${props.provider}:${props.channelId}`

  const load = async (): Promise<void> => {
    const seq: number = ++requestSeq.current
    setLoading(true)
    setErrorText(null)
    try {
      const next: ChannelDetail = await getChannel(props.provider, props.channelId)
      if (seq !== requestSeq.current) return
      setDetail(next)
      setVideos(next.videos)
      setNextToken(next.nextPageToken)
      setSortMode("latest")
    } catch {
      if (seq !== requestSeq.current) return
      setDetail(null)
      setErrorText("無法載入頻道資料，請確認網路連線後重試")
    }
    if (seq === requestSeq.current) setLoading(false)
  }

  useEffect(() => {
    void load()
  }, [props.provider, props.channelId])
  useEffect(() => {
    setSubscribed(isSubscribed(subscriptionId))
    return subscribeStorageChanges(() => {
      setSubscribed(isSubscribed(subscriptionId))
    }, ["subscriptions"])
  }, [subscriptionId])

  const currentName: string = detail?.name || props.initialName || props.channelId
  const currentAvatar: string = detail?.avatarUrl || props.initialAvatar || ""
  const searching: boolean = searchedQuery.length > 0
  const shownVideos: UnifiedVideoItem[] = searching ? results : videos
  const shownToken: string | undefined = searching ? resultsToken : nextToken

  const patchVideos = (incoming: UnifiedVideoItem[]): UnifiedVideoItem[] =>
    incoming.map((video: UnifiedVideoItem): UnifiedVideoItem => {
      if (video.authorName && video.authorId) return video
      return {
        ...video,
        authorName: video.authorName || currentName,
        authorId: video.authorId || props.channelId,
        authorAvatar: video.authorAvatar || currentAvatar || undefined,
      }
    })

  const loadMore = async (): Promise<void> => {
    if (loadingMoreRef.current || !shownToken) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      if (searching) {
        const seq: number = searchSeq.current
        const page = await searchChannelVideos(props.provider, props.channelId, searchedQuery, shownToken)
        if (seq !== searchSeq.current) return
        setResults((previous: UnifiedVideoItem[]): UnifiedVideoItem[] => [...previous, ...patchVideos(page.videos)])
        setResultsToken(page.nextPageToken)
        return
      }
      const page = await getChannelVideos(props.provider, props.channelId, shownToken, sortMode)
      setVideos((previous: UnifiedVideoItem[]): UnifiedVideoItem[] => [
        ...previous,
        ...patchVideos(page.videos),
      ])
      setNextToken(page.nextPageToken)
    } catch {
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }

  const changeSort = async (mode: ChannelSortMode): Promise<void> => {
    if (mode === sortMode) return
    const seq: number = ++requestSeq.current
    setSortMode(mode)
    setListLoading(true)
    setVideos([])
    setNextToken(undefined)
    try {
      const page = await getChannelVideos(props.provider, props.channelId, undefined, mode)
      if (seq !== requestSeq.current) return
      setVideos(patchVideos(page.videos))
      setNextToken(page.nextPageToken)
    } catch {
    } finally {
      if (seq === requestSeq.current) setListLoading(false)
    }
  }

  const clearSearch = (): void => {
    searchSeq.current++
    setSearchedQuery("")
    setResults([])
    setResultsToken(undefined)
    setResultsLoading(false)
    setSearchError(null)
  }

  const submitSearch = async (): Promise<void> => {
    const text: string = query.trim()
    if (!text) {
      clearSearch()
      return
    }
    if (text === searchedQuery && !resultsLoading && !searchError) return
    const seq: number = ++searchSeq.current
    setSearchedQuery(text)
    setResults([])
    setResultsToken(undefined)
    setSearchError(null)
    setResultsLoading(true)
    try {
      const page = await searchChannelVideos(props.provider, props.channelId, text, undefined)
      if (seq !== searchSeq.current) return
      setResults(patchVideos(page.videos))
      setResultsToken(page.nextPageToken)
    } catch (error: unknown) {
      if (seq !== searchSeq.current) return
      setSearchError(error instanceof Error ? error.message : String(error))
    } finally {
      if (seq === searchSeq.current) setResultsLoading(false)
    }
  }

  const handleQueryChange = (value: string): void => {
    setQuery(value)
    if (!value.trim()) clearSearch()
  }

  const handleToggleSubscription = (): void => {
    const next: boolean = toggleChannelSubscription({
      provider: props.provider,
      rawId: props.channelId,
      name: currentName,
      avatarUrl: currentAvatar,
    })
    setSubscribed(next)
  }

  const handleSelect = (video: UnifiedVideoItem): void => {
    const index: number = shownVideos.findIndex((item: UnifiedVideoItem): boolean => item.id === video.id)
    playVideoQueue(shownVideos, { startIndex: index >= 0 ? index : 0 })
  }

  const handlePlayAll = (): void => {
    if (shownVideos.length === 0) return
    playVideoQueue(shownVideos)
  }

  const loadMoreRef = useRef<() => void>(() => {})
  loadMoreRef.current = (): void => {
    void loadMore()
  }

  const prefetchObserver: ScrollVisibilityChangeOptions = useMemo(
    () => ({
      threshold: 0.01,
      onChanged: (visible: boolean): void => {
        if (visible) loadMoreRef.current()
      },
    }),
    [],
  )

  const prefetchIndex: number =
    shownToken && shownVideos.length > 0
      ? Math.max(0, shownVideos.length - PREFETCH_LEAD_COUNT)
      : -1

  const footer: VirtualNode | null = shownToken && shownVideos.length > 0 ? (
    <VStack padding={{ vertical: 18 }} frame={{ maxWidth: "infinity" }}>
      {loadingMore ? (
        <ProgressView />
      ) : (
        <PillButton label="載入更多影片" icon="chevron.down" onTap={() => void loadMore()} />
      )}
    </VStack>
  ) : null

  let listContent: VirtualNode
  if (searching ? resultsLoading : (loading || listLoading) && videos.length === 0) {
    listContent = <VideoCardSkeleton layout={layoutMode} />
  } else if (searching && searchError) {
    listContent = (
      <EmptyState
        icon="exclamationmark.magnifyingglass"
        title="搜尋失敗"
        message={searchError}
        actionLabel="重試"
        onAction={() => void submitSearch()}
      />
    )
  } else if (errorText && !searching) {
    listContent = (
      <EmptyState
        icon="wifi.exclamationmark"
        title="連不上伺服器"
        message={errorText}
        actionLabel="重試"
        onAction={() => void load()}
      />
    )
  } else if (shownVideos.length === 0) {
    listContent = (
      <EmptyState
        icon={searching ? "magnifyingglass" : "tray"}
        title={searching ? "沒有符合的影片" : "這個頻道還沒有影片"}
      />
    )
  } else {
    listContent = (
      <LazyVStack spacing={layoutMode === "grid" ? space.cardGap : 4} frame={{ maxWidth: "infinity" }}>
        {shownVideos.map((video: UnifiedVideoItem, index: number) => (
          <VideoCard
            key={video.id}
            item={video}
            layout={layoutMode}
            progressSeconds={getSavedPosition(video.id, video.cid)}
            scrollVisibility={index === prefetchIndex ? prefetchObserver : undefined}
            onSelect={handleSelect}
            onOpenChannel={props.onOpenChannel}
          />
        ))}
      </LazyVStack>
    )
  }

  return (
    <ScrollView
      axes="vertical"
      scrollIndicator="hidden"
      scrollDismissesKeyboard="immediately"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      refreshable={load}
      navigationBarTitleDisplayMode="inline"
      scrollEdgeEffectStyle="soft"
      onScrollGeometryChange={{
        of: "contentOffset",
        onChanged: (_old: Readonly<Point>, next: Readonly<Point>): void => {
          const shouldShow: boolean = next.y > TITLE_REVEAL_OFFSET
          if (titleShownRef.current === shouldShow) return
          titleShownRef.current = shouldShow
          setTitleVisible(shouldShow)
        },
      }}
      onScrollPhaseChange={(
        _old: ScrollPhase,
        next: ScrollPhase,
        context: ScrollPhaseChangeContext,
      ): void => {
        const phase: string = String(next)
        if (phase !== "idle" && phase !== "decelerating") return
        if (!shownToken || loadingMoreRef.current) return
        const geometry: ScrollGeometry = context.geometry
        const velocityY: number = phase === "decelerating" && context.velocity ? Math.max(0, context.velocity.dy) : 0
        const lookahead: number = Math.min(velocityY * DECEL_LOOKAHEAD_S, MAX_LOOKAHEAD_PX)
        const remaining: number =
          geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height
        if (remaining - lookahead > LOAD_MORE_DISTANCE) return
        void loadMore()
      }}
      toolbar={{
        principal: (
          <Text
            font={type.cardTitle}
            fontWeight="semibold"
            foregroundStyle="label"
            lineLimit={1}
            opacity={titleVisible ? 1 : 0}
            animation={{ animation: motion.enter, value: titleVisible }}
          >
            {currentName}
          </Text>
        ),
      }}
    >
      <VStack spacing={20} frame={{ maxWidth: "infinity" }} padding={{ bottom: 16 }}>
        <ChannelBanner bannerUrl={detail?.bannerUrl} />
        <ChannelHero
          provider={props.provider}
          name={currentName}
          avatarUrl={currentAvatar}
          subscriberCountText={detail?.subscriberCountText}
          videoCountText={detail?.videoCountText}
          description={detail?.description}
          descriptionExpanded={descriptionExpanded}
          onToggleDescription={() => setDescriptionExpanded(!descriptionExpanded)}
          showDescriptionSkeleton={loading && !detail}
          subscribed={subscribed}
          onToggleSubscription={handleToggleSubscription}
          canPlayAll={shownVideos.length > 0}
          onPlayAll={handlePlayAll}
        />
        <ChannelToolbar
          provider={props.provider}
          query={query}
          onQueryChange={handleQueryChange}
          onSearch={() => void submitSearch()}
          searching={searching}
          sortMode={sortMode}
          onSortChange={(mode: ChannelSortMode) => void changeSort(mode)}
          layoutMode={layoutMode}
          onLayoutChange={setLayoutMode}
        />
        {listContent}
        {footer}
      </VStack>
    </ScrollView>
  )
}
