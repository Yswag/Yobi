import { Button, HStack, Image, Menu, Text, VStack } from "scripting"
import type { VirtualNode } from "scripting"
import type { Provider, UnifiedVideoItem } from "../types"
import {
  addVideoToPlaylist,
  createPlaylist,
  getPlaylists,
  toggleWatchLater,
} from "../services"
import { formatCount, getVideoShareUrl } from "../utils/format"
import { Avatar, Skeleton, Thumbnail } from "../ui/primitives"
import { pageContentWidth, radius, space, thumbHeight, type } from "../ui/theme"

export interface CardAction {
  label: string
  icon: string
  destructive?: boolean
  onTap: () => void
}

export interface VideoCardProps {
  item: UnifiedVideoItem
  layout?: "grid" | "row"
  progressSeconds?: number
  meta?: string
  actions?: CardAction[]
  onSelect: (item: UnifiedVideoItem) => void
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
}

const ROW_THUMB_WIDTH: number = 164

export async function addToPlaylistFlow(item: UnifiedVideoItem): Promise<void> {
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

function watchedRatio(item: UnifiedVideoItem, progressSeconds?: number): number {
  if (!progressSeconds || progressSeconds <= 0 || item.duration <= 0) return 0
  return Math.min(1, progressSeconds / item.duration)
}

function cardMenu(item: UnifiedVideoItem, actions?: CardAction[]): VirtualNode {
  return (
    <Menu
      label={
        <HStack spacing={0} frame={{ width: 28, height: 28 }} contentShape="rect">
          <Image systemName="ellipsis" font={15} fontWeight="semibold" foregroundStyle="secondaryLabel" />
        </HStack>
      }
    >
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
      {(actions ?? []).map((action: CardAction) => (
        <Button
          key={`act-${action.label}`}
          title={action.label}
          systemImage={action.icon}
          role={action.destructive ? "destructive" : undefined}
          action={action.onTap}
        />
      ))}
    </Menu>
  )
}

function metaText(item: UnifiedVideoItem): string {
  const base: string = `${formatCount(item.viewCount)} 次觀看`
  return item.publishedText ? `${base} · ${item.publishedText}` : base
}

function selectCard(props: VideoCardProps): void {
  props.onSelect(props.item)
}

function RowCard(props: VideoCardProps): VirtualNode {
  const item: UnifiedVideoItem = props.item

  return (
    <HStack
      alignment="top"
      spacing={12}
      padding={{ horizontal: space.page, vertical: 8 }}
      frame={{ maxWidth: "infinity" }}
      contentShape="rect"
      onTapGesture={() => selectCard(props)}
    >
      <Thumbnail
        url={item.thumbnailUrl}
        width={ROW_THUMB_WIDTH}
        cornerRadius={radius.sm}
        provider={item.provider}
        duration={item.duration}
        isLive={item.isLive}
        progress={watchedRatio(item, props.progressSeconds)}
      />

      <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text
          font={type.body}
          fontWeight="semibold"
          foregroundStyle="label"
          lineLimit={2}
          multilineTextAlignment="leading"
        >
          {item.title}
        </Text>
        <Text font={type.meta} foregroundStyle="secondaryLabel" lineLimit={1}>{item.authorName}</Text>
        <HStack spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={type.caption} foregroundStyle="tertiaryLabel" lineLimit={1} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            {props.meta ?? metaText(item)}
          </Text>
          {cardMenu(item, props.actions)}
        </HStack>
      </VStack>
    </HStack>
  )
}

function GridCard(props: VideoCardProps): VirtualNode {
  const item: UnifiedVideoItem = props.item
  const select = (): void => selectCard(props)
  const openChannel = (): void => {
    props.onOpenChannel?.(item.provider, item.authorId, item.authorName, item.authorAvatar)
  }

  return (
    <VStack spacing={12} padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity" }}>
      <Thumbnail
        url={item.thumbnailUrl}
        cornerRadius={radius.lg}
        provider={item.provider}
        duration={item.duration}
        isLive={item.isLive}
        progress={watchedRatio(item, props.progressSeconds)}
        onTap={select}
      />

      <HStack alignment="top" spacing={12} frame={{ maxWidth: "infinity" }}>
        <Avatar
          url={item.authorAvatar}
          name={item.authorName}
          size={38}
          provider={item.provider}
          onTap={openChannel}
        />
        <VStack
          alignment="leading"
          spacing={4}
          frame={{ maxWidth: "infinity", alignment: "leading" }}
          contentShape="rect"
          onTapGesture={select}
        >
          <Text
            font={type.cardTitle + 1}
            fontWeight="semibold"
            foregroundStyle="label"
            lineLimit={2}
            multilineTextAlignment="leading"
          >
            {item.title}
          </Text>
          <Text font={type.meta + 1} foregroundStyle="secondaryLabel" lineLimit={1}>
            {`${item.authorName} · ${props.meta ?? metaText(item)}`}
          </Text>
        </VStack>
        {cardMenu(item, props.actions)}
      </HStack>
    </VStack>
  )
}

export function VideoCard(props: VideoCardProps): VirtualNode {
  if (props.layout === "row") return <RowCard {...props} />
  return <GridCard {...props} />
}

export function VideoCardSkeleton(props: { layout: "grid" | "row"; count?: number }): VirtualNode {
  if (props.layout === "row") {
    return (
      <VStack spacing={16} padding={{ horizontal: space.page, vertical: 8 }}>
        {Array.from({ length: props.count ?? 6 }, (_, index: number) => (
          <HStack key={`sk-row-${index}`} spacing={12} alignment="top">
            <Skeleton width={ROW_THUMB_WIDTH} height={thumbHeight(ROW_THUMB_WIDTH)} cornerRadius={radius.sm} />
            <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Skeleton height={13} />
              <Skeleton width={110} height={13} />
              <Skeleton width={70} height={10} />
            </VStack>
          </HStack>
        ))}
      </VStack>
    )
  }
  return (
    <VStack spacing={space.cardGap} padding={{ horizontal: space.page }}>
      {Array.from({ length: props.count ?? 2 }, (_, index: number) => (
        <VStack key={`sk-grid-${index}`} spacing={12}>
          <Skeleton height={thumbHeight(pageContentWidth())} cornerRadius={radius.lg} />
          <HStack spacing={12} alignment="top">
            <Skeleton width={38} height={38} cornerRadius={19} />
            <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Skeleton height={14} />
              <Skeleton width={160} height={11} />
            </VStack>
          </HStack>
        </VStack>
      ))}
    </VStack>
  )
}
