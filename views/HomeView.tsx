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
import type { Provider, UnifiedVideoItem, WatchHistoryEntry } from "../types"
import { VideoCard, VideoCardSkeleton } from "../components/VideoCard"
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
import { markZoomSource } from "../ui/zoom"

export interface HomeViewProps {
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
  onOpenSettings?: () => void
}

type LayoutMode = "grid" | "row"

const CONTINUE_CARD_WIDTH: number = 220

function ContinueCard(props: { entry: WatchHistoryEntry; onSelect: () => void }): VirtualNode {
  const entry: WatchHistoryEntry = props.entry
  const total: number = entry.duration || entry.item.duration || 0
  const ratio: number = total > 0 ? entry.position / total : 0
  const remaining: number = Math.max(0, total - entry.position)
  const zoomID: string = `continue:${entry.item.id}-${entry.cid ?? entry.page ?? 0}`

  return (
    <VStack
      alignment="leading"
      spacing={8}
      frame={{ width: CONTINUE_CARD_WIDTH }}
      contentShape="rect"
      onTapGesture={() => {
        markZoomSource(zoomID)
        props.onSelect()
      }}
    >
      <Thumbnail
        url={entry.item.thumbnailUrl}
        zoomID={zoomID}
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
  const [history, setHistory] = useState<WatchHistoryEntry[]>(() => getWatchHistory())
  const requestSeq = useRef<number>(0)

  const loadFeed = async (target: FeedFilter): Promise<void> => {
    const seq: number = ++requestSeq.current
    setLoading(true)
    setErrorText(null)
    try {
      const list: UnifiedVideoItem[] = await getHomeFeed(target)
      if (seq !== requestSeq.current) return
      setItems(list)
    } catch {
      if (seq !== requestSeq.current) return
      setItems([])
      setErrorText("載入失敗，請檢查網路連線")
    }
    if (seq === requestSeq.current) setLoading(false)
  }

  useEffect(() => {
    void loadFeed(filter)
  }, [filter])

  useEffect(() => {
    setHistory(getWatchHistory())
    return subscribeStorageChanges(() => {
      setHistory(getWatchHistory())
    })
  }, [])

  const continueEntries: WatchHistoryEntry[] = history
    .filter((entry: WatchHistoryEntry): boolean => entry.position > 5)
    .slice(0, 8)

  const handleSelect = (item: UnifiedVideoItem): void => {
    void openVideo(item, { queue: items })
  }

  const handleOpenChannel = (provider: Provider, authorId: string, authorName: string, avatarUrl?: string): void => {
    props.onOpenChannel?.(provider, authorId, authorName, avatarUrl)
  }

  const header: VirtualNode = (
    <PageHeader
      title="Yobi"
      trailing={
        <HStack spacing={10}>
          <GlassIconButton icon="link" onTap={() => void openLinkFlow()} />
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
        <SectionHeader title="繼續觀看" detail={`${continueEntries.length} 部`} />
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
      </LazyVStack>
    )
  }

  return (
    <ScrollView
      axes="vertical"
      scrollIndicator="hidden"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      refreshable={() => loadFeed(filter)}
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
        </VStack>
      </VStack>
    </ScrollView>
  )
}
