import {
  HStack,
  Image,
  LazyVStack,
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
import type { Point, VirtualNode } from "scripting"
import type { ChannelDetail, Provider, UnifiedVideoItem } from "../types"
import { VideoCard, VideoCardSkeleton } from "../components/VideoCard"
import {
  getChannel,
  getSavedPosition,
  isSubscribed,
  subscribeStorageChanges,
  toggleSubscription,
} from "../services"
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
import { providerColor, space, type } from "../ui/theme"

export interface ChannelViewProps {
  provider: Provider
  channelId: string
  initialName?: string
  initialAvatar?: string
  /** 保留給非推入式的呼叫端；推入頁的返回由系統導覽列提供。 */
  onClose?: () => void
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
}

type SortMode = "latest" | "popular"
type LayoutMode = "row" | "grid"

const BANNER_HEIGHT: number = 132
const AVATAR_SIZE: number = 76
/** 名字上緣大約在這個位移（封面 132 + 間距 20）之後看不見。 */
const TITLE_REVEAL_OFFSET: number = 140

const SORT_OPTIONS: ChipOption<SortMode>[] = [
  { key: "latest", label: "最新" },
  { key: "popular", label: "熱門" },
]

function sortVideos(list: UnifiedVideoItem[], mode: SortMode): UnifiedVideoItem[] {
  const next: UnifiedVideoItem[] = list.slice()
  if (mode === "popular") {
    return next.sort((a: UnifiedVideoItem, b: UnifiedVideoItem): number => (b.viewCount ?? 0) - (a.viewCount ?? 0))
  }
  return next.sort((a: UnifiedVideoItem, b: UnifiedVideoItem): number => {
    const aTime: number | undefined = a.publishedAt
    const bTime: number | undefined = b.publishedAt
    if (aTime === undefined && bTime === undefined) return 0
    if (aTime === undefined) return 1
    if (bTime === undefined) return -1
    return bTime - aTime
  })
}

export function ChannelView(props: ChannelViewProps): VirtualNode {
  const [detail, setDetail] = useState<ChannelDetail | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [subscribed, setSubscribed] = useState<boolean>(false)
  const [query, setQuery] = useState<string>("")
  const [sortMode, setSortMode] = useState<SortMode>("latest")
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("row")
  const [descriptionExpanded, setDescriptionExpanded] = useState<boolean>(false)
  // 導覽列標題跟頻道名走：名字還在畫面上就不顯示，捲出去才浮出來。
  const [titleVisible, setTitleVisible] = useState<boolean>(false)
  const titleShownRef = useRef<boolean>(false)
  const requestSeq = useRef<number>(0)

  const subscriptionId: string = `${props.provider}:${props.channelId}`

  const load = async (): Promise<void> => {
    const seq: number = ++requestSeq.current
    setLoading(true)
    setErrorText(null)
    try {
      const next: ChannelDetail = await getChannel(props.provider, props.channelId)
      if (seq !== requestSeq.current) return
      setDetail(next)
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
  const videos: UnifiedVideoItem[] = detail?.videos ?? []
  const keyword: string = query.trim().toLowerCase()
  const searchedVideos: UnifiedVideoItem[] = keyword.length === 0
    ? videos
    : videos.filter((video: UnifiedVideoItem): boolean => {
      const haystack: string = `${video.title} ${video.authorName}`.toLowerCase()
      return haystack.includes(keyword)
    })
  const filteredVideos: UnifiedVideoItem[] = sortVideos(searchedVideos, sortMode)

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
    void openVideo(video, { queue: filteredVideos })
  }

  const handlePlayAll = (): void => {
    if (filteredVideos.length === 0) return
    void openVideo(filteredVideos[0], { queue: filteredVideos })
  }

  const metaParts: string[] = [providerFullName(props.provider)]
  if (detail?.subscriberCountText) metaParts.push(detail.subscriberCountText)
  if (detail) metaParts.push(`${videos.length} 部影片`)

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
        {filteredVideos.length > 0 ? (
          <PillButton label="全部播放" icon="play.fill" prominent={false} onTap={handlePlayAll} />
        ) : null}
      </HStack>
    </VStack>
  )

  const filterField: VirtualNode = (
    <SearchField value={query} prompt="在頻道中搜尋" onChange={setQuery} />
  )

  let listContent: VirtualNode
  if (loading && videos.length === 0) {
    listContent = <VideoCardSkeleton layout={layoutMode} />
  } else if (errorText) {
    listContent = (
      <EmptyState
        icon="wifi.exclamationmark"
        title="連不上伺服器"
        message={errorText}
        actionLabel="重試"
        onAction={() => void load()}
      />
    )
  } else if (filteredVideos.length === 0) {
    listContent = (
      <EmptyState
        icon={keyword.length > 0 ? "magnifyingglass" : "tray"}
        title={keyword.length > 0 ? "沒有符合的影片" : "這個頻道還沒有影片"}
      />
    )
  } else {
    listContent = (
      <LazyVStack spacing={layoutMode === "grid" ? space.cardGap : 4} frame={{ maxWidth: "infinity" }}>
        {filteredVideos.map((video: UnifiedVideoItem) => (
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
      // 只訂閱位移；轉成布林後用 ref 去重，SwiftUI 每幀都回呼但只有跨過門檻才重繪。
      onScrollGeometryChange={{
        of: "contentOffset",
        onChanged: (_old: Readonly<Point>, next: Readonly<Point>): void => {
          const shouldShow: boolean = next.y > TITLE_REVEAL_OFFSET
          if (titleShownRef.current === shouldShow) return
          titleShownRef.current = shouldShow
          setTitleVisible(shouldShow)
        },
      }}
      toolbar={{
        principal: (
          <Text
            font={type.cardTitle}
            fontWeight="semibold"
            foregroundStyle="label"
            lineLimit={1}
            opacity={titleVisible ? 1 : 0}
            animation={{ animation: Animation.easeIn(0.18), value: titleVisible }}
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
          <ChipBar
            options={SORT_OPTIONS}
            value={sortMode}
            onChange={setSortMode}
            trailing={<LayoutToggle layout={layoutMode} onChange={setLayoutMode} />}
          />
        </VStack>
        {listContent}
      </VStack>
    </ScrollView>
  )
}
