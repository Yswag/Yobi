import { MagnifyGesture, Rectangle, ZStack, useEffect, useMemo, useRef, useState } from "scripting"
import type { DragGestureDetails, MagnifyGestureValue, Point, VirtualNode } from "scripting"
import type { PlayerStoreSnapshot } from "../state/playerStore"
import {
  retryPlayback,
  seekBy,
  setTemporaryBoost2x,
  usePlayerSelector,
} from "../state/playerStore"
import { motion } from "../ui/theme"
import { PlayerControlsLayer } from "./player/PlayerControlsLayer"
import { PlayerFloatingLayer } from "./player/PlayerFloatingLayer"
import { MIN_HIT_SIZE, type ScrubPreview, type TapHint } from "./player/controlsPrimitives"

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

type DragMode = "none" | "minimize" | "enterFullscreen" | "exitFullscreen" | "ignore"

const AUTO_HIDE_MS: number = 4000
const DOUBLE_TAP_MS: number = 230
const TAP_HINT_MS: number = 650
const FILL_HINT_MS: number = 1200
const LONG_PRESS_BOOST_MS: number = 350
const LONG_PRESS_HOLD_MS: number = 60_000
const POST_BOOST_TAP_SUPPRESS_MS: number = 250
const PINCH_ZOOM_IN_THRESHOLD: number = 1.12
const PINCH_ZOOM_OUT_THRESHOLD: number = 0.88

export function PlayerControlsOverlay(props: PlayerControlsOverlayProps): VirtualNode {
  const store = usePlayerSelector((s: PlayerStoreSnapshot) => ({
    currentItem: s.currentItem,
    hasManifest: s.manifest !== null,
    subtitles: s.manifest?.subtitles,
    status: s.status,
    errorText: s.errorText,
    isFullscreen: s.isFullscreen,
    isPortraitFullscreen: s.isPortraitFullscreen,
    danmakuEnabled: s.danmakuEnabled,
    selectedSubtitleId: s.selectedSubtitleId,
    playbackRate: s.playbackRate,
    isBoosting2x: s.isBoosting2x,
    selectedQualityId: s.selectedQualityId,
    selectedQualityLabel: s.selectedQualityLabel,
    activeCid: s.activeCid,
    activePage: s.activePage,
    statsVisible: s.statsVisible,
    skippedToast: s.skippedToast,
    activeSponsorPrompt: s.activeSponsorPrompt,
  }))

  const [controlsVisible, setControlsVisible] = useState<boolean>(false)
  const [controlsMounted, setControlsMounted] = useState<boolean>(false)
  const [scrub, setScrub] = useState<ScrubPreview | null>(null)
  const [tapHint, setTapHint] = useState<TapHint>(null)
  const [fillHint, setFillHint] = useState<string | null>(null)

  const lastTapAtRef = useRef<number | null>(null)
  const dragModeRef = useRef<DragMode>("none")
  const hideTimerRef = useRef<number | null>(null)
  const unmountTimerRef = useRef<number | null>(null)
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
    if (unmountTimerRef.current !== null) {
      clearTimeout(unmountTimerRef.current)
      unmountTimerRef.current = null
    }
    if (controlsVisible) {
      setControlsMounted(true)
      return
    }
    if (!controlsMounted) return
    const delayMs: number = Math.ceil(motion.duration.exit * 1000) + 40
    unmountTimerRef.current = setTimeout(() => {
      unmountTimerRef.current = null
      setControlsMounted(false)
    }, delayMs)
  }, [controlsVisible])

  useEffect(() => {
    return () => {
      stopBoost()
      if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current)
      if (unmountTimerRef.current !== null) clearTimeout(unmountTimerRef.current)
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

  function resolveDragMode(d: DragGestureDetails): DragMode {
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
    const mode: DragMode = dragModeRef.current
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
    let mode: DragMode = dragModeRef.current
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

  function handleRetry(): void {
    void retryPlayback()
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
        {controlsMounted || controlsVisible ? (
          <PlayerControlsLayer
            width={props.width}
            height={props.height}
            topInset={topInset}
            bottomInset={bottomInset}
            edgeInset={edgeInset}
            trackWidth={trackWidth}
            barWidth={barWidth}
            store={store}
            controlsVisible={controlsVisible}
            scrub={scrub}
            onScrub={handleScrub}
            onTapChrome={handleChromeTap}
            onOpenQualitySheet={props.onOpenQualitySheet}
            onOpenDanmakuSheet={props.onOpenDanmakuSheet}
          />
        ) : null}
      </ZStack>
      <PlayerFloatingLayer
        width={props.width}
        height={props.height}
        topInset={topInset}
        edgeInset={edgeInset}
        floatingBottomInset={floatingBottomInset}
        store={store}
        controlsVisible={controlsVisible}
        scrub={scrub}
        tapHint={tapHint}
        fillHint={fillHint}
        videoFill={props.videoFill === true}
        onRetry={handleRetry}
      />
    </ZStack>
  )
}
