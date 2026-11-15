import {
  EmptyView,
  HStack,
  Image,
  LazyVStack,
  Picker,
  Rectangle,
  ScrollView,
  Text,
  VideoPlaybackView,
  VStack,
  ZStack,
  useEffect,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { Provider, UnifiedVideoItem, VideoChapter, VideoPagePart } from "../types"
import { CommentsSheet } from "../components/CommentsSheet"
import { DanmakuSheet, QualitySheet } from "../components/PlaybackSheets"
import { PlayerControlsOverlay } from "../components/PlayerControlsOverlay"
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
  getPlayerController,
  openVideo,
  reloadComments,
  seekTo,
  selectPage,
  usePlayerProgress,
  usePlayerStore,
} from "../state/playerStore"
import { Avatar, EmptyState, SectionHeader } from "../ui/primitives"
import { palette, providerColor, radius, space, type } from "../ui/theme"

export interface WatchViewProps {
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
  zoom?: { sourceID: string; namespace: NamespaceID }
}

type InfoTab = "related" | "comments"

const SEGMENT_CARD_WIDTH: number = 156

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
      frame={{ width: SEGMENT_CARD_WIDTH, alignment: "leading" }}
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

export function WatchView(props: WatchViewProps): VirtualNode {
  const store = usePlayerStore()
  const progress = usePlayerProgress()

  const [showDescription, setShowDescription] = useState(false)
  const [showQualitySheet, setShowQualitySheet] = useState(false)
  const [showDanmakuSheet, setShowDanmakuSheet] = useState(false)
  const [tab, setTab] = useState<InfoTab>("related")
  const [watchLaterOn, setWatchLaterOn] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [offlineSaved, setOfflineSaved] = useState(false)
  const [offlineBusy, setOfflineBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const item: UnifiedVideoItem | null = store.currentItem
  const detail = store.detail
  const channelRawId: string = detail?.authorId || item?.authorId || ""
  const channelName: string = detail?.authorName || item?.authorName || ""
  const channelAvatar: string | undefined = detail?.authorAvatar || item?.authorAvatar

  useEffect(() => {
    if (!item) return
    setWatchLaterOn(isInWatchLater(item.id))
    setSubscribed(isSubscribed(`${item.provider}:${channelRawId}`))
    setOfflineSaved(findDownload(item.id, store.activeCid) !== null)
    setShowDescription(false)
    setShowQualitySheet(false)
    setShowDanmakuSheet(false)
  }, [item?.id, store.activeCid])

  // Keyed on the item, not the presentation mode: the page stays drawn while its pop animation runs.
  if (!item) {
    return <EmptyView />
  }

  const screenWidth: number = Device.screen.width
  const screenHeight: number = Device.screen.height
  const portraitWidth: number = Math.min(screenWidth, screenHeight)
  const playerWidth: number = store.isFullscreen ? Math.max(screenWidth, screenHeight) : portraitWidth
  const playerHeight: number = store.isFullscreen
    ? Math.min(screenWidth, screenHeight)
    : Math.round(portraitWidth * 9 / 16)

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

  const handleSubscribe = (): void => {
    const next: boolean = toggleSubscription({
      id: `${item.provider}:${channelRawId}`,
      provider: item.provider,
      rawId: channelRawId,
      name: channelName,
      avatarUrl: channelAvatar ?? "",
      subscribedAt: Date.now(),
    })
    setSubscribed(next)
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
    props.onOpenChannel?.(item.provider, channelRawId, channelName, channelAvatar)
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
          <Avatar url={channelAvatar} name={channelName} size={40} provider={item.provider} />
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
        <ActionChip icon="slider.horizontal.3" label={store.selectedQualityLabel || "畫質"} onTap={() => setShowQualitySheet(true)} />
        {item.provider === "bili" ? (
          <ActionChip
            icon={store.danmakuEnabled ? "text.bubble.fill" : "text.bubble"}
            label="彈幕"
            active={store.danmakuEnabled}
            onTap={() => setShowDanmakuSheet(true)}
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
    ? (
      <VStack alignment="leading" spacing={10}>
        <SectionHeader title="章節" />
        <ScrollView axes="horizontal" scrollIndicator="hidden">
          <HStack spacing={8} padding={{ horizontal: space.page }}>
            {detail.chapters.map((chapter: VideoChapter, index: number) => (
              <SegmentCard
                key={`chapter-${index}-${chapter.startTime}`}
                caption={formatDuration(chapter.startTime)}
                title={chapter.title}
                active={progress.position >= chapter.startTime && progress.position < chapter.endTime}
                onTap={() => void seekTo(chapter.startTime)}
              />
            ))}
          </HStack>
        </ScrollView>
      </VStack>
    )
    : null

  const tabContent: VirtualNode = tab === "related"
    ? related.length === 0
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
    : (
      <CommentsSheet
        comments={store.comments}
        loading={store.commentsLoading}
        onRefresh={() => {
          void reloadComments()
        }}
      />
    )

  return (
    <VStack
      spacing={0}
      frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}
      background={<Rectangle fill={store.isFullscreen ? "black" : "systemBackground"} ignoresSafeArea />}
      navigationTransition={props.zoom ? { type: "zoom", sourceID: props.zoom.sourceID, namespace: props.zoom.namespace } : "automatic"}
      toolbarVisibility={{
        visibility: "hidden",
        bars: store.isFullscreen ? ["tabBar", "navigationBar", "statusBar"] : ["tabBar", "navigationBar"],
      }}
      sheet={{
        isPresented: showQualitySheet,
        onChanged: setShowQualitySheet,
        content: <QualitySheet onDone={() => setShowQualitySheet(false)} />,
      }}
      toast={{
        message: toast ?? "",
        position: "bottom",
        isPresented: toast !== null,
        onChanged: (presented: boolean) => {
          if (!presented) setToast(null)
        },
      }}
    >
      <ZStack
        frame={{ width: playerWidth, height: playerHeight }}
        background="black"
        sheet={{
          isPresented: showDanmakuSheet,
          onChanged: setShowDanmakuSheet,
          content: <DanmakuSheet onDone={() => setShowDanmakuSheet(false)} />,
        }}
      >
        <VideoPlaybackView
          controller={getPlayerController()}
          gestures={false}
          videoGravity="resizeAspect"
          frame={{ width: playerWidth, height: playerHeight }}
        />
        <PlayerControlsOverlay
          width={playerWidth}
          height={playerHeight}
          onOpenQualitySheet={() => setShowQualitySheet(true)}
          onOpenDanmakuSheet={() => setShowDanmakuSheet(true)}
        />
      </ZStack>

      {store.isFullscreen ? null : (
        <ScrollView axes="vertical" scrollIndicator="hidden" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
          <VStack spacing={20} frame={{ maxWidth: "infinity" }} padding={{ bottom: 24 }}>
            {infoBlock}
            {actionBar}
            {pagesSection}
            {chaptersSection}
            <VStack spacing={8} frame={{ maxWidth: "infinity" }}>
              <Picker
                title="內容"
                value={tab}
                onChanged={(next: string) => setTab(next as InfoTab)}
                pickerStyle="segmented"
                padding={{ horizontal: space.page }}
              >
                <Text tag="related">{related.length > 0 ? `相關影片 ${related.length}` : "相關影片"}</Text>
                <Text tag="comments">{store.comments.length > 0 ? `留言 ${store.comments.length}` : "留言"}</Text>
              </Picker>
              {tabContent}
            </VStack>
          </VStack>
        </ScrollView>
      )}
    </VStack>
  )
}
