import {
  HStack,
  Rectangle,
  VideoPlaybackView,
  VStack,
  ZStack,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { Provider, UnifiedVideoItem } from "../types"
import type { PlayerPresentationMode, PlayerProgressSnapshot, PlayerStoreSnapshot } from "../state/playerStore"
import {
  expandFromMiniPlayer,
  getPlayerController,
  usePlayerProgress,
  usePlayerStore,
} from "../state/playerStore"
import { MINI_BUTTON_SIZE, MiniPlayerBar } from "./MiniPlayerBar"
import { DanmakuSheet, QualitySheet } from "./PlaybackSheets"
import { PlayerControlsOverlay } from "./PlayerControlsOverlay"
import { WatchView } from "../views/WatchView"

// Sized and inset to line up with the floating tab bar, like the system bottom accessory.
const MINI_HEIGHT: number = 56
const MINI_MARGIN: number = 21
const MINI_RADIUS: number = MINI_HEIGHT / 2
// A plain rounded rect, pulled in far enough that its leading corners clear the capsule's curve.
const MINI_VIDEO_INSET_V: number = 8
const MINI_VIDEO_INSET_LEADING: number = 10
const MINI_VIDEO_RADIUS: number = 10
// From the bottom safe-area edge up to the tab bar's top edge, plus the gap above it.
const TAB_BAR_CLEARANCE: number = 44 + 8
/** Space pages keep free above the tab bar while a video is loaded. */
export const MINI_PLAYER_RESERVED_HEIGHT: number = MINI_HEIGHT + 8
const MORPH_SECONDS: number = 0.38
// Layers that belong to only one end of the morph leave right away and arrive in its last stretch,
// so nothing is half-visible while the card is still changing shape.
const FADE_OUT_SECONDS: number = 0.12
const FADE_IN_SECONDS: number = 0.2

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

/**
 * The only place the player controller is bound to a surface. It stays mounted for the app's lifetime;
 * expanding, minimizing, fullscreen and closing only change this card's frame and offset, so the video
 * view never detaches and re-attaches.
 */
export function PlayerHost(props: {
  onOpenChannel: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
}): VirtualNode {
  const store: PlayerStoreSnapshot = usePlayerStore()
  const progress: PlayerProgressSnapshot = usePlayerProgress()
  const [showQualitySheet, setShowQualitySheet] = useState<boolean>(false)
  const [showDanmakuSheet, setShowDanmakuSheet] = useState<boolean>(false)

  // 這個元件隨播放進度重繪；給 WatchView 的回呼要固定，不然整個播放頁跟著重繪。
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

  // Keep drawing the last video while the card slides away after closing.
  const lastItemRef = useRef<UnifiedVideoItem | null>(null)
  if (store.currentItem) lastItemRef.current = store.currentItem
  const item: UnifiedVideoItem | null = store.currentItem ?? lastItemRef.current
  // A surface bound before the controller has ever opened media stays black on the first video.
  // Attach it with the first video instead, then keep it for the app's lifetime.
  const surfaceMounted: boolean = item !== null

  const mode: PlayerPresentationMode = store.currentItem ? store.presentationMode : "hidden"
  // Where a hidden card rests: closing from the mini bar drops it below the tab bar, otherwise it waits under the screen.
  const restingModeRef = useRef<PlayerPresentationMode>("expanded")
  if (mode !== "hidden") restingModeRef.current = mode
  const fullscreen: boolean = store.isFullscreen && mode === "expanded"

  // Window insets turn to landscape values in fullscreen; remember the portrait ones.
  const insetsRef = useRef<Insets>(FALLBACK_INSETS)
  const liveInsets = Device.safeAreaInsets
  if (!store.isFullscreen && liveInsets && liveInsets.leading === 0 && liveInsets.top > 0) {
    insetsRef.current = { top: liveInsets.top, bottom: liveInsets.bottom }
  }
  const insets: Insets = insetsRef.current

  useEffect(() => {
    setShowQualitySheet(false)
    setShowDanmakuSheet(false)
  }, [store.currentItem?.id])

  const shortSide: number = Math.min(Device.screen.width, Device.screen.height)
  const longSide: number = Math.max(Device.screen.width, Device.screen.height)
  const screenWidth: number = fullscreen ? longSide : shortSide
  const screenHeight: number = fullscreen ? shortSide : longSide

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
  const geometry: CardGeometry = mode === "mini"
    ? mini
    : mode === "expanded"
      ? expanded
      : restsMini
        ? { ...mini, y: screenHeight }
        : { ...expanded, y: screenHeight }

  const isExpanded: boolean = mode === "expanded"
  const isMini: boolean = mode === "mini"
  const duration: number = progress.duration > 0 ? progress.duration : item?.duration ?? 0
  const ratio: number = duration > 0 ? progress.position / duration : 0
  const surfaceColor = fullscreen ? "black" : "systemBackground"
  const fadeOut: Animation = Animation.easeOut(FADE_OUT_SECONDS)
  const fadeInLate: Animation = Animation.easeOut(FADE_IN_SECONDS).delay(MORPH_SECONDS - FADE_IN_SECONDS)

  return (
    <ZStack
      alignment="topLeading"
      // In landscape the root is shorter than the screen, so a fixed-size frame would be centered and leave a gap.
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
        shadow={isMini ? { color: "rgba(0,0,0,0.25)", radius: 16, y: 6 } : { color: "rgba(0,0,0,0)", radius: 0 }}
        animation={{ animation: Animation.smooth({ duration: MORPH_SECONDS }), value: `${mode}|${fullscreen}` }}
        sheet={{
          isPresented: showQualitySheet,
          onChanged: setShowQualitySheet,
          content: <QualitySheet onDone={() => setShowQualitySheet(false)} />,
        }}
      >
        <ZStack
          alignment="top"
          frame={{ width: geometry.width, height: geometry.height, alignment: "top" }}
          clipShape={{ type: "rect", cornerRadius: geometry.radius, style: "continuous" }}
        >
          <Rectangle
            fill="rgba(0,0,0,0.001)"
            frame={{ width: geometry.width, height: geometry.height }}
            glassEffect={{ glass: UIGlass.regular(), shape: { type: "rect", cornerRadius: geometry.radius } }}
            opacity={isMini ? 1 : 0}
          />
          <Rectangle
            fill={surfaceColor}
            frame={{ width: geometry.width, height: geometry.height }}
            opacity={isMini ? 0 : 1}
            animation={{ animation: isMini ? fadeInLate : fadeOut, value: isMini }}
          />
          <VStack spacing={0} alignment="leading" frame={{ width: geometry.width, height: geometry.height, alignment: "top" }}>
            <Rectangle fill="black" frame={{ width: geometry.width, height: geometry.topInset }} />
            <HStack
              spacing={0}
              padding={{ leading: geometry.videoInset }}
              frame={{ width: geometry.width, height: geometry.rowHeight, alignment: "leading" }}
            >
              <ZStack
                frame={{ width: geometry.videoWidth, height: geometry.videoHeight }}
                background="black"
                clipShape={{ type: "rect", cornerRadius: geometry.videoRadius, style: "continuous" }}
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
                    videoGravity={isMini ? "resizeAspectFill" : "resizeAspect"}
                    frame={{ width: geometry.videoWidth, height: geometry.videoHeight }}
                  />
                ) : (
                  <Rectangle fill="black" frame={{ width: geometry.videoWidth, height: geometry.videoHeight }} />
                )}
                {isExpanded ? (
                  <ZStack
                    transition={Transition.asymmetric(
                      Transition.opacity().animation(fadeInLate),
                      Transition.opacity().animation(fadeOut),
                    )}
                  >
                    <PlayerControlsOverlay
                      width={geometry.videoWidth}
                      height={geometry.videoHeight}
                      onOpenQualitySheet={() => setShowQualitySheet(true)}
                      onOpenDanmakuSheet={() => setShowDanmakuSheet(true)}
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
                frame={{ width: Math.max(0, geometry.width - geometry.videoWidth - geometry.videoInset), height: geometry.rowHeight }}
                opacity={isMini ? 1 : 0}
                animation={{ animation: isMini ? fadeInLate : fadeOut, value: isMini }}
                allowsHitTesting={isMini}
                clipped
              >
                <MiniPlayerBar
                  item={item}
                  height={MINI_HEIGHT}
                  progress={ratio}
                  trailingInset={MINI_RADIUS - MINI_BUTTON_SIZE / 2}
                />
              </ZStack>
            </HStack>
            {fullscreen ? null : (
              <ZStack
                frame={{ width: geometry.width, maxHeight: "infinity", alignment: "top" }}
                opacity={isExpanded ? 1 : 0}
                animation={{ animation: isExpanded ? fadeInLate : fadeOut, value: isExpanded }}
                allowsHitTesting={isExpanded}
              >
                <WatchView
                  onOpenChannel={openChannel}
                  onOpenQualitySheet={openQualitySheet}
                  onOpenDanmakuSheet={openDanmakuSheet}
                />
              </ZStack>
            )}
          </VStack>
        </ZStack>
      </ZStack>
    </ZStack>
  )
}
