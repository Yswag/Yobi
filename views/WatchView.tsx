import {
  EmptyView,
  GeometryReader,
  Picker,
  ScrollView,
  TabView,
  Text,
  VStack,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "scripting"
import type { GeometryProxy, ScrollGeometry, ScrollPhase, ScrollPhaseChangeContext, VirtualNode } from "scripting"
import type { Provider, UnifiedVideoItem, VideoCollaborator, VideoDetail } from "../types/index"
import { LiveChat } from "../components/LiveChat"
import { WatchActionBar, WatchInfoHeader } from "../components/watch/WatchInfoHeader"
import {
  WatchChaptersSection,
  WatchCommentsSection,
  WatchPagesSection,
  WatchRelatedList,
} from "../components/watch/WatchSections"
import {
  addToPlaylistFlow,
  copyVideoLink,
  isChannelGroupSubscribed,
  pickCollaborator,
  toggleChannelSubscription,
  toggleWatchLaterAction,
} from "../actions/index"
import type { PlayerStoreSnapshot } from "../state/playerStore"
import {
  getCommentsStoreSnapshot,
  loadMoreComments,
  openVideo,
  setProgressUpdatesPaused,
  usePlayerSelector,
} from "../state/playerStore"
import { isInWatchLater } from "../services/index"
import { SectionHeader } from "../ui/primitives"
import { motion, space } from "../ui/theme"
import { useToast } from "../ui/useToast"

export interface WatchViewProps {
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
  onOpenQualitySheet: () => void
  onOpenDanmakuSheet: () => void
}

const TAB_RELATED: number = 0
const TAB_COMMENTS: number = 1
const COMMENTS_AUTO_LOAD_PX: number = 600
const COMMENTS_DECEL_LOOKAHEAD_S: number = 0.4
const COMMENTS_MAX_LOOKAHEAD_PX: number = 900

export function WatchView(props: WatchViewProps): VirtualNode {
  const store = usePlayerSelector((s: PlayerStoreSnapshot) => ({
    currentItem: s.currentItem,
    detail: s.detail,
    delivery: s.manifest?.delivery ?? null,
    selectedQualityLabel: s.selectedQualityLabel,
    danmakuEnabled: s.danmakuEnabled,
    activeCid: s.activeCid,
    activePage: s.activePage,
  }))

  const [showDescription, setShowDescription] = useState(false)
  const [tab, setTab] = useState<number>(TAB_RELATED)
  const [watchLaterOn, setWatchLaterOn] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const toast = useToast()

  const item: UnifiedVideoItem | null = store.currentItem
  const detail: VideoDetail | null = store.detail
  const itemId: string = item?.id ?? ""
  useEffect(() => {
    setTab(TAB_RELATED)
  }, [itemId])
  useEffect((): (() => void) => {
    return (): void => setProgressUpdatesPaused(false)
  }, [itemId])
  const channelRawId: string = detail?.authorId || item?.authorId || ""
  const collaborators: VideoCollaborator[] = detail?.collaborators ?? []
  const isCollab: boolean = collaborators.length > 1

  const readSubscribed = (): boolean => {
    if (!item) return false
    return isChannelGroupSubscribed(item.provider, channelRawId, collaborators)
  }

  useEffect(() => {
    setSubscribed(readSubscribed())
  }, [detail?.collaborators?.length])

  useEffect(() => {
    if (!item) return
    setWatchLaterOn(isInWatchLater(item.id))
    setSubscribed(readSubscribed())
    setShowDescription(false)
  }, [item?.id, store.activeCid])

  const relatedVideosRef = useRef<UnifiedVideoItem[] | undefined>(detail?.relatedVideos)
  relatedVideosRef.current = detail?.relatedVideos
  const handleSelectRelated = useCallback((selected: UnifiedVideoItem): void => {
    void openVideo(selected, { queue: relatedVideosRef.current })
  }, [])

  if (!item) {
    return <EmptyView />
  }

  const related: UnifiedVideoItem[] = detail?.relatedVideos ?? []
  const deliveryTag: string | null = store.delivery ? store.delivery.toUpperCase() : null

  const handleWatchLater = (): void => {
    const result: { added: boolean; message: string } = toggleWatchLaterAction(item)
    setWatchLaterOn(result.added)
    toast.showToast(result.message)
  }

  const subscribeChannel = (rawId: string, name: string, avatarUrl?: string): void => {
    toggleChannelSubscription({ provider: item.provider, rawId, name, avatarUrl })
    setSubscribed(readSubscribed())
  }

  const handleToggleSubscription = (): void => {
    if (!isCollab) {
      subscribeChannel(channelRawId, detail?.authorName || item.authorName, detail?.authorAvatar || item.authorAvatar)
      return
    }
    void pickCollaborator(
      collaborators,
      "訂閱頻道",
      (channel: VideoCollaborator) =>
        `${isChannelGroupSubscribed(item.provider, channel.id, []) ? "取消訂閱" : "訂閱"} ${channel.name}`,
    ).then((channel: VideoCollaborator | null) => {
      if (channel) subscribeChannel(channel.id, channel.name, channel.avatarUrl)
    })
  }

  const openChannel = (): void => {
    if (!isCollab) {
      props.onOpenChannel?.(item.provider, channelRawId, detail?.authorName || item.authorName, detail?.authorAvatar || item.authorAvatar)
      return
    }
    void pickCollaborator(collaborators, "前往頻道", (channel: VideoCollaborator) => channel.name).then((channel: VideoCollaborator | null) => {
      if (channel) props.onOpenChannel?.(item.provider, channel.id, channel.name, channel.avatarUrl)
    })
  }

  const handleAddToPlaylist = (): void => {
    void addToPlaylistFlow(item)
  }

  const handleShare = (): void => {
    void copyVideoLink(item).then((message: string) => toast.showToast(message))
  }

  const handleScrollPhase = (next: ScrollPhase): void => {
    setProgressUpdatesPaused(String(next) !== "idle")
  }

  const handleCommentsPhase = (
    _old: ScrollPhase,
    next: ScrollPhase,
    context: ScrollPhaseChangeContext,
  ): void => {
    handleScrollPhase(next)
    const phase: string = String(next)
    if (phase !== "idle" && phase !== "decelerating") return
    const geometry: ScrollGeometry = context.geometry
    if (geometry.containerSize.height <= 0) return
    const commentsSnap = getCommentsStoreSnapshot()
    if (commentsSnap.cursor === null) return
    if (commentsSnap.loading || commentsSnap.loadingMore) return
    const velocityY: number = phase === "decelerating" && context.velocity ? Math.max(0, context.velocity.dy) : 0
    const lookahead: number = Math.min(velocityY * COMMENTS_DECEL_LOOKAHEAD_S, COMMENTS_MAX_LOOKAHEAD_PX)
    const remaining: number = geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height
    if (remaining - lookahead > COMMENTS_AUTO_LOAD_PX) return
    void loadMoreComments()
  }

  const pagesSection: VirtualNode | null = detail?.pages && detail.pages.length > 1
    ? (
      <WatchPagesSection
        pages={detail.pages}
        activeCid={store.activeCid}
        activePage={store.activePage}
      />
    )
    : null

  const chaptersSection: VirtualNode | null = detail?.chapters && detail.chapters.length > 0
    ? <WatchChaptersSection chapters={detail.chapters} />
    : null

  return (
    <VStack
      spacing={0}
      frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}
      toast={{ ...toast.toastProps, position: "bottom" }}
    >
      <VStack
        spacing={0}
        frame={{ maxWidth: "infinity" }}
        padding={{ horizontal: space.page, top: 6, bottom: 6 }}
        background="systemBackground"
      >
        <Picker
          title="內容"
          value={tab}
          onChanged={(next: number) => withAnimation(motion.move, () => setTab(next))}
          pickerStyle="segmented"
          frame={{ maxWidth: "infinity", height: 32 }}
        >
          <Text tag={TAB_RELATED}>詳情</Text>
          <Text tag={TAB_COMMENTS}>{item.isLive ? "聊天室" : "留言"}</Text>
        </Picker>
      </VStack>
      <GeometryReader>
        {(proxy: GeometryProxy) => (
          <TabView
            key={`pager-${itemId}`}
            tabIndex={tab}
            onTabIndexChanged={setTab}
            tabViewStyle="pageNeverDisplayIndex"
            frame={{ width: proxy.size.width, height: proxy.size.height }}
          >
            <ScrollView
              axes="vertical"
              scrollIndicator="hidden"
              tag={TAB_RELATED}
              frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}
              onScrollPhaseChange={(_old: ScrollPhase, next: ScrollPhase): void => handleScrollPhase(next)}
            >
              <VStack spacing={20} frame={{ maxWidth: "infinity" }} padding={{ top: 10, bottom: 24 }}>
                <WatchInfoHeader
                  item={item}
                  detail={detail}
                  showDescription={showDescription}
                  subscribed={subscribed}
                  deliveryTag={deliveryTag}
                  onToggleDescription={() => setShowDescription(!showDescription)}
                  onOpenChannel={openChannel}
                  onToggleSubscription={handleToggleSubscription}
                />
                <WatchActionBar
                  item={item}
                  watchLaterOn={watchLaterOn}
                  qualityLabel={store.selectedQualityLabel || "畫質"}
                  danmakuEnabled={store.danmakuEnabled}
                  onWatchLater={handleWatchLater}
                  onAddToPlaylist={handleAddToPlaylist}
                  onOpenQualitySheet={props.onOpenQualitySheet}
                  onOpenDanmakuSheet={props.onOpenDanmakuSheet}
                  onShare={handleShare}
                />
                {pagesSection}
                {chaptersSection}
                <VStack spacing={10} frame={{ maxWidth: "infinity" }}>
                  <SectionHeader title="相關影片" />
                  <WatchRelatedList
                    related={related}
                    onSelect={handleSelectRelated}
                    onOpenChannel={props.onOpenChannel}
                  />
                </VStack>
              </VStack>
            </ScrollView>
            {item.isLive ? (
              <VStack tag={TAB_COMMENTS} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}>
                <LiveChat videoId={item.rawId} />
              </VStack>
            ) : (
              <ScrollView
                axes="vertical"
                scrollIndicator="hidden"
                tag={TAB_COMMENTS}
                frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}
                onScrollPhaseChange={handleCommentsPhase}
              >
                <VStack spacing={0} frame={{ maxWidth: "infinity" }} padding={{ top: 10, bottom: 24 }}>
                  <WatchCommentsSection />
                </VStack>
              </ScrollView>
            )}
          </TabView>
        )}
      </GeometryReader>
    </VStack>
  )
}
