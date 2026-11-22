import {
  Button,
  HStack,
  Image,
  MagnifyGesture,
  Menu,
  ProgressView,
  Rectangle,
  Spacer,
  Text,
  VStack,
  ZStack,
  gradient,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "scripting"
import type { DragGestureDetails, MagnifyGestureValue, Point, VirtualNode } from "scripting"
import type { PlayerProgressSnapshot, PlayerStoreSnapshot } from "../state/playerStore"
import {
  dismissActiveSponsorSegment,
  getPlayerProgressSnapshot,
  minimizeToMiniPlayer,
  openVideo,
  seekBy,
  seekTo,
  selectQuality,
  selectSubtitle,
  setPlaybackRate,
  setTemporaryBoost2x,
  skipActiveSponsorSegment,
  subscribePlayerProgress,
  toggleDanmaku,
  toggleFullscreen,
  togglePlayPause,
  usePlayerStore,
} from "../state/playerStore"
import type { SponsorSegment, SubtitleTrackInfo } from "../types"
import {
  SPONSOR_CATEGORY_COLORS,
  SPONSOR_CATEGORY_LABELS,
  formatDuration,
} from "../utils/format"
import { motion, palette, type } from "../ui/theme"
import { NetSpeedLabel, PlaybackStatsPanel } from "./PlaybackStats"

export interface PlayerControlsOverlayProps {
  width: number
  height: number
  topSafeInset?: number
  bottomSafeInset?: number
  dragSpace: string
  videoFill?: boolean
  onVideoFillChange?: (fill: boolean) => void
  onOpenQualitySheet?: () => void
  onOpenDanmakuSheet?: () => void
  onMinimizeDragChanged?: (dy: number, dx: number) => void
  onMinimizeDragEnded?: (dy: number, dx: number, predictedDy: number) => void
  onFullscreenDragChanged?: (direction: "enter" | "exit", translationY: number) => void
  onFullscreenDragEnded?: (direction: "enter" | "exit", translationY: number, predictedY: number) => void
  onCancelFullscreenDrag?: () => void
}

const AUTO_HIDE_MS: number = 4000
const DOUBLE_TAP_MS: number = 230
const TAP_HINT_MS: number = 650
const FILL_HINT_MS: number = 1200
const LONG_PRESS_BOOST_MS: number = 350
const LONG_PRESS_HOLD_MS: number = 60_000
const POST_BOOST_TAP_SUPPRESS_MS: number = 250
const PINCH_ZOOM_IN_THRESHOLD: number = 1.12
const PINCH_ZOOM_OUT_THRESHOLD: number = 0.88
const PLAYBACK_RATES: number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
const EDGE_SCRIM_HEIGHT: number = 96
const SCRUBBER_HEIGHT: number = 22
const SCRUBBER_TRACK: number = 3
const SCRUBBER_KNOB: number = 11
const MIN_HIT_SIZE: number = 44
const SPINNER_BOX: number = 60
const SPEED_OFFSET_Y: number = 44

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

export interface ScrubPreview {
  seconds: number
  duration: number
}

function ProgressBar(props: {
  active: boolean
  trackWidth: number
  barWidth: number
  edgeInset: number
  bottomInset: number
  fullscreen: boolean
  scrub: ScrubPreview | null
  onScrub: (preview: ScrubPreview | null) => void
  onTapChrome: () => void
}): VirtualNode {
  const store: PlayerStoreSnapshot = usePlayerStore()
  const [progress, setProgress] = useState<PlayerProgressSnapshot>(() => getPlayerProgressSnapshot())
  useEffect(() => {
    if (!props.active) return
    const sync = (): void => setProgress(getPlayerProgressSnapshot())
    sync()
    return subscribePlayerProgress(sync)
  }, [props.active])
  const duration: number = progress.duration || 0
  const live: boolean = store.currentItem?.isLive === true
  const scrubWidthRef = useRef<number>(1)
  const scrubTargetRef = useRef<number | null>(null)

  function handleScrubChanged(d: DragGestureDetails): void {
    if (duration <= 0) return
    const x: number = Math.max(0, Math.min(scrubWidthRef.current, d.location.x))
    const value: number = (x / scrubWidthRef.current) * duration
    scrubTargetRef.current = value
    props.onScrub({ seconds: value, duration })
  }

  function handleScrubEnded(): void {
    const target: number | null = scrubTargetRef.current
    scrubTargetRef.current = null
    props.onScrub(null)
    if (target !== null) void seekTo(target)
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

  function renderScrubber(width: number): VirtualNode | null {
    if (duration <= 0) return null
    scrubWidthRef.current = width
    const value: number = props.scrub ? props.scrub.seconds : Math.min(progress.position, duration)
    const ratio: number = Math.max(0, Math.min(1, value / duration))
    const knob: number = props.scrub ? SCRUBBER_KNOB + 4 : SCRUBBER_KNOB
    const knobX: number = Math.max(knob / 2, Math.min(width - knob / 2, width * ratio)) - knob / 2
    return (
      <ZStack
        alignment="leading"
        frame={{ width, height: SCRUBBER_HEIGHT, alignment: "leading" }}
        contentShape="rect"
        onDragGesture={{
          minDistance: 0,
          coordinateSpace: "local",
          onChanged: handleScrubChanged,
          onEnded: handleScrubEnded,
        }}
      >
        <ZStack alignment="leading" frame={{ width, height: SCRUBBER_KNOB, alignment: "leading" }} allowsHitTesting={false}>
          <Rectangle
            fill="rgba(255,255,255,0.24)"
            frame={{ width, height: SCRUBBER_TRACK }}
            clipShape={{ type: "rect", cornerRadius: SCRUBBER_TRACK / 2 }}
          />
          <Rectangle
            fill={palette.brand}
            frame={{ width: width * ratio, height: SCRUBBER_TRACK }}
            clipShape={{ type: "rect", cornerRadius: SCRUBBER_TRACK / 2 }}
          />
          {renderSponsorBlocks(width, SCRUBBER_TRACK)}
          <Rectangle
            fill="white"
            frame={{ width: knob, height: knob }}
            clipShape={{ type: "rect", cornerRadius: knob / 2 }}
            offset={{ x: knobX, y: 0 }}
            shadow={{ color: "rgba(0,0,0,0.35)", radius: 3, y: 1 }}
          />
        </ZStack>
      </ZStack>
    )
  }

  return (
    <VStack spacing={2} padding={{ horizontal: props.edgeInset, bottom: props.bottomInset }} frame={{ width: props.trackWidth }}>
      <HStack
        spacing={4}
        frame={{ width: props.trackWidth }}
        contentShape="rect"
        onTapGesture={props.onTapChrome}
      >
        {live ? (
          <HStack spacing={5}>
            <Rectangle
              fill={palette.danger}
              frame={{ width: 6, height: 6 }}
              clipShape={{ type: "rect", cornerRadius: 3 }}
            />
            <Text font={type.caption} fontWeight="semibold" foregroundStyle={palette.onMedia}>
              直播中
            </Text>
          </HStack>
        ) : (
          <HStack spacing={4}>
            <Text font={type.caption} monospacedDigit foregroundStyle={palette.onMedia}>
              {formatDuration(props.scrub ? props.scrub.seconds : progress.position)}
            </Text>
            <Text font={type.caption} monospacedDigit foregroundStyle={palette.onMediaDim}>
              {`/ ${formatDuration(progress.duration)}`}
            </Text>
            {progress.activeChapter ? (
              <Text font={type.caption} foregroundStyle={palette.onMediaDim} lineLimit={1}>
                {`· ${progress.activeChapter.title}`}
              </Text>
            ) : null}
          </HStack>
        )}
        <Spacer />
      </HStack>
      <HStack spacing={4} frame={{ width: props.trackWidth }}>
        {live ? <Spacer /> : renderScrubber(props.barWidth)}
        <Button action={() => toggleFullscreen()} buttonStyle="plain">
          <VStack frame={{ width: MIN_HIT_SIZE, height: 30 }} contentShape="rect">
            <Image
              systemName={props.fullscreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right"}
              font={16}
              foregroundStyle={palette.onMedia}
            />
          </VStack>
        </Button>
      </HStack>
    </VStack>
  )
}

export function PlayerControlsOverlay(props: PlayerControlsOverlayProps): VirtualNode {
  const store: PlayerStoreSnapshot = usePlayerStore()

  const [controlsVisible, setControlsVisible] = useState<boolean>(false)
  const [scrub, setScrub] = useState<ScrubPreview | null>(null)
  const [tapHint, setTapHint] = useState<"left" | "right" | null>(null)
  const [fillHint, setFillHint] = useState<string | null>(null)

  const lastTapAtRef = useRef<number | null>(null)
  const dragModeRef = useRef<"none" | "minimize" | "enterFullscreen" | "exitFullscreen" | "ignore">("none")
  const hideTimerRef = useRef<number | null>(null)
  const hintTimerRef = useRef<number | null>(null)
  const fillHintTimerRef = useRef<number | null>(null)
  const boostTimerRef = useRef<number | null>(null)
  const boostingRef = useRef<boolean>(false)
  const suppressTapUntilRef = useRef<number>(0)
  const pinchHandledRef = useRef<boolean>(false)
  const isLiveRef = useRef<boolean>(store.currentItem?.isLive === true)
  isLiveRef.current = store.currentItem?.isLive === true
  const isFullscreenRef = useRef<boolean>(store.isFullscreen)
  isFullscreenRef.current = store.isFullscreen
  const videoFillRef = useRef<boolean>(props.videoFill === true)
  videoFillRef.current = props.videoFill === true
  const onVideoFillChangeRef = useRef(props.onVideoFillChange)
  onVideoFillChangeRef.current = props.onVideoFillChange
  const onCancelFullscreenDragRef = useRef(props.onCancelFullscreenDrag)
  onCancelFullscreenDragRef.current = props.onCancelFullscreenDrag
  const statusRef = useRef<string>(store.status)
  statusRef.current = store.status

  function cancelPendingBoost(): void {
    if (boostTimerRef.current !== null) {
      clearTimeout(boostTimerRef.current)
      boostTimerRef.current = null
    }
  }

  function stopBoost(): void {
    cancelPendingBoost()
    if (!boostingRef.current) return
    boostingRef.current = false
    suppressTapUntilRef.current = Date.now() + POST_BOOST_TAP_SUPPRESS_MS
    setTemporaryBoost2x(false)
  }

  function handleLongPressingChanged(pressing: boolean): void {
    if (!pressing) {
      stopBoost()
      return
    }
    if (isLiveRef.current || statusRef.current !== "playing") return
    cancelPendingBoost()
    boostTimerRef.current = setTimeout(() => {
      boostTimerRef.current = null
      if (isLiveRef.current || statusRef.current !== "playing" || dragModeRef.current !== "none") return
      boostingRef.current = true
      HapticFeedback.lightImpact()
      setTemporaryBoost2x(true)
    }, LONG_PRESS_BOOST_MS)
  }

  useEffect(() => {
    if (store.status !== "playing") stopBoost()
    if (store.status === "ended") {
      setControlsVisible(true)
      clearAutoHide()
      return
    }
    if (store.status === "playing" && controlsVisible) armAutoHide()
  }, [store.status])

  useEffect(() => {
    stopBoost()
  }, [store.currentItem?.id])

  useEffect(() => {
    return () => {
      stopBoost()
      if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current)
      if (hintTimerRef.current !== null) clearTimeout(hintTimerRef.current)
      if (fillHintTimerRef.current !== null) clearTimeout(fillHintTimerRef.current)
    }
  }, [])

  const magnifyGesture = useMemo(
    () =>
      MagnifyGesture(0.05)
        .onChanged((value: MagnifyGestureValue): void => {
          if (!isFullscreenRef.current) return
          stopBoost()
          dragModeRef.current = "ignore"
          onCancelFullscreenDragRef.current?.()
          if (pinchHandledRef.current) return
          if (value.magnification >= PINCH_ZOOM_IN_THRESHOLD && !videoFillRef.current) {
            pinchHandledRef.current = true
            videoFillRef.current = true
            HapticFeedback.lightImpact()
            onVideoFillChangeRef.current?.(true)
            setFillHint("已縮放以填滿畫面")
            if (fillHintTimerRef.current !== null) clearTimeout(fillHintTimerRef.current)
            fillHintTimerRef.current = setTimeout(() => {
              fillHintTimerRef.current = null
              setFillHint(null)
            }, FILL_HINT_MS)
          } else if (value.magnification <= PINCH_ZOOM_OUT_THRESHOLD && videoFillRef.current) {
            pinchHandledRef.current = true
            videoFillRef.current = false
            HapticFeedback.lightImpact()
            onVideoFillChangeRef.current?.(false)
            setFillHint("原始比例")
            if (fillHintTimerRef.current !== null) clearTimeout(fillHintTimerRef.current)
            fillHintTimerRef.current = setTimeout(() => {
              fillHintTimerRef.current = null
              setFillHint(null)
            }, FILL_HINT_MS)
          }
        })
        .onEnded((): void => {
          pinchHandledRef.current = false
        }),
    [],
  )

  const landscapeFullscreen: boolean = store.isFullscreen && !store.isPortraitFullscreen
  const portraitFullscreen: boolean = store.isFullscreen && store.isPortraitFullscreen
  const sideSafeInset: number = Math.max(Device.safeAreaInsets?.leading ?? 0, Device.safeAreaInsets?.trailing ?? 0)
  const edgeInset: number = landscapeFullscreen ? Math.max(24, sideSafeInset) : portraitFullscreen ? 16 : 12
  const topInset: number = portraitFullscreen ? Math.max(14, props.topSafeInset ?? 0) : store.isFullscreen ? 14 : 8
  const bottomInset: number = portraitFullscreen ? Math.max(20, props.bottomSafeInset ?? 34) : store.isFullscreen ? 10 : 4
  const floatingBottomInset: number = portraitFullscreen ? bottomInset + 84 : 56
  const trackWidth: number = Math.max(1, props.width - edgeInset * 2)
  const barWidth: number = Math.max(1, trackWidth - 4 - MIN_HIT_SIZE)

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
      if (statusRef.current === "paused" || statusRef.current === "ended") return
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

  function showControls(): void {
    setControlsVisible(true)
    armAutoHide()
  }

  function handleScrub(preview: ScrubPreview | null): void {
    setScrub(preview)
    if (preview) clearAutoHide()
    else armAutoHide()
  }

  function hideControls(): void {
    setControlsVisible(false)
    clearAutoHide()
  }

  function handleChromeTap(): void {
    lastTapAtRef.current = null
    if (controlsVisible) hideControls()
    else showControls()
  }

  function handleTap(loc: Point): void {
    const now: number = Date.now()
    if (now < suppressTapUntilRef.current) return
    const lastTapAt: number | null = lastTapAtRef.current
    if (lastTapAt !== null && now - lastTapAt < DOUBLE_TAP_MS && !store.currentItem?.isLive) {
      lastTapAtRef.current = null
      if (loc.x < props.width * 0.42) {
        void seekBy(-10)
        showTapHint("left")
      } else if (loc.x > props.width * 0.58) {
        void seekBy(10)
        showTapHint("right")
      }
      return
    }
    lastTapAtRef.current = now
    if (controlsVisible) hideControls()
    else showControls()
  }

  function resolveDragMode(d: DragGestureDetails): "none" | "minimize" | "enterFullscreen" | "exitFullscreen" | "ignore" {
    const dy: number = d.translation.height
    const dx: number = d.translation.width
    const absY: number = Math.abs(dy)
    const absX: number = Math.abs(dx)
    if (store.isFullscreen) {
      const topGuard: number = portraitFullscreen ? 44 : 28
      if (d.startLocation.y < topGuard) return "ignore"
      if (absY < 8 && absX < 8) return "none"
      return dy > 0 && absY > absX * 1.15 ? "exitFullscreen" : "ignore"
    }
    if (absY < 8 && absX < 8) return "none"
    if (absY <= absX * 1.15) return "ignore"
    return dy > 0 ? "minimize" : "enterFullscreen"
  }

  function handleDragChanged(d: DragGestureDetails): void {
    if (boostingRef.current) {
      dragModeRef.current = "ignore"
      return
    }
    if (dragModeRef.current === "none") {
      dragModeRef.current = resolveDragMode(d)
    }
    const mode = dragModeRef.current
    if (mode !== "none" && mode !== "ignore") cancelPendingBoost()
    if (mode === "minimize") {
      props.onMinimizeDragChanged?.(d.translation.height, d.translation.width)
    } else if (mode === "enterFullscreen") {
      props.onFullscreenDragChanged?.("enter", d.translation.height)
    } else if (mode === "exitFullscreen") {
      props.onFullscreenDragChanged?.("exit", d.translation.height)
    }
  }

  function handleDragEnded(d: DragGestureDetails): void {
    let mode = dragModeRef.current
    dragModeRef.current = "none"
    if (mode === "none") {
      mode = resolveDragMode(d)
    }
    if (mode === "minimize") {
      props.onMinimizeDragEnded?.(
        d.translation.height,
        d.translation.width,
        d.predictedEndTranslation.height,
      )
    } else if (mode === "enterFullscreen") {
      props.onFullscreenDragEnded?.("enter", d.translation.height, d.predictedEndTranslation.height)
    } else if (mode === "exitFullscreen") {
      props.onFullscreenDragEnded?.("exit", d.translation.height, d.predictedEndTranslation.height)
    }
  }

  function handleBack(): void {
    if (store.isFullscreen) toggleFullscreen()
    else minimizeToMiniPlayer()
  }

  function handleRetry(): void {
    if (!store.currentItem) return
    if (store.manifest) {
      void selectQuality(store.selectedQualityId)
      return
    }
    void openVideo(store.currentItem, { cid: store.activeCid, page: store.activePage })
  }

  function renderScrims(): VirtualNode {
    const maxEdge: number = Math.round(props.height * 0.38)
    const topEdge: number = Math.min(portraitFullscreen ? topInset + EDGE_SCRIM_HEIGHT : EDGE_SCRIM_HEIGHT, maxEdge)
    const bottomEdge: number = Math.min(
      portraitFullscreen ? bottomInset + EDGE_SCRIM_HEIGHT + 24 : EDGE_SCRIM_HEIGHT,
      maxEdge,
    )
    return (
      <ZStack frame={{ width: props.width, height: props.height }} allowsHitTesting={false}>
        <Rectangle fill="rgba(0,0,0,0.22)" frame={{ width: props.width, height: props.height }} />
        <VStack spacing={0} frame={{ width: props.width, height: props.height }}>
          <Rectangle
            fill={gradient("linear", { colors: ["rgba(0,0,0,0.6)", "rgba(0,0,0,0)"], startPoint: "top", endPoint: "bottom" })}
            frame={{ width: props.width, height: topEdge }}
          />
          <Spacer />
          <Rectangle
            fill={gradient("linear", { colors: ["rgba(0,0,0,0)", "rgba(0,0,0,0.7)"], startPoint: "top", endPoint: "bottom" })}
            frame={{ width: props.width, height: bottomEdge }}
          />
        </VStack>
      </ZStack>
    )
  }

  function renderControlsLayer(): VirtualNode {
    const title: string = store.currentItem?.title ?? ""
    const provider = store.currentItem?.provider ?? "yt"
    const playing: boolean = store.status === "playing"
    const ended: boolean = store.status === "ended"
    const loading: boolean = store.status === "loading" || store.status === "buffering"
    const hasSubtitles: boolean = (store.manifest?.subtitles.length ?? 0) > 0

    return (
      <ZStack frame={{ width: props.width, height: props.height }}>
        {renderScrims()}
        <VStack spacing={0} frame={{ width: props.width, height: props.height }}>
          <HStack spacing={10} padding={{ horizontal: edgeInset, top: topInset }}>
            <GlassCircle
              icon={store.isFullscreen ? "chevron.left" : "chevron.down"}
              size={34}
              iconSize={14}
              onTap={handleBack}
            />
            {landscapeFullscreen ? (
              <Text
                font={type.cardTitle + 1}
                fontWeight="semibold"
                foregroundStyle={palette.onMedia}
                lineLimit={1}
                layoutPriority={1}
                shadow={{ color: "rgba(0,0,0,0.4)", radius: 4 }}
              >
                {title}
              </Text>
            ) : null}
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
              {hasSubtitles ? (
                <Menu
                  label={
                    <HStack spacing={0} frame={{ width: MIN_HIT_SIZE, height: MIN_HIT_SIZE }} contentShape="rect">
                      <Image
                        systemName={store.selectedSubtitleId ? "captions.bubble.fill" : "captions.bubble"}
                        font={17}
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
              ) : (
                <VStack frame={{ width: MIN_HIT_SIZE, height: MIN_HIT_SIZE }} contentShape="rect" opacity={0.35}>
                  <Image systemName="captions.bubble" font={17} foregroundStyle={palette.onMedia} />
                </VStack>
              )}
              <Menu
                label={
                  <HStack spacing={0} frame={{ width: MIN_HIT_SIZE, height: MIN_HIT_SIZE }} contentShape="rect">
                    <Text font={type.meta + 3} fontWeight="semibold" monospacedDigit foregroundStyle={palette.onMedia}>
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
            </HStack>
          </HStack>

          <Spacer />

          <HStack spacing={landscapeFullscreen ? 44 : store.isFullscreen ? 32 : 28}>
            {store.currentItem?.isLive ? null : (
              <GlassCircle icon="gobackward.10" size={44} iconSize={18} onTap={() => void seekBy(-10)} />
            )}
            {loading ? (
              <ZStack frame={{ width: SPINNER_BOX, height: SPINNER_BOX }}>
                <ProgressView tint="white" controlSize="large" />
                <NetSpeedLabel offsetY={SPEED_OFFSET_Y} />
              </ZStack>
            ) : (
              <GlassCircle
                icon={ended ? "arrow.counterclockwise" : playing ? "pause.fill" : "play.fill"}
                size={60}
                iconSize={26}
                onTap={() => void togglePlayPause()}
              />
            )}
            {store.currentItem?.isLive ? null : (
              <GlassCircle icon="goforward.10" size={44} iconSize={18} onTap={() => void seekBy(10)} />
            )}
          </HStack>

          <Spacer />

          {portraitFullscreen && title ? (
            <HStack spacing={0} padding={{ horizontal: edgeInset, bottom: 6 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text
                font={type.cardTitle + 1}
                fontWeight="semibold"
                foregroundStyle={palette.onMedia}
                lineLimit={1}
                shadow={{ color: "rgba(0,0,0,0.4)", radius: 4 }}
              >
                {title}
              </Text>
            </HStack>
          ) : null}

          <ProgressBar
            active={controlsVisible}
            trackWidth={trackWidth}
            barWidth={barWidth}
            edgeInset={edgeInset}
            bottomInset={bottomInset}
            fullscreen={store.isFullscreen}
            scrub={scrub}
            onScrub={handleScrub}
            onTapChrome={handleChromeTap}
          />
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
            <HStack spacing={0} padding={{ top: portraitFullscreen ? topInset : 14 }}>
              <OverlayCapsule>
                <Image systemName="forward.fill" font={11} foregroundStyle={palette.onMedia} />
                <Text font={type.meta} fontWeight="semibold" foregroundStyle={palette.onMedia}>2× 快轉</Text>
              </OverlayCapsule>
            </HStack>
            <Spacer />
          </VStack>
        ) : fillHint ? (
          <VStack spacing={0} frame={{ width: props.width, height: props.height }}>
            <HStack spacing={0} padding={{ top: portraitFullscreen ? topInset : 14 }}>
              <OverlayCapsule>
                <Image
                  systemName={props.videoFill ? "arrow.up.left.and.arrow.down.right" : "arrow.down.right.and.arrow.up.left"}
                  font={11}
                  foregroundStyle={palette.onMedia}
                />
                <Text font={type.meta} fontWeight="semibold" foregroundStyle={palette.onMedia}>{fillHint}</Text>
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

        {scrub ? (
          <ZStack frame={{ width: props.width, height: props.height }}>
            <OverlayCapsule>
              <Text font={type.cardTitle} fontWeight="semibold" monospacedDigit foregroundStyle={palette.onMedia}>
                {formatDuration(scrub.seconds)}
              </Text>
              <Text font={type.cardTitle} monospacedDigit foregroundStyle={palette.onMediaDim}>
                {`/ ${formatDuration(scrub.duration)}`}
              </Text>
            </OverlayCapsule>
          </ZStack>
        ) : null}

        {loading && !controlsVisible ? (
          <ZStack frame={{ width: props.width, height: props.height }}>
            <ZStack frame={{ width: SPINNER_BOX, height: SPINNER_BOX }}>
              <ProgressView tint="white" controlSize="large" />
              <NetSpeedLabel offsetY={SPEED_OFFSET_Y} />
            </ZStack>
          </ZStack>
        ) : null}

        {store.statsVisible ? (
          <ZStack
            frame={{ width: props.width, height: props.height, alignment: "topLeading" }}
            allowsHitTesting={false}
          >
            <VStack padding={{ leading: edgeInset, top: controlsVisible ? topInset + 50 : portraitFullscreen ? topInset : 10 }}>
              <PlaybackStatsPanel />
            </VStack>
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
            <HStack spacing={0} padding={{ leading: edgeInset, bottom: floatingBottomInset }}>
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
            <HStack spacing={6} padding={{ trailing: edgeInset, bottom: floatingBottomInset }}>
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

  return (
    <ZStack frame={{ width: props.width, height: props.height }}>
      <Rectangle
        fill="rgba(0,0,0,0.001)"
        frame={{ width: props.width, height: props.height }}
        onTapGesture={{ count: 1, coordinateSpace: "local", perform: handleTap }}
        onLongPressGesture={{
          minDuration: LONG_PRESS_HOLD_MS,
          perform: () => {},
          onPressingChanged: handleLongPressingChanged,
        }}
        onDragGesture={{
          minDistance: 10,
          coordinateSpace: props.dragSpace,
          onChanged: handleDragChanged,
          onEnded: handleDragEnded,
        }}
        simultaneousGesture={magnifyGesture}
      />
      <ZStack
        frame={{ width: props.width, height: props.height }}
        opacity={controlsVisible ? 1 : 0}
        allowsHitTesting={controlsVisible}
        animation={{
          animation: controlsVisible ? motion.enter : motion.exit,
          value: controlsVisible,
        }}
      >
        {renderControlsLayer()}
      </ZStack>
      {renderFloatingLayer()}
    </ZStack>
  )
}
