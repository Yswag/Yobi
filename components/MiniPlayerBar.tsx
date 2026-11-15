import {
  Button,
  EmptyView,
  HStack,
  Image,
  ProgressView,
  Rectangle,
  Spacer,
  Text,
  VStack,
  VideoPlaybackView,
  ZStack,
} from "scripting"
import type { Color, VirtualNode } from "scripting"
import type { PlayerProgressSnapshot, PlayerStoreSnapshot } from "../state/playerStore"
import {
  closePlayer,
  expandFromMiniPlayer,
  getPlayerController,
  togglePlayPause,
  usePlayerProgress,
  usePlayerStore,
} from "../state/playerStore"
import { formatDuration, providerAccentColor, providerBadgeLabel } from "../utils/format"

const THUMB_WIDTH: number = 96
const THUMB_HEIGHT: number = 54
const CARD_HORIZONTAL_INSET: number = 10
const PROGRESS_HEIGHT: number = 2.5

function toColor(value: string): Color {
  return value as Color
}

export function MiniPlayerBar(): VirtualNode {
  const store: PlayerStoreSnapshot = usePlayerStore()
  const progress: PlayerProgressSnapshot = usePlayerProgress()

  if (store.presentationMode !== "mini" || !store.currentItem) {
    return <EmptyView />
  }

  const item = store.currentItem
  const isLoading: boolean = store.status === "loading" || store.status === "buffering"
  const isPlaying: boolean = store.status === "playing"
  const duration: number = progress.duration > 0 ? progress.duration : item.duration
  const ratio: number = duration > 0 ? Math.max(0, Math.min(1, progress.position / duration)) : 0
  const accentColor: Color = toColor(providerAccentColor(item.provider))
  const cardWidth: number = Math.max(1, Device.screen.width - CARD_HORIZONTAL_INSET * 2)

  return (
    <VStack spacing={0} padding={{ horizontal: CARD_HORIZONTAL_INSET, bottom: 6 }}>
      <VStack
        spacing={0}
        background="secondarySystemBackground"
        clipShape={{ type: "rect", cornerRadius: 14 }}
        shadow={{ color: "rgba(0, 0, 0, 0.22)", radius: 10, y: 3 }}
      >
        <HStack spacing={10} padding={{ horizontal: 10, vertical: 8 }}>
          <ZStack
            alignment="bottomLeading"
            frame={{ width: THUMB_WIDTH, height: THUMB_HEIGHT }}
            clipShape={{ type: "rect", cornerRadius: 8 }}
          >
            <VideoPlaybackView
              controller={getPlayerController()}
              gestures={false}
              videoGravity="resizeAspectFill"
              frame={{ width: THUMB_WIDTH, height: THUMB_HEIGHT }}
            />
            <Rectangle
              fill="rgba(0, 0, 0, 0.001)"
              frame={{ width: THUMB_WIDTH, height: THUMB_HEIGHT }}
              onTapGesture={() => expandFromMiniPlayer()}
            />
            <Text
              font={8}
              fontWeight="bold"
              foregroundStyle="white"
              padding={{ horizontal: 4, vertical: 1.5 }}
              background={{ style: accentColor, shape: { type: "rect", cornerRadius: 3 } }}
              offset={{ x: 4, y: -4 }}
            >
              {providerBadgeLabel(item.provider)}
            </Text>
          </ZStack>

          <VStack alignment="leading" spacing={3} onTapGesture={() => expandFromMiniPlayer()}>
            <Text font={13} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>
              {item.title}
            </Text>
            <Text font={11} foregroundStyle="secondaryLabel" lineLimit={1}>
              {`${item.authorName} · ${formatDuration(progress.position)} / ${formatDuration(duration)}`}
            </Text>
          </VStack>

          <Spacer />

          <Button action={() => void togglePlayPause()} buttonStyle="plain">
            <ZStack frame={{ width: 34, height: 34 }}>
              {isLoading ? (
                <ProgressView controlSize="small" />
              ) : (
                <Image systemName={isPlaying ? "pause.fill" : "play.fill"} font={16} foregroundStyle="label" />
              )}
            </ZStack>
          </Button>

          <Button action={() => void closePlayer()} buttonStyle="plain">
            <ZStack frame={{ width: 30, height: 30 }}>
              <Image systemName="xmark" font={14} foregroundStyle="secondaryLabel" />
            </ZStack>
          </Button>
        </HStack>

        <ZStack
          alignment="leading"
          frame={{ width: cardWidth, height: PROGRESS_HEIGHT }}
          background="rgba(120, 120, 128, 0.24)"
        >
          <Rectangle fill={accentColor} frame={{ width: cardWidth * ratio, height: PROGRESS_HEIGHT }} />
        </ZStack>
      </VStack>
    </VStack>
  )
}
