import { Button, HStack, Image, VStack } from "scripting"
import type { VirtualNode } from "scripting"
import type { PlaybackStatus } from "../../state/playerStore"
import type { SponsorSegment, SubtitleTrackInfo, UnifiedVideoItem } from "../../types/index"
import { palette } from "../../ui/theme"

export const MIN_HIT_SIZE: number = 44
export const EDGE_SCRIM_HEIGHT: number = 96
export const SCRUBBER_HEIGHT: number = 22
export const SCRUBBER_TRACK: number = 3
export const SCRUBBER_KNOB: number = 11
export const SPINNER_BOX: number = 60
export const SPEED_OFFSET_Y: number = 44
export const PLAYBACK_RATES: number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

export interface ScrubPreview {
  seconds: number
  duration: number
  liveEdge: number | null
}

export type TapSide = "left" | "right"
export type TapHint = TapSide | null

export interface PlayerControlsSnapshot {
  currentItem: UnifiedVideoItem | null
  liveSeekable: boolean
  hasManifest: boolean
  subtitles: SubtitleTrackInfo[] | undefined
  status: PlaybackStatus
  errorText: string | null
  isFullscreen: boolean
  isPortraitFullscreen: boolean
  danmakuEnabled: boolean
  selectedSubtitleId: string | null
  playbackRate: number
  isBoosting2x: boolean
  selectedQualityId: string
  selectedQualityLabel: string
  activeCid?: number
  activePage: number
  statsVisible: boolean
  skippedToast: string | null
  activeSponsorPrompt: SponsorSegment | null
}

export function GlassCircle(props: { icon: string; size: number; iconSize: number; onTap: () => void }): VirtualNode {
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

export function IconControl(props: { icon: string; size: number; onTap: () => void }): VirtualNode {
  return (
    <Button action={props.onTap} buttonStyle="plain">
      <VStack frame={{ width: MIN_HIT_SIZE, height: MIN_HIT_SIZE }} contentShape="rect">
        <Image systemName={props.icon} font={props.size} foregroundStyle={palette.onMedia} />
      </VStack>
    </Button>
  )
}

export function OverlayCapsule(props: { children: VirtualNode | VirtualNode[] }): VirtualNode {
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

export function rateLabel(rate: number): string {
  return `${rate === Math.floor(rate) ? rate.toFixed(0) : String(rate)}×`
}
