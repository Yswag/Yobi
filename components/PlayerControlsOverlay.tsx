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
  useEffect,
  useRef,
  useState,
} from "scripting"
import type { Color, DragGestureDetails, Point, VirtualNode } from "scripting"
import type { PlayerProgressSnapshot, PlayerStoreSnapshot } from "../state/playerStore"
import {
  dismissActiveSponsorSegment,
  minimizeToMiniPlayer,
  openVideo,
  seekBy,
  seekTo,
  selectSubtitle,
  setPlaybackRate,
  setTemporaryBoost2x,
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
  providerAccentColor,
  providerBadgeLabel,
} from "../utils/format"

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

function deliveryLabel(store: PlayerStoreSnapshot): string {
  const delivery: string | undefined = store.manifest?.delivery
  if (!delivery) return ""
  if (delivery === "progressive") return "MP4"
  return delivery.toUpperCase()
}

function toColor(value: string): Color {
  return value as Color
}

function capsuleBackground(color: string): { style: Color; shape: "capsule" } {
  return { style: toColor(color), shape: "capsule" }
}

export function PlayerControlsOverlay(props: PlayerControlsOverlayProps): VirtualNode {
  const store: PlayerStoreSnapshot = usePlayerStore()
  const progress: PlayerProgressSnapshot = usePlayerProgress()

  const [controlsVisible, setControlsVisible] = useState<boolean>(true)
  const [scrubPreviewSec, setScrubPreviewSec] = useState<number>(0)
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false)
  const [tapHint, setTapHint] = useState<"left" | "right" | null>(null)

  const lastTapAtRef = useRef<number | null>(null)
  const hideTimerRef = useRef<number | null>(null)
  const hintTimerRef = useRef<number | null>(null)
  const scrubTargetRef = useRef<number | null>(null)
  const draggingHorizontallyRef = useRef<boolean>(false)
  const statusRef = useRef<string>(store.status)
  statusRef.current = store.status

  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current)
      if (hintTimerRef.current !== null) clearTimeout(hintTimerRef.current)
    }
  }, [])

  const duration: number = progress.duration || 0
  const trackWidth: number = Math.max(1, props.width - 24)
  const accentColor: Color = toColor(providerAccentColor(store.currentItem?.provider ?? "yt"))

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
        void togglePlayPause()
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

  function scrubSpan(): number {
    return Math.min(180, Math.max(60, duration * 0.5))
  }

  function handleDragChanged(d: DragGestureDetails): void {
    const dx: number = d.translation.width
    const dy: number = d.translation.height
    if (Math.abs(dx) <= Math.abs(dy) * 1.3) return
    if (!draggingHorizontallyRef.current) {
      if (Math.abs(dx) < 16) return
      draggingHorizontallyRef.current = true
    }
    const span: number = scrubSpan()
    const upperBound: number = duration > 0 ? duration : span
    const moved: number = (dx / Math.max(1, props.width)) * span
    const target: number = Math.min(upperBound, Math.max(0, progress.position + moved))
    scrubTargetRef.current = target
    setScrubPreviewSec(target)
    setIsScrubbing(true)
  }

  function handleDragEnded(): void {
    if (!draggingHorizontallyRef.current) return
    const target: number | null = scrubTargetRef.current
    draggingHorizontallyRef.current = false
    scrubTargetRef.current = null
    setIsScrubbing(false)
    if (target !== null) void seekTo(target)
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
    setScrubPreviewSec(value)
    setIsScrubbing(true)
    void seekTo(value)
  }

  function renderSponsorBlocks(fullWidth: number, blockHeight: number): VirtualNode[] {
    if (duration <= 0) return []
    return store.sponsorSegments.map((seg: SponsorSegment) => {
      const leftRatio: number = Math.max(0, Math.min(1, seg.startTime / duration))
      const widthRatio: number = Math.max(0, Math.min(1 - leftRatio, (seg.endTime - seg.startTime) / duration))
      return (
        <Rectangle
          key={seg.uuid}
          fill={toColor(SPONSOR_CATEGORY_COLORS[seg.category])}
          frame={{ width: Math.max(2, fullWidth * widthRatio), height: blockHeight }}
          offset={{ x: fullWidth * leftRatio, y: 0 }}
        />
      )
    })
  }

  function renderBoostCapsule(): VirtualNode {
    return (
      <HStack spacing={5} padding={{ horizontal: 12, vertical: 6 }} background={capsuleBackground("rgba(0, 0, 0, 0.72)")}>
        <Image systemName="forward.fill" font={11} foregroundStyle="white" />
        <Text font={12} fontWeight="semibold" foregroundStyle="white">2.0x 倍速快進中</Text>
      </HStack>
    )
  }

  function renderTapHintCapsule(): VirtualNode | null {
    if (tapHint === null) return null
    const forward: boolean = tapHint === "right"
    return (
      <HStack spacing={5} padding={{ horizontal: 12, vertical: 6 }} background={capsuleBackground("rgba(0, 0, 0, 0.72)")}>
        <Image systemName={forward ? "goforward.10" : "gobackward.10"} font={12} foregroundStyle="white" />
        <Text font={12} fontWeight="semibold" foregroundStyle="white">10 秒</Text>
      </HStack>
    )
  }

  function renderScrubCapsule(): VirtualNode {
    return (
      <HStack spacing={4} padding={{ horizontal: 14, vertical: 8 }} background={capsuleBackground("rgba(0, 0, 0, 0.78)")}>
        <Text font={13} fontWeight="semibold" foregroundStyle="white" monospaced>
          {`${formatDuration(scrubPreviewSec)} / ${formatDuration(duration)}`}
        </Text>
      </HStack>
    )
  }

  function renderControlsLayer(): VirtualNode {
    const title: string = store.currentItem?.title ?? ""
    const provider = store.currentItem?.provider ?? "yt"
    const modeLabel: string = deliveryLabel(store)
    const sliderMax: number = Math.max(1, progress.duration || 1)
    const sliderValue: number = isScrubbing
      ? scrubPreviewSec
      : Math.min(progress.position, sliderMax)

    return (
      <ZStack frame={{ width: props.width, height: props.height }}>
        <Rectangle
          fill="rgba(0, 0, 0, 0.45)"
          frame={{ width: props.width, height: props.height }}
          allowsHitTesting={false}
        />
        <VStack spacing={0} frame={{ width: props.width, height: props.height }}>
          <HStack spacing={8} padding={{ horizontal: 12, vertical: 8 }}>
            <Button action={handleBack} buttonStyle="plain">
              <Image
                systemName={store.isFullscreen ? "chevron.left" : "chevron.down"}
                font={15}
                foregroundStyle="white"
                frame={{ width: 30, height: 30 }}
              />
            </Button>
            <HStack spacing={6}>
              <Text
                font={10}
                fontWeight="bold"
                foregroundStyle="white"
                padding={{ horizontal: 5, vertical: 2 }}
                background={{ style: toColor(providerAccentColor(provider)), shape: { type: "rect", cornerRadius: 4 } }}
              >
                {providerBadgeLabel(provider)}
              </Text>
              {modeLabel.length > 0 ? (
                <Text
                  font={10}
                  fontWeight="bold"
                  foregroundStyle="white"
                  padding={{ horizontal: 5, vertical: 2 }}
                  background={{ style: "rgba(255, 255, 255, 0.22)", shape: { type: "rect", cornerRadius: 4 } }}
                >
                  {modeLabel}
                </Text>
              ) : null}
            </HStack>
            <Text font={13} fontWeight="semibold" foregroundStyle="white" lineLimit={1} layoutPriority={1}>
              {title}
            </Text>
            <Spacer />
            <HStack spacing={12}>
              {provider === "bili" ? (
                <Button action={() => toggleDanmaku()} buttonStyle="plain">
                  <Image
                    systemName={store.danmakuEnabled ? "bubble.left.and.bubble.right.fill" : "bubble.left.and.bubble.right"}
                    font={16}
                    foregroundStyle="white"
                    frame={{ width: 30, height: 30 }}
                  />
                </Button>
              ) : null}
              {provider === "bili" ? (
                <Button action={() => props.onOpenDanmakuSheet?.()} buttonStyle="plain">
                  <Image
                    systemName="slider.horizontal.3"
                    font={16}
                    foregroundStyle="white"
                    frame={{ width: 30, height: 30 }}
                  />
                </Button>
              ) : null}
              <Button action={() => props.onOpenQualitySheet?.()} buttonStyle="plain">
                <Text
                  font={11}
                  fontWeight="semibold"
                  foregroundStyle="white"
                  padding={{ horizontal: 7, vertical: 3 }}
                  border={{ style: "rgba(255, 255, 255, 0.45)", width: 1 }}
                  background={{ style: "rgba(255, 255, 255, 0.12)", shape: { type: "rect", cornerRadius: 6 } }}
                >
                  {store.selectedQualityLabel}
                </Text>
              </Button>
              <Button action={() => void startPiP()} buttonStyle="plain">
                <Image systemName="pip.enter" font={16} foregroundStyle="white" frame={{ width: 30, height: 30 }} />
              </Button>
            </HStack>
          </HStack>

          <Spacer />

          <HStack spacing={40}>
            <Button action={() => void seekBy(-10)} buttonStyle="plain">
              <Image systemName="gobackward.10" font={24} foregroundStyle="white" />
            </Button>
            <Button action={() => void togglePlayPause()} buttonStyle="plain">
              <ZStack
                frame={{ width: 48, height: 48 }}
                background={{ style: "rgba(0, 0, 0, 0.5)", shape: "circle" }}
              >
                <Image
                  systemName={store.status === "playing" ? "pause.fill" : "play.fill"}
                  font={26}
                  foregroundStyle="white"
                />
              </ZStack>
            </Button>
            <Button action={() => void seekBy(10)} buttonStyle="plain">
              <Image systemName="goforward.10" font={24} foregroundStyle="white" />
            </Button>
          </HStack>

          <Spacer />

          <VStack spacing={4} padding={{ horizontal: 12, bottom: 8 }}>
            <ZStack alignment="leading" frame={{ width: trackWidth, height: 18 }}>
              <Slider
                min={0}
                max={sliderMax}
                step={0.5}
                value={sliderValue}
                onChanged={handleSliderChanged}
                onEditingChanged={(editing: boolean) => {
                  if (!editing) setIsScrubbing(false)
                }}
              />
              <ZStack
                alignment="leading"
                frame={{ width: trackWidth, height: 4 }}
                offset={{ x: 0, y: 14 }}
                allowsHitTesting={false}
              >
                {renderSponsorBlocks(trackWidth, 4)}
              </ZStack>
            </ZStack>
            <HStack spacing={6}>
              <Text font={11} foregroundStyle="white" monospaced>
                {`${formatDuration(progress.position)} / ${formatDuration(progress.duration)}`}
              </Text>
              {progress.activeChapter ? (
                <Text font={11} foregroundStyle="rgba(255, 255, 255, 0.85)" lineLimit={1}>
                  {` • ${progress.activeChapter.title}`}
                </Text>
              ) : null}
              <Spacer />
              {(store.manifest?.subtitles.length ?? 0) > 0 ? (
                <Menu
                  label={
                    <HStack spacing={3}>
                      <Image
                        systemName={store.selectedSubtitleId ? "captions.bubble.fill" : "captions.bubble"}
                        font={12}
                        foregroundStyle="white"
                      />
                      <Text font={11} foregroundStyle="white">字幕</Text>
                    </HStack>
                  }
                >
                  <Button title={store.selectedSubtitleId ? "關閉字幕" : "✓ 關閉字幕"} action={() => void selectSubtitle(null)} />
                  {(store.manifest?.subtitles ?? []).map((track: SubtitleTrackInfo) => (
                    <Button
                      key={track.id}
                      title={`${store.selectedSubtitleId === track.id ? "✓ " : ""}${track.label}`}
                      action={() => void selectSubtitle(track.id)}
                    />
                  ))}
                </Menu>
              ) : null}
              <Menu
                label={
                  <HStack spacing={2}>
                    <Text font={11} foregroundStyle="white">{`${store.playbackRate}x`}</Text>
                  </HStack>
                }
              >
                {PLAYBACK_RATES.map((rate: number) => (
                  <Button
                    key={String(rate)}
                    title={`${store.playbackRate === rate ? "✓ " : ""}${rate.toFixed(rate === Math.floor(rate) ? 1 : 2)}x`}
                    action={() => setPlaybackRate(rate)}
                  />
                ))}
              </Menu>
              <Button action={() => toggleFullscreen()} buttonStyle="plain">
                <Image
                  systemName={store.isFullscreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right"}
                  font={15}
                  foregroundStyle="white"
                  frame={{ width: 28, height: 28 }}
                />
              </Button>
            </HStack>
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
            <HStack spacing={0} padding={{ top: 12 }}>{renderBoostCapsule()}</HStack>
            <Spacer />
          </VStack>
        ) : null}

        {tapHint !== null ? (
          <ZStack
            frame={{ width: props.width, height: props.height }}
            alignment={tapHint === "left" ? "leading" : "trailing"}
          >
            <HStack spacing={0} padding={{ horizontal: 18 }}>{renderTapHintCapsule()}</HStack>
          </ZStack>
        ) : null}

        {isScrubbing ? (
          <ZStack frame={{ width: props.width, height: props.height }}>
            {renderScrubCapsule()}
          </ZStack>
        ) : null}

        {loading ? (
          <ZStack frame={{ width: props.width, height: props.height }}>
            <VStack spacing={8}>
              <ProgressView tint="white" />
              <Text font={11} foregroundStyle="rgba(255, 255, 255, 0.85)">
                {store.status === "buffering" ? "緩衝中…" : "載入中…"}
              </Text>
            </VStack>
          </ZStack>
        ) : null}

        {store.status === "error" ? (
          <ZStack
            frame={{ width: props.width, height: props.height }}
            background="rgba(0, 0, 0, 0.58)"
          >
            <VStack spacing={10}>
              <Text font={12} foregroundStyle="rgba(255, 255, 255, 0.9)" multilineTextAlignment="center" padding={{ horizontal: 28 }}>
                {store.errorText ?? "播放發生錯誤"}
              </Text>
              <Button action={handleRetry} buttonStyle="borderedProminent" controlSize="small" tint="white">
                <Text font={12} fontWeight="semibold">重試</Text>
              </Button>
            </VStack>
          </ZStack>
        ) : null}

        {store.skippedToast ? (
          <ZStack
            frame={{ width: props.width, height: props.height }}
            alignment="bottomLeading"
          >
            <HStack spacing={6} padding={{ leading: 14, bottom: 42 }}>
              <HStack
                spacing={6}
                padding={{ horizontal: 10, vertical: 5 }}
                background={capsuleBackground("rgba(0, 0, 0, 0.72)")}
              >
                <ZStack frame={{ width: 6, height: 6 }} background={{ style: "rgba(0, 212, 0, 1)", shape: "circle" }} />
                <Text font={11} foregroundStyle="white" lineLimit={1}>{store.skippedToast}</Text>
              </HStack>
            </HStack>
          </ZStack>
        ) : null}

        {prompt !== null ? (
          <ZStack
            frame={{ width: props.width, height: props.height }}
            alignment="bottomTrailing"
          >
            <HStack spacing={6} padding={{ trailing: 14, bottom: 42 }}>
              <Button action={() => skipActiveSponsorSegment()} buttonStyle="plain">
                <HStack
                  spacing={5}
                  padding={{ horizontal: 10, vertical: 6 }}
                  background={capsuleBackground("rgba(0, 0, 0, 0.78)")}
                >
                  <ZStack
                    frame={{ width: 6, height: 6 }}
                    background={{ style: toColor(SPONSOR_CATEGORY_COLORS[prompt.category]), shape: "circle" }}
                  />
                  <Text font={11} fontWeight="semibold" foregroundStyle="white">
                    {`跳過${SPONSOR_CATEGORY_LABELS[prompt.category] ?? "片段"} (${promptSeconds}s)`}
                  </Text>
                </HStack>
              </Button>
              <Button action={() => dismissActiveSponsorSegment()} buttonStyle="plain">
                <ZStack
                  frame={{ width: 22, height: 22 }}
                  background={{ style: "rgba(0, 0, 0, 0.78)", shape: "circle" }}
                >
                  <Image systemName="xmark" font={10} foregroundStyle="rgba(255, 255, 255, 0.85)" />
                </ZStack>
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
      <ZStack frame={{ width: props.width, height: props.height }} alignment="bottom">
        <ZStack
          alignment="leading"
          frame={{ width: props.width, height: 2.5 }}
          background="rgba(255, 255, 255, 0.2)"
        >
          <Rectangle fill={accentColor} frame={{ width: props.width * ratio, height: 2.5 }} />
          {renderSponsorBlocks(props.width, 2.5)}
        </ZStack>
      </ZStack>
    )
  }

  return (
    <ZStack frame={{ width: props.width, height: props.height }}>
      <Rectangle
        fill="rgba(0, 0, 0, 0.001)"
        frame={{ width: props.width, height: props.height }}
        onTapGesture={{ count: 1, coordinateSpace: "local", perform: handleTap }}
        onLongPressGesture={{
          minDuration: 400,
          perform: () => {},
          onPressingChanged: (pressing: boolean) => setTemporaryBoost2x(pressing),
        }}
        onDragGesture={{
          minDistance: 16,
          coordinateSpace: "local",
          onChanged: handleDragChanged,
          onEnded: () => handleDragEnded(),
        }}
      />
      {controlsVisible ? renderControlsLayer() : null}
      {renderFloatingLayer()}
      {renderThinProgressBar()}
    </ZStack>
  )
}
