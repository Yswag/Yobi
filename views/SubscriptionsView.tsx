import {
  HStack,
  Image,
  LazyVStack,
  ScrollView,
  Text,
  VStack,
  ZStack,
  useEffect,
  useRef,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { ChannelDetail, Provider, SubscriptionChannel, UnifiedVideoItem } from "../types"
import { VideoCard, VideoCardSkeleton } from "../components/VideoCard"
import {
  getChannel,
  getSavedPosition,
  getSubscriptions,
  subscribeStorageChanges,
  toggleSubscription,
} from "../services"
import { providerFullName } from "../utils/format"
import { openVideo } from "../state/playerStore"
import {
  Avatar,
  ChipBar,
  EmptyState,
  GlassIconButton,
  LayoutToggle,
  PageHeader,
  PROVIDER_FILTERS,
  SectionHeader,
} from "../ui/primitives"
import { palette, providerColor, space, type } from "../ui/theme"

export interface SubscriptionsViewProps {
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
  onOpenSearch?: () => void
}

type ProviderFilter = "all" | Provider
type LayoutMode = "row" | "grid"

const STRIP_AVATAR_SIZE: number = 56
const STRIP_RING: number = 3

/**
 * 跨頻道聚合：
 * 全部影片都有 `publishedAt` 時依時間新到舊排序；
 * 否則保持「各頻道第 1 部 → 各頻道第 2 部」的交錯順序，避免單一頻道洗版。
 */
function buildTimeline(groups: UnifiedVideoItem[][]): UnifiedVideoItem[] {
  const merged: UnifiedVideoItem[] = []
  const seen: Set<string> = new Set()
  const longest: number = groups.reduce(
    (max: number, group: UnifiedVideoItem[]): number => Math.max(max, group.length),
    0,
  )
  for (let index = 0; index < longest; index++) {
    for (const group of groups) {
      const item: UnifiedVideoItem | undefined = group[index]
      if (!item || seen.has(item.id)) continue
      seen.add(item.id)
      merged.push(item)
    }
  }

  const allStamped: boolean = merged.every(
    (item: UnifiedVideoItem): boolean => typeof item.publishedAt === "number",
  )
  if (!allStamped) return merged

  return merged.sort(
    (a: UnifiedVideoItem, b: UnifiedVideoItem): number => (b.publishedAt as number) - (a.publishedAt as number),
  )
}

function ChannelStripItem(props: {
  channel: SubscriptionChannel | null
  selected: boolean
  dimmed: boolean
  onTap: () => void
}): VirtualNode {
  const channel: SubscriptionChannel | null = props.channel
  const outer: number = STRIP_AVATAR_SIZE + STRIP_RING * 2 + 4

  return (
    <VStack
      spacing={6}
      frame={{ width: outer + 6 }}
      opacity={props.dimmed ? 0.45 : 1}
      contentShape="rect"
      animation={{ animation: Animation.smooth({ duration: 0.25 }), value: props.selected }}
      onTapGesture={props.onTap}
    >
      <ZStack
        frame={{ width: outer, height: outer }}
        background={{
          style: props.selected ? palette.brand : "rgba(0,0,0,0)",
          shape: { type: "rect", cornerRadius: outer / 2 },
        }}
      >
        <ZStack
          frame={{ width: STRIP_AVATAR_SIZE + 4, height: STRIP_AVATAR_SIZE + 4 }}
          background={{ style: "systemBackground", shape: { type: "rect", cornerRadius: (STRIP_AVATAR_SIZE + 4) / 2 } }}
        >
          {channel ? (
            <Avatar
              url={channel.avatarUrl || undefined}
              name={channel.name}
              size={STRIP_AVATAR_SIZE}
              provider={channel.provider}
            />
          ) : (
            <VStack
              frame={{ width: STRIP_AVATAR_SIZE, height: STRIP_AVATAR_SIZE }}
              background={{ style: "tertiarySystemFill", shape: { type: "rect", cornerRadius: STRIP_AVATAR_SIZE / 2 } }}
            >
              <Image systemName="square.stack.fill" font={20} foregroundStyle="label" />
            </VStack>
          )}
        </ZStack>
      </ZStack>
      <Text
        font={type.caption}
        fontWeight={props.selected ? "semibold" : "regular"}
        foregroundStyle={props.selected ? "label" : "secondaryLabel"}
        lineLimit={1}
      >
        {channel ? channel.name : "全部"}
      </Text>
    </VStack>
  )
}

function ManageRow(props: {
  channel: SubscriptionChannel
  onOpen: () => void
  onUnsubscribe: () => void
}): VirtualNode {
  const channel: SubscriptionChannel = props.channel
  return (
    <HStack spacing={12} padding={{ horizontal: space.page, vertical: 10 }} frame={{ maxWidth: "infinity" }}>
      <HStack spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect" onTapGesture={props.onOpen}>
        <Avatar url={channel.avatarUrl || undefined} name={channel.name} size={44} provider={channel.provider} />
        <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={type.cardTitle} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>{channel.name}</Text>
          <HStack spacing={5}>
            <VStack
              frame={{ width: 6, height: 6 }}
              background={{ style: providerColor(channel.provider), shape: { type: "rect", cornerRadius: 3 } }}
            />
            <Text font={type.meta} foregroundStyle="secondaryLabel">{providerFullName(channel.provider)}</Text>
          </HStack>
        </VStack>
      </HStack>
      <Text
        font={type.meta + 1}
        fontWeight="semibold"
        foregroundStyle={palette.danger}
        padding={{ horizontal: 12, vertical: 7 }}
        background={{ style: palette.dangerSoft, shape: "capsule" }}
        onTapGesture={props.onUnsubscribe}
      >
        取消訂閱
      </Text>
    </HStack>
  )
}

export function SubscriptionsView(props: SubscriptionsViewProps): VirtualNode {
  const [subscriptions, setSubscriptions] = useState<SubscriptionChannel[]>(() => getSubscriptions())
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all")
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("row")
  const [managing, setManaging] = useState<boolean>(false)
  const [cache, setCache] = useState<Record<string, ChannelDetail>>({})
  const [failedIds, setFailedIds] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState<boolean>(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const refreshWaiters = useRef<(() => void)[]>([])

  const settleRefresh = (): void => {
    const waiters: (() => void)[] = refreshWaiters.current
    refreshWaiters.current = []
    waiters.forEach((resolve: () => void) => resolve())
  }

  useEffect(() => {
    setSubscriptions(getSubscriptions())
    return subscribeStorageChanges(() => {
      setSubscriptions(getSubscriptions())
    })
  }, [])

  useEffect(() => {
    if (selectedChannelId && !subscriptions.some((ch: SubscriptionChannel): boolean => ch.id === selectedChannelId)) {
      setSelectedChannelId(null)
    }
  }, [subscriptions, selectedChannelId])

  const providerChannels: SubscriptionChannel[] = subscriptions.filter(
    (ch: SubscriptionChannel): boolean => providerFilter === "all" || ch.provider === providerFilter,
  )
  const activeChannels: SubscriptionChannel[] = selectedChannelId
    ? providerChannels.filter((ch: SubscriptionChannel): boolean => ch.id === selectedChannelId)
    : providerChannels
  const activeKey: string = activeChannels.map((ch: SubscriptionChannel): string => ch.id).join(",")
  const selectedChannel: SubscriptionChannel | null =
    providerChannels.find((ch: SubscriptionChannel): boolean => ch.id === selectedChannelId) ?? null

  useEffect(() => {
    if (activeChannels.length === 0) {
      setLoading(false)
      settleRefresh()
      return
    }
    // 快取只用來避免切換篩選時重複請求，強制重抓由 refresh() 清空快取觸發。
    const missing: SubscriptionChannel[] = activeChannels.filter(
      (ch: SubscriptionChannel): boolean => !cache[ch.id] && !failedIds[ch.id],
    )
    if (missing.length === 0) {
      setLoading(false)
      settleRefresh()
      return
    }

    let cancelled: boolean = false
    setLoading(true)
    Promise.allSettled(missing.map((ch: SubscriptionChannel) => getChannel(ch.provider, ch.rawId)))
      .then((results) => {
        if (cancelled) return
        const next: Record<string, ChannelDetail> = { ...cache }
        const nextFailed: Record<string, boolean> = { ...failedIds }
        let failedCount: number = 0
        results.forEach((result, index: number) => {
          const id: string = missing[index].id
          if (result.status === "fulfilled") {
            next[id] = result.value
            delete nextFailed[id]
          } else {
            failedCount += 1
            nextFailed[id] = true
          }
        })
        // 沒有任何成功結果時不改動狀態，避免快取身分變動造成無限重抓。
        if (failedCount < results.length) setCache(next)
        if (failedCount > 0 || Object.keys(failedIds).length > 0) setFailedIds(nextFailed)
        setErrorText(failedCount === results.length ? "訂閱動態載入失敗，請確認網路後重試" : null)
        setLoading(false)
        settleRefresh()
      })
      .catch(() => {
        if (cancelled) return
        setErrorText("訂閱動態載入失敗，請確認網路後重試")
        setLoading(false)
        settleRefresh()
      })

    return () => {
      cancelled = true
    }
  }, [activeKey, cache, failedIds])

  const groups: UnifiedVideoItem[][] = activeChannels.map(
    (ch: SubscriptionChannel): UnifiedVideoItem[] => cache[ch.id]?.videos ?? [],
  )
  const displayedVideos: UnifiedVideoItem[] = buildTimeline(groups)

  const refresh = (): void => {
    setErrorText(null)
    setCache({})
    setFailedIds({})
  }

  const refreshAndWait = (): Promise<void> => new Promise<void>((resolve: () => void) => {
    refreshWaiters.current.push(resolve)
    refresh()
  })

  const handleSelect = (item: UnifiedVideoItem): void => {
    void openVideo(item, { queue: displayedVideos })
  }

  const handleOpenChannel = (channel: SubscriptionChannel): void => {
    props.onOpenChannel?.(channel.provider, channel.rawId, channel.name, channel.avatarUrl || undefined)
  }

  const header: VirtualNode = (
    <PageHeader
      title="訂閱"
      trailing={subscriptions.length > 0 ? (
        <GlassIconButton
          icon={managing ? "checkmark" : "slider.horizontal.3"}
          tint={managing ? palette.brand : undefined}
          onTap={() => setManaging(!managing)}
        />
      ) : undefined}
    />
  )

  const channelStrip: VirtualNode | null = providerChannels.length === 0
    ? null
    : (
      <ScrollView axes="horizontal" scrollIndicator="hidden">
        <HStack spacing={10} alignment="top" padding={{ horizontal: space.page - 3 }}>
          <ChannelStripItem
            channel={null}
            selected={selectedChannelId === null}
            dimmed={false}
            onTap={() => setSelectedChannelId(null)}
          />
          {providerChannels.map((ch: SubscriptionChannel) => (
            <ChannelStripItem
              key={ch.id}
              channel={ch}
              selected={selectedChannelId === ch.id}
              dimmed={selectedChannelId !== null && selectedChannelId !== ch.id}
              onTap={() => setSelectedChannelId(selectedChannelId === ch.id ? null : ch.id)}
            />
          ))}
        </HStack>
      </ScrollView>
    )

  let content: VirtualNode
  if (subscriptions.length === 0) {
    content = (
      <EmptyState
        icon="person.2"
        title="還沒有訂閱"
        message="不用登入就能同時訂閱 YouTube 與 BiliBili 的創作者"
        actionLabel={props.onOpenSearch ? "搜尋頻道" : undefined}
        onAction={props.onOpenSearch}
      />
    )
  } else if (managing) {
    content = (
      <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
        {subscriptions.map((ch: SubscriptionChannel) => (
          <ManageRow
            key={ch.id}
            channel={ch}
            onOpen={() => handleOpenChannel(ch)}
            onUnsubscribe={() => {
              toggleSubscription({
                id: ch.id,
                provider: ch.provider,
                rawId: ch.rawId,
                name: ch.name,
                avatarUrl: ch.avatarUrl,
                subscribedAt: ch.subscribedAt,
              })
              setSubscriptions(getSubscriptions())
            }}
          />
        ))}
      </VStack>
    )
  } else {
    let feed: VirtualNode
    if (loading && displayedVideos.length === 0) {
      feed = <VideoCardSkeleton layout={layoutMode} />
    } else if (errorText && displayedVideos.length === 0) {
      feed = (
        <EmptyState
          icon="wifi.exclamationmark"
          title="連不上伺服器"
          message={errorText}
          actionLabel="重試"
          onAction={refresh}
        />
      )
    } else if (displayedVideos.length === 0) {
      feed = (
        <EmptyState
          icon="tray"
          title={activeChannels.length === 0 ? "這個平台還沒有訂閱" : "目前沒有新影片"}
        />
      )
    } else {
      feed = (
        <LazyVStack spacing={layoutMode === "grid" ? space.cardGap : 4} frame={{ maxWidth: "infinity" }}>
          {displayedVideos.map((item: UnifiedVideoItem) => (
            <VideoCard
              key={item.id}
              item={item}
              layout={layoutMode}
              progressSeconds={getSavedPosition(item.id, item.cid)}
              onSelect={handleSelect}
              onOpenChannel={props.onOpenChannel}
            />
          ))}
        </LazyVStack>
      )
    }

    content = (
      <VStack spacing={16} frame={{ maxWidth: "infinity" }}>
        {channelStrip}
        <ChipBar
          options={PROVIDER_FILTERS}
          value={providerFilter}
          onChange={(next: ProviderFilter) => {
            setProviderFilter(next)
            setSelectedChannelId(null)
          }}
          trailing={<LayoutToggle layout={layoutMode} onChange={setLayoutMode} />}
        />
        {selectedChannel ? (
          <SectionHeader
            title={selectedChannel.name}
            detail="頻道主頁"
            onDetail={() => handleOpenChannel(selectedChannel)}
          />
        ) : null}
        {feed}
      </VStack>
    )
  }

  return (
    <ScrollView
      axes="vertical"
      scrollIndicator="hidden"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      refreshable={subscriptions.length > 0 && !managing ? refreshAndWait : undefined}
    >
      <VStack spacing={4} frame={{ maxWidth: "infinity" }} padding={{ bottom: 16 }}>
        {header}
        {content}
      </VStack>
    </ScrollView>
  )
}
