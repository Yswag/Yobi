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
import type { Provider, UnifiedVideoItem, WatchHistoryEntry } from "../types"
import { VideoCard } from "../components/VideoCard"
import type { DetectedInputLink, FeedFilter } from "../services"
import {
  detectInputLink,
  getHomeFeed,
  getSavedPosition,
  getWatchHistory,
  resolveBiliShortUrl,
  subscribeStorageChanges,
} from "../services"
import { formatDuration, providerFullName } from "../utils/format"
import { openVideo } from "../state/playerStore"

export interface HomeViewProps {
  onOpenSearch?: () => void
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
  onExitApp?: () => void
}

type LayoutMode = "grid" | "row"

const LINK_BLUE: Color = "rgba(10,132,255,1)"
const YT_RED: Color = "rgba(255,46,77,1)"
const BILI_PINK: Color = "rgba(251,114,153,1)"
const CONTINUE_CARD_WIDTH: number = 180
const CONTINUE_THUMB_HEIGHT: number = 101

function accentColor(provider: Provider): Color {
  return provider === "bili" ? BILI_PINK : YT_RED
}

function FilterChip(props: {
  label: string
  active: boolean
  activeColor: Color
  onTap: () => void
}): VirtualNode {
  return (
    <HStack
      spacing={0}
      padding={{ horizontal: 13, vertical: 6 }}
      background={props.active ? props.activeColor : "tertiarySystemFill"}
      clipShape="capsule"
      onTapGesture={props.onTap}
    >
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

function platformBadge(provider: Provider): VirtualNode {
  return (
    <Text
      font={9}
      fontWeight="bold"
      foregroundStyle="white"
      padding={{ horizontal: 5, vertical: 2 }}
      background={accentColor(provider)}
      clipShape={{ type: "rect", cornerRadius: 4 }}
    >
      {provider === "bili" ? "BILI" : "YT"}
    </Text>
  )
}

function ContinueCard(props: { entry: WatchHistoryEntry; onSelect: () => void }): VirtualNode {
  const entry: WatchHistoryEntry = props.entry
  const total: number = entry.duration || entry.item.duration || 0
  const ratio: number = total > 0 ? Math.min(1, Math.max(0, entry.position / total)) : 0

  return (
    <VStack spacing={5} frame={{ width: CONTINUE_CARD_WIDTH }}>
      <ZStack
        frame={{ width: CONTINUE_CARD_WIDTH, height: CONTINUE_THUMB_HEIGHT }}
        background="#1c1c1e"
        clipShape={{ type: "rect", cornerRadius: 10 }}
        clipped
        onTapGesture={props.onSelect}
      >
        {entry.item.thumbnailUrl
          ? (
            <Image
              imageUrl={entry.item.thumbnailUrl}
              resizable
              scaleToFill
              frame={{ width: CONTINUE_CARD_WIDTH, height: CONTINUE_THUMB_HEIGHT }}
            />
          )
          : (
            <VStack
              frame={{ width: CONTINUE_CARD_WIDTH, height: CONTINUE_THUMB_HEIGHT }}
              background="#1c1c1e"
            >
              <Image systemName="play.rectangle.fill" font={24} foregroundStyle="rgba(255,255,255,0.55)" />
            </VStack>
          )}

        <VStack
          spacing={0}
          frame={{ width: CONTINUE_CARD_WIDTH, height: CONTINUE_THUMB_HEIGHT }}
          padding={6}
          allowsHitTesting={false}
        >
          <HStack spacing={0} frame={{ maxWidth: "infinity" }}>
            {platformBadge(entry.item.provider)}
            <Spacer />
          </HStack>
          <Spacer />
          <HStack spacing={0} frame={{ maxWidth: "infinity" }}>
            <Spacer />
            <Text
              font={9}
              monospaced
              foregroundStyle="white"
              padding={{ horizontal: 4, vertical: 2 }}
              background="rgba(0,0,0,0.75)"
              clipShape={{ type: "rect", cornerRadius: 3 }}
            >
              {`${formatDuration(entry.position)} / ${formatDuration(total)}`}
            </Text>
          </HStack>
        </VStack>

        <VStack
          spacing={0}
          frame={{ width: CONTINUE_CARD_WIDTH, height: CONTINUE_THUMB_HEIGHT }}
          allowsHitTesting={false}
        >
          <Spacer />
          <HStack spacing={0} frame={{ width: CONTINUE_CARD_WIDTH, height: 3 }} background="rgba(255,255,255,0.28)">
            <HStack
              spacing={0}
              frame={{ width: CONTINUE_CARD_WIDTH * ratio, height: 3 }}
              background={accentColor(entry.item.provider)}
            />
          </HStack>
        </VStack>
      </ZStack>

      <Text font={12} fontWeight="medium" foregroundStyle="label" lineLimit={1}>
        {entry.item.title}
      </Text>
      <Text font={11} foregroundStyle="secondaryLabel" lineLimit={1}>
        {entry.item.authorName}
      </Text>
    </VStack>
  )
}

async function detectAnyInput(input: string): Promise<DetectedInputLink | null> {
  const trimmed: string = (input ?? "").trim()
  if (!trimmed) return null

  const direct: DetectedInputLink | null = detectInputLink(trimmed)
  if (direct) return direct

  if (trimmed.includes("b23.tv")) {
    const resolved: { bvid?: string; aid?: number } | null = await resolveBiliShortUrl(trimmed)
    if (resolved?.bvid) return detectInputLink(resolved.bvid)
    if (resolved?.aid) return detectInputLink(`av${resolved.aid}`)
  }
  return null
}

async function openLinkFlow(): Promise<void> {
  const clipboard: string = (await Pasteboard.getString()) ?? ""
  let detected: DetectedInputLink | null = await detectAnyInput(clipboard)

  if (!detected) {
    const input: string | null = await Dialog.prompt({
      title: "開啟連結",
      message: "貼上 YouTube 連結或 BiliBili BV / AV 番號",
      defaultValue: clipboard,
      placeholder: "https://... 或 BV1xx411c7mD",
      confirmLabel: "開啟",
    })
    if (input === null) return
    detected = await detectAnyInput(input)
  }

  if (!detected) {
    await Dialog.alert({
      title: "無法辨識連結",
      message: "請輸入 YouTube 影片連結或 BiliBili BV / AV 番號。",
    })
    return
  }

  const link: DetectedInputLink = detected
  const tempItem: UnifiedVideoItem = {
    id: `${link.provider}:${link.rawId}`,
    provider: link.provider,
    rawId: link.rawId,
    title: link.rawId,
    thumbnailUrl: "",
    duration: 0,
    authorId: "",
    authorName: providerFullName(link.provider),
  }
  void openVideo(tempItem)
}

export function HomeView(props: HomeViewProps): VirtualNode {
  const [filter, setFilter] = useState<FeedFilter>("all")
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("grid")
  const [items, setItems] = useState<UnifiedVideoItem[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [refreshSeq, setRefreshSeq] = useState<number>(0)
  const [history, setHistory] = useState<WatchHistoryEntry[]>(() => getWatchHistory())

  useEffect(() => {
    let cancelled: boolean = false
    setLoading(true)
    setErrorText(null)
    getHomeFeed(filter)
      .then((list: UnifiedVideoItem[]) => {
        if (cancelled) return
        setItems(list)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setItems([])
        setErrorText("載入失敗，請檢查網路連線")
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [filter, refreshSeq])

  useEffect(() => {
    setHistory(getWatchHistory())
    return subscribeStorageChanges(() => {
      setHistory(getWatchHistory())
    })
  }, [])

  const continueEntries: WatchHistoryEntry[] = history
    .filter((entry: WatchHistoryEntry): boolean => entry.position > 5)
    .slice(0, 8)

  const reload = (): void => {
    setRefreshSeq((seq: number): number => seq + 1)
  }

  const handleSelect = (item: UnifiedVideoItem): void => {
    void openVideo(item, { queue: items })
  }

  const handleOpenChannel = (provider: Provider, authorId: string, authorName: string, avatarUrl?: string): void => {
    props.onOpenChannel?.(provider, authorId, authorName, avatarUrl)
  }

  const header: VirtualNode = (
    <VStack spacing={10} padding={{ horizontal: 12, vertical: 10 }}>
      <HStack spacing={10} frame={{ maxWidth: "infinity" }}>
        <HStack spacing={8}>
          <ZStack
            frame={{ width: 28, height: 28 }}
            background={YT_RED}
            clipShape={{ type: "rect", cornerRadius: 8 }}
          >
            <Image systemName="play.rectangle.fill" font={15} foregroundStyle="white" />
          </ZStack>
          <Text font={20} fontWeight="bold" foregroundStyle="label">Yobi</Text>
        </HStack>

        <Spacer />

        <HStack spacing={8}>
          <HStack
            spacing={5}
            padding={{ horizontal: 10, vertical: 6 }}
            background="tertiarySystemFill"
            clipShape="capsule"
            onTapGesture={() => {
              void openLinkFlow()
            }}
          >
            <Image systemName="link.badge.plus" font={12} foregroundStyle="secondaryLabel" />
            <Text font={12} fontWeight="medium" foregroundStyle="label" lineLimit={1}>開啟連結</Text>
          </HStack>
          <CircleIconButton
            icon="magnifyingglass"
            size={32}
            onTap={() => props.onOpenSearch?.()}
          />
          {props.onExitApp ? (
            <CircleIconButton
              icon="xmark"
              size={32}
              onTap={() => props.onExitApp?.()}
            />
          ) : null}
        </HStack>
      </HStack>

      <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
        <HStack spacing={6}>
          <FilterChip
            label="全部"
            active={filter === "all"}
            activeColor={LINK_BLUE}
            onTap={() => setFilter("all")}
          />
          <FilterChip
            label="YouTube"
            active={filter === "yt"}
            activeColor={YT_RED}
            onTap={() => setFilter("yt")}
          />
          <FilterChip
            label="BiliBili"
            active={filter === "bili"}
            activeColor={BILI_PINK}
            onTap={() => setFilter("bili")}
          />
        </HStack>

        <Spacer />

        <HStack spacing={8}>
          <CircleIconButton
            icon={layoutMode === "grid" ? "rectangle.grid.1x2" : "list.bullet"}
            size={30}
            onTap={() => setLayoutMode(layoutMode === "grid" ? "row" : "grid")}
          />
          <CircleIconButton icon="arrow.clockwise" size={30} onTap={reload} />
        </HStack>
      </HStack>
    </VStack>
  )

  const continueSection: VirtualNode | null = continueEntries.length > 0
    ? (
      <VStack spacing={8} alignment="leading" frame={{ maxWidth: "infinity" }}>
        <HStack spacing={6} padding={{ horizontal: 14 }}>
          <Text font={15} fontWeight="semibold" foregroundStyle="label">繼續觀看</Text>
          <Spacer />
          <Text font={11} foregroundStyle="secondaryLabel">{`${continueEntries.length} 部`}</Text>
        </HStack>
        <ScrollView axes="horizontal" scrollIndicator="hidden">
          <HStack spacing={10} padding={{ horizontal: 14 }}>
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
    feedContent = (
      <VStack spacing={10} frame={{ maxWidth: "infinity", minHeight: 220 }}>
        <ProgressView />
        <Text font={13} foregroundStyle="secondaryLabel">正在載入跨平台熱門影片...</Text>
      </VStack>
    )
  } else if (!loading && items.length === 0) {
    feedContent = (
      <VStack spacing={10} frame={{ maxWidth: "infinity", minHeight: 220 }}>
        <Image
          systemName={errorText ? "wifi.exclamationmark" : "tray"}
          font={30}
          foregroundStyle="tertiaryLabel"
        />
        <Text font={13} foregroundStyle="secondaryLabel">
          {errorText ?? "目前沒有推薦影片"}
        </Text>
        <Button
          title="重試"
          action={reload}
          buttonStyle="borderedProminent"
          controlSize="small"
          tint={LINK_BLUE}
        />
      </VStack>
    )
  } else {
    feedContent = (
      <VStack spacing={layoutMode === "grid" ? 18 : 0} frame={{ maxWidth: "infinity" }}>
        {items.map((item: UnifiedVideoItem) => (
          <VideoCard
            key={item.id}
            item={item}
            layout={layoutMode}
            progressSeconds={getSavedPosition(item.id, item.cid)}
            onSelect={handleSelect}
            onOpenChannel={handleOpenChannel}
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
        <VStack spacing={14} alignment="leading" frame={{ maxWidth: "infinity" }} padding={{ top: 4 }}>
          {continueSection}
          <VStack spacing={0} frame={{ maxWidth: "infinity" }} padding={{ horizontal: layoutMode === "grid" ? 12 : 0 }}>
            {feedContent}
          </VStack>
          <Spacer frame={{ height: 96 }} />
        </VStack>
      </ScrollView>
    </VStack>
  )
}
