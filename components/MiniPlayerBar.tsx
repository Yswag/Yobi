import {
  Button,
  HStack,
  Image,
  ProgressView,
  Rectangle,
  Text,
  VStack,
  VideoPlaybackView,
  ZStack,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { PlayerProgressSnapshot, PlayerStoreSnapshot } from "../state/playerStore"
import {
  closePlayer,
  expandFromMiniPlayer,
  getPlayerController,
  togglePlayPause,
  usePlayerProgress,
  usePlayerStore,
} from "../state/playerStore"
import { ProgressTrack } from "../ui/primitives"
import { palette, type } from "../ui/theme"

const THUMB_WIDTH: number = 56
const THUMB_HEIGHT: number = 32

// Rendered inside TabView's bottom accessory; the system supplies the glass capsule.
export function MiniPlayerBar(): VirtualNode {
  const store: PlayerStoreSnapshot = usePlayerStore()
  const progress: PlayerProgressSnapshot = usePlayerProgress()
  const item = store.currentItem
  if (!item) return <HStack />

  const isLoading: boolean = store.status === "loading" || store.status === "buffering"
  const isPlaying: boolean = store.status === "playing"
  const duration: number = progress.duration > 0 ? progress.duration : item.duration
  const ratio: number = duration > 0 ? progress.position / duration : 0

  return (
    <HStack spacing={10} padding={{ leading: 8, trailing: 4 }} frame={{ maxWidth: "infinity" }}>
      <ZStack
        alignment="bottom"
        frame={{ width: THUMB_WIDTH, height: THUMB_HEIGHT }}
        clipShape={{ type: "rect", cornerRadius: 7, style: "continuous" }}
      >
        <VideoPlaybackView
          controller={getPlayerController()}
          gestures={false}
          videoGravity="resizeAspectFill"
          frame={{ width: THUMB_WIDTH, height: THUMB_HEIGHT }}
        />
        <Rectangle
          fill="rgba(0,0,0,0.001)"
          frame={{ width: THUMB_WIDTH, height: THUMB_HEIGHT }}
          onTapGesture={() => expandFromMiniPlayer()}
        />
        <ProgressTrack ratio={ratio} color={palette.brand} height={2} allowsHitTesting={false} />
      </ZStack>

      <VStack
        alignment="leading"
        spacing={1}
        frame={{ maxWidth: "infinity", alignment: "leading" }}
        contentShape="rect"
        onTapGesture={() => expandFromMiniPlayer()}
      >
        <Text font={type.meta + 1} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>
          {item.title}
        </Text>
        <Text font={type.caption} foregroundStyle="secondaryLabel" lineLimit={1}>
          {item.authorName}
        </Text>
      </VStack>

      <Button action={() => void togglePlayPause()} buttonStyle="plain">
        <ZStack frame={{ width: 36, height: 36 }} contentShape="rect">
          {isLoading ? (
            <ProgressView controlSize="small" />
          ) : (
            <Image
              systemName={isPlaying ? "pause.fill" : "play.fill"}
              font={18}
              foregroundStyle="label"
              contentTransition="symbolEffectReplace"
            />
          )}
        </ZStack>
      </Button>

      <Button action={() => void closePlayer()} buttonStyle="plain">
        <ZStack frame={{ width: 32, height: 36 }} contentShape="rect">
          <Image systemName="xmark" font={14} fontWeight="semibold" foregroundStyle="secondaryLabel" />
        </ZStack>
      </Button>
    </HStack>
  )
}
