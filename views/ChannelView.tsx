import {
  HStack,
  Image,
  LazyVStack,
  ProgressView,
  Rectangle,
  ScrollView,
  Spacer,
  Text,
  VStack,
  ZStack,
  useEffect,
  useRef,
  useState,
} from "scripting"
import type { Point, ScrollGeometry, ScrollPhase, ScrollPhaseChangeContext, VirtualNode } from "scripting"
import type { ChannelDetail, Provider, UnifiedVideoItem } from "../types"
import { VideoCard, VideoCardSkeleton } from "../components/VideoCard"
import {
  getChannel,
  getChannelVideos,
  getSavedPosition,
  isSubscribed,
  searchChannelVideos,
  subscribeStorageChanges,
  toggleSubscription,
} from "../services/index"
import { providerFullName } from "../utils/format"
import { openVideo } from "../state/playerStore"
import type { ChipOption } from "../ui/primitives"
import {
  Avatar,
  ChipBar,
  EmptyState,
  LayoutToggle,
  PillButton,
  SearchField,
  Skeleton,
} from "../ui/primitives"
import { motion, providerColor, space, type } from "../ui/theme"

export interface ChannelViewProps {
  provider: Provider
  channelId: string
  initialName?: string
  initialAvatar?: string
  onClose?: () => void
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
}

type SortMode = "latest" | "popular" | "oldest"
type LayoutMode = "row" | "grid"

const BANNER_HEIGHT: number = 132
const AVATAR_SIZE: number = 76
const LOAD_MORE_DISTANCE: number = 320
const TITLE_REVEAL_OFFSET: number = 140

const SORT_OPTIONS_YT: ChipOption<SortMode>[] = [
  { key: "latest", label: "最新" },
  { key: "popular", label: "熱門" },
  { key: "oldest", label: "最早" },
]

const SORT_OPTIONS_BILI: ChipOption<SortMode>[] = [
  { key: "latest", label: "最新" },
  { key: "popular", label: "熱門" },
]

export function ChannelView(props: ChannelViewProps): VirtualNode {
  const [detail, setDetail] = useState<ChannelDetail | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [subscribed, setSubscribed] = useState<boolean>(false)
  const [query, setQuery] = useState<string>("")
  const [sortMode, setSortMode] = useState<SortMode>("latest")
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
    })
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

  const changeSort = async (mode: SortMode): Promise<void> => {
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
    const next: boolean = toggleSubscription({
      id: subscriptionId,
      provider: props.provider,
      rawId: props.channelId,
      name: currentName,
      avatarUrl: currentAvatar,
      subscribedAt: Date.now(),
    })
    setSubscribed(next)
  }

  const handleSelect = (video: UnifiedVideoItem): void => {
    void openVideo(video, { queue: shownVideos })
  }

  const handlePlayAll = (): void => {
    if (shownVideos.length === 0) return
    void openVideo(shownVideos[0], { queue: shownVideos })
  }

  const metaParts: string[] = [providerFullName(props.provider)]
  if (detail?.subscriberCountText) metaParts.push(detail.subscriberCountText)
  if (detail?.videoCountText) metaParts.push(`${detail.videoCountText} 部影片`)

  const banner: VirtualNode = detail?.bannerUrl
    ? (
      <Rectangle
        fill="secondarySystemFill"
        frame={{ maxWidth: "infinity", height: BANNER_HEIGHT }}
        overlay={
          <Image
            imageUrl={detail.bannerUrl}
            resizable
            scaleToFill
            frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          />
        }
        clipped
      />
    )
    : <Rectangle fill="rgba(0,0,0,0)" frame={{ maxWidth: "infinity", height: 52 }} />

  const hero: VirtualNode = (
    <VStack alignment="leading" spacing={14} padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <HStack spacing={14} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Avatar url={currentAvatar || undefined} name={currentName} size={AVATAR_SIZE} provider={props.provider} />
        <VStack alignment="leading" spacing={5} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={type.title + 2} fontWeight="heavy" foregroundStyle="label" lineLimit={2}>
            {currentName}
          </Text>
          <HStack spacing={6}>
            <Rectangle
              fill={providerColor(props.provider)}
              frame={{ width: 7, height: 7 }}
              clipShape={{ type: "rect", cornerRadius: 3.5 }}
            />
            <Text font={type.meta + 1} foregroundStyle="secondaryLabel" lineLimit={1}>
              {metaParts.join(" · ")}
            </Text>
          </HStack>
        </VStack>
      </HStack>

      {detail?.description ? (
        <Text
          font={type.body}
          foregroundStyle="secondaryLabel"
          lineLimit={descriptionExpanded ? undefined : 2}
          multilineTextAlignment="leading"
          frame={{ maxWidth: "infinity", alignment: "leading" }}
          onTapGesture={() => setDescriptionExpanded(!descriptionExpanded)}
        >
          {detail.description}
        </Text>
      ) : loading && !detail ? (
        <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Skeleton height={12} />
          <Skeleton width={180} height={12} />
        </VStack>
      ) : null}

      <HStack spacing={10} frame={{ maxWidth: "infinity" }}>
        <PillButton
          label={subscribed ? "已訂閱" : "訂閱"}
          icon={subscribed ? "checkmark" : "plus"}
          prominent={!subscribed}
          onTap={handleToggleSubscription}
        />
        {shownVideos.length > 0 ? (
          <PillButton label="全部播放" icon="play.fill" prominent={false} onTap={handlePlayAll} />
        ) : null}
      </HStack>
    </VStack>
  )

  const filterField: VirtualNode = (
    <SearchField
      value={query}
      prompt="在頻道中搜尋"
      onChange={handleQueryChange}
      onCommit={() => void submitSearch()}
    />
  )

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
        {shownVideos.map((video: UnifiedVideoItem) => (
          <VideoCard
            key={video.id}
            item={video}
            layout={layoutMode}
            progressSeconds={getSavedPosition(video.id, video.cid)}
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
        if (String(next) !== "idle") return
        if (!shownToken || loadingMoreRef.current) return
        const geometry: ScrollGeometry = context.geometry
        const remaining: number =
          geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height
        if (remaining > LOAD_MORE_DISTANCE) return
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
        {banner}
        {hero}
        <VStack spacing={12} frame={{ maxWidth: "infinity" }}>
          <VStack padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity" }}>
            {filterField}
          </VStack>
          {searching ? (
            <HStack padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity" }}>
              <Spacer />
              <LayoutToggle layout={layoutMode} onChange={setLayoutMode} />
            </HStack>
          ) : (
            <ChipBar
              options={props.provider === "yt" ? SORT_OPTIONS_YT : SORT_OPTIONS_BILI}
              value={sortMode}
              onChange={(mode: SortMode) => void changeSort(mode)}
              trailing={<LayoutToggle layout={layoutMode} onChange={setLayoutMode} />}
            />
          )}
        </VStack>
        {listContent}
        {footer}
      </VStack>
    </ScrollView>
  )
}
