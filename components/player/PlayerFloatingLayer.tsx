import { Button, HStack, Image, ProgressView, Rectangle, Spacer, Text, VStack, ZStack } from "scripting"
import type { VirtualNode } from "scripting"
import { dismissActiveSponsorSegment, skipActiveSponsorSegment } from "../../state/playerStore"
import type { SponsorSegment } from "../../types/index"
import { SPONSOR_CATEGORY_COLORS, SPONSOR_CATEGORY_LABELS, formatDuration } from "../../utils/format"
import { palette, type } from "../../ui/theme"
import { NetSpeedLabel, PlaybackStatsPanel } from "../PlaybackStats"
import {
  OverlayCapsule,
  SPINNER_BOX,
  SPEED_OFFSET_Y,
  type PlayerControlsSnapshot,
  type ScrubPreview,
  type TapHint,
} from "./controlsPrimitives"

export interface PlayerFloatingLayerProps {
  width: number
  height: number
  topInset: number
  edgeInset: number
  floatingBottomInset: number
  store: PlayerControlsSnapshot
  controlsVisible: boolean
  scrub: ScrubPreview | null
  tapHint: TapHint
  fillHint: string | null
  videoFill: boolean
  onRetry: () => void
}

export function PlayerFloatingLayer(props: PlayerFloatingLayerProps): VirtualNode {
  const store: PlayerControlsSnapshot = props.store
  const portraitFullscreen: boolean = store.isFullscreen && store.isPortraitFullscreen
  const loading: boolean = store.status === "loading" || store.status === "buffering"
  const prompt: SponsorSegment | null = store.activeSponsorPrompt
  const promptSeconds: number = prompt ? Math.max(1, Math.round(prompt.endTime - prompt.startTime)) : 0

  return (
    <ZStack frame={{ width: props.width, height: props.height }}>
      {store.isBoosting2x ? (
        <VStack spacing={0} frame={{ width: props.width, height: props.height }}>
          <HStack spacing={0} padding={{ top: portraitFullscreen ? props.topInset : 14 }}>
            <OverlayCapsule>
              <Image systemName="forward.fill" font={11} foregroundStyle={palette.onMedia} />
              <Text font={type.meta} fontWeight="semibold" foregroundStyle={palette.onMedia}>2× 快轉</Text>
            </OverlayCapsule>
          </HStack>
          <Spacer />
        </VStack>
      ) : props.fillHint ? (
        <VStack spacing={0} frame={{ width: props.width, height: props.height }}>
          <HStack spacing={0} padding={{ top: portraitFullscreen ? props.topInset : 14 }}>
            <OverlayCapsule>
              <Image
                systemName={props.videoFill ? "arrow.up.left.and.arrow.down.right" : "arrow.down.right.and.arrow.up.left"}
                font={11}
                foregroundStyle={palette.onMedia}
              />
              <Text font={type.meta} fontWeight="semibold" foregroundStyle={palette.onMedia}>{props.fillHint}</Text>
            </OverlayCapsule>
          </HStack>
          <Spacer />
        </VStack>
      ) : null}

      {props.tapHint !== null ? (
        <ZStack
          frame={{ width: props.width, height: props.height, alignment: props.tapHint === "left" ? "leading" : "trailing" }}
        >
          <HStack spacing={0} padding={{ horizontal: 24 }}>
            <OverlayCapsule>
              <Image
                systemName={props.tapHint === "right" ? "goforward.10" : "gobackward.10"}
                font={14}
                fontWeight="semibold"
                foregroundStyle={palette.onMedia}
              />
            </OverlayCapsule>
          </HStack>
        </ZStack>
      ) : null}

      {props.scrub ? (
        <ZStack frame={{ width: props.width, height: props.height }}>
          {props.scrub.liveEdge !== null ? (
            <OverlayCapsule>
              <Text font={type.cardTitle} fontWeight="semibold" monospacedDigit foregroundStyle={palette.onMedia}>
                {`-${formatDuration(Math.max(0, props.scrub.liveEdge - props.scrub.seconds))}`}
              </Text>
            </OverlayCapsule>
          ) : (
            <OverlayCapsule>
              <Text font={type.cardTitle} fontWeight="semibold" monospacedDigit foregroundStyle={palette.onMedia}>
                {formatDuration(props.scrub.seconds)}
              </Text>
              <Text font={type.cardTitle} monospacedDigit foregroundStyle={palette.onMediaDim}>
                {`/ ${formatDuration(props.scrub.duration)}`}
              </Text>
            </OverlayCapsule>
          )}
        </ZStack>
      ) : null}

      {loading && !props.controlsVisible ? (
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
          <VStack padding={{ leading: props.edgeInset, top: props.controlsVisible ? props.topInset + 50 : portraitFullscreen ? props.topInset : 10 }}>
            <PlaybackStatsPanel />
          </VStack>
        </ZStack>
      ) : null}

      {store.status === "error" ? (
        <ZStack frame={{ width: props.width, height: props.height }}>
          <Rectangle
            fill="rgba(0,0,0,0.7)"
            frame={{ width: props.width, height: props.height }}
            allowsHitTesting={false}
          />
          <VStack spacing={14}>
            <Image
              systemName="exclamationmark.triangle.fill"
              font={26}
              foregroundStyle={palette.onMediaDim}
              allowsHitTesting={false}
            />
            <Text
              font={type.body}
              foregroundStyle={palette.onMedia}
              multilineTextAlignment="center"
              padding={{ horizontal: 32 }}
              allowsHitTesting={false}
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
              onTapGesture={props.onRetry}
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
          <HStack spacing={0} padding={{ leading: props.edgeInset, bottom: props.floatingBottomInset }}>
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
          <HStack spacing={6} padding={{ trailing: props.edgeInset, bottom: props.floatingBottomInset }}>
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
