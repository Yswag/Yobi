import {
  Button,
  HStack,
  Image,
  LazyVStack,
  Menu,
  ScrollView,
  Text,
  VStack,
} from "scripting"
import type { VirtualNode } from "scripting"
import type {
  CustomPlaylist,
  OpenChannel,
  ProviderFilter,
  UnifiedVideoItem,
  WatchHistoryEntry,
} from "../../types/index"
import { VideoCard } from "../VideoCard"
import { formatDuration } from "../../utils/format"
import {
  ChipBar,
  EmptyState,
  GlassIconButton,
  PillButton,
  PROVIDER_FILTERS,
  Thumbnail,
} from "../../ui/primitives"
import { palette, radius, space, type } from "../../ui/theme"

export const PLAYLIST_COVER_WIDTH: number = 120

export function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

export function relativeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ""
  const then: Date = new Date(timestamp)
  const now: Date = new Date()
  const diffMinutes: number = Math.floor((now.getTime() - timestamp) / 60000)
  if (diffMinutes < 1) return "剛剛"
  if (diffMinutes < 60) return `${diffMinutes} 分鐘前`
  const clock: string = `${pad2(then.getHours())}:${pad2(then.getMinutes())}`
  const startOfToday: number = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (timestamp >= startOfToday) return `今天 ${clock}`
  if (timestamp >= startOfToday - 86400000) return `昨天 ${clock}`
  return `${then.getMonth() + 1} 月 ${then.getDate()} 日`
}

export function matchesKeyword(item: UnifiedVideoItem, keyword: string): boolean {
  if (!keyword) return true
  return (
    item.title.toLowerCase().includes(keyword) ||
    item.authorName.toLowerCase().includes(keyword)
  )
}

export function entryKey(entry: WatchHistoryEntry): string {
  return `${entry.item.id}-${entry.cid ?? entry.item.cid ?? 0}-${entry.page ?? 0}`
}

export function historyMeta(entry: WatchHistoryEntry): string {
  const parts: string[] = []
  if (entry.item.provider === "bili" && entry.page !== undefined && entry.page > 1) parts.push(`P${entry.page}`)
  parts.push(`看到 ${formatDuration(entry.position)}`)
  const when: string = relativeTime(entry.watchedAt)
  if (when) parts.push(when)
  return parts.join(" · ")
}

export function PlayActions(props: { onPlay: () => void; onShuffle?: () => void }): VirtualNode {
  return (
    <HStack spacing={10} padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity" }}>
      <PillButton label="全部播放" icon="play.fill" prominent onTap={props.onPlay} />
      {props.onShuffle ? <PillButton label="隨機播放" icon="shuffle" onTap={props.onShuffle} /> : null}
    </HStack>
  )
}

export function PlaylistRow(props: {
  playlist: CustomPlaylist
  onOpen: () => void
  onPlay: () => void
  onShuffle: () => void
  onDelete: () => void
}): VirtualNode {
  const playlist: CustomPlaylist = props.playlist
  const coverUrl: string | undefined = playlist.items[0]?.thumbnailUrl || undefined

  return (
    <HStack spacing={12} padding={{ horizontal: space.page, vertical: 8 }} frame={{ maxWidth: "infinity" }}>
      <HStack spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect" onTapGesture={props.onOpen}>
        {coverUrl ? (
          <Thumbnail url={coverUrl} width={PLAYLIST_COVER_WIDTH} cornerRadius={radius.sm} />
        ) : (
          <VStack
            frame={{ width: PLAYLIST_COVER_WIDTH, height: Math.round(PLAYLIST_COVER_WIDTH * 9 / 16) }}
            background={{ style: palette.brandSoft, shape: { type: "rect", cornerRadius: radius.sm, style: "continuous" } }}
          >
            <Image systemName="music.note.list" font={22} foregroundStyle={palette.brand} />
          </VStack>
        )}
        <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={type.cardTitle} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>{playlist.name}</Text>
          <Text font={type.meta} foregroundStyle="secondaryLabel" lineLimit={1}>
            {`${playlist.items.length} 部影片 · ${relativeTime(playlist.updatedAt)}`}
          </Text>
          {playlist.description ? (
            <Text font={type.caption} foregroundStyle="tertiaryLabel" lineLimit={1}>{playlist.description}</Text>
          ) : null}
        </VStack>
      </HStack>
      <Menu
        label={
          <HStack spacing={0} frame={{ width: 28, height: 28 }} contentShape="rect">
            <Image systemName="ellipsis" font={15} fontWeight="semibold" foregroundStyle="secondaryLabel" />
          </HStack>
        }
      >
        <Button title="全部播放" systemImage="play.fill" action={props.onPlay} />
        <Button title="隨機播放" systemImage="shuffle" action={props.onShuffle} />
        <Button title="刪除清單" systemImage="trash" role="destructive" action={props.onDelete} />
      </Menu>
    </HStack>
  )
}

export function PlaylistDetailView(props: {
  playlist: CustomPlaylist
  items: UnifiedVideoItem[]
  filter: ProviderFilter
  onFilterChange: (value: ProviderFilter) => void
  onBack: () => void
  onPlay: () => void
  onShuffle: () => void
  onSelectItem: (item: UnifiedVideoItem, queue: UnifiedVideoItem[]) => void
  onRemoveItem: (item: UnifiedVideoItem) => void
  onOpenChannel?: OpenChannel
}): VirtualNode {
  const playlist: CustomPlaylist = props.playlist
  const items: UnifiedVideoItem[] = props.items

  return (
    <ScrollView axes="vertical" scrollIndicator="hidden" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <VStack spacing={16} frame={{ maxWidth: "infinity" }} padding={{ top: 6, bottom: 16 }}>
        <HStack padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <GlassIconButton icon="chevron.left" onTap={props.onBack} />
        </HStack>
        <VStack alignment="leading" spacing={6} padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={type.largeTitle - 4} fontWeight="heavy" foregroundStyle="label" lineLimit={2}>
            {playlist.name}
          </Text>
          <Text font={type.meta + 1} foregroundStyle="secondaryLabel" lineLimit={1}>
            {`${items.length} 部影片 · ${relativeTime(playlist.updatedAt)}`}
          </Text>
          {playlist.description ? (
            <Text font={type.body} foregroundStyle="secondaryLabel" lineLimit={3}>{playlist.description}</Text>
          ) : null}
        </VStack>
        {items.length > 0 ? <PlayActions onPlay={props.onPlay} onShuffle={props.onShuffle} /> : null}
        <ChipBar options={PROVIDER_FILTERS} value={props.filter} onChange={props.onFilterChange} />
        {items.length === 0 ? (
          <EmptyState
            icon="tray"
            title="這個清單還沒有影片"
            message="在任何影片的「⋯」選單選「加入播放清單」"
          />
        ) : (
          <LazyVStack spacing={4} frame={{ maxWidth: "infinity" }}>
            {items.map((item: UnifiedVideoItem) => (
              <VideoCard
                key={item.id}
                item={item}
                layout="row"
                actions={[{
                  label: "從清單移除",
                  icon: "minus.circle",
                  destructive: true,
                  onTap: () => props.onRemoveItem(item),
                }]}
                onSelect={() => props.onSelectItem(item, items)}
                onOpenChannel={props.onOpenChannel}
              />
            ))}
          </LazyVStack>
        )}
      </VStack>
    </ScrollView>
  )
}
