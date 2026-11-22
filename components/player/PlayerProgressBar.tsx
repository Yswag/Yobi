import {
  Button,
  HStack,
  Image,
  Rectangle,
  Spacer,
  Text,
  VStack,
  ZStack,
  useEffect,
  useRef,
  useState,
} from "scripting"
import type { DragGestureDetails, VirtualNode } from "scripting"
import type { PlayerProgressSnapshot, PlayerStoreSnapshot } from "../../state/playerStore"
import {
  getPlayerProgressSnapshot,
  seekTo,
  subscribePlayerProgress,
  toggleFullscreen,
  usePlayerSelector,
} from "../../state/playerStore"
import type { SponsorSegment } from "../../types/index"
import { SPONSOR_CATEGORY_COLORS, formatDuration } from "../../utils/format"
import { palette, type } from "../../ui/theme"
import {
  MIN_HIT_SIZE,
  SCRUBBER_HEIGHT,
  SCRUBBER_KNOB,
  SCRUBBER_TRACK,
  type ScrubPreview,
} from "./controlsPrimitives"

export function ProgressBar(props: {
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
  const barState = usePlayerSelector((s: PlayerStoreSnapshot) => ({
    isLive: s.currentItem?.isLive === true,
    sponsorSegments: s.sponsorSegments,
  }))
  const [progress, setProgress] = useState<PlayerProgressSnapshot>(() => getPlayerProgressSnapshot())
  useEffect(() => {
    if (!props.active) return
    const sync = (): void => setProgress(getPlayerProgressSnapshot())
    sync()
    return subscribePlayerProgress(sync)
  }, [props.active])
  const duration: number = progress.duration || 0
  const live: boolean = barState.isLive
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
    return barState.sponsorSegments.map((seg: SponsorSegment) => {
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
