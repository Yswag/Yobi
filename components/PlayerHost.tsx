import {
  HStack,
  Rectangle,
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
import type { PlayerPresentationMode, PlayerProgressSnapshot, PlayerStoreSnapshot } from "../state/playerStore"
import {
  expandFromMiniPlayer,
  getPlayerController,
  minimizeToMiniPlayer,
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
// 手勢掛在會移動的卡片上，位移一定要對一個「靜止」的座標空間量，不然誤差會隨卡片下移累積。
const PLAYER_DRAG_SPACE: string = "playerRoot"
// 卡片上緣跟著手指 1:1 走，所以「拖到迷你播放器位置」剛好就是收完；放開時走過這個比例才收。
const MINIMIZE_DRAG_RATIO: number = 0.45

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function mix(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

/** Same shape at any point between expanded and mini, so the card can follow the finger. */
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
  // 拖曳過程中手指的垂直位移（pt）；null 代表手指不在畫面上。
  const [dragTranslation, setDragTranslation] = useState<number | null>(null)
  // 展開到迷你的垂直距離，每次重繪更新，回呼裡要用最新值。
  const dragTravelRef = useRef<number>(1)

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

  // 垂直往下的拖曳才跟手；偏水平或往上就讓卡片留在展開位置。
  const handleMinimizeDragChanged = useCallback((dy: number, dx: number): void => {
    setDragTranslation(dy > 0 && dy > Math.abs(dx) ? dy : 0)
  }, [])
  const handleMinimizeDragEnded = useCallback((dy: number, dx: number, predictedDy: number): void => {
    const travel: number = dragTravelRef.current
    // 甩一下也算：預測位移最多多算 1/4 路程，免得小閃一下就收。
    const projected: number = Math.max(dy, Math.min(predictedDy, dy + travel * 0.25))
    // 先換模式再清位移：兩個更新若分成兩次重繪，中途也不會退回展開的幾何。
    if (projected > travel * MINIMIZE_DRAG_RATIO && dy > Math.abs(dx)) minimizeToMiniPlayer()
    setDragTranslation(null)
  }, [])

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
  const settled: CardGeometry = mode === "mini"
    ? mini
    : mode === "expanded"
      ? expanded
      : restsMini
        ? { ...mini, y: screenHeight }
        : { ...expanded, y: screenHeight }

  const isExpanded: boolean = mode === "expanded"
  const isMini: boolean = mode === "mini"
  // 插值用的路程：卡片從展開位置走到迷你播放器要走多遠。
  const dragTravel: number = Math.max(1, mini.y - expanded.y)
  dragTravelRef.current = dragTravel
  // 拖曳中、且還在展開狀態時才跟手；進度直接拿位移除以路程，卡片上緣才會貼著手指。
  const drag: number | null = isExpanded && !fullscreen && dragTranslation !== null
    ? clamp01(dragTranslation / dragTravel)
    : null
  const geometry: CardGeometry = drag === null ? settled : blendGeometry(expanded, mini, drag)
  // 0 = 完全展開、1 = 完全收成迷你播放器；分層的不透明度都吃這個值。
  const morph: number = drag !== null ? drag : isMini ? 1 : 0
  const watchOpacity: number = isExpanded ? clamp01(1 - morph / 0.3) : 0
  const controlsOpacity: number = 1 - clamp01(morph / 0.3)
  const surfaceOpacity: number = 1 - clamp01((morph - 0.35) / 0.65)
  const miniBarOpacity: number = clamp01((morph - 0.5) / 0.5)
  // 跟手拖曳時這個元件每幀重繪；播放頁自己接 store，不必跟著重建。
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

  const duration: number = progress.duration > 0 ? progress.duration : item?.duration ?? 0
  const ratio: number = duration > 0 ? progress.position / duration : 0
  const surfaceColor = fullscreen ? "black" : "systemBackground"
  const fadeOut: Animation = Animation.easeOut(FADE_OUT_SECONDS)
  const fadeInLate: Animation = Animation.easeOut(FADE_IN_SECONDS).delay(MORPH_SECONDS - FADE_IN_SECONDS)

  return (
    <ZStack
      alignment="topLeading"
      coordinateSpace={PLAYER_DRAG_SPACE}
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
        shadow={{
          color: morph > 0 ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0)",
          radius: 16 * morph,
          y: 6 * morph,
        }}
        // 拖曳途中值不變，所以幾何直接貼著手指；放開後才用動畫收尾。
        animation={{
          animation: Animation.smooth({ duration: MORPH_SECONDS }),
          value: `${mode}|${fullscreen}|${drag === null ? "settled" : "drag"}`,
        }}
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
            opacity={morph}
          />
          <Rectangle
            fill={surfaceColor}
            frame={{ width: geometry.width, height: geometry.height }}
            opacity={surfaceOpacity}
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
                    opacity={controlsOpacity}
                    transition={Transition.asymmetric(
                      Transition.opacity().animation(fadeInLate),
                      Transition.opacity().animation(fadeOut),
                    )}
                  >
                    <PlayerControlsOverlay
                      width={geometry.videoWidth}
                      height={geometry.videoHeight}
                      dragSpace={PLAYER_DRAG_SPACE}
                      onOpenQualitySheet={() => setShowQualitySheet(true)}
                      onOpenDanmakuSheet={() => setShowDanmakuSheet(true)}
                      onMinimizeDragChanged={handleMinimizeDragChanged}
                      onMinimizeDragEnded={handleMinimizeDragEnded}
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
                opacity={miniBarOpacity}
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
                opacity={watchOpacity}
                animation={{ animation: isExpanded ? fadeInLate : fadeOut, value: isExpanded }}
                allowsHitTesting={isExpanded}
              >
                {watchNode}
              </ZStack>
            )}
          </VStack>
        </ZStack>
      </ZStack>
    </ZStack>
  )
}
