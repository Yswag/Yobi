import {
  HStack,
  Rectangle,
  RoundedRectangle,
  VideoPlaybackView,
  VStack,
  ZStack,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { Provider, UnifiedVideoItem } from "../types"
import type { PlayerPresentationMode, PlayerStoreSnapshot } from "../state/playerStore"
import {
  expandFromMiniPlayer,
  getPlayerController,
  minimizeToMiniPlayer,
  setFullscreen,
  usePlayerStore,
} from "../state/playerStore"
import { MINI_BUTTON_SIZE, MiniPlayerBar } from "./MiniPlayerBar"
import { motion } from "../ui/theme"
import { DanmakuSheet, QualitySheet } from "./PlaybackSheets"
import { PlayerControlsOverlay } from "./PlayerControlsOverlay"
import { WatchView } from "../views/WatchView"

const MINI_HEIGHT: number = 56
const MINI_MARGIN: number = 21
const MINI_RADIUS: number = MINI_HEIGHT / 2
const MINI_VIDEO_INSET_V: number = 8
const MINI_VIDEO_INSET_LEADING: number = 10
const MINI_VIDEO_RADIUS: number = 10
const TAB_BAR_CLEARANCE: number = 44 + 8
export const MINI_PLAYER_RESERVED_HEIGHT: number = MINI_HEIGHT + 8
const MORPH_SECONDS: number = motion.duration.morph
const FADE_OUT_SECONDS: number = motion.duration.exit
const FADE_IN_SECONDS: number = motion.duration.enter
const PLAYER_DRAG_SPACE: string = "playerRoot"
const MINIMIZE_DRAG_RATIO: number = 0.45
const ENTER_FULLSCREEN_MIN_DY: number = 48
const ENTER_FULLSCREEN_PREDICTED_DY: number = 90
const ENTER_FULLSCREEN_FLICK_DY: number = 24
const EXIT_FULLSCREEN_MIN_DY: number = 56
const EXIT_FULLSCREEN_PREDICTED_DY: number = 110
const EXIT_FULLSCREEN_FLICK_DY: number = 28

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function mix(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

function blendGeometry(from: CardGeometry, to: CardGeometry, t: number): CardGeometry {
  return {
    width: mix(from.width, to.width, t),
    height: mix(from.height, to.height, t),
    x: mix(from.x, to.x, t),
    y: mix(from.y, to.y, t),
    rowHeight: mix(from.rowHeight, to.rowHeight, t),
    videoWidth: mix(from.videoWidth, to.videoWidth, t),
    videoHeight: mix(from.videoHeight, to.videoHeight, t),
    videoInset: mix(from.videoInset, to.videoInset, t),
    videoRadius: mix(from.videoRadius, to.videoRadius, t),
    topInset: mix(from.topInset, to.topInset, t),
    radius: mix(from.radius, to.radius, t),
  }
}

interface Insets {
  top: number
  bottom: number
}

const FALLBACK_INSETS: Insets = { top: 59, bottom: 34 }

interface CardGeometry {
  width: number
  height: number
  x: number
  y: number
  rowHeight: number
  videoWidth: number
  videoHeight: number
  videoInset: number
  videoRadius: number
  topInset: number
  radius: number
}

export function PlayerHost(props: {
  onOpenChannel: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
}): VirtualNode {
  const store: PlayerStoreSnapshot = usePlayerStore()
  const [showQualitySheet, setShowQualitySheet] = useState<boolean>(false)
  const [showDanmakuSheet, setShowDanmakuSheet] = useState<boolean>(false)
  const [videoFill, setVideoFill] = useState<boolean>(false)
  const [dragTranslation, setDragTranslation] = useState<number | null>(null)
  const [fullscreenGesture, setFullscreenGesture] = useState<{ direction: "enter" | "exit"; distance: number } | null>(null)
  const dragTravelRef = useRef<number>(1)
  const thresholdCrossedRef = useRef<boolean>(false)

  const onOpenChannelRef = useRef(props.onOpenChannel)
  onOpenChannelRef.current = props.onOpenChannel
  const openChannel = useCallback(
    (provider: Provider, authorId: string, authorName: string, avatarUrl?: string): void => {
      onOpenChannelRef.current(provider, authorId, authorName, avatarUrl)
    },
    [],
  )
  const openQualitySheet = useCallback((): void => setShowQualitySheet(true), [])
  const openDanmakuSheet = useCallback((): void => setShowDanmakuSheet(true), [])

  const handleMinimizeDragChanged = useCallback((dy: number, dx: number): void => {
    setDragTranslation(dy > 0 && dy > Math.abs(dx) ? dy : 0)
  }, [])
  const handleMinimizeDragEnded = useCallback((dy: number, dx: number, predictedDy: number): void => {
    const travel: number = dragTravelRef.current
    const projected: number = Math.max(dy, Math.min(predictedDy, dy + travel * 0.25))
    if (projected > travel * MINIMIZE_DRAG_RATIO && dy > Math.abs(dx)) minimizeToMiniPlayer()
    setDragTranslation(null)
  }, [])
  const handleFullscreenDragChanged = useCallback((direction: "enter" | "exit", translationY: number): void => {
    const distance: number = Math.max(0, direction === "enter" ? -translationY : translationY)
    const threshold: number = direction === "enter" ? ENTER_FULLSCREEN_MIN_DY : EXIT_FULLSCREEN_MIN_DY
    const crossed: boolean = distance >= threshold
    if (crossed !== thresholdCrossedRef.current) {
      thresholdCrossedRef.current = crossed
      if (crossed) HapticFeedback.lightImpact()
    }
    setFullscreenGesture({ direction, distance })
  }, [])
  const handleFullscreenDragEnded = useCallback(
    (direction: "enter" | "exit", translationY: number, predictedY: number): void => {
      thresholdCrossedRef.current = false
      if (direction === "enter") {
        const dy: number = -translationY
        const pred: number = -predictedY
        if (dy >= ENTER_FULLSCREEN_MIN_DY || (pred >= ENTER_FULLSCREEN_PREDICTED_DY && dy >= ENTER_FULLSCREEN_FLICK_DY)) {
          setFullscreen(true)
        }
      } else {
        const dy: number = translationY
        const pred: number = predictedY
        if (dy >= EXIT_FULLSCREEN_MIN_DY || (pred >= EXIT_FULLSCREEN_PREDICTED_DY && dy >= EXIT_FULLSCREEN_FLICK_DY)) {
          setFullscreen(false)
        }
      }
      setFullscreenGesture(null)
    },
    [],
  )
  const handleCancelFullscreenDrag = useCallback((): void => {
    thresholdCrossedRef.current = false
    setFullscreenGesture(null)
  }, [])
  const handleVideoFillChange = useCallback((fill: boolean): void => {
    setVideoFill(fill)
  }, [])

  const lastItemRef = useRef<UnifiedVideoItem | null>(null)
  if (store.currentItem) lastItemRef.current = store.currentItem
  const item: UnifiedVideoItem | null = store.currentItem ?? lastItemRef.current
  const surfaceMounted: boolean = item !== null

  const mode: PlayerPresentationMode = store.currentItem ? store.presentationMode : "hidden"
  const restingModeRef = useRef<PlayerPresentationMode>("expanded")
  if (mode !== "hidden") restingModeRef.current = mode
  const fullscreen: boolean = store.isFullscreen && mode === "expanded"

  const insetsRef = useRef<Insets>(FALLBACK_INSETS)
  const liveInsets = Device.safeAreaInsets
  if (!store.isFullscreen && liveInsets && liveInsets.leading === 0 && liveInsets.top > 0) {
    insetsRef.current = { top: liveInsets.top, bottom: liveInsets.bottom }
  }
  const insets: Insets = insetsRef.current

  useEffect(() => {
    setShowQualitySheet(false)
    setShowDanmakuSheet(false)
    setVideoFill(false)
  }, [store.currentItem?.id])

  useEffect(() => {
    if (!store.isFullscreen) setVideoFill(false)
  }, [store.isFullscreen])

  const shortSide: number = Math.min(Device.screen.width, Device.screen.height)
  const longSide: number = Math.max(Device.screen.width, Device.screen.height)
  const landscapeFullscreen: boolean = fullscreen && !store.isPortraitFullscreen
  const screenWidth: number = landscapeFullscreen ? longSide : shortSide
  const screenHeight: number = landscapeFullscreen ? shortSide : longSide

  const expanded: CardGeometry = {
    width: screenWidth,
    height: screenHeight,
    x: 0,
    y: 0,
    rowHeight: fullscreen ? screenHeight : Math.round(screenWidth * 9 / 16),
    videoWidth: screenWidth,
    videoHeight: fullscreen ? screenHeight : Math.round(screenWidth * 9 / 16),
    videoInset: 0,
    videoRadius: 0,
    topInset: fullscreen ? 0 : insets.top,
    radius: 0,
  }
  const miniY: number = screenHeight - insets.bottom - TAB_BAR_CLEARANCE - MINI_HEIGHT
  const miniVideoHeight: number = MINI_HEIGHT - MINI_VIDEO_INSET_V * 2
  const mini: CardGeometry = {
    width: screenWidth - MINI_MARGIN * 2,
    height: MINI_HEIGHT,
    x: MINI_MARGIN,
    y: miniY,
    rowHeight: MINI_HEIGHT,
    videoWidth: Math.round(miniVideoHeight * 16 / 9),
    videoHeight: miniVideoHeight,
    videoInset: MINI_VIDEO_INSET_LEADING,
    videoRadius: MINI_VIDEO_RADIUS,
    topInset: 0,
    radius: MINI_RADIUS,
  }
  const restsMini: boolean = restingModeRef.current === "mini"
  const settled: CardGeometry = mode === "mini"
    ? mini
    : mode === "expanded"
      ? expanded
      : restsMini
        ? { ...mini, y: screenHeight }
        : { ...expanded, y: screenHeight }

  const isExpanded: boolean = mode === "expanded"
  const isMini: boolean = mode === "mini"
  const watchHeight: number = Math.max(0, expanded.height - expanded.topInset - expanded.rowHeight)
  const miniBarWidth: number = mini.width - mini.videoWidth - mini.videoInset
  const dragTravel: number = Math.max(1, mini.y - expanded.y)
  dragTravelRef.current = dragTravel
  const drag: number | null = isExpanded && !fullscreen && dragTranslation !== null
    ? clamp01(dragTranslation / dragTravel)
    : null
  const geometry: CardGeometry = drag === null ? settled : blendGeometry(expanded, mini, drag)
  const morph: number = drag !== null ? drag : isMini ? 1 : 0
  const enterZooming: boolean = isExpanded && !fullscreen && fullscreenGesture?.direction === "enter"
  const exitShifting: boolean = fullscreen && fullscreenGesture?.direction === "exit"
  const enterProgress: number = enterZooming && fullscreenGesture ? clamp01(fullscreenGesture.distance / 120) : 0
  const exitProgress: number = exitShifting && fullscreenGesture ? clamp01(fullscreenGesture.distance / 120) : 0
  const watchOpacity: number = isExpanded ? clamp01(1 - morph / 0.3) : 0
  const watchZoomOpacity: number = 1 - enterProgress * 0.55
  const controlsOpacity: number = (1 - clamp01(morph / 0.3)) * (1 - clamp01(exitProgress / 0.35))
  const surfaceOpacity: number = 1 - clamp01((morph - 0.35) / 0.65)
  const miniBarOpacity: number = clamp01((morph - 0.5) / 0.5)
  const videoScale: number = enterZooming && fullscreenGesture
    ? 1 + (fullscreenGesture.distance / (fullscreenGesture.distance + 120)) * 0.14
    : exitShifting
      ? 1 - exitProgress * 0.06
      : 1
  const videoCornerRadius: number = exitShifting ? exitProgress * 16 : geometry.videoRadius
  const videoOffsetY: number = exitShifting && fullscreenGesture
    ? Math.min(
        140,
        fullscreenGesture.distance <= 60
          ? fullscreenGesture.distance * 0.85
          : 51 + (fullscreenGesture.distance - 60) * 0.45,
      )
    : 0
  const watchNode: VirtualNode = useMemo(
    () => (
      <WatchView
        onOpenChannel={openChannel}
        onOpenQualitySheet={openQualitySheet}
        onOpenDanmakuSheet={openDanmakuSheet}
      />
    ),
    [openChannel, openQualitySheet, openDanmakuSheet],
  )

  const surfaceColor = fullscreen ? "black" : "systemBackground"
  const fadeOut: Animation = motion.exit
  const fadeInLate: Animation = motion.enter.delay(MORPH_SECONDS - FADE_IN_SECONDS)

  return (
    <ZStack
      alignment="topLeading"
      coordinateSpace={PLAYER_DRAG_SPACE}
      frame={fullscreen
        ? { maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }
        : { width: screenWidth, height: screenHeight, alignment: "topLeading" }}
      ignoresSafeArea
    >
      <ZStack
        alignment="topLeading"
        frame={{ width: geometry.width, height: geometry.height, alignment: "topLeading" }}
        offset={{ x: geometry.x, y: geometry.y }}
        opacity={mode === "hidden" && restsMini ? 0 : 1}
        allowsHitTesting={mode !== "hidden"}
        animation={{
          animation: motion.morph,
          value: `${mode}|${fullscreen}|${store.isPortraitFullscreen}|${drag === null ? "settled" : "drag"}`,
        }}
        sheet={{
          isPresented: showQualitySheet,
          onChanged: setShowQualitySheet,
          content: <QualitySheet onDone={() => setShowQualitySheet(false)} />,
        }}
      >
        <ZStack
          frame={{ width: geometry.width, height: geometry.height }}
          opacity={morph}
          compositingGroup
          allowsHitTesting={false}
        >
          <RoundedRectangle
            cornerRadius={geometry.radius}
            style="continuous"
            fill="black"
            shadow={{ color: "rgba(0,0,0,0.25)", radius: 16, y: 6 }}
          />
          <RoundedRectangle cornerRadius={geometry.radius} style="continuous" fill="black" blendMode="destinationOut" />
        </ZStack>
        <ZStack
          alignment="top"
          frame={{ width: geometry.width, height: geometry.height, alignment: "top" }}
          clipShape={{ type: "rect", cornerRadius: geometry.radius, style: "continuous" }}
        >
          <Rectangle
            fill="rgba(0,0,0,0.001)"
            frame={{ width: geometry.width, height: geometry.height }}
            glassEffect={{ glass: UIGlass.regular(), shape: { type: "rect", cornerRadius: geometry.radius } }}
            opacity={morph}
          />
          <ZStack alignment="topLeading" frame={{ width: geometry.width, height: geometry.height, alignment: "topLeading" }}>
            <Rectangle
              fill={surfaceColor}
              frame={{ width: expanded.width, height: expanded.height }}
              opacity={surfaceOpacity}
              animation={{ animation: isMini ? fadeInLate : fadeOut, value: isMini }}
            />
          </ZStack>
          <VStack spacing={0} alignment="leading" frame={{ width: geometry.width, height: geometry.height, alignment: "top" }}>
            <Rectangle fill="black" frame={{ width: geometry.width, height: geometry.topInset }} />
            <HStack
              spacing={0}
              padding={{ leading: geometry.videoInset }}
              frame={{ width: geometry.width, height: geometry.rowHeight, alignment: "leading" }}
              zIndex={enterZooming ? 1 : 0}
            >
              <ZStack
                frame={{ width: geometry.videoWidth, height: geometry.videoHeight }}
                background="black"
                clipShape={{ type: "rect", cornerRadius: videoCornerRadius, style: "continuous" }}
                scaleEffect={{ x: videoScale, y: videoScale, anchor: enterZooming ? "top" : "center" }}
                offset={{ x: 0, y: videoOffsetY }}
                animation={{
                  animation: motion.morph,
                  value: fullscreenGesture ? "drag" : "settled",
                }}
                sheet={{
                  isPresented: showDanmakuSheet,
                  onChanged: setShowDanmakuSheet,
                  content: <DanmakuSheet onDone={() => setShowDanmakuSheet(false)} />,
                }}
              >
                {surfaceMounted ? (
                  <VideoPlaybackView
                    controller={getPlayerController()}
                    gestures={false}
                    videoGravity={isMini || (fullscreen && videoFill) ? "resizeAspectFill" : "resizeAspect"}
                    frame={{ width: geometry.videoWidth, height: geometry.videoHeight }}
                  />
                ) : (
                  <Rectangle fill="black" frame={{ width: geometry.videoWidth, height: geometry.videoHeight }} />
                )}
                {isExpanded ? (
                  <ZStack
                    opacity={controlsOpacity}
                    transition={Transition.asymmetric(
                      Transition.opacity().animation(fadeInLate),
                      Transition.opacity().animation(fadeOut),
                    )}
                  >
                    <PlayerControlsOverlay
                      width={geometry.videoWidth}
                      height={geometry.videoHeight}
                      topSafeInset={insets.top}
                      bottomSafeInset={insets.bottom}
                      dragSpace={PLAYER_DRAG_SPACE}
                      onOpenQualitySheet={() => setShowQualitySheet(true)}
                      onOpenDanmakuSheet={() => setShowDanmakuSheet(true)}
                      onMinimizeDragChanged={handleMinimizeDragChanged}
                      onMinimizeDragEnded={handleMinimizeDragEnded}
                      onFullscreenDragChanged={handleFullscreenDragChanged}
                      onFullscreenDragEnded={handleFullscreenDragEnded}
                      onCancelFullscreenDrag={handleCancelFullscreenDrag}
                      videoFill={videoFill}
                      onVideoFillChange={handleVideoFillChange}
                    />
                  </ZStack>
                ) : (
                  <Rectangle
                    fill="rgba(0,0,0,0.001)"
                    frame={{ width: geometry.videoWidth, height: geometry.videoHeight }}
                    onTapGesture={() => expandFromMiniPlayer()}
                  />
                )}
              </ZStack>
              <ZStack
                alignment="topLeading"
                frame={{ width: Math.max(0, geometry.width - geometry.videoWidth - geometry.videoInset), height: geometry.rowHeight, alignment: "topLeading" }}
                allowsHitTesting={isMini}
                clipped
                geometryGroup
              >
                <ZStack
                  frame={{ width: miniBarWidth, height: MINI_HEIGHT }}
                  opacity={miniBarOpacity}
                  animation={{ animation: isMini ? fadeInLate : fadeOut, value: isMini }}
                >
                  {morph > 0 ? (
                    <MiniPlayerBar
                      item={item}
                      height={MINI_HEIGHT}
                      trailingInset={MINI_RADIUS - MINI_BUTTON_SIZE / 2}
                    />
                  ) : null}
                </ZStack>
              </ZStack>
            </HStack>
            {fullscreen ? null : (
              <ZStack
                alignment="topLeading"
                frame={{ width: geometry.width, maxHeight: "infinity", alignment: "topLeading" }}
                allowsHitTesting={isExpanded}
                geometryGroup
              >
                <ZStack
                  frame={{ width: expanded.width, height: watchHeight, alignment: "top" }}
                  opacity={watchOpacity}
                  animation={{ animation: isExpanded ? fadeInLate : fadeOut, value: isExpanded }}
                >
                  <ZStack
                    frame={{ width: expanded.width, height: watchHeight, alignment: "top" }}
                    opacity={watchZoomOpacity}
                    animation={{ animation: motion.morph, value: enterZooming ? "drag" : "settled" }}
                  >
                    {watchNode}
                  </ZStack>
                </ZStack>
              </ZStack>
            )}
          </VStack>
        </ZStack>
      </ZStack>
    </ZStack>
  )
}
