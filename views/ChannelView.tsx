import {
  Button,
  HStack,
  Image,
  ProgressView,
  ScrollView,
  Spacer,
  Text,
  TextField,
  VStack,
  ZStack,
  useEffect,
  useState,
} from "scripting"
import type { Color, VirtualNode } from "scripting"
import type { ChannelDetail, Provider, UnifiedVideoItem } from "../types"
import { VideoCard } from "../components/VideoCard"
import {
  getChannel,
  getSavedPosition,
  isSubscribed,
  subscribeStorageChanges,
  toggleSubscription,
} from "../services"
import {
  providerAccentColor,
  providerFullName,
  providerSoftBgColor,
} from "../utils/format"
import { openVideo } from "../state/playerStore"

export interface ChannelViewProps {
  provider: Provider
  channelId: string
  initialName?: string
  initialAvatar?: string
  onClose?: () => void
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
}

type SortMode = "latest" | "popular"
type LayoutMode = "row" | "grid"

const LINK_BLUE: Color = "rgba(10,132,255,1)"
const BANNER_HEIGHT: number = 110
const AVATAR_SIZE: number = 64

function Chip(props: {
  label: string
  icon?: string
  active: boolean
  activeColor: Color
  onTap: () => void
}): VirtualNode {
  return (
    <HStack
      spacing={4}
      padding={{ horizontal: 11, vertical: 6 }}
      background={props.active ? props.activeColor : "tertiarySystemFill"}
      clipShape="capsule"
      onTapGesture={props.onTap}
    >
      {props.icon
        ? (
          <Image
            systemName={props.icon}
            font={11}
            foregroundStyle={props.active ? "white" : "secondaryLabel"}
          />
        )
        : null}
      <Text
        font={12}
        fontWeight={props.active ? "semibold" : "medium"}
        foregroundStyle={props.active ? "white" : "label"}
        lineLimit={1}
      >
        {props.label}
      </Text>
    </HStack>
  )
}

function CircleIconButton(props: { icon: string; size: number; onTap: () => void }): VirtualNode {
  return (
    <VStack
      frame={{ width: props.size, height: props.size }}
      background="tertiarySystemFill"
      clipShape="circle"
      onTapGesture={props.onTap}
    >
      <Image systemName={props.icon} font={Math.round(props.size * 0.44)} foregroundStyle="label" />
    </VStack>
  )
}

function AvatarCircle(props: {
  provider: Provider
  name: string
  avatarUrl?: string
  size: number
}): VirtualNode {
  if (props.avatarUrl) {
    return (
      <Image
        imageUrl={props.avatarUrl}
        resizable
        scaleToFill
        frame={{ width: props.size, height: props.size }}
        clipShape="circle"
      />
    )
  }
  const initial: string = (props.name.trim().charAt(0) || "?").toUpperCase()
  return (
    <VStack
      frame={{ width: props.size, height: props.size }}
      background={providerAccentColor(props.provider)}
      clipShape="circle"
    >
      <Text font={Math.round(props.size * 0.42)} fontWeight="semibold" foregroundStyle="white">
        {initial}
      </Text>
    </VStack>
  )
}

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
  const [refreshSeq, setRefreshSeq] = useState<number>(0)
  const [subscribed, setSubscribed] = useState<boolean>(false)
  const [query, setQuery] = useState<string>("")
  const [sortMode, setSortMode] = useState<SortMode>("latest")
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("row")
  const [descriptionExpanded, setDescriptionExpanded] = useState<boolean>(false)

  const subscriptionId: string = `${props.provider}:${props.channelId}`

  useEffect(() => {
    let cancelled: boolean = false
    setLoading(true)
    setErrorText(null)
    getChannel(props.provider, props.channelId)
      .then((next: ChannelDetail) => {
        if (cancelled) return
        setDetail(next)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setDetail(null)
        setErrorText("無法載入頻道資料，請確認網路連線後重試")
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [props.provider, props.channelId, refreshSeq])

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

  const topBar: VirtualNode = (
    <HStack spacing={8} padding={{ horizontal: 12, vertical: 8 }} frame={{ maxWidth: "infinity" }}>
      {props.onClose
        ? (
          <HStack
            spacing={4}
            padding={{ horizontal: 10, vertical: 6 }}
            background="tertiarySystemFill"
            clipShape="capsule"
            onTapGesture={props.onClose}
          >
            <Image systemName="chevron.left" font={12} foregroundStyle="label" />
            <Text font={13} fontWeight="medium" foregroundStyle="label" lineLimit={1}>返回</Text>
          </HStack>
        )
        : null}

      <Spacer />

      <Text
        font={10}
        fontWeight="bold"
        foregroundStyle="white"
        padding={{ horizontal: 7, vertical: 3 }}
        background={providerAccentColor(props.provider)}
        clipShape="capsule"
      >
        {providerFullName(props.provider)}
      </Text>

      <CircleIconButton
        icon="arrow.clockwise"
        size={30}
        onTap={() => setRefreshSeq((seq: number): number => seq + 1)}
      />
    </HStack>
  )

  const banner: VirtualNode = detail?.bannerUrl
    ? (
      <ZStack frame={{ maxWidth: "infinity", height: BANNER_HEIGHT }} clipped>
        <Image
          imageUrl={detail.bannerUrl}
          resizable
          scaleToFill
          frame={{ maxWidth: "infinity", height: BANNER_HEIGHT }}
        />
      </ZStack>
    )
    : (
      <VStack
        frame={{ maxWidth: "infinity", height: 56 }}
        background={providerSoftBgColor(props.provider)}
      />
    )

  const infoCard: VirtualNode = (
    <VStack
      spacing={12}
      padding={16}
      frame={{ maxWidth: "infinity" }}
      background="secondarySystemGroupedBackground"
      clipShape={{ type: "rect", cornerRadius: 16 }}
    >
      <HStack spacing={14} alignment="center" frame={{ maxWidth: "infinity" }}>
        <AvatarCircle
          provider={props.provider}
          name={currentName}
          avatarUrl={currentAvatar || undefined}
          size={AVATAR_SIZE}
        />

        <VStack
          alignment="leading"
          spacing={4}
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          <Text font="title3" fontWeight="bold" foregroundStyle="label" lineLimit={1}>
            {currentName}
          </Text>
          <HStack spacing={6}>
            <Text
              font={9}
              fontWeight="bold"
              foregroundStyle="white"
              padding={{ horizontal: 5, vertical: 2 }}
              background={providerAccentColor(props.provider)}
              clipShape={{ type: "rect", cornerRadius: 4 }}
            >
              {providerFullName(props.provider)}
            </Text>
            {detail?.subscriberCountText
              ? (
                <Text font={11} foregroundStyle="secondaryLabel" lineLimit={1}>
                  {detail.subscriberCountText}
                </Text>
              )
              : null}
            <Text font={11} foregroundStyle="tertiaryLabel" lineLimit={1}>
              {`${videos.length} 部影片`}
            </Text>
          </HStack>
        </VStack>

        <HStack
          spacing={5}
          padding={{ horizontal: 14, vertical: 8 }}
          background={subscribed ? "tertiarySystemFill" : providerAccentColor(props.provider)}
          clipShape="capsule"
          onTapGesture={handleToggleSubscription}
        >
          <Image
            systemName={subscribed ? "checkmark" : "plus"}
            font={12}
            foregroundStyle={subscribed ? "secondaryLabel" : "white"}
          />
          <Text
            font={13}
            fontWeight={subscribed ? "medium" : "bold"}
            foregroundStyle={subscribed ? "secondaryLabel" : "white"}
            lineLimit={1}
          >
            {subscribed ? "已訂閱" : "訂閱"}
          </Text>
        </HStack>
      </HStack>

      {detail?.description
        ? (
          <Text
            font="footnote"
            foregroundStyle="secondaryLabel"
            lineLimit={descriptionExpanded ? undefined : 2}
            multilineTextAlignment="leading"
            onTapGesture={() => setDescriptionExpanded(!descriptionExpanded)}
          >
            {detail.description}
          </Text>
        )
        : null}
    </VStack>
  )

  const toolbar: VirtualNode = (
    <VStack spacing={8} frame={{ maxWidth: "infinity" }}>
      <HStack
        spacing={6}
        padding={{ horizontal: 12, vertical: 8 }}
        background="tertiarySystemFill"
        clipShape={{ type: "rect", cornerRadius: 10 }}
        frame={{ maxWidth: "infinity" }}
      >
        <Image systemName="magnifyingglass" font={14} foregroundStyle="secondaryLabel" />
        <TextField
          title="篩選頻道影片"
          value={query}
          onChanged={setQuery}
          prompt="篩選頻道影片…"
          font={14}
          frame={{ maxWidth: "infinity" }}
        />
        {query.length > 0
          ? (
            <HStack spacing={0} onTapGesture={() => setQuery("")}>
              <Image systemName="xmark.circle.fill" font={15} foregroundStyle="tertiaryLabel" />
            </HStack>
          )
          : null}
      </HStack>

      <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
        <Chip
          label="最新上傳"
          active={sortMode === "latest"}
          activeColor={LINK_BLUE}
          onTap={() => setSortMode("latest")}
        />
        <Chip
          label="熱門觀看"
          active={sortMode === "popular"}
          activeColor={LINK_BLUE}
          onTap={() => setSortMode("popular")}
        />

        <Spacer />

        {filteredVideos.length > 0
          ? (
            <Chip
              label="全部播放"
              icon="play.fill"
              active
              activeColor={providerAccentColor(props.provider)}
              onTap={handlePlayAll}
            />
          )
          : null}

        <CircleIconButton
          icon={layoutMode === "row" ? "rectangle.grid.1x2" : "list.bullet"}
          size={30}
          onTap={() => setLayoutMode(layoutMode === "row" ? "grid" : "row")}
        />
      </HStack>
    </VStack>
  )

  let listContent: VirtualNode
  if (loading && videos.length === 0) {
    listContent = (
      <VStack spacing={10} frame={{ maxWidth: "infinity", minHeight: 200 }}>
        <ProgressView />
        <Text font={13} foregroundStyle="secondaryLabel">載入頻道資料中…</Text>
      </VStack>
    )
  } else if (errorText) {
    listContent = (
      <VStack spacing={12} frame={{ maxWidth: "infinity", minHeight: 200 }}>
        <Image systemName="wifi.exclamationmark" font={30} foregroundStyle="tertiaryLabel" />
        <Text font={13} foregroundStyle="secondaryLabel">{errorText}</Text>
        <Button
          title="重試"
          action={() => setRefreshSeq((seq: number): number => seq + 1)}
          buttonStyle="borderedProminent"
          controlSize="small"
          tint={LINK_BLUE}
        />
      </VStack>
    )
  } else if (filteredVideos.length === 0) {
    listContent = (
      <VStack spacing={10} frame={{ maxWidth: "infinity", minHeight: 200 }}>
        <Image
          systemName={keyword.length > 0 ? "magnifyingglass" : "tray"}
          font={30}
          foregroundStyle="tertiaryLabel"
        />
        <Text font={13} foregroundStyle="secondaryLabel">
          {keyword.length > 0 ? "沒有符合關鍵字的影片" : "此頻道目前沒有可顯示的影片"}
        </Text>
      </VStack>
    )
  } else {
    listContent = (
      <VStack spacing={layoutMode === "grid" ? 18 : 0} frame={{ maxWidth: "infinity" }}>
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
      </VStack>
    )
  }

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      {topBar}
      <ScrollView
        axes="vertical"
        scrollIndicator="automatic"
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      >
        <VStack spacing={14} alignment="leading" frame={{ maxWidth: "infinity" }} padding={{ top: 4 }}>
          {banner}
          <VStack spacing={14} padding={{ horizontal: 12 }} frame={{ maxWidth: "infinity" }}>
            {infoCard}
            {toolbar}
          </VStack>
          <VStack
            spacing={0}
            frame={{ maxWidth: "infinity" }}
            padding={{ horizontal: layoutMode === "grid" ? 12 : 0 }}
          >
            {listContent}
          </VStack>
          <Spacer frame={{ height: 96 }} />
        </VStack>
      </ScrollView>
    </VStack>
  )
}
