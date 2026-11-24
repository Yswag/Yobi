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
} from "scripting"
import type { VirtualNode } from "scripting"
import {
  minimizeToMiniPlayer,
  seekBy,
  selectSubtitle,
  setPlaybackRate,
  toggleDanmaku,
  toggleFullscreen,
  togglePlayPause,
} from "../../state/playerStore"
import type { SubtitleTrackInfo } from "../../types/index"
import { palette, type } from "../../ui/theme"
import { NetSpeedLabel } from "../PlaybackStats"
import {
  EDGE_SCRIM_HEIGHT,
  GlassCircle,
  IconControl,
  MIN_HIT_SIZE,
  PLAYBACK_RATES,
  SPINNER_BOX,
  SPEED_OFFSET_Y,
  rateLabel,
  type PlayerControlsSnapshot,
  type ScrubPreview,
} from "./controlsPrimitives"
import { ProgressBar } from "./PlayerProgressBar"

export interface PlayerControlsLayerProps {
  width: number
  height: number
  topInset: number
  bottomInset: number
  edgeInset: number
  trackWidth: number
  barWidth: number
  store: PlayerControlsSnapshot
  controlsVisible: boolean
  scrub: ScrubPreview | null
  onScrub: (preview: ScrubPreview | null) => void
  onTapChrome: () => void
  onOpenQualitySheet?: () => void
  onOpenDanmakuSheet?: () => void
}

export function PlayerControlsLayer(props: PlayerControlsLayerProps): VirtualNode {
  const store: PlayerControlsSnapshot = props.store
  const portraitFullscreen: boolean = store.isFullscreen && store.isPortraitFullscreen
  const landscapeFullscreen: boolean = store.isFullscreen && !store.isPortraitFullscreen

  function handleBack(): void {
    if (store.isFullscreen) toggleFullscreen()
    else minimizeToMiniPlayer()
  }

  function renderScrims(): VirtualNode {
    const maxEdge: number = Math.round(props.height * 0.38)
    const topEdge: number = Math.min(portraitFullscreen ? props.topInset + EDGE_SCRIM_HEIGHT : EDGE_SCRIM_HEIGHT, maxEdge)
    const bottomEdge: number = Math.min(
      portraitFullscreen ? props.bottomInset + EDGE_SCRIM_HEIGHT + 24 : EDGE_SCRIM_HEIGHT,
      maxEdge,
    )
    return (
      <ZStack frame={{ width: props.width, height: props.height }} allowsHitTesting={false}>
        <Rectangle fill="rgba(0,0,0,0.22)" frame={{ width: props.width, height: props.height }} />
        <VStack spacing={0} frame={{ width: props.width, height: props.height }}>
          <Rectangle
            fill={gradient("linear", { colors: ["rgba(0,0,0,0.6)", "rgba(0,0,0,0)"], startPoint: "top", endPoint: "bottom" })}
            frame={{ width: props.width, height: topEdge }}
          />
          <Spacer />
          <Rectangle
            fill={gradient("linear", { colors: ["rgba(0,0,0,0)", "rgba(0,0,0,0.7)"], startPoint: "top", endPoint: "bottom" })}
            frame={{ width: props.width, height: bottomEdge }}
          />
        </VStack>
      </ZStack>
    )
  }

  const title: string = store.currentItem?.title ?? ""
  const provider = store.currentItem?.provider ?? "yt"
  const playing: boolean = store.status === "playing"
  const ended: boolean = store.status === "ended"
  const loading: boolean = store.status === "loading" || store.status === "buffering"
  const hasSubtitles: boolean = (store.subtitles?.length ?? 0) > 0

  return (
    <ZStack frame={{ width: props.width, height: props.height }}>
      {renderScrims()}
      <VStack spacing={0} frame={{ width: props.width, height: props.height }}>
        <HStack spacing={10} padding={{ horizontal: props.edgeInset, top: props.topInset }}>
          <GlassCircle
            icon={store.isFullscreen ? "chevron.left" : "chevron.down"}
            size={34}
            iconSize={14}
            onTap={handleBack}
          />
          {landscapeFullscreen ? (
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
                {(store.subtitles ?? []).map((track: SubtitleTrackInfo) => (
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

        <HStack spacing={landscapeFullscreen ? 44 : store.isFullscreen ? 32 : 28}>
          {store.currentItem?.isLive && !store.liveSeekable ? null : (
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
          {store.currentItem?.isLive && !store.liveSeekable ? null : (
            <GlassCircle icon="goforward.10" size={44} iconSize={18} onTap={() => void seekBy(10)} />
          )}
        </HStack>

        <Spacer />

        {portraitFullscreen && title ? (
          <HStack spacing={0} padding={{ horizontal: props.edgeInset, bottom: 6 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text
              font={type.cardTitle + 1}
              fontWeight="semibold"
              foregroundStyle={palette.onMedia}
              lineLimit={1}
              shadow={{ color: "rgba(0,0,0,0.4)", radius: 4 }}
            >
              {title}
            </Text>
          </HStack>
        ) : null}

        <ProgressBar
          active={props.controlsVisible}
          trackWidth={props.trackWidth}
          barWidth={props.barWidth}
          edgeInset={props.edgeInset}
          bottomInset={props.bottomInset}
          fullscreen={store.isFullscreen}
          scrub={props.scrub}
          onScrub={props.onScrub}
          onTapChrome={props.onTapChrome}
        />
      </VStack>
    </ZStack>
  )
}
