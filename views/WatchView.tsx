import {
  EmptyView,
  GeometryReader,
  HStack,
  Image,
  LazyVStack,
  Picker,
  Rectangle,
  ScrollView,
  TabView,
  Text,
  VStack,
  useEffect,
  useRef,
  useState,
} from "scripting"
import type { GeometryProxy, ScrollGeometry, ScrollPhase, ScrollPhaseChangeContext, VirtualNode } from "scripting"
import type { Provider, UnifiedVideoItem, VideoChapter, VideoCollaborator, VideoPagePart } from "../types"
import { CommentsSheet } from "../components/CommentsSheet"
import { addToPlaylistFlow, VideoCard } from "../components/VideoCard"
import {
  downloadVideo,
  findDownload,
  isInWatchLater,
  isSubscribed,
  removeDownload,
  toggleSubscription,
  toggleWatchLater,
} from "../services"
import {
  formatCount,
  formatDuration,
  getVideoShareUrl,
  providerFullName,
} from "../utils/format"
import {
  getPlayerProgressSnapshot,
  loadCommentReplies,
  loadMoreComments,
  openVideo,
  reloadComments,
  seekTo,
  selectPage,
  setCommentsSort,
  setProgressUpdatesPaused,
  subscribePlayerProgress,
  usePlayerStore,
} from "../state/playerStore"
import { Avatar, EmptyState, SectionHeader } from "../ui/primitives"
import { palette, providerColor, radius, space, type } from "../ui/theme"

// Everything below the video; PlayerHost owns the video surface and the sheets it opens.
export interface WatchViewProps {
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
  onOpenQualitySheet: () => void
  onOpenDanmakuSheet: () => void
}

const TAB_RELATED: number = 0
const TAB_COMMENTS: number = 1

const SEGMENT_CARD_WIDTH: number = 156
/** 卡片固定高度，一行與兩行標題的卡片才對齊（caption 約 13 + 間距 4 + 兩行標題 31 + 上下 20）。 */
const SEGMENT_CARD_HEIGHT: number = 70
/** 留言捲到剩這麼多高度就自動抓下一頁。 */
const COMMENTS_AUTO_LOAD_PX: number = 320

interface ScrollGeometrySnapshot {
  contentOffset: { x: number; y: number }
  contentSize: { width: number; height: number }
  containerSize: { width: number; height: number }
}

function ActionChip(props: { icon: string; label: string; active?: boolean; onTap: () => void }): VirtualNode {
  return (
    <HStack
      spacing={6}
      padding={{ horizontal: 14, vertical: 9 }}
      background={{ style: "tertiarySystemFill", shape: "capsule" }}
      contentShape="capsule"
      fixedSize
      onTapGesture={props.onTap}
    >
      <Image
        systemName={props.icon}
        font={14}
        fontWeight="semibold"
        foregroundStyle={props.active ? palette.brand : "label"}
        contentTransition="symbolEffectReplace"
      />
      <Text font={type.meta + 1} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>{props.label}</Text>
    </HStack>
  )
}

function SegmentCard(props: { caption: string; title: string; active: boolean; onTap: () => void }): VirtualNode {
  return (
    <VStack
      alignment="leading"
      spacing={4}
      padding={{ horizontal: 12, vertical: 10 }}
      frame={{ width: SEGMENT_CARD_WIDTH, height: SEGMENT_CARD_HEIGHT, alignment: "topLeading" }}
      background={{
        style: props.active ? palette.brandSoft : "tertiarySystemFill",
        shape: { type: "rect", cornerRadius: radius.md, style: "continuous" },
      }}
      contentShape="rect"
      onTapGesture={props.onTap}
    >
      <Text font={type.caption} monospacedDigit foregroundStyle={props.active ? palette.brand : "tertiaryLabel"} lineLimit={1}>
        {props.caption}
      </Text>
      <Text
        font={type.meta + 1}
        fontWeight={props.active ? "semibold" : "regular"}
        foregroundStyle="label"
        lineLimit={2}
        multilineTextAlignment="leading"
        frame={{ maxWidth: "infinity", alignment: "leading" }}
      >
        {props.title}
      </Text>
    </VStack>
  )
}

// 只有「換章節」才重繪。原本訂閱 progress 是每個 tick 都重建整排卡片，
// 那會讓正在捲動的頁面持續重排版，看起來一直在抖。
function useActiveChapterIndex(chapters: VideoChapter[]): number {
  const [index, setIndex] = useState<number>(-1)
  useEffect(() => {
    const apply = (): void => {
      const position: number = getPlayerProgressSnapshot().position
      const next: number = chapters.findIndex(
        (chapter: VideoChapter): boolean => position >= chapter.startTime && position < chapter.endTime,
      )
      setIndex((previous: number): number => (previous === next ? previous : next))
    }
    apply()
    return subscribePlayerProgress(apply)
  }, [chapters])
  return index
}

// 只有這塊跟著播放進度重繪，整頁不要訂閱 progress。
function ChaptersSection(props: { chapters: VideoChapter[] }): VirtualNode {
  const activeIndex: number = useActiveChapterIndex(props.chapters)
  return (
    <VStack alignment="leading" spacing={10}>
      <SectionHeader title="章節" />
      <ScrollView axes="horizontal" scrollIndicator="hidden">
        <HStack spacing={8} padding={{ horizontal: space.page }}>
          {props.chapters.map((chapter: VideoChapter, index: number) => (
            <SegmentCard
              key={`chapter-${index}-${chapter.startTime}`}
              caption={formatDuration(chapter.startTime)}
              title={chapter.title}
              active={index === activeIndex}
              onTap={() => void seekTo(chapter.startTime)}
            />
          ))}
        </HStack>
      </ScrollView>
    </VStack>
  )
}

export function WatchView(props: WatchViewProps): VirtualNode {
  const store = usePlayerStore()

  const [showDescription, setShowDescription] = useState(false)
  const [tab, setTab] = useState<number>(TAB_RELATED)
  const [watchLaterOn, setWatchLaterOn] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [offlineSaved, setOfflineSaved] = useState(false)
  const [offlineBusy, setOfflineBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const item: UnifiedVideoItem | null = store.currentItem
  const detail = store.detail
  const itemId: string = item?.id ?? ""
  // 這個元件跟著播放器常駐（PlayerHost 用 useMemo 包住），換片不會重建；
  // 所以自己把分頁與捲動位置收回頂部。
  useEffect(() => {
    setTab(TAB_RELATED)
  }, [itemId])
  // 換頁或關掉播放頁時把凍結解除，不然進度條會一直停住。
  useEffect((): (() => void) => {
    return (): void => setProgressUpdatesPaused(false)
  }, [itemId])
  const channelRawId: string = detail?.authorId || item?.authorId || ""
  const channelName: string = detail?.authorName || item?.authorName || ""
  const channelAvatar: string | undefined = detail?.authorAvatar || item?.authorAvatar
  const collaborators: VideoCollaborator[] = detail?.collaborators ?? []
  const isCollab: boolean = collaborators.length > 1

  // 合作影片要每個頻道都訂了才算「已訂閱」。
  const readSubscribed = (): boolean => {
    if (!item) return false
    if (isCollab) {
      return collaborators.every((channel: VideoCollaborator): boolean => isSubscribed(`${item.provider}:${channel.id}`))
    }
    return isSubscribed(`${item.provider}:${channelRawId}`)
  }

  useEffect(() => {
    setSubscribed(readSubscribed())
  }, [detail?.collaborators?.length])

  useEffect(() => {
    if (!item) return
    setWatchLaterOn(isInWatchLater(item.id))
    setSubscribed(readSubscribed())
    setOfflineSaved(findDownload(item.id, store.activeCid) !== null)
    setShowDescription(false)
  }, [item?.id, store.activeCid])

  if (!item) {
    return <EmptyView />
  }

  const related: UnifiedVideoItem[] = detail?.relatedVideos ?? []
  const tags: string[] = detail?.tags ?? []
  const deliveryTag: string | null = store.manifest ? store.manifest.delivery.toUpperCase() : null

  const headlineParts: string[] = [`${formatCount(item.viewCount)} 次觀看`]
  if (item.publishedText) headlineParts.push(item.publishedText)
  const statParts: string[] = []
  if (item.likeCount !== undefined) statParts.push(`${formatCount(item.likeCount)} 個讚`)
  if (item.provider === "bili" && item.danmakuCount !== undefined) statParts.push(`${formatCount(item.danmakuCount)} 則彈幕`)
  if (deliveryTag) statParts.push(deliveryTag)

  const handleWatchLater = (): void => {
    const next: boolean = toggleWatchLater(item)
    setWatchLaterOn(next)
    setToast(next ? "已加入稍後觀看" : "已移出稍後觀看")
  }

  const toggleChannel = (rawId: string, name: string, avatarUrl: string | undefined): void => {
    toggleSubscription({
      id: `${item.provider}:${rawId}`,
      provider: item.provider,
      rawId,
      name,
      avatarUrl: avatarUrl ?? "",
      subscribedAt: Date.now(),
    })
    setSubscribed(readSubscribed())
  }

  const pickCollaborator = async (title: string, labelFor: (channel: VideoCollaborator) => string): Promise<VideoCollaborator | null> => {
    const index: number | null | undefined = await Dialog.actionSheet({
      title,
      actions: collaborators.map((channel: VideoCollaborator) => ({ label: labelFor(channel) })),
    })
    return typeof index === "number" ? collaborators[index] ?? null : null
  }

  const handleSubscribe = (): void => {
    if (!isCollab) {
      toggleChannel(channelRawId, channelName, channelAvatar)
      return
    }
    void pickCollaborator("訂閱頻道", (channel: VideoCollaborator) =>
      `${isSubscribed(`${item.provider}:${channel.id}`) ? "取消訂閱" : "訂閱"} ${channel.name}`,
    ).then((channel: VideoCollaborator | null) => {
      if (channel) toggleChannel(channel.id, channel.name, channel.avatarUrl)
    })
  }

  const handleShare = (): void => {
    void Pasteboard.setString(getVideoShareUrl(item)).then(() => setToast("已複製連結"))
  }

  const handleDownload = (): void => {
    if (offlineBusy) return
    const existing = findDownload(item.id, store.activeCid)
    if (existing) {
      void Dialog.confirm({
        title: "刪除離線檔案",
        message: "已下載此影片，要改為刪除本機檔案嗎？",
        confirmLabel: "刪除",
      }).then((confirmed: boolean) => {
        if (!confirmed) return
        void removeDownload(existing.id).then(() => {
          setOfflineSaved(false)
          setToast("已刪除離線檔案")
        })
      })
      return
    }
    setOfflineBusy(true)
    setToast("開始下載")
    void downloadVideo(item, {
      cid: store.activeCid,
      page: store.activePage,
      preferredHeight: store.settings.preferredQualityHeight,
    })
      .then(() => {
        setOfflineSaved(true)
        setToast("下載完成，可離線播放")
      })
      .catch((error: unknown) => {
        setToast(error instanceof Error ? error.message : "下載失敗")
      })
      .finally(() => {
        setOfflineBusy(false)
      })
  }

  const openChannel = (): void => {
    if (!isCollab) {
      props.onOpenChannel?.(item.provider, channelRawId, channelName, channelAvatar)
      return
    }
    void pickCollaborator("前往頻道", (channel: VideoCollaborator) => channel.name).then((channel: VideoCollaborator | null) => {
      if (channel) props.onOpenChannel?.(item.provider, channel.id, channel.name, channel.avatarUrl)
    })
  }

  const infoBlock: VirtualNode = (
    <VStack alignment="leading" spacing={12} padding={{ horizontal: space.page, top: 14 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text
          font={type.title - 3}
          fontWeight="bold"
          foregroundStyle="label"
          lineLimit={showDescription ? undefined : 2}
          multilineTextAlignment="leading"
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          {item.title}
        </Text>
        <HStack spacing={6}>
          {item.isLive ? (
            <Text
              font={type.micro}
              fontWeight="heavy"
              foregroundStyle={palette.onMedia}
              padding={{ horizontal: 6, vertical: 2 }}
              background={{ style: palette.danger, shape: { type: "rect", cornerRadius: 4 } }}
            >
              LIVE
            </Text>
          ) : null}
          <Text font={type.meta + 1} foregroundStyle="secondaryLabel" lineLimit={1}>
            {headlineParts.join(" · ")}
          </Text>
        </HStack>
      </VStack>

      <VStack
        alignment="leading"
        spacing={8}
        padding={12}
        frame={{ maxWidth: "infinity", alignment: "leading" }}
        background={{ style: "secondarySystemFill", shape: { type: "rect", cornerRadius: radius.md, style: "continuous" } }}
        contentShape="rect"
        onTapGesture={() => setShowDescription(!showDescription)}
      >
        <HStack spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Rectangle
            fill={providerColor(item.provider)}
            frame={{ width: 7, height: 7 }}
            clipShape={{ type: "rect", cornerRadius: 3.5 }}
          />
          <Text font={type.meta + 1} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>
            {[providerFullName(item.provider), ...statParts].join(" · ")}
          </Text>
        </HStack>
        <Text
          font={type.body}
          foregroundStyle="secondaryLabel"
          lineSpacing={3}
          lineLimit={showDescription ? undefined : 2}
          multilineTextAlignment="leading"
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          {detail?.description || "沒有簡介"}
        </Text>
        {showDescription && tags.length > 0 ? (
          <Text font={type.meta} foregroundStyle={palette.brand} lineLimit={3}>
            {tags.map((tag: string) => `#${tag}`).join("  ")}
          </Text>
        ) : null}
        {showDescription ? (
          <Text font={type.caption} monospaced foregroundStyle="tertiaryLabel">{item.rawId}</Text>
        ) : (
          <Text font={type.meta} fontWeight="semibold" foregroundStyle="label">更多</Text>
        )}
      </VStack>

      <HStack spacing={12} frame={{ maxWidth: "infinity" }}>
        <HStack spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect" onTapGesture={openChannel}>
          {isCollab ? (
            <HStack spacing={-14}>
              {collaborators.slice(0, 2).map((channel: VideoCollaborator) => (
                <VStack
                  key={`collab-${channel.id}`}
                  padding={2}
                  background={{ style: "systemBackground", shape: "circle" }}
                >
                  <Avatar url={channel.avatarUrl} name={channel.name} size={34} provider={item.provider} />
                </VStack>
              ))}
            </HStack>
          ) : (
            <Avatar url={channelAvatar} name={channelName} size={40} provider={item.provider} />
          )}
          <VStack alignment="leading" spacing={2}>
            <Text font={type.cardTitle} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>{channelName}</Text>
            {detail?.subscriberCountText ? (
              <Text font={type.meta} foregroundStyle="secondaryLabel" lineLimit={1}>{detail.subscriberCountText}</Text>
            ) : null}
          </VStack>
        </HStack>
        <Text
          font={type.body}
          fontWeight="semibold"
          foregroundStyle={subscribed ? "label" : palette.onMedia}
          padding={{ horizontal: 16, vertical: 8 }}
          background={{ style: subscribed ? "tertiarySystemFill" : palette.brand, shape: "capsule" }}
          contentShape="capsule"
          animation={{ animation: Animation.smooth({ duration: 0.25 }), value: subscribed }}
          onTapGesture={handleSubscribe}
        >
          {subscribed ? "已訂閱" : "訂閱"}
        </Text>
      </HStack>
    </VStack>
  )

  const actionBar: VirtualNode = (
    <ScrollView axes="horizontal" scrollIndicator="hidden">
      <HStack spacing={8} padding={{ horizontal: space.page }}>
        <ActionChip
          icon={watchLaterOn ? "bookmark.fill" : "bookmark"}
          label="稍後觀看"
          active={watchLaterOn}
          onTap={handleWatchLater}
        />
        <ActionChip icon="text.badge.plus" label="加入清單" onTap={() => void addToPlaylistFlow(item)} />
        <ActionChip
          icon={offlineSaved ? "arrow.down.circle.fill" : "arrow.down.circle"}
          label={offlineBusy ? "下載中" : offlineSaved ? "已下載" : "下載"}
          active={offlineSaved}
          onTap={handleDownload}
        />
        <ActionChip icon="slider.horizontal.3" label={store.selectedQualityLabel || "畫質"} onTap={props.onOpenQualitySheet} />
        {item.provider === "bili" ? (
          <ActionChip
            icon={store.danmakuEnabled ? "text.bubble.fill" : "text.bubble"}
            label="彈幕"
            active={store.danmakuEnabled}
            onTap={props.onOpenDanmakuSheet}
          />
        ) : null}
        <ActionChip icon="square.and.arrow.up" label="分享" onTap={handleShare} />
      </HStack>
    </ScrollView>
  )

  const pagesSection: VirtualNode | null = detail?.pages && detail.pages.length > 1
    ? (
      <VStack alignment="leading" spacing={10}>
        <SectionHeader title="選集" detail={`${store.activePage} / ${detail.pages.length}`} />
        <ScrollView axes="horizontal" scrollIndicator="hidden">
          <HStack spacing={8} padding={{ horizontal: space.page }}>
            {detail.pages.map((page: VideoPagePart) => (
              <SegmentCard
                key={`page-${page.cid}`}
                caption={`P${page.page} · ${formatDuration(page.duration)}`}
                title={page.title}
                active={page.cid === store.activeCid}
                onTap={() => void selectPage(page)}
              />
            ))}
          </HStack>
        </ScrollView>
      </VStack>
    )
    : null

  const chaptersSection: VirtualNode | null = detail?.chapters && detail.chapters.length > 0
    ? <ChaptersSection chapters={detail.chapters} />
    : null

  const relatedList: VirtualNode = related.length === 0
    ? <EmptyState icon="rectangle.stack" title="沒有相關影片" />
    : (
      <LazyVStack spacing={4} frame={{ maxWidth: "infinity" }}>
        {related.map((video: UnifiedVideoItem) => (
          <VideoCard
            key={`related-${video.id}`}
            item={video}
            layout="row"
            onSelect={(selected: UnifiedVideoItem) => {
              void openVideo(selected, { queue: detail?.relatedVideos })
            }}
            onOpenChannel={props.onOpenChannel}
          />
        ))}
      </LazyVStack>
    )

  const commentsList: VirtualNode = (
    <CommentsSheet
        comments={store.comments}
        loading={store.commentsLoading}
        loadingMore={store.commentsLoadingMore}
        sort={store.commentsSort}
        hasMore={store.commentsCursor !== null}
        repliesLoading={store.repliesLoading}
        onSort={(sort) => {
          void setCommentsSort(sort)
        }}
        onLoadMore={() => {
          void loadMoreComments()
        }}
        onLoadReplies={(commentId) => {
          void loadCommentReplies(commentId)
        }}
        onRefresh={() => {
          void reloadComments()
        }}
      />
    )

  // 留言捲到底自動抓下一頁。
  // 用「階段變化」而不是每幀的幾何回呼：幾何版每次捲動畫面都會跨橋進 JS，
  // 就算立刻 return 也佔主執行緒；階段版一個手勢只回呼一兩次。
  // 捲動時凍結播放進度通知：捲動是主執行緒最敏感的時刻，這一秒的數字沒人看得到。
  const handleScrollPhase = (next: ScrollPhase): void => {
    setProgressUpdatesPaused(String(next) !== "idle")
  }

  const handleCommentsPhase = (
    _old: ScrollPhase,
    next: ScrollPhase,
    context: ScrollPhaseChangeContext,
  ): void => {
    handleScrollPhase(next)
    if (String(next) !== "idle") return
    const geometry: ScrollGeometry = context.geometry
    if (geometry.containerSize.height <= 0) return
    if (store.commentsCursor === null) return
    if (store.commentsLoading || store.commentsLoadingMore) return
    const remaining: number = geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height
    if (remaining > COMMENTS_AUTO_LOAD_PX) return
    void loadMoreComments()
  }

  return (
    <VStack
      spacing={0}
      frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}
      toast={{
        message: toast ?? "",
        position: "bottom",
        isPresented: toast !== null,
        onChanged: (presented: boolean) => {
          if (!presented) setToast(null)
        },
      }}
    >
      {/* 頁首當真正的兄弟，佔實際空間（不疊上去、不靠安全區）。 */}
      {/* 材質要鋪在外層，否則上下內距會露出卡片底色（深色下就是一條黑邊）。 */}
      <VStack
        spacing={0}
        frame={{ maxWidth: "infinity" }}
        padding={{ horizontal: space.page, top: 6, bottom: 6 }}
        background="systemBackground"
      >
        <Picker
          title="內容"
          value={tab}
          onChanged={(next: number) => withAnimation(() => setTab(next))}
          pickerStyle="segmented"
          frame={{ maxWidth: "infinity", height: 32 }}
        >
          <Text tag={TAB_RELATED}>詳情</Text>
          <Text tag={TAB_COMMENTS}>留言</Text>
        </Picker>
      </VStack>
      {/* TabView 不會回報自己需要多少高，要自己量。
          兩頁改成「填滿且靠上」：寫死高度時頁面比容器高，SwiftUI 會把它垂直置中，
          上緣就溢出到容器外 → 最上面那排內容看起來被切掉。 */}
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
                {infoBlock}
                {actionBar}
                {pagesSection}
                {chaptersSection}
                <VStack spacing={10} frame={{ maxWidth: "infinity" }}>
                  <SectionHeader title="相關影片" />
                  {relatedList}
                </VStack>
              </VStack>
            </ScrollView>
            <ScrollView
              axes="vertical"
              scrollIndicator="hidden"
              tag={TAB_COMMENTS}
              frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}
              onScrollPhaseChange={handleCommentsPhase}
            >
              <VStack spacing={0} frame={{ maxWidth: "infinity" }} padding={{ top: 10, bottom: 24 }}>
                {commentsList}
              </VStack>
            </ScrollView>
          </TabView>
        )}
      </GeometryReader>
    </VStack>
  )
}
