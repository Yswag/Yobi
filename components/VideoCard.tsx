import { Button, HStack, Image, Menu, Spacer, Text, VStack, ZStack } from "scripting"
import type { VirtualNode } from "scripting"
import type { Provider, UnifiedVideoItem } from "../types"
import {
  addVideoToPlaylist,
  createPlaylist,
  getPlaylists,
  toggleWatchLater,
} from "../services"
import {
  formatCount,
  formatDuration,
  getVideoShareUrl,
  providerBadgeLabel,
} from "../utils/format"

export interface VideoCardProps {
  item: UnifiedVideoItem
  layout?: "grid" | "row"
  progressSeconds?: number
  onSelect: (item: UnifiedVideoItem) => void
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
}

function accentColor(provider: Provider) {
  return provider === "bili" ? "rgba(251,114,153,1)" : "rgba(255,46,77,1)"
}

const ROW_THUMB_WIDTH: number = 148
const ROW_THUMB_HEIGHT: number = 84
const GRID_THUMB_HEIGHT: number = 202

async function addToPlaylistFlow(item: UnifiedVideoItem): Promise<void> {
  const playlists = getPlaylists()
  const labels: string[] = playlists.map(playlist => playlist.name)
  labels.push("＋ 新增播放清單")

  const index: number | null | undefined = await Dialog.actionSheet({
    title: "加入播放清單",
    actions: labels.map((label: string) => ({ label })),
  })
  if (typeof index !== "number") return

  if (index < playlists.length) {
    addVideoToPlaylist(playlists[index].id, item)
    return
  }

  const name: string | null = await Dialog.prompt({
    title: "新增播放清單",
    message: "輸入清單名稱",
    confirmLabel: "建立",
  })
  const trimmed: string = (name ?? "").trim()
  if (!trimmed) return
  const created = createPlaylist(trimmed)
  addVideoToPlaylist(created.id, item)
}

function platformBadge(provider: Provider): VirtualNode {
  return (
    <Text
      font={9}
      fontWeight="bold"
      foregroundStyle="white"
      padding={{ horizontal: 5, vertical: 2 }}
      background={accentColor(provider)}
      clipShape={{ type: "rect", cornerRadius: 4 }}
    >
      {providerBadgeLabel(provider)}
    </Text>
  )
}

function durationBadge(item: UnifiedVideoItem): VirtualNode {
  return (
    <Text
      font={10}
      monospaced
      foregroundStyle="white"
      padding={{ horizontal: 5, vertical: 2 }}
      background="rgba(0,0,0,0.75)"
      clipShape={{ type: "rect", cornerRadius: 4 }}
    >
      {item.isLive ? "LIVE" : formatDuration(item.duration)}
    </Text>
  )
}

function watchedRatio(item: UnifiedVideoItem, progressSeconds?: number): number {
  if (!progressSeconds || progressSeconds <= 0 || item.duration <= 0) return 0
  return Math.min(1, progressSeconds / item.duration)
}

function progressBar(provider: Provider, width: number, ratio: number): VirtualNode {
  return (
    <HStack
      spacing={0}
      frame={{ width, height: 3 }}
      background="rgba(255,255,255,0.28)"
    >
      <HStack
        spacing={0}
        frame={{ width: Math.max(0, width * ratio), height: 3 }}
        background={accentColor(provider)}
      />
    </HStack>
  )
}

function cardMenu(item: UnifiedVideoItem): VirtualNode {
  return (
    <Menu label={<HStack spacing={0}><Image systemName="ellipsis" font={14} foregroundStyle="secondaryLabel" /></HStack>}>
      <Button
        title="加入稍後觀看"
        systemImage="bookmark"
        action={() => {
          toggleWatchLater(item)
        }}
      />
      <Button
        title="加入播放清單"
        systemImage="text.badge.plus"
        action={() => {
          void addToPlaylistFlow(item)
        }}
      />
      <Button
        title="複製連結"
        systemImage="link"
        action={() => {
          void Pasteboard.setString(getVideoShareUrl(item))
        }}
      />
    </Menu>
  )
}

function metaText(item: UnifiedVideoItem): string {
  const base: string = `${formatCount(item.viewCount)}觀看`
  return item.publishedText ? `${base} • ${item.publishedText}` : base
}

function avatarView(provider: Provider, name: string, avatarUrl: string | undefined, size: number): VirtualNode {
  if (avatarUrl) {
    return (
      <Image
        imageUrl={avatarUrl}
        resizable
        scaleToFill
        frame={{ width: size, height: size }}
        clipShape="circle"
      />
    )
  }
  const initial: string = (name.trim().charAt(0) || "?").toUpperCase()
  return (
    <VStack
      frame={{ width: size, height: size }}
      background={accentColor(provider)}
      clipShape="circle"
    >
      <Text font={Math.round(size * 0.42)} fontWeight="semibold" foregroundStyle="white">{initial}</Text>
    </VStack>
  )
}

function RowCard(props: VideoCardProps): VirtualNode {
  const item: UnifiedVideoItem = props.item
  const ratio: number = watchedRatio(item, props.progressSeconds)

  return (
    <HStack
      alignment="top"
      spacing={10}
      padding={{ horizontal: 12, vertical: 8 }}
      frame={{ maxWidth: "infinity" }}
      onTapGesture={() => props.onSelect(item)}
    >
      <ZStack
        frame={{ width: ROW_THUMB_WIDTH, height: ROW_THUMB_HEIGHT }}
        background="#1c1c1e"
        clipShape={{ type: "rect", cornerRadius: 10 }}
        clipped
      >
        {item.thumbnailUrl ? (
          <Image
            imageUrl={item.thumbnailUrl}
            resizable
            scaleToFill
            frame={{ width: ROW_THUMB_WIDTH, height: ROW_THUMB_HEIGHT }}
          />
        ) : (
          <VStack frame={{ width: ROW_THUMB_WIDTH, height: ROW_THUMB_HEIGHT }} background="#1c1c1e">
            <Image systemName="play.rectangle.fill" font={26} foregroundStyle="rgba(255,255,255,0.55)" />
          </VStack>
        )}
        <VStack
          spacing={0}
          frame={{ width: ROW_THUMB_WIDTH, height: ROW_THUMB_HEIGHT }}
          padding={6}
          allowsHitTesting={false}
        >
          <HStack spacing={0} frame={{ maxWidth: "infinity" }}>
            {platformBadge(item.provider)}
            <Spacer />
          </HStack>
          <Spacer />
          <HStack spacing={0} frame={{ maxWidth: "infinity" }}>
            <Spacer />
            {durationBadge(item)}
          </HStack>
        </VStack>
        {ratio > 0
          ? (
            <VStack spacing={0} frame={{ width: ROW_THUMB_WIDTH, height: ROW_THUMB_HEIGHT }} allowsHitTesting={false}>
              <Spacer />
              {progressBar(item.provider, ROW_THUMB_WIDTH, ratio)}
            </VStack>
          )
          : null}
      </ZStack>

      <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity" }}>
        <Text font={14} fontWeight="medium" foregroundStyle="label" lineLimit={2} multilineTextAlignment="leading">
          {item.title}
        </Text>
        <Text font={12} foregroundStyle="secondaryLabel" lineLimit={1}>{item.authorName}</Text>
        <HStack spacing={4} frame={{ maxWidth: "infinity" }}>
          <Text font={11} foregroundStyle="tertiaryLabel" lineLimit={1}>{metaText(item)}</Text>
          <Spacer />
          {cardMenu(item)}
        </HStack>
      </VStack>
    </HStack>
  )
}

function GridCard(props: VideoCardProps): VirtualNode {
  const item: UnifiedVideoItem = props.item
  const ratio: number = watchedRatio(item, props.progressSeconds)
  const fullWidth: number = Device.screen.width
  const openChannel = (): void => {
    props.onOpenChannel?.(item.provider, item.authorId, item.authorName, item.authorAvatar)
  }

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
      <ZStack
        frame={{ maxWidth: "infinity", height: GRID_THUMB_HEIGHT }}
        background="#1c1c1e"
        clipped
        onTapGesture={() => props.onSelect(item)}
      >
        {item.thumbnailUrl ? (
          <Image
            imageUrl={item.thumbnailUrl}
            resizable
            scaleToFill
            frame={{ maxWidth: "infinity", height: GRID_THUMB_HEIGHT }}
          />
        ) : (
          <VStack frame={{ maxWidth: "infinity", height: GRID_THUMB_HEIGHT }} background="#1c1c1e">
            <Image systemName="play.rectangle.fill" font={34} foregroundStyle="rgba(255,255,255,0.55)" />
          </VStack>
        )}
        <VStack spacing={0} frame={{ maxWidth: "infinity", height: GRID_THUMB_HEIGHT }} padding={8} allowsHitTesting={false}>
          <HStack spacing={0} frame={{ maxWidth: "infinity" }}>
            {platformBadge(item.provider)}
            <Spacer />
          </HStack>
          <Spacer />
          <HStack spacing={0} frame={{ maxWidth: "infinity" }}>
            <Spacer />
            {durationBadge(item)}
          </HStack>
        </VStack>
        {ratio > 0
          ? (
            <VStack spacing={0} frame={{ maxWidth: "infinity", height: GRID_THUMB_HEIGHT }} allowsHitTesting={false}>
              <Spacer />
              {progressBar(item.provider, fullWidth, ratio)}
            </VStack>
          )
          : null}
      </ZStack>

      <HStack alignment="top" spacing={10} padding={{ horizontal: 4, vertical: 8 }}>
        <HStack spacing={0} onTapGesture={openChannel}>
          {avatarView(item.provider, item.authorName, item.authorAvatar, 36)}
        </HStack>
        <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity" }}>
          <Text
            font={15}
            fontWeight="semibold"
            foregroundStyle="label"
            lineLimit={2}
            multilineTextAlignment="leading"
            onTapGesture={() => props.onSelect(item)}
          >
            {item.title}
          </Text>
          <Text
            font={12}
            foregroundStyle="secondaryLabel"
            lineLimit={1}
            onTapGesture={() => props.onSelect(item)}
          >
            {`${item.authorName} • ${metaText(item)}`}
          </Text>
        </VStack>
        {cardMenu(item)}
      </HStack>
    </VStack>
  )
}

export function VideoCard(props: VideoCardProps): VirtualNode {
  if (props.layout === "row") return <RowCard {...props} />
  return <GridCard {...props} />
}
