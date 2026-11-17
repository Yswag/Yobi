import {
  Button,
  HStack,
  Image,
  ProgressView,
  Text,
  VStack,
  ZStack,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { UnifiedVideoItem } from "../types"
import type { PlayerProgressSnapshot, PlayerStoreSnapshot } from "../state/playerStore"
import {
  closePlayer,
  expandFromMiniPlayer,
  togglePlayPause,
  usePlayerProgress,
  usePlayerStore,
} from "../state/playerStore"
import { ProgressTrack } from "../ui/primitives"
import { palette, type } from "../ui/theme"

/** Hit area of each trailing button; the close button's center lands on the capsule's end-cap center. */
export const MINI_BUTTON_SIZE: number = 44

function MiniButton(props: { action: () => void; children: VirtualNode }): VirtualNode {
  return (
    <Button action={props.action} buttonStyle="plain">
      <ZStack frame={{ width: MINI_BUTTON_SIZE, height: MINI_BUTTON_SIZE }} contentShape="rect">
        {props.children}
      </ZStack>
    </Button>
  )
}

// The trailing part of the minimized player card; the live video sits to its left in PlayerHost.
export function MiniPlayerBar(props: {
  item: UnifiedVideoItem | null
  height: number
  trailingInset: number
}): VirtualNode {
  const store: PlayerStoreSnapshot = usePlayerStore()
  // 進度自己訂閱：PlayerHost 不必為了這條細進度條跟著每次 timeupdate 重畫。
  const progress: PlayerProgressSnapshot = usePlayerProgress()
  const item: UnifiedVideoItem | null = props.item
  const isLoading: boolean = store.status === "loading" || store.status === "buffering"
  const isPlaying: boolean = store.status === "playing"
  const duration: number = progress.duration > 0 ? progress.duration : item?.duration ?? 0
  const ratio: number = duration > 0 ? progress.position / duration : 0

  return (
    <HStack spacing={0} padding={{ leading: 12, trailing: props.trailingInset }} frame={{ maxWidth: "infinity", height: props.height }}>
      <VStack
        alignment="leading"
        spacing={3}
        padding={{ trailing: 8 }}
        frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "leading" }}
        contentShape="rect"
        onTapGesture={() => expandFromMiniPlayer()}
      >
        <Text font={type.meta + 1} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>
          {item?.title ?? ""}
        </Text>
        <Text font={type.caption} foregroundStyle="secondaryLabel" lineLimit={1}>
          {item?.authorName ?? ""}
        </Text>
        <ProgressTrack ratio={ratio} color={palette.brand} height={2} padding={{ top: 2 }} />
      </VStack>

      <MiniButton action={() => void togglePlayPause()}>
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
      </MiniButton>

      <MiniButton action={() => void closePlayer()}>
        <Image systemName="xmark" font={16} fontWeight="semibold" foregroundStyle="label" />
      </MiniButton>
    </HStack>
  )
}
