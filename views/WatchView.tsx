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
import { LiveChat } from "../components/LiveChat"
import { addToPlaylistFlow, VideoCard } from "../components/VideoCard"
import {
  isInWatchLater,
  isSubscribed,
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
  useLiveViewers,
  usePlayerStore,
} from "../state/playerStore"
import { Avatar, EmptyState, SectionHeader } from "../ui/primitives"
import { palette, providerColor, radius, space, type } from "../ui/theme"

export interface WatchViewProps {
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
  onOpenQualitySheet: () => void
  onOpenDanmakuSheet: () => void
}

const TAB_RELATED: number = 0
const TAB_COMMENTS: number = 1

function LiveViewerLabel(props: { videoId: string; publishedText?: string }): VirtualNode {
  const viewers = useLiveViewers()
  const count: number | null = viewers.videoId === props.videoId ? viewers.count : null
  const parts: string[] = []
  if (count !== null && count > 0) parts.push(`${formatCount(count)} 人正在觀看`)
  if (props.publishedText) parts.push(props.publishedText)
  return (
    <Text font={type.meta + 1} foregroundStyle="secondaryLabel" lineLimit={1}>
      {parts.join(" · ")}
    </Text>
  )
}

const SEGMENT_CARD_WIDTH: number = 156
const SEGMENT_CARD_HEIGHT: number = 70
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
  const [toast, setToast] = useState<string | null>(null)

  const item: UnifiedVideoItem | null = store.currentItem
  const detail = store.detail
  const itemId: string = item?.id ?? ""
  useEffect(() => {
    setTab(TAB_RELATED)
  }, [itemId])
  useEffect((): (() => void) => {
    return (): void => setProgressUpdatesPaused(false)
  }, [itemId])
  const channelRawId: string = detail?.authorId || item?.authorId || ""
  const channelName: string = detail?.authorName || item?.authorName || ""
  const channelAvatar: string | undefined = detail?.authorAvatar || item?.authorAvatar
  const collaborators: VideoCollaborator[] = detail?.collaborators ?? []
  const isCollab: boolean = collaborators.length > 1

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
    setShowDescription(false)
  }, [item?.id, store.activeCid])

  if (!item) {
    return <EmptyView />
  }

  const related: UnifiedVideoItem[] = detail?.relatedVideos ?? []
  const tags: string[] = detail?.tags ?? []
  const deliveryTag: string | null = store.manifest ? store.manifest.delivery.toUpperCase() : null

  const headlineParts: string[] = []
  if (!item.isLive && item.viewCount !== undefined) headlineParts.push(`${formatCount(item.viewCount)} 次觀看`)
  if (item.publishedText) headlineParts.push(item.publishedText)
  const statParts: string[] = []
  if (item.likeCount !== undefined) statParts.push(`${formatCount(item.likeCount)} 個讚`)
  if (item.provider === "bili" && item.danmakuCount !== undefined) statParts.push(`${formatCount(item.danmakuCount)} 則彈幕`)
  if (item.membersOnly) statParts.push("會員專屬")
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
          {item.isLive ? (
            <LiveViewerLabel videoId={item.id} publishedText={item.publishedText} />
          ) : (
            <Text font={type.meta + 1} foregroundStyle="secondaryLabel" lineLimit={1}>
              {headlineParts.join(" · ")}
            </Text>
          )}
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
                  {commentsList}
                </VStack>
              </ScrollView>
            )}
          </TabView>
        )}
      </GeometryReader>
    </VStack>
  )
}
