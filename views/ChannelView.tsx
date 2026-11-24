import {
  LazyVStack,
  ScrollView,
  Text,
  VStack,
  useEffect,
  useRef,
  useState,
} from "scripting"
import type { Point, VirtualNode } from "scripting"
import type { ChannelDetail, LayoutMode, OpenChannel, Provider, UnifiedVideoItem, VideoPage } from "../types/index"
import { VideoCard, VideoCardSkeleton } from "../components/VideoCard"
import { LoadMoreFooter } from "../components/paging/LoadMoreFooter"
import { usePagedVideos, type PagedVideos } from "../components/paging/usePagedVideos"
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
import { EmptyState } from "../ui/primitives"
import { motion, space, type } from "../ui/theme"

export interface ChannelViewProps {
  provider: Provider
  channelId: string
  initialName?: string
  initialAvatar?: string
  onClose?: () => void
  onOpenChannel?: OpenChannel
}

const TITLE_REVEAL_OFFSET: number = 140

export function ChannelView(props: ChannelViewProps): VirtualNode {
  const [detail, setDetail] = useState<ChannelDetail | null>(null)
  const detailRef = useRef<ChannelDetail | null>(null)
  const [subscribed, setSubscribed] = useState<boolean>(false)
  const [query, setQuery] = useState<string>("")
  const [sortMode, setSortMode] = useState<ChannelSortMode>("latest")
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("row")
  const [descriptionExpanded, setDescriptionExpanded] = useState<boolean>(false)
  const [titleVisible, setTitleVisible] = useState<boolean>(false)
  const titleShownRef = useRef<boolean>(false)
  const uploads: PagedVideos = usePagedVideos({ initialLoading: true })
  const results: PagedVideos = usePagedVideos()
  const [searchedQuery, setSearchedQuery] = useState<string>("")

  const subscriptionId: string = `${props.provider}:${props.channelId}`
  const channelKeyRef = useRef<string>(subscriptionId)
  channelKeyRef.current = subscriptionId

  const patchVideos = (incoming: UnifiedVideoItem[]): UnifiedVideoItem[] => {
    const name: string = detailRef.current?.name || props.initialName || props.channelId
    const avatar: string = detailRef.current?.avatarUrl || props.initialAvatar || ""
    return incoming.map((video: UnifiedVideoItem): UnifiedVideoItem => {
      if (video.authorName && video.authorId) return video
      return {
        ...video,
        authorName: video.authorName || name,
        authorId: video.authorId || props.channelId,
        authorAvatar: video.authorAvatar || avatar || undefined,
      }
    })
  }

  const patchPage = (page: VideoPage): VideoPage => ({ ...page, videos: patchVideos(page.videos) })

  const loadUploads = (mode: ChannelSortMode, withDetail: boolean, clear: boolean): Promise<void> => {
    const key: string = subscriptionId
    return uploads.reload(async (cursor?: string): Promise<VideoPage> => {
      if (cursor || !withDetail) {
        return patchPage(await getChannelVideos(props.provider, props.channelId, cursor, mode))
      }
      const next: ChannelDetail = await getChannel(props.provider, props.channelId)
      if (key === channelKeyRef.current) {
        detailRef.current = next
        setDetail(next)
      }
      return patchPage({ videos: next.videos, nextPageToken: next.nextPageToken })
    }, { clear })
  }

  const load = (): Promise<void> => {
    setSortMode("latest")
    return loadUploads("latest", true, false)
  }

  const retryUploads = (): void => {
    if (detail) void loadUploads(sortMode, false, true)
    else void load()
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
  const shown: PagedVideos = searching ? results : uploads
  const shownVideos: UnifiedVideoItem[] = shown.items

  const changeSort = (mode: ChannelSortMode): void => {
    if (mode === sortMode) return
    setSortMode(mode)
    void loadUploads(mode, false, true)
  }

  const clearSearch = (): void => {
    setSearchedQuery("")
    results.reset()
  }

  const submitSearch = async (): Promise<void> => {
    const text: string = query.trim()
    if (!text) {
      clearSearch()
      return
    }
    if (text === searchedQuery && !results.loading && !results.failed) return
    setSearchedQuery(text)
    await results.reload(
      async (cursor?: string): Promise<VideoPage> =>
        patchPage(await searchChannelVideos(props.provider, props.channelId, text, cursor)),
      { clear: true },
    )
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

  const footer: VirtualNode | null = shown.hasMore ? (
    <LoadMoreFooter
      loading={shown.loadingMore}
      hasMore
      label="載入更多影片"
      onLoadMore={() => void shown.loadMore()}
    />
  ) : null

  let listContent: VirtualNode
  if (shown.loading && shownVideos.length === 0) {
    listContent = <VideoCardSkeleton layout={layoutMode} />
  } else if (searching && results.failed) {
    listContent = (
      <EmptyState
        icon="exclamationmark.magnifyingglass"
        title="搜尋失敗"
        message="請確認網路連線後重試"
        actionLabel="重試"
        onAction={() => void submitSearch()}
      />
    )
  } else if (!searching && uploads.failed) {
    listContent = (
      <EmptyState
        icon="wifi.exclamationmark"
        title="連不上伺服器"
        message="無法載入頻道資料，請確認網路連線後重試"
        actionLabel="重試"
        onAction={retryUploads}
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
            scrollVisibility={index === shown.prefetchIndex ? shown.prefetchObserver : undefined}
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
      onScrollPhaseChange={shown.onScrollPhaseChange}
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
          showDescriptionSkeleton={uploads.loading && !detail}
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
          onSortChange={changeSort}
          layoutMode={layoutMode}
          onLayoutChange={setLayoutMode}
        />
        {listContent}
        {footer}
      </VStack>
    </ScrollView>
  )
}
