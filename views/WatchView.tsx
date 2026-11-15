import { Button, EmptyView, HStack, Image, ScrollView, Slider, Spacer, Text, Toggle, VideoPlaybackView, VStack, ZStack, useEffect, useState } from "scripting"
import type { VirtualNode } from "scripting"
import type { Provider, UnifiedVideoItem, VideoChapter, VideoPagePart, VideoQualityTrack } from "../types"
import { CommentsSheet } from "../components/CommentsSheet"
import { PlayerControlsOverlay } from "../components/PlayerControlsOverlay"
import { VideoCard } from "../components/VideoCard"
import {
  addVideoToPlaylist,
  createPlaylist,
  downloadVideo,
  findDownload,
  getPlaylists,
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
  selectQuality,
  selectYoutubeStreamMode,
  updateDanmakuSettings,
  usePlayerProgress,
  usePlayerStore,
} from "../state/playerStore"

export interface WatchViewProps {
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
}

const LINK_BLUE = "rgba(10,132,255,1)"
const CLEAR = "rgba(0,0,0,0)"

function accentColor(provider: Provider) {
  return provider === "bili" ? "rgba(251,114,153,1)" : "rgba(255,46,77,1)"
}
const AREA_OPTIONS: { label: string; value: number }[] = [
  { label: "25%", value: 0.25 },
  { label: "50%", value: 0.5 },
  { label: "75%", value: 0.75 },
  { label: "100%", value: 1 },
]
const STREAM_MODES: { label: string; value: "auto" | "hls" | "sabr" }[] = [
  { label: "Auto (HLS+SABR)", value: "auto" },
  { label: "HLS", value: "hls" },
  { label: "SABR", value: "sabr" },
]

function ActionChip(props: { icon: string; label: string; active?: boolean; onTap: () => void }): VirtualNode {
  const tint = props.active ? LINK_BLUE : "label"
  return (
    <HStack
      spacing={6}
      padding={{ horizontal: 12, vertical: 7 }}
      background={props.active ? "rgba(10,132,255,0.16)" : "tertiarySystemFill"}
      clipShape="capsule"
      onTapGesture={props.onTap}
    >
      <Image systemName={props.icon} font={13} foregroundStyle={props.active ? LINK_BLUE : "secondaryLabel"} />
      <Text font={12} fontWeight="medium" foregroundStyle={tint} lineLimit={1}>{props.label}</Text>
    </HStack>
  )
}

function OptionChip(props: { label: string; active: boolean; onTap: () => void }): VirtualNode {
  return (
    <HStack
      spacing={0}
      padding={{ horizontal: 11, vertical: 6 }}
      background={props.active ? "rgba(10,132,255,0.16)" : "tertiarySystemFill"}
      clipShape="capsule"
      onTapGesture={props.onTap}
    >
      <Text font={12} fontWeight={props.active ? "semibold" : "regular"} foregroundStyle={props.active ? LINK_BLUE : "label"} lineLimit={1}>
        {props.label}
      </Text>
    </HStack>
  )
}

function SectionTitle(props: { text: string }): VirtualNode {
  return <Text font={13} fontWeight="semibold" foregroundStyle="label" padding={{ horizontal: 14 }}>{props.text}</Text>
}

function avatarView(provider: Provider, name: string, avatarUrl: string | undefined, size: number): VirtualNode {
  if (avatarUrl) {
    return (
      <Image
        imageUrl={avatarUrl}
        resizable
        scaleToFill
        frame={{ width: size, height: size }}
        clipShape="circle"
      />
    )
  }
  const initial: string = (name.trim().charAt(0) || "?").toUpperCase()
  return (
    <VStack frame={{ width: size, height: size }} background={accentColor(provider)} clipShape="circle">
      <Text font={Math.round(size * 0.42)} fontWeight="semibold" foregroundStyle="white">{initial}</Text>
    </VStack>
  )
}

async function addToPlaylistFlow(item: UnifiedVideoItem): Promise<void> {
  const playlists = getPlaylists()
  const labels: string[] = playlists.map(playlist => playlist.name)
  labels.push("＋ 新增播放清單")

  const index: number | null | undefined = await Dialog.actionSheet({
    title: "加入播放清單",
    actions: labels.map((label: string) => ({ label })),
  })
  if (typeof index !== "number") return

  if (index < playlists.length) {
    addVideoToPlaylist(playlists[index].id, item)
    return
  }

  const name: string | null = await Dialog.prompt({
    title: "新增播放清單",
    message: "輸入清單名稱",
    confirmLabel: "建立",
  })
  const trimmed: string = (name ?? "").trim()
  if (!trimmed) return
  const created = createPlaylist(trimmed)
  addVideoToPlaylist(created.id, item)
}

export function WatchView(props: WatchViewProps): VirtualNode {
  const store = usePlayerStore()
  const progress = usePlayerProgress()

  const [showDescription, setShowDescription] = useState(false)
  const [showQualitySheet, setShowQualitySheet] = useState(false)
  const [showDanmakuSheet, setShowDanmakuSheet] = useState(false)
  const [tab, setTab] = useState<"related" | "comments">("related")
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

  if (store.presentationMode !== "expanded" || !item) {
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
  const qualities: VideoQualityTrack[] = store.manifest?.qualities ?? []
  const deliveryTag: string | null = store.manifest ? store.manifest.delivery.toUpperCase() : null

  const flashToast = (message: string): void => {
    setToast(message)
    setTimeout(() => setToast(null), 1800)
  }

  const handleWatchLater = (): void => {
    const next: boolean = toggleWatchLater(item)
    setWatchLaterOn(next)
    flashToast(next ? "已加入稍後觀看" : "已移出稍後觀看")
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
    void Pasteboard.setString(getVideoShareUrl(item)).then(() => flashToast("已複製連結"))
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
          flashToast("已刪除離線檔案")
        })
      })
      return
    }
    setOfflineBusy(true)
    flashToast("開始下載…")
    void downloadVideo(item, {
      cid: store.activeCid,
      page: store.activePage,
      preferredHeight: store.settings.preferredQualityHeight,
    })
      .then(() => {
        setOfflineSaved(true)
        flashToast("下載完成，可離線播放")
      })
      .catch((error: unknown) => {
        flashToast(error instanceof Error ? error.message : "下載失敗")
      })
      .finally(() => {
        setOfflineBusy(false)
      })
  }

  const openChannel = (): void => {
    props.onOpenChannel?.(item.provider, channelRawId, channelName, channelAvatar)
  }

  const renderTab = (key: "related" | "comments", label: string): VirtualNode => (
    <VStack
      spacing={5}
      padding={{ horizontal: 10, vertical: 6 }}
      onTapGesture={() => setTab(key)}
    >
      <Text
        font={13}
        fontWeight={tab === key ? "semibold" : "regular"}
        foregroundStyle={tab === key ? "label" : "secondaryLabel"}
      >
        {label}
      </Text>
      <HStack
        spacing={0}
        frame={{ height: 2, maxWidth: "infinity" }}
        background={tab === key ? LINK_BLUE : CLEAR}
        clipShape="capsule"
      />
    </VStack>
  )

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background="systemBackground">
      <ZStack frame={{ width: playerWidth, height: playerHeight }} background="black">
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

      {store.isFullscreen
        ? null
        : (
          <ScrollView axes="vertical" scrollIndicator="automatic" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
            <VStack spacing={0} frame={{ maxWidth: "infinity" }} padding={{ bottom: 24 }}>
              <VStack alignment="leading" spacing={8} padding={{ horizontal: 14, vertical: 12 }}>
                <HStack spacing={6}>
                  <Text
                    font={10}
                    fontWeight="bold"
                    foregroundStyle="white"
                    padding={{ horizontal: 6, vertical: 2 }}
                    background={accentColor(item.provider)}
                    clipShape={{ type: "rect", cornerRadius: 4 }}
                  >
                    {providerFullName(item.provider)}
                  </Text>
                  {item.isLive
                    ? (
                      <Text
                        font={10}
                        fontWeight="bold"
                        foregroundStyle="white"
                        padding={{ horizontal: 6, vertical: 2 }}
                        background="rgba(255,59,48,1)"
                        clipShape={{ type: "rect", cornerRadius: 4 }}
                      >
                        直播
                      </Text>
                    )
                    : null}
                </HStack>

                <HStack
                  alignment="top"
                  spacing={8}
                  frame={{ maxWidth: "infinity" }}
                  onTapGesture={() => setShowDescription(!showDescription)}
                >
                  <Text
                    font={17}
                    fontWeight="bold"
                    foregroundStyle="label"
                    lineLimit={showDescription ? undefined : 2}
                    multilineTextAlignment="leading"
                    frame={{ maxWidth: "infinity" }}
                  >
                    {item.title}
                  </Text>
                  <Image
                    systemName={showDescription ? "chevron.up" : "chevron.down"}
                    font={12}
                    fontWeight="semibold"
                    foregroundStyle="tertiaryLabel"
                  />
                </HStack>

                <HStack spacing={10} frame={{ maxWidth: "infinity" }}>
                  <Text font={12} foregroundStyle="secondaryLabel" lineLimit={1}>
                    {`${formatCount(item.viewCount)}觀看`}
                  </Text>
                  {item.likeCount !== undefined
                    ? <Text font={12} foregroundStyle="secondaryLabel" lineLimit={1}>{`${formatCount(item.likeCount)}讚`}</Text>
                    : null}
                  {item.provider === "bili" && item.danmakuCount !== undefined
                    ? <Text font={12} foregroundStyle="secondaryLabel" lineLimit={1}>{`彈幕 ${formatCount(item.danmakuCount)}`}</Text>
                    : null}
                  <Spacer />
                  {deliveryTag
                    ? (
                      <Text
                        font={10}
                        fontWeight="semibold"
                        foregroundStyle="secondaryLabel"
                        padding={{ horizontal: 5, vertical: 1 }}
                        background="tertiarySystemFill"
                        clipShape={{ type: "rect", cornerRadius: 4 }}
                      >
                        {deliveryTag}
                      </Text>
                    )
                    : null}
                  {item.publishedText
                    ? <Text font={11} foregroundStyle="tertiaryLabel" lineLimit={1}>{item.publishedText}</Text>
                    : null}
                </HStack>

                {showDescription
                  ? (
                    <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity" }}>
                      <Text font={13} foregroundStyle="secondaryLabel" lineSpacing={3}>{detail?.description || "沒有簡介"}</Text>
                      {tags.length > 0
                        ? (
                          <ScrollView axes="horizontal" scrollIndicator="hidden">
                            <HStack spacing={6}>
                              {tags.map((tag: string, index: number) => (
                                <Text
                                  key={`tag-${index}-${tag}`}
                                  font={11}
                                  foregroundStyle="secondaryLabel"
                                  padding={{ horizontal: 8, vertical: 3 }}
                                  background="tertiarySystemFill"
                                  clipShape="capsule"
                                >
                                  {tag}
                                </Text>
                              ))}
                            </HStack>
                          </ScrollView>
                        )
                        : null}
                      <Text font={11} monospaced foregroundStyle="tertiaryLabel">{item.rawId}</Text>
                    </VStack>
                  )
                  : null}
              </VStack>

              <HStack spacing={10} padding={{ horizontal: 14, vertical: 10 }} frame={{ maxWidth: "infinity" }}>
                <HStack spacing={10} onTapGesture={openChannel}>
                  {avatarView(item.provider, channelName, channelAvatar, 40)}
                  <VStack alignment="leading" spacing={2}>
                    <Text font={14} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>{channelName}</Text>
                    {detail?.subscriberCountText
                      ? <Text font={11} foregroundStyle="tertiaryLabel" lineLimit={1}>{detail.subscriberCountText}</Text>
                      : null}
                  </VStack>
                </HStack>
                <Spacer />
                <Button
                  title={subscribed ? "已訂閱" : "訂閱"}
                  action={handleSubscribe}
                  buttonStyle={subscribed ? "bordered" : "borderedProminent"}
                  controlSize="small"
                  tint={subscribed ? "tertiarySystemFill" : accentColor(item.provider)}
                />
              </HStack>

              <ScrollView axes="horizontal" scrollIndicator="hidden">
                <HStack spacing={8} padding={{ horizontal: 14, vertical: 6 }}>
                  <ActionChip
                    icon={watchLaterOn ? "bookmark.fill" : "bookmark"}
                    label="稍後觀看"
                    active={watchLaterOn}
                    onTap={handleWatchLater}
                  />
                  <ActionChip
                    icon="text.badge.plus"
                    label="加入清單"
                    onTap={() => {
                      void addToPlaylistFlow(item)
                    }}
                  />
                  <ActionChip
                    icon={offlineSaved ? "arrow.down.circle.fill" : "arrow.down.circle"}
                    label={offlineBusy ? "下載中…" : offlineSaved ? "已下載" : "下載"}
                    active={offlineSaved}
                    onTap={handleDownload}
                  />
                  <ActionChip
                    icon="sparkles.tv"
                    label={`畫質 · ${store.selectedQualityLabel}`}
                    active={showQualitySheet}
                    onTap={() => setShowQualitySheet(!showQualitySheet)}
                  />
                  {item.provider === "bili"
                    ? (
                      <ActionChip
                        icon="bubble.left.and.bubble.right"
                        label={`彈幕 · ${store.danmakuEnabled ? "開" : "關"}`}
                        active={showDanmakuSheet}
                        onTap={() => setShowDanmakuSheet(!showDanmakuSheet)}
                      />
                    )
                    : null}
                  <ActionChip icon="square.and.arrow.up" label="分享連結" onTap={handleShare} />
                </HStack>
              </ScrollView>

              {toast
                ? <Text font={11} foregroundStyle="secondaryLabel" padding={{ horizontal: 14 }}>{toast}</Text>
                : null}

              {showQualitySheet
                ? (
                  <VStack spacing={10} padding={{ horizontal: 14, vertical: 4 }}>
                    <VStack
                      alignment="leading"
                      spacing={10}
                      padding={14}
                      frame={{ maxWidth: "infinity" }}
                      background="tertiarySystemFill"
                      clipShape={{ type: "rect", cornerRadius: 12 }}
                    >
                      <HStack spacing={0}>
                        <Text font={13} fontWeight="semibold">畫質與串流</Text>
                        <Spacer />
                        <Button title="完成" font={12} buttonStyle="plain" action={() => setShowQualitySheet(false)} />
                      </HStack>

                      {item.provider === "yt"
                        ? (
                          <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity" }}>
                            <Text font={11} foregroundStyle="tertiaryLabel">串流引擎</Text>
                            <ScrollView axes="horizontal" scrollIndicator="hidden">
                              <HStack spacing={6}>
                                {STREAM_MODES.map(mode => (
                                  <OptionChip
                                    key={`mode-${mode.value}`}
                                    label={mode.label}
                                    active={store.settings.youtubeStreamMode === mode.value}
                                    onTap={() => {
                                      void selectYoutubeStreamMode(mode.value)
                                    }}
                                  />
                                ))}
                              </HStack>
                            </ScrollView>
                          </VStack>
                        )
                        : null}

                      {qualities.length === 0
                        ? <Text font={12} foregroundStyle="secondaryLabel">尚無可用畫質</Text>
                        : qualities.map((quality: VideoQualityTrack) => (
                          <HStack
                            key={`quality-${quality.id}`}
                            spacing={8}
                            padding={{ vertical: 4 }}
                            frame={{ maxWidth: "infinity" }}
                            onTapGesture={() => {
                              void selectQuality(quality.id)
                              setShowQualitySheet(false)
                            }}
                          >
                            <Image
                              systemName={quality.id === store.selectedQualityId ? "largecircle.fill.circle" : "circle"}
                              font={14}
                              foregroundStyle={quality.id === store.selectedQualityId ? LINK_BLUE : "tertiaryLabel"}
                            />
                            <Text
                              font={14}
                              fontWeight={quality.id === store.selectedQualityId ? "semibold" : "regular"}
                              foregroundStyle="label"
                            >
                              {quality.label}
                            </Text>
                            <Text font={10} foregroundStyle="tertiaryLabel">{quality.delivery.toUpperCase()}</Text>
                            {quality.codec
                              ? <Text font={10} foregroundStyle="tertiaryLabel">{quality.codec}</Text>
                              : null}
                            <Spacer />
                            {quality.height
                              ? <Text font={11} foregroundStyle="tertiaryLabel">{`${quality.height}p`}</Text>
                              : null}
                          </HStack>
                        ))}
                    </VStack>
                  </VStack>
                )
                : null}

              {showDanmakuSheet && item.provider === "bili"
                ? (
                  <VStack spacing={10} padding={{ horizontal: 14, vertical: 4 }}>
                    <VStack
                      alignment="leading"
                      spacing={10}
                      padding={14}
                      frame={{ maxWidth: "infinity" }}
                      background="tertiarySystemFill"
                      clipShape={{ type: "rect", cornerRadius: 12 }}
                    >
                      <HStack spacing={0}>
                        <Text font={13} fontWeight="semibold">彈幕設定</Text>
                        <Spacer />
                        <Button title="完成" font={12} buttonStyle="plain" action={() => setShowDanmakuSheet(false)} />
                      </HStack>

                      <HStack spacing={0} frame={{ maxWidth: "infinity" }}>
                        <Text font={13} foregroundStyle="label">顯示彈幕</Text>
                        <Spacer />
                        <Toggle
                          value={store.danmakuEnabled}
                          onChanged={(value: boolean) => updateDanmakuSettings({ danmakuEnabled: value })}
                        />
                      </HStack>

                      <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity" }}>
                        <Text font={11} foregroundStyle="tertiaryLabel">
                          {`不透明度 ${Math.round(store.settings.danmakuOpacity * 100)}%`}
                        </Text>
                        <Slider
                          value={store.settings.danmakuOpacity}
                          min={0.1}
                          max={1}
                          step={0.05}
                          onChanged={(value: number) => updateDanmakuSettings({ danmakuOpacity: value })}
                        />
                      </VStack>

                      <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity" }}>
                        <Text font={11} foregroundStyle="tertiaryLabel">
                          {`速度 ${store.settings.danmakuSpeed.toFixed(2)}x`}
                        </Text>
                        <Slider
                          value={store.settings.danmakuSpeed}
                          min={0.5}
                          max={2}
                          step={0.25}
                          onChanged={(value: number) => updateDanmakuSettings({ danmakuSpeed: value })}
                        />
                      </VStack>

                      <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity" }}>
                        <Text font={11} foregroundStyle="tertiaryLabel">顯示區域</Text>
                        <HStack spacing={6}>
                          {AREA_OPTIONS.map(option => (
                            <OptionChip
                              key={`area-${option.value}`}
                              label={option.label}
                              active={store.settings.danmakuArea === option.value}
                              onTap={() => updateDanmakuSettings({ danmakuArea: option.value })}
                            />
                          ))}
                        </HStack>
                      </VStack>
                    </VStack>
                  </VStack>
                )
                : null}

              {detail?.pages && detail.pages.length > 1
                ? (
                  <VStack alignment="leading" spacing={8} padding={{ vertical: 8 }}>
                    <SectionTitle text={`選集 (${store.activePage}/${detail.pages.length})`} />
                    <ScrollView axes="horizontal" scrollIndicator="hidden">
                      <HStack spacing={8} padding={{ horizontal: 14 }}>
                        {detail.pages.map((page: VideoPagePart) => {
                          const active: boolean = page.cid === store.activeCid
                          return (
                            <VStack
                              key={`page-${page.cid}`}
                              alignment="leading"
                              spacing={4}
                              padding={{ horizontal: 12, vertical: 8 }}
                              frame={{ width: 148 }}
                              background={active ? "rgba(10,132,255,0.16)" : "tertiarySystemFill"}
                              clipShape={{ type: "rect", cornerRadius: 10 }}
                              border={active ? { style: LINK_BLUE, width: 1 } : undefined}
                              onTapGesture={() => {
                                void selectPage(page)
                              }}
                            >
                              <Text font={10} foregroundStyle="tertiaryLabel" lineLimit={1}>
                                {`P${page.page} · ${formatDuration(page.duration)}`}
                              </Text>
                              <Text
                                font={12}
                                fontWeight={active ? "semibold" : "regular"}
                                foregroundStyle="label"
                                lineLimit={2}
                              >
                                {page.title}
                              </Text>
                            </VStack>
                          )
                        })}
                      </HStack>
                    </ScrollView>
                  </VStack>
                )
                : null}

              {detail?.chapters && detail.chapters.length > 0
                ? (
                  <VStack alignment="leading" spacing={8} padding={{ vertical: 8 }}>
                    <SectionTitle text="章節" />
                    <ScrollView axes="horizontal" scrollIndicator="hidden">
                      <HStack spacing={8} padding={{ horizontal: 14 }}>
                        {detail.chapters.map((chapter: VideoChapter, index: number) => {
                          const active: boolean = progress.position >= chapter.startTime && progress.position < chapter.endTime
                          return (
                            <VStack
                              key={`chapter-${index}-${chapter.startTime}`}
                              alignment="leading"
                              spacing={4}
                              padding={{ horizontal: 12, vertical: 8 }}
                              frame={{ width: 152 }}
                              background={active ? "rgba(10,132,255,0.16)" : "tertiarySystemFill"}
                              clipShape={{ type: "rect", cornerRadius: 10 }}
                              border={active ? { style: LINK_BLUE, width: 1 } : undefined}
                              onTapGesture={() => {
                                void seekTo(chapter.startTime)
                              }}
                            >
                              <Text font={11} monospaced foregroundStyle="tertiaryLabel" lineLimit={1}>
                                {formatDuration(chapter.startTime)}
                              </Text>
                              <Text
                                font={12}
                                fontWeight={active ? "semibold" : "regular"}
                                foregroundStyle="label"
                                lineLimit={2}
                              >
                                {chapter.title}
                              </Text>
                            </VStack>
                          )
                        })}
                      </HStack>
                    </ScrollView>
                  </VStack>
                )
                : null}

              <HStack spacing={0} padding={{ horizontal: 14, vertical: 6 }} frame={{ maxWidth: "infinity" }}>
                {renderTab("related", `相關推薦 (${related.length})`)}
                {renderTab("comments", `留言 (${store.comments.length})`)}
              </HStack>

              {tab === "related"
                ? (
                  related.length === 0
                    ? <Text font={12} foregroundStyle="secondaryLabel" padding={{ vertical: 28 }}>目前沒有相關推薦</Text>
                    : related.map((video: UnifiedVideoItem) => (
                      <VideoCard
                        key={`related-${video.id}`}
                        item={video}
                        layout="row"
                        onSelect={(selected: UnifiedVideoItem) => {
                          void openVideo(selected, { queue: detail?.relatedVideos })
                        }}
                        onOpenChannel={props.onOpenChannel}
                      />
                    ))
                )
                : (
                  <CommentsSheet
                    comments={store.comments}
                    loading={store.commentsLoading}
                    onRefresh={() => {
                      void reloadComments()
                    }}
                  />
                )}
            </VStack>
          </ScrollView>
        )}
    </VStack>
  )
}
