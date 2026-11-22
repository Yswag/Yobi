import {
  HStack,
  LazyVStack,
  ScrollView,
  VStack,
  useEffect,
  useRef,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { ChannelDetail, LayoutMode, OpenChannel, ProviderFilter, SubscriptionChannel, UnifiedVideoItem } from "../types/index"
import { VideoCard, VideoCardSkeleton } from "../components/VideoCard"
import {
  ChannelStripItem,
  ManageRow,
  buildTimeline,
} from "../components/subscriptions/SubscriptionParts"
import {
  getChannel,
  getSavedPosition,
  getSubscriptions,
  subscribeStorageChanges,
} from "../services/index"
import { toggleChannelSubscription } from "../actions/index"
import { openVideo } from "../state/playerStore"
import {
  ChipBar,
  EmptyState,
  GlassIconButton,
  LayoutToggle,
  PageHeader,
  PROVIDER_FILTERS,
  SectionHeader,
} from "../ui/primitives"
import { palette, space } from "../ui/theme"

export interface SubscriptionsViewProps {
  onOpenChannel?: OpenChannel
  onOpenSearch?: () => void
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
    }, ["subscriptions"])
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
    Promise.allSettled(missing.map((ch: SubscriptionChannel) => getChannel(ch.provider, ch.rawId, { withAbout: false })))
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
              toggleChannelSubscription({
                provider: ch.provider,
                rawId: ch.rawId,
                name: ch.name,
                avatarUrl: ch.avatarUrl,
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
