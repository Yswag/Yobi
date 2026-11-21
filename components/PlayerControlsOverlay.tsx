import {
  Button,
  HStack,
  Image,
  Menu,
  ProgressView,
  Rectangle,
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
  selectQuality,
  selectSubtitle,
  setPlaybackRate,
  skipActiveSponsorSegment,
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
import { NetSpeedLabel, PlaybackStatsPanel } from "./PlaybackStats"

export interface PlayerControlsOverlayProps {
  width: number
  height: number
  dragSpace: string
  onOpenQualitySheet?: () => void
  onOpenDanmakuSheet?: () => void
  onMinimizeDragChanged?: (dy: number, dx: number) => void
  onMinimizeDragEnded?: (dy: number, dx: number, predictedDy: number) => void
}

const AUTO_HIDE_MS: number = 4000
const CONTROLS_FADE_IN_SECONDS: number = 0.15
const CONTROLS_FADE_OUT_SECONDS: number = 0.09
const DOUBLE_TAP_MS: number = 230
const TAP_HINT_MS: number = 650
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
  const progress: PlayerProgressSnapshot = usePlayerProgress()
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

  const lastTapAtRef = useRef<number | null>(null)
  const hideTimerRef = useRef<number | null>(null)
  const hintTimerRef = useRef<number | null>(null)
  const statusRef = useRef<string>(store.status)
  statusRef.current = store.status

  useEffect(() => {
    if (store.status === "ended") {
      setControlsVisible(true)
      clearAutoHide()
      return
    }
    if (store.status === "playing" && controlsVisible) armAutoHide()
  }, [store.status])

  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current)
      if (hintTimerRef.current !== null) clearTimeout(hintTimerRef.current)
    }
  }, [])

  const sideSafeInset: number = Math.max(Device.safeAreaInsets?.leading ?? 0, Device.safeAreaInsets?.trailing ?? 0)
  const edgeInset: number = store.isFullscreen ? Math.max(24, sideSafeInset) : 12
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

  function handleDragChanged(d: DragGestureDetails): void {
    if (store.isFullscreen) return
    props.onMinimizeDragChanged?.(d.translation.height, d.translation.width)
  }

  function handleDragEnded(d: DragGestureDetails): void {
    if (store.isFullscreen) return
    props.onMinimizeDragEnded?.(
      d.translation.height,
      d.translation.width,
      d.predictedEndTranslation.height,
    )
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
    const playing: boolean = store.status === "playing"
    const ended: boolean = store.status === "ended"
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
            {store.isFullscreen ? (
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

          <HStack spacing={store.isFullscreen ? 44 : 28}>
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

          <ProgressBar
            trackWidth={trackWidth}
            barWidth={barWidth}
            edgeInset={edgeInset}
            bottomInset={store.isFullscreen ? 10 : 4}
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
            <VStack padding={{ leading: edgeInset, top: controlsVisible ? (store.isFullscreen ? 64 : 56) : 10 }}>
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

  return (
    <ZStack frame={{ width: props.width, height: props.height }}>
      <Rectangle
        fill="rgba(0,0,0,0.001)"
        frame={{ width: props.width, height: props.height }}
        onTapGesture={{ count: 1, coordinateSpace: "local", perform: handleTap }}
        onDragGesture={{
          minDistance: 10,
          coordinateSpace: props.dragSpace,
          onChanged: handleDragChanged,
          onEnded: handleDragEnded,
        }}
      />
      <ZStack
        frame={{ width: props.width, height: props.height }}
        opacity={controlsVisible ? 1 : 0}
        allowsHitTesting={controlsVisible}
        animation={{
          animation: controlsVisible ? Animation.easeOut(CONTROLS_FADE_IN_SECONDS) : Animation.easeIn(CONTROLS_FADE_OUT_SECONDS),
          value: controlsVisible,
        }}
      >
        {renderControlsLayer()}
      </ZStack>
      {renderFloatingLayer()}
    </ZStack>
  )
}
