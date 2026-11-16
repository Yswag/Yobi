import {
  Button,
  HStack,
  Image,
  Menu,
  ProgressView,
  Rectangle,
  Slider,
  Spacer,
  Text,
  VStack,
  ZStack,
  gradient,
  useEffect,
  useRef,
  useState,
} from "scripting"
import type { DragGestureDetails, Point, VirtualNode } from "scripting"
import type { PlayerProgressSnapshot, PlayerStoreSnapshot } from "../state/playerStore"
import {
  dismissActiveSponsorSegment,
  minimizeToMiniPlayer,
  openVideo,
  seekBy,
  seekTo,
  selectSubtitle,
  setPlaybackRate,
  skipActiveSponsorSegment,
  startPiP,
  toggleDanmaku,
  toggleFullscreen,
  togglePlayPause,
  usePlayerProgress,
  usePlayerStore,
} from "../state/playerStore"
import type { SponsorSegment, SubtitleTrackInfo } from "../types"
import {
  SPONSOR_CATEGORY_COLORS,
  SPONSOR_CATEGORY_LABELS,
  formatDuration,
} from "../utils/format"
import { palette, type } from "../ui/theme"

export interface PlayerControlsOverlayProps {
  width: number
  height: number
  onOpenQualitySheet?: () => void
  onOpenDanmakuSheet?: () => void
}

const AUTO_HIDE_MS: number = 4000
const DOUBLE_TAP_MS: number = 230
const TAP_HINT_MS: number = 650
const PLAYBACK_RATES: number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
const EDGE_SCRIM_HEIGHT: number = 96
const MINIMIZE_DRAG_DISTANCE: number = 70
// 64pt 以下一律放大到 44pt 的觸控框（HIG 最小值），視覺尺寸不變。
const MIN_HIT_SIZE: number = 44

function GlassCircle(props: { icon: string; size: number; iconSize: number; onTap: () => void }): VirtualNode {
  const hit: number = Math.max(MIN_HIT_SIZE, props.size)
  return (
    <Button action={props.onTap} buttonStyle="plain">
      <VStack frame={{ width: hit, height: hit }}>
        <VStack
          frame={{ width: props.size, height: props.size }}
          contentShape={{ type: "rect", cornerRadius: props.size / 2 }}
          glassEffect={{
            glass: UIGlass.clear().interactive(),
            shape: { type: "rect", cornerRadius: props.size / 2 },
          }}
        >
          <Image
            systemName={props.icon}
            font={props.iconSize}
            fontWeight="semibold"
            foregroundStyle={palette.onMedia}
            contentTransition="symbolEffectReplace"
          />
        </VStack>
      </VStack>
    </Button>
  )
}

// 頂列與底列的小圖示：畫多大隨人，吃點擊的一律 44×44。
function IconControl(props: { icon: string; size: number; onTap: () => void }): VirtualNode {
  return (
    <Button action={props.onTap} buttonStyle="plain">
      <VStack frame={{ width: MIN_HIT_SIZE, height: MIN_HIT_SIZE }} contentShape="rect">
        <Image systemName={props.icon} font={props.size} foregroundStyle={palette.onMedia} />
      </VStack>
    </Button>
  )
}

function OverlayCapsule(props: { children: VirtualNode | VirtualNode[] }): VirtualNode {
  return (
    <HStack
      spacing={6}
      padding={{ horizontal: 12, vertical: 7 }}
      background={{ style: palette.scrim, shape: "capsule" }}
    >
      {props.children}
    </HStack>
  )
}

function rateLabel(rate: number): string {
  return `${rate === Math.floor(rate) ? rate.toFixed(0) : String(rate)}×`
}

export function PlayerControlsOverlay(props: PlayerControlsOverlayProps): VirtualNode {
  const store: PlayerStoreSnapshot = usePlayerStore()
  const progress: PlayerProgressSnapshot = usePlayerProgress()

  const [controlsVisible, setControlsVisible] = useState<boolean>(true)
  const [scrubPreviewSec, setScrubPreviewSec] = useState<number>(0)
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false)
  const [tapHint, setTapHint] = useState<"left" | "right" | null>(null)

  const lastTapAtRef = useRef<number | null>(null)
  const scrubTargetRef = useRef<number | null>(null)
  const hideTimerRef = useRef<number | null>(null)
  const hintTimerRef = useRef<number | null>(null)
  const statusRef = useRef<string>(store.status)
  statusRef.current = store.status

  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current)
      if (hintTimerRef.current !== null) clearTimeout(hintTimerRef.current)
    }
  }, [])

  const duration: number = progress.duration || 0
  const sideSafeInset: number = Math.max(Device.safeAreaInsets?.leading ?? 0, Device.safeAreaInsets?.trailing ?? 0)
  const edgeInset: number = store.isFullscreen ? Math.max(24, sideSafeInset) : 12
  const trackWidth: number = Math.max(1, props.width - edgeInset * 2)

  function clearAutoHide(): void {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }

  function armAutoHide(): void {
    clearAutoHide()
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null
      if (statusRef.current === "paused") return
      setControlsVisible(false)
    }, AUTO_HIDE_MS)
  }

  function showTapHint(side: "left" | "right"): void {
    setTapHint(side)
    if (hintTimerRef.current !== null) clearTimeout(hintTimerRef.current)
    hintTimerRef.current = setTimeout(() => {
      hintTimerRef.current = null
      setTapHint(null)
    }, TAP_HINT_MS)
  }

  function toggleControls(): void {
    const next: boolean = !controlsVisible
    setControlsVisible(next)
    if (next) armAutoHide()
    else clearAutoHide()
  }

  function handleTap(loc: Point): void {
    const now: number = Date.now()
    const lastTapAt: number | null = lastTapAtRef.current
    if (lastTapAt !== null && now - lastTapAt < DOUBLE_TAP_MS) {
      lastTapAtRef.current = null
      if (loc.x < props.width * 0.42) {
        void seekBy(-10)
        showTapHint("left")
      } else if (loc.x > props.width * 0.58) {
        void seekBy(10)
        showTapHint("right")
      } else {
        toggleControls()
      }
      return
    }
    lastTapAtRef.current = now
    setTimeout(() => {
      if (lastTapAtRef.current !== now) return
      lastTapAtRef.current = null
      toggleControls()
    }, DOUBLE_TAP_MS)
  }

  function handleDragEnded(d: DragGestureDetails): void {
    const dy: number = d.translation.height
    if (!store.isFullscreen && dy > MINIMIZE_DRAG_DISTANCE && dy > Math.abs(d.translation.width)) {
      minimizeToMiniPlayer()
    }
  }

  function handleBack(): void {
    if (store.isFullscreen) toggleFullscreen()
    else minimizeToMiniPlayer()
  }

  function handleRetry(): void {
    if (!store.currentItem) return
    void openVideo(store.currentItem, { cid: store.activeCid, page: store.activePage })
  }

  function handleSliderChanged(value: number): void {
    // Seeking on every tick floods the local proxy with segment requests; seek once on release.
    scrubTargetRef.current = value
    setScrubPreviewSec(value)
    setIsScrubbing(true)
  }

  function handleSliderEditingChanged(editing: boolean): void {
    if (editing) {
      clearAutoHide()
      return
    }
    const target: number | null = scrubTargetRef.current
    scrubTargetRef.current = null
    if (target !== null) void seekTo(target)
    setIsScrubbing(false)
    armAutoHide()
  }

  function renderSponsorBlocks(fullWidth: number, blockHeight: number): VirtualNode[] {
    if (duration <= 0) return []
    return store.sponsorSegments.map((seg: SponsorSegment) => {
      const leftRatio: number = Math.max(0, Math.min(1, seg.startTime / duration))
      const widthRatio: number = Math.max(0, Math.min(1 - leftRatio, (seg.endTime - seg.startTime) / duration))
      return (
        <Rectangle
          key={seg.uuid}
          fill={SPONSOR_CATEGORY_COLORS[seg.category]}
          frame={{ width: Math.max(2, fullWidth * widthRatio), height: blockHeight }}
          offset={{ x: fullWidth * leftRatio, y: 0 }}
        />
      )
    })
  }

  function renderScrims(): VirtualNode {
    const edge: number = Math.min(EDGE_SCRIM_HEIGHT, Math.round(props.height * 0.38))
    return (
      <ZStack frame={{ width: props.width, height: props.height }} allowsHitTesting={false}>
        <Rectangle fill="rgba(0,0,0,0.22)" frame={{ width: props.width, height: props.height }} />
        <VStack spacing={0} frame={{ width: props.width, height: props.height }}>
          <Rectangle
            fill={gradient("linear", { colors: ["rgba(0,0,0,0.6)", "rgba(0,0,0,0)"], startPoint: "top", endPoint: "bottom" })}
            frame={{ width: props.width, height: edge }}
          />
          <Spacer />
          <Rectangle
            fill={gradient("linear", { colors: ["rgba(0,0,0,0)", "rgba(0,0,0,0.7)"], startPoint: "top", endPoint: "bottom" })}
            frame={{ width: props.width, height: edge }}
          />
        </VStack>
      </ZStack>
    )
  }

  function renderControlsLayer(): VirtualNode {
    const title: string = store.currentItem?.title ?? ""
    const provider = store.currentItem?.provider ?? "yt"
    const sliderMax: number = Math.max(1, progress.duration || 1)
    const sliderValue: number = isScrubbing
      ? scrubPreviewSec
      : Math.min(progress.position, sliderMax)
    const playing: boolean = store.status === "playing"
    const loading: boolean = store.status === "loading" || store.status === "buffering"
    const hasSubtitles: boolean = (store.manifest?.subtitles.length ?? 0) > 0

    return (
      <ZStack frame={{ width: props.width, height: props.height }}>
        {renderScrims()}
        <VStack spacing={0} frame={{ width: props.width, height: props.height }}>
          <HStack spacing={10} padding={{ horizontal: edgeInset, top: store.isFullscreen ? 14 : 8 }}>
            <GlassCircle
              icon={store.isFullscreen ? "chevron.left" : "chevron.down"}
              size={34}
              iconSize={14}
              onTap={handleBack}
            />
            <Text
              font={store.isFullscreen ? type.cardTitle + 1 : type.body}
              fontWeight="semibold"
              foregroundStyle={palette.onMedia}
              lineLimit={1}
              layoutPriority={1}
              shadow={{ color: "rgba(0,0,0,0.4)", radius: 4 }}
            >
              {title}
            </Text>
            <Spacer />
            <HStack spacing={4} fixedSize>
              {provider === "bili" ? (
                <IconControl
                  icon={store.danmakuEnabled ? "text.bubble.fill" : "text.bubble"}
                  size={17}
                  onTap={() => toggleDanmaku()}
                />
              ) : null}
              {provider === "bili" ? (
                <IconControl icon="slider.horizontal.3" size={17} onTap={() => props.onOpenDanmakuSheet?.()} />
              ) : null}
              <Button action={() => props.onOpenQualitySheet?.()} buttonStyle="plain">
                <VStack frame={{ height: MIN_HIT_SIZE }} contentShape="rect">
                  <Text
                    font={type.caption}
                    fontWeight="bold"
                    foregroundStyle={palette.onMedia}
                    lineLimit={1}
                    fixedSize
                    padding={{ horizontal: 8, vertical: 4 }}
                    background={{ style: "rgba(255,255,255,0.18)", shape: "capsule" }}
                  >
                    {store.selectedQualityLabel}
                  </Text>
                </VStack>
              </Button>
              <IconControl icon="pip.enter" size={17} onTap={() => void startPiP()} />
            </HStack>
          </HStack>

          <Spacer />

          <HStack spacing={store.isFullscreen ? 56 : 36}>
            <GlassCircle icon="gobackward.10" size={48} iconSize={20} onTap={() => void seekBy(-10)} />
            {loading ? (
              <VStack frame={{ width: 68, height: 68 }}>
                <ProgressView tint="white" controlSize="large" />
              </VStack>
            ) : (
              <GlassCircle icon={playing ? "pause.fill" : "play.fill"} size={68} iconSize={28} onTap={() => void togglePlayPause()} />
            )}
            <GlassCircle icon="goforward.10" size={48} iconSize={20} onTap={() => void seekBy(10)} />
          </HStack>

          <Spacer />

          <VStack spacing={2} padding={{ horizontal: edgeInset, bottom: store.isFullscreen ? 16 : 6 }}>
            <HStack spacing={4} frame={{ width: trackWidth }}>
              <HStack spacing={4}>
                <Text font={type.caption} fontWeight="semibold" monospacedDigit foregroundStyle={palette.onMedia}>
                  {formatDuration(isScrubbing ? scrubPreviewSec : progress.position)}
                </Text>
                <Text font={type.caption} fontWeight="semibold" monospacedDigit foregroundStyle={palette.onMediaDim}>
                  {`/ ${formatDuration(progress.duration)}`}
                </Text>
                {progress.activeChapter ? (
                  <Text font={type.caption} foregroundStyle={palette.onMediaDim} lineLimit={1}>
                    {`· ${progress.activeChapter.title}`}
                  </Text>
                ) : null}
              </HStack>
              <Spacer />
              {hasSubtitles ? (
                <Menu
                  label={
                    <HStack spacing={0} frame={{ width: MIN_HIT_SIZE, height: MIN_HIT_SIZE }} contentShape="rect">
                      <Image
                        systemName={store.selectedSubtitleId ? "captions.bubble.fill" : "captions.bubble"}
                        font={16}
                        foregroundStyle={palette.onMedia}
                      />
                    </HStack>
                  }
                >
                  <Button
                    title="關閉字幕"
                    systemImage={store.selectedSubtitleId ? undefined : "checkmark"}
                    action={() => void selectSubtitle(null)}
                  />
                  {(store.manifest?.subtitles ?? []).map((track: SubtitleTrackInfo) => (
                    <Button
                      key={track.id}
                      title={track.label}
                      systemImage={store.selectedSubtitleId === track.id ? "checkmark" : undefined}
                      action={() => void selectSubtitle(track.id)}
                    />
                  ))}
                </Menu>
              ) : null}
              <Menu
                label={
                  <HStack spacing={0} frame={{ width: MIN_HIT_SIZE, height: MIN_HIT_SIZE }} contentShape="rect">
                    <Text font={type.meta + 1} fontWeight="bold" monospacedDigit foregroundStyle={palette.onMedia}>
                      {rateLabel(store.playbackRate)}
                    </Text>
                  </HStack>
                }
              >
                {PLAYBACK_RATES.map((rate: number) => (
                  <Button
                    key={String(rate)}
                    title={rateLabel(rate)}
                    systemImage={store.playbackRate === rate ? "checkmark" : undefined}
                    action={() => setPlaybackRate(rate)}
                  />
                ))}
              </Menu>
              <IconControl
                icon={store.isFullscreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right"}
                size={16}
                onTap={() => toggleFullscreen()}
              />
            </HStack>
            <ZStack alignment="leading" frame={{ width: trackWidth, height: 22, alignment: "leading" }}>
              <Slider
                min={0}
                max={sliderMax}
                step={0.5}
                value={sliderValue}
                tint={palette.brand}
                onChanged={handleSliderChanged}
                onEditingChanged={handleSliderEditingChanged}
              />
              <ZStack
                alignment="leading"
                frame={{ width: trackWidth, height: 3, alignment: "leading" }}
                offset={{ x: 0, y: 14 }}
                allowsHitTesting={false}
              >
                {renderSponsorBlocks(trackWidth, 3)}
              </ZStack>
            </ZStack>
          </VStack>
        </VStack>
      </ZStack>
    )
  }

  function renderFloatingLayer(): VirtualNode {
    const loading: boolean = store.status === "loading" || store.status === "buffering"
    const prompt: SponsorSegment | null = store.activeSponsorPrompt
    const promptSeconds: number = prompt ? Math.max(1, Math.round(prompt.endTime - prompt.startTime)) : 0

    return (
      <ZStack frame={{ width: props.width, height: props.height }}>
        {store.isBoosting2x ? (
          <VStack spacing={0} frame={{ width: props.width, height: props.height }}>
            <HStack spacing={0} padding={{ top: 14 }}>
              <OverlayCapsule>
                <Image systemName="forward.fill" font={11} foregroundStyle={palette.onMedia} />
                <Text font={type.meta} fontWeight="semibold" foregroundStyle={palette.onMedia}>2× 快轉</Text>
              </OverlayCapsule>
            </HStack>
            <Spacer />
          </VStack>
        ) : null}

        {tapHint !== null ? (
          <ZStack
            frame={{ width: props.width, height: props.height, alignment: tapHint === "left" ? "leading" : "trailing" }}
          >
            <HStack spacing={0} padding={{ horizontal: 24 }}>
              <OverlayCapsule>
                <Image
                  systemName={tapHint === "right" ? "goforward.10" : "gobackward.10"}
                  font={14}
                  fontWeight="semibold"
                  foregroundStyle={palette.onMedia}
                />
              </OverlayCapsule>
            </HStack>
          </ZStack>
        ) : null}

        {isScrubbing ? (
          <ZStack frame={{ width: props.width, height: props.height }}>
            <OverlayCapsule>
              <Text font={type.cardTitle} fontWeight="semibold" monospacedDigit foregroundStyle={palette.onMedia}>
                {formatDuration(scrubPreviewSec)}
              </Text>
              <Text font={type.cardTitle} monospacedDigit foregroundStyle={palette.onMediaDim}>
                {`/ ${formatDuration(duration)}`}
              </Text>
            </OverlayCapsule>
          </ZStack>
        ) : null}

        {loading && !controlsVisible ? (
          <ZStack frame={{ width: props.width, height: props.height }}>
            <ProgressView tint="white" controlSize="large" />
          </ZStack>
        ) : null}

        {store.status === "error" ? (
          <ZStack
            frame={{ width: props.width, height: props.height }}
            background="rgba(0,0,0,0.7)"
          >
            <VStack spacing={14}>
              <Image systemName="exclamationmark.triangle.fill" font={26} foregroundStyle={palette.onMediaDim} />
              <Text
                font={type.body}
                foregroundStyle={palette.onMedia}
                multilineTextAlignment="center"
                padding={{ horizontal: 32 }}
              >
                {store.errorText ?? "播放發生錯誤"}
              </Text>
              <Text
                font={type.body}
                fontWeight="semibold"
                foregroundStyle="black"
                padding={{ horizontal: 20, vertical: 9 }}
                background={{ style: "white", shape: "capsule" }}
                contentShape="capsule"
                onTapGesture={handleRetry}
              >
                重試
              </Text>
            </VStack>
          </ZStack>
        ) : null}

        {store.skippedToast ? (
          <ZStack
            frame={{ width: props.width, height: props.height, alignment: "bottomLeading" }}
          >
            <HStack spacing={0} padding={{ leading: edgeInset, bottom: 56 }}>
              <OverlayCapsule>
                <Image systemName="forward.end.fill" font={11} foregroundStyle={palette.success} />
                <Text font={type.meta} foregroundStyle={palette.onMedia} lineLimit={1}>{store.skippedToast}</Text>
              </OverlayCapsule>
            </HStack>
          </ZStack>
        ) : null}

        {prompt !== null ? (
          <ZStack
            frame={{ width: props.width, height: props.height, alignment: "bottomTrailing" }}
          >
            <HStack spacing={6} padding={{ trailing: edgeInset, bottom: 56 }}>
              <Button action={() => skipActiveSponsorSegment()} buttonStyle="plain">
                <HStack
                  spacing={6}
                  padding={{ horizontal: 14, vertical: 8 }}
                  background={{ style: "white", shape: "capsule" }}
                >
                  <Rectangle
                    fill={SPONSOR_CATEGORY_COLORS[prompt.category]}
                    frame={{ width: 7, height: 7 }}
                    clipShape={{ type: "rect", cornerRadius: 3.5 }}
                  />
                  <Text font={type.meta + 1} fontWeight="semibold" foregroundStyle="black">
                    {`跳過${SPONSOR_CATEGORY_LABELS[prompt.category] ?? "片段"}`}
                  </Text>
                  <Text font={type.meta} monospacedDigit foregroundStyle="rgba(0,0,0,0.5)">{`${promptSeconds}s`}</Text>
                </HStack>
              </Button>
              <Button action={() => dismissActiveSponsorSegment()} buttonStyle="plain">
                <VStack
                  frame={{ width: 28, height: 28 }}
                  background={{ style: palette.scrim, shape: { type: "rect", cornerRadius: 14 } }}
                >
                  <Image systemName="xmark" font={11} fontWeight="bold" foregroundStyle={palette.onMedia} />
                </VStack>
              </Button>
            </HStack>
          </ZStack>
        ) : null}
      </ZStack>
    )
  }

  function renderThinProgressBar(): VirtualNode | null {
    if (controlsVisible || store.isFullscreen || duration <= 0) return null
    const ratio: number = Math.max(0, Math.min(1, progress.position / duration))
    return (
      <ZStack frame={{ width: props.width, height: props.height, alignment: "bottom" }} allowsHitTesting={false}>
        <ZStack
          alignment="leading"
          frame={{ width: props.width, height: 2.5, alignment: "leading" }}
          background="rgba(255,255,255,0.2)"
        >
          <Rectangle fill={palette.brand} frame={{ width: props.width * ratio, height: 2.5 }} />
          {renderSponsorBlocks(props.width, 2.5)}
        </ZStack>
      </ZStack>
    )
  }

  return (
    <ZStack frame={{ width: props.width, height: props.height }}>
      <Rectangle
        fill="rgba(0,0,0,0.001)"
        frame={{ width: props.width, height: props.height }}
        onTapGesture={{ count: 1, coordinateSpace: "local", perform: handleTap }}
        onDragGesture={{
          minDistance: 16,
          coordinateSpace: "local",
          onEnded: handleDragEnded,
        }}
      />
      {controlsVisible ? renderControlsLayer() : null}
      {renderFloatingLayer()}
      {renderThinProgressBar()}
    </ZStack>
  )
}
