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
import type { OpenChannel, Provider, UnifiedVideoItem } from "../types/index"
import type { PlayerPresentationMode, PlayerStoreSnapshot } from "../state/playerStore"
import { expandFromMiniPlayer, getPlayerController, usePlayerSelector } from "../state/playerStore"
import { MINI_BUTTON_SIZE, MiniPlayerBar } from "./MiniPlayerBar"
import { motion } from "../ui/theme"
import { DanmakuSheet, QualitySheet } from "./PlaybackSheets"
import { PlayerControlsOverlay } from "./PlayerControlsOverlay"
import { FALLBACK_INSETS, MINI_HEIGHT, MINI_RADIUS, computePlayerLayout } from "./player/geometry"
import type { CardGeometry, Insets, PlayerLayout } from "./player/geometry"
import { usePlayerGestures } from "./player/usePlayerGestures"

export { MINI_PLAYER_RESERVED_HEIGHT } from "./player/geometry"

export interface PlayerWatchRenderProps {
  onOpenChannel: OpenChannel
  onOpenQualitySheet: () => void
  onOpenDanmakuSheet: () => void
}

const MORPH_SECONDS: number = motion.duration.morph
const FADE_OUT_SECONDS: number = motion.duration.exit
const FADE_IN_SECONDS: number = motion.duration.enter
const PLAYER_DRAG_SPACE: string = "playerRoot"

export function PlayerHost(props: {
  onOpenChannel: OpenChannel
  renderWatch: (watchProps: PlayerWatchRenderProps) => VirtualNode
}): VirtualNode {
  const store = usePlayerSelector((s: PlayerStoreSnapshot) => ({
    currentItem: s.currentItem,
    presentationMode: s.presentationMode,
    isFullscreen: s.isFullscreen,
    isPortraitFullscreen: s.isPortraitFullscreen,
    isLoading: s.status === "loading",
  }))
  const [showQualitySheet, setShowQualitySheet] = useState<boolean>(false)
  const [showDanmakuSheet, setShowDanmakuSheet] = useState<boolean>(false)
  const [videoFill, setVideoFill] = useState<boolean>(false)
  const gestures = usePlayerGestures()

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
  const closeQualitySheet = useCallback((): void => setShowQualitySheet(false), [])
  const closeDanmakuSheet = useCallback((): void => setShowDanmakuSheet(false), [])
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
  const restsMini: boolean = restingModeRef.current === "mini"
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

  const layout: PlayerLayout = computePlayerLayout({
    mode,
    fullscreen,
    restingMini: restsMini,
    screenWidth,
    screenHeight,
    insets,
    dragTranslation: gestures.dragTranslation,
    fullscreenGesture: gestures.fullscreenGesture,
  })
  gestures.dragTravelRef.current = layout.dragTravel

  const geometry: CardGeometry = layout.geometry
  const expanded: CardGeometry = layout.expanded
  const isExpanded: boolean = layout.isExpanded
  const isMini: boolean = layout.isMini
  const watchHeight: number = layout.watchHeight
  const miniBarWidth: number = layout.miniBarWidth
  const drag: number | null = layout.drag
  const morph: number = layout.morph
  const enterZooming: boolean = layout.enterZooming
  const watchOpacity: number = layout.watchOpacity
  const watchZoomOpacity: number = layout.watchZoomOpacity
  const controlsOpacity: number = layout.controlsOpacity
  const surfaceOpacity: number = layout.surfaceOpacity
  const miniBarOpacity: number = layout.miniBarOpacity
  const videoScale: number = layout.videoScale
  const videoCornerRadius: number = layout.videoCornerRadius
  const videoOffsetY: number = layout.videoOffsetY

  const watchNode: VirtualNode = useMemo(
    () =>
      props.renderWatch({
        onOpenChannel: openChannel,
        onOpenQualitySheet: openQualitySheet,
        onOpenDanmakuSheet: openDanmakuSheet,
      }),
    [props.renderWatch, openChannel, openQualitySheet, openDanmakuSheet],
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
          content: <QualitySheet onDone={closeQualitySheet} />,
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
                  value: gestures.fullscreenGesture ? "drag" : "settled",
                }}
                sheet={{
                  isPresented: showDanmakuSheet,
                  onChanged: setShowDanmakuSheet,
                  content: <DanmakuSheet onDone={closeDanmakuSheet} />,
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
                <Rectangle
                  fill="black"
                  frame={{ width: geometry.videoWidth, height: geometry.videoHeight }}
                  opacity={store.isLoading ? 1 : 0}
                  allowsHitTesting={false}
                  animation={{ animation: motion.exit, value: store.isLoading }}
                />
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
                      onOpenQualitySheet={openQualitySheet}
                      onOpenDanmakuSheet={openDanmakuSheet}
                      onMinimizeDragChanged={gestures.handleMinimizeDragChanged}
                      onMinimizeDragEnded={gestures.handleMinimizeDragEnded}
                      onFullscreenDragChanged={gestures.handleFullscreenDragChanged}
                      onFullscreenDragEnded={gestures.handleFullscreenDragEnded}
                      onCancelFullscreenDrag={gestures.handleCancelFullscreenDrag}
                      videoFill={videoFill}
                      onVideoFillChange={handleVideoFillChange}
                    />
                  </ZStack>
                ) : (
                  <Rectangle
                    fill="rgba(0,0,0,0.001)"
                    frame={{ width: geometry.videoWidth, height: geometry.videoHeight }}
                    onTapGesture={expandFromMiniPlayer}
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
