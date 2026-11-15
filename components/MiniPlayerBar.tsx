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
import type { PlayerStoreSnapshot } from "../state/playerStore"
import {
  closePlayer,
  expandFromMiniPlayer,
  togglePlayPause,
  usePlayerStore,
} from "../state/playerStore"
import { type } from "../ui/theme"

// The trailing part of the minimized player card; the live video sits to its left in PlayerHost.
export function MiniPlayerBar(props: { item: UnifiedVideoItem | null; height: number }): VirtualNode {
  const store: PlayerStoreSnapshot = usePlayerStore()
  const item: UnifiedVideoItem | null = props.item
  const isLoading: boolean = store.status === "loading" || store.status === "buffering"
  const isPlaying: boolean = store.status === "playing"

  return (
    <HStack spacing={4} padding={{ leading: 12, trailing: 10 }} frame={{ maxWidth: "infinity", height: props.height }}>
      <VStack
        alignment="leading"
        spacing={1}
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
      </VStack>

      <Button action={() => void togglePlayPause()} buttonStyle="plain">
        <ZStack frame={{ width: 40, height: props.height }} contentShape="rect">
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
        <ZStack frame={{ width: 36, height: props.height }} contentShape="rect">
          <Image systemName="xmark" font={14} fontWeight="semibold" foregroundStyle="secondaryLabel" />
        </ZStack>
      </Button>
    </HStack>
  )
}
