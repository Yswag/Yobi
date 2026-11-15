import {
  Button,
  HStack,
  Image,
  ProgressView,
  ScrollView,
  Spacer,
  Text,
  VStack,
  ZStack,
  useEffect,
  useState,
} from "scripting"
import type { Color, VirtualNode } from "scripting"
import type { ChannelDetail, Provider, SubscriptionChannel, UnifiedVideoItem } from "../types"
import { VideoCard } from "../components/VideoCard"
import {
  getChannel,
  getSavedPosition,
  getSubscriptions,
  subscribeStorageChanges,
  toggleSubscription,
} from "../services"
import {
  providerAccentColor,
  providerBadgeLabel,
  providerFullName,
} from "../utils/format"
import { openVideo } from "../state/playerStore"

export interface SubscriptionsViewProps {
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
  onOpenSearch?: () => void
}

type ProviderFilter = "all" | Provider
type LayoutMode = "row" | "grid"

const LINK_BLUE: Color = "rgba(10,132,255,1)"
const STRIP_AVATAR_SIZE: number = 52
const STRIP_ITEM_WIDTH: number = 64

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
  label: string
  selected: boolean
  onTap: () => void
}): VirtualNode {
  const channel: SubscriptionChannel | null = props.channel
  const ringColor: Color = channel ? providerAccentColor(channel.provider) : LINK_BLUE

  return (
    <VStack spacing={5} frame={{ width: STRIP_ITEM_WIDTH }} onTapGesture={props.onTap}>
      <ZStack
        frame={{ width: STRIP_AVATAR_SIZE + 6, height: STRIP_AVATAR_SIZE + 6 }}
        background={props.selected ? ringColor : "tertiarySystemFill"}
        clipShape="circle"
      >
        {channel
          ? (
            <ZStack frame={{ width: STRIP_AVATAR_SIZE, height: STRIP_AVATAR_SIZE }}>
              <AvatarCircle
                provider={channel.provider}
                name={channel.name}
                avatarUrl={channel.avatarUrl || undefined}
                size={STRIP_AVATAR_SIZE}
              />
              <VStack
                spacing={0}
                frame={{ width: STRIP_AVATAR_SIZE, height: STRIP_AVATAR_SIZE }}
                padding={1}
                allowsHitTesting={false}
              >
                <Spacer />
                <HStack spacing={0} frame={{ maxWidth: "infinity" }}>
                  <Spacer />
                  <Text
                    font={7}
                    fontWeight="bold"
                    foregroundStyle="white"
                    padding={{ horizontal: 3, vertical: 1 }}
                    background={providerAccentColor(channel.provider)}
                    clipShape="capsule"
                  >
                    {providerBadgeLabel(channel.provider)}
                  </Text>
                </HStack>
              </VStack>
            </ZStack>
          )
          : (
            <VStack
              frame={{ width: STRIP_AVATAR_SIZE, height: STRIP_AVATAR_SIZE }}
              background="secondarySystemBackground"
              clipShape="circle"
            >
              <Image systemName="person.2.fill" font={20} foregroundStyle="secondaryLabel" />
            </VStack>
          )}
      </ZStack>
      <Text font="caption2" foregroundStyle="secondaryLabel" lineLimit={1}>{props.label}</Text>
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
    <HStack spacing={10} padding={{ horizontal: 12, vertical: 10 }} frame={{ maxWidth: "infinity" }}>
      <AvatarCircle
        provider={channel.provider}
        name={channel.name}
        avatarUrl={channel.avatarUrl || undefined}
        size={40}
      />
      <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={14} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>{channel.name}</Text>
        <Text
          font={9}
          fontWeight="bold"
          foregroundStyle="white"
          padding={{ horizontal: 5, vertical: 2 }}
          background={providerAccentColor(channel.provider)}
          clipShape={{ type: "rect", cornerRadius: 4 }}
        >
          {providerFullName(channel.provider)}
        </Text>
      </VStack>

      <HStack spacing={6}>
        <Chip label="進入頻道" active={false} activeColor={LINK_BLUE} onTap={props.onOpen} />
        <Chip
          label="取消訂閱"
          icon="minus.circle"
          active
          activeColor="rgba(255,59,48,1)"
          onTap={props.onUnsubscribe}
        />
      </HStack>
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
      return
    }
    // 快取只用來避免切換篩選時重複請求，強制重抓由 refresh() 清空快取觸發。
    const missing: SubscriptionChannel[] = activeChannels.filter(
      (ch: SubscriptionChannel): boolean => !cache[ch.id] && !failedIds[ch.id],
    )
    if (missing.length === 0) {
      setLoading(false)
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
      })
      .catch(() => {
        if (cancelled) return
        setErrorText("訂閱動態載入失敗，請確認網路後重試")
        setLoading(false)
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

  const handleSelect = (item: UnifiedVideoItem): void => {
    void openVideo(item, { queue: displayedVideos })
  }

  const handleOpenChannel = (channel: SubscriptionChannel): void => {
    props.onOpenChannel?.(channel.provider, channel.rawId, channel.name, channel.avatarUrl || undefined)
  }

  const header: VirtualNode = (
    <VStack spacing={10} padding={{ horizontal: 12, vertical: 10 }} frame={{ maxWidth: "infinity" }}>
      <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
        <HStack spacing={7}>
          <Text font="title2" fontWeight="bold" foregroundStyle="label">訂閱動態</Text>
          <Text
            font={11}
            fontWeight="semibold"
            foregroundStyle="white"
            padding={{ horizontal: 7, vertical: 2 }}
            background={providerAccentColor("yt")}
            clipShape="capsule"
          >
            {subscriptions.length}
          </Text>
        </HStack>

        <Spacer />

        <HStack spacing={8}>
          <Chip
            label={managing ? "完成" : "管理"}
            icon={managing ? "checkmark" : "slider.horizontal.3"}
            active={managing}
            activeColor={LINK_BLUE}
            onTap={() => setManaging(!managing)}
          />
          <CircleIconButton icon="arrow.clockwise" size={30} onTap={refresh} />
          <CircleIconButton
            icon={layoutMode === "row" ? "rectangle.grid.1x2" : "list.bullet"}
            size={30}
            onTap={() => setLayoutMode(layoutMode === "row" ? "grid" : "row")}
          />
        </HStack>
      </HStack>

      <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
        <Chip
          label="全部"
          active={providerFilter === "all"}
          activeColor={LINK_BLUE}
          onTap={() => setProviderFilter("all")}
        />
        <Chip
          label="YouTube"
          active={providerFilter === "yt"}
          activeColor={providerAccentColor("yt")}
          onTap={() => setProviderFilter("yt")}
        />
        <Chip
          label="BiliBili"
          active={providerFilter === "bili"}
          activeColor={providerAccentColor("bili")}
          onTap={() => setProviderFilter("bili")}
        />
        <Spacer />
      </HStack>
    </VStack>
  )

  const channelStrip: VirtualNode | null = providerChannels.length === 0
    ? null
    : (
      <VStack spacing={6} frame={{ maxWidth: "infinity" }} alignment="leading">
        <ScrollView axes="horizontal" scrollIndicator="hidden">
          <HStack spacing={12} padding={{ horizontal: 12 }}>
            <ChannelStripItem
              channel={null}
              label="全部"
              selected={selectedChannelId === null}
              onTap={() => setSelectedChannelId(null)}
            />
            {providerChannels.map((ch: SubscriptionChannel) => (
              <ChannelStripItem
                key={ch.id}
                channel={ch}
                label={ch.name}
                selected={selectedChannelId === ch.id}
                onTap={() => setSelectedChannelId(selectedChannelId === ch.id ? null : ch.id)}
              />
            ))}
          </HStack>
        </ScrollView>
      </VStack>
    )

  const selectedBanner: VirtualNode | null = selectedChannel
    ? (
      <HStack
        spacing={6}
        padding={{ horizontal: 14, vertical: 10 }}
        background={providerAccentColor(selectedChannel.provider)}
        clipShape={{ type: "rect", cornerRadius: 12 }}
        frame={{ maxWidth: "infinity" }}
        onTapGesture={() => handleOpenChannel(selectedChannel)}
      >
        <Image systemName="person.crop.circle" font={13} foregroundStyle="white" />
        <Text font={13} fontWeight="semibold" foregroundStyle="white" lineLimit={1}>
          {`查看「${selectedChannel.name}」頻道主頁`}
        </Text>
        <Spacer />
        <Image systemName="chevron.right" font={12} foregroundStyle="white" />
      </HStack>
    )
    : null

  const emptyCard: VirtualNode = (
    <VStack
      spacing={12}
      padding={24}
      frame={{ maxWidth: "infinity" }}
      background="secondarySystemGroupedBackground"
      clipShape={{ type: "rect", cornerRadius: 18 }}
    >
      <Image systemName="rectangle.stack.person.crop" font={38} foregroundStyle="tertiaryLabel" />
      <Text font="headline" fontWeight="semibold" foregroundStyle="label">尚無本機訂閱頻道</Text>
      <Text font="footnote" foregroundStyle="secondaryLabel" multilineTextAlignment="center">
        不需登入帳號即可跨平台訂閱 YouTube 與 BiliBili 創作者
      </Text>
      {props.onOpenSearch
        ? (
          <Button
            title="前往搜尋頻道或影片"
            systemImage="magnifyingglass"
            action={() => props.onOpenSearch?.()}
            buttonStyle="borderedProminent"
            controlSize="regular"
            tint={LINK_BLUE}
          />
        )
        : null}
    </VStack>
  )

  const manageList: VirtualNode = (
    <VStack
      spacing={0}
      frame={{ maxWidth: "infinity" }}
      background="secondarySystemGroupedBackground"
      clipShape={{ type: "rect", cornerRadius: 16 }}
    >
      {subscriptions.length === 0
        ? (
          <Text font={13} foregroundStyle="secondaryLabel" padding={16}>
            目前沒有已訂閱的頻道
          </Text>
        )
        : subscriptions.map((ch: SubscriptionChannel, index: number) => (
          <VStack key={ch.id} spacing={0} frame={{ maxWidth: "infinity" }}>
            {index > 0
              ? (
                <HStack
                  spacing={0}
                  frame={{ maxWidth: "infinity", height: 0.5 }}
                  background="separator"
                />
              )
              : null}
            <ManageRow
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
          </VStack>
        ))}
    </VStack>
  )

  let content: VirtualNode
  if (subscriptions.length === 0) {
    content = emptyCard
  } else if (managing) {
    content = manageList
  } else if (loading && displayedVideos.length === 0) {
    content = (
      <VStack spacing={10} frame={{ maxWidth: "infinity", minHeight: 200 }}>
        <ProgressView />
        <Text font={13} foregroundStyle="secondaryLabel">正在彙整訂閱動態…</Text>
      </VStack>
    )
  } else if (errorText && displayedVideos.length === 0) {
    content = (
      <VStack spacing={12} frame={{ maxWidth: "infinity", minHeight: 200 }}>
        <Image systemName="wifi.exclamationmark" font={30} foregroundStyle="tertiaryLabel" />
        <Text font={13} foregroundStyle="secondaryLabel">{errorText}</Text>
        <Button
          title="重試"
          action={refresh}
          buttonStyle="borderedProminent"
          controlSize="small"
          tint={LINK_BLUE}
        />
      </VStack>
    )
  } else if (displayedVideos.length === 0) {
    content = (
      <VStack spacing={10} frame={{ maxWidth: "infinity", minHeight: 200 }}>
        <Image systemName="tray" font={30} foregroundStyle="tertiaryLabel" />
        <Text font={13} foregroundStyle="secondaryLabel">
          {activeChannels.length === 0 ? "此平台尚無已訂閱頻道" : "訂閱頻道目前沒有新影片"}
        </Text>
      </VStack>
    )
  } else {
    content = (
      <VStack spacing={layoutMode === "grid" ? 18 : 0} frame={{ maxWidth: "infinity" }}>
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
      </VStack>
    )
  }

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      {header}
      <ScrollView
        axes="vertical"
        scrollIndicator="automatic"
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      >
        <VStack spacing={12} alignment="leading" frame={{ maxWidth: "infinity" }} padding={{ top: 4 }}>
          {channelStrip}
          {selectedBanner
            ? (
              <VStack padding={{ horizontal: 12 }} frame={{ maxWidth: "infinity" }}>
                {selectedBanner}
              </VStack>
            )
            : null}
          <VStack
            spacing={0}
            frame={{ maxWidth: "infinity" }}
            padding={{ horizontal: layoutMode === "grid" ? 12 : 0 }}
          >
            {content}
          </VStack>
          <Spacer frame={{ height: 96 }} />
        </VStack>
      </ScrollView>
    </VStack>
  )
}
