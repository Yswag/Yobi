import {
  HStack,
  Image,
  ScrollView,
  Spacer,
  Text,
  TextField,
  VStack,
  ZStack,
  useEffect,
  useState,
} from "scripting"
import type { Color, VirtualNode } from "scripting"
import type { CustomPlaylist, Provider, UnifiedVideoItem, WatchHistoryEntry } from "../types"
import { VideoCard } from "../components/VideoCard"
import {
  clearWatchHistory,
  createPlaylist,
  deletePlaylist,
  getPlaylists,
  getWatchLater,
  getWatchHistory,
  removeVideoFromPlaylist,
  subscribeStorageChanges,
  toggleWatchLater,
} from "../services"
import {
  formatDuration,
  providerAccentColor,
  providerBadgeLabel,
  providerSoftBgColor,
} from "../utils/format"
import { openVideo } from "../state/playerStore"

export interface LibraryViewProps {
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
  onOpenSettings?: () => void
}

type LibraryFilter = "all" | Provider
type LibraryTab = "history" | "watchLater" | "playlists"

const LINK_BLUE: Color = "rgba(10,132,255,1)"
const DANGER_RED: Color = "rgba(255,59,48,1)"
const ROW_TEXT_INSET: number = 170
const PLAY_SOFT_BG: Color = "rgba(10,132,255,0.16)"

const FILTERS: { label: string; value: LibraryFilter }[] = [
  { label: "全部", value: "all" },
  { label: providerBadgeLabel("yt"), value: "yt" },
  { label: providerBadgeLabel("bili"), value: "bili" },
]

function filterColor(value: LibraryFilter): Color {
  if (value === "all") return LINK_BLUE
  return providerAccentColor(value)
}

function shuffle<T>(list: T[]): T[] {
  const copy: T[] = list.slice()
  for (let i = copy.length - 1; i > 0; i--) {
    const j: number = Math.floor(Math.random() * (i + 1))
    const tmp: T = copy[i]
    copy[i] = copy[j]
    copy[j] = tmp
  }
  return copy
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

function relativeTime(timestamp: number): string {
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

function matchesKeyword(item: UnifiedVideoItem, keyword: string): boolean {
  if (!keyword) return true
  return (
    item.title.toLowerCase().includes(keyword) ||
    item.authorName.toLowerCase().includes(keyword)
  )
}

function entryKey(entry: WatchHistoryEntry): string {
  return `${entry.item.id}-${entry.cid ?? entry.item.cid ?? 0}-${entry.page ?? 0}`
}

// ─── Small building blocks ──────────────────────────────────────────────────

function FilterChip(props: { label: string; active: boolean; value: LibraryFilter; onTap: () => void }): VirtualNode {
  const accent: Color = filterColor(props.value)
  return (
    <HStack
      spacing={0}
      padding={{ horizontal: 10, vertical: 5 }}
      background={props.active ? accent : "tertiarySystemFill"}
      clipShape="capsule"
      onTapGesture={props.onTap}
    >
      <Text
        font={11}
        fontWeight={props.active ? "semibold" : "medium"}
        foregroundStyle={props.active ? "white" : "secondaryLabel"}
        lineLimit={1}
      >
        {props.label}
      </Text>
    </HStack>
  )
}

function CircleIcon(props: {
  icon: string
  size: number
  tint?: Color
  background?: Color
  onTap: () => void
}): VirtualNode {
  return (
    <VStack
      frame={{ width: props.size, height: props.size }}
      background={props.background ?? "tertiarySystemFill"}
      clipShape="circle"
      onTapGesture={props.onTap}
    >
      <Image
        systemName={props.icon}
        font={Math.round(props.size * 0.4)}
        foregroundStyle={props.tint ?? "label"}
      />
    </VStack>
  )
}

function PillButton(props: {
  icon: string
  label: string
  filled?: boolean
  onTap: () => void
}): VirtualNode {
  const foreground: Color = props.filled ? "white" : "label"
  return (
    <HStack
      spacing={5}
      padding={{ horizontal: 11, vertical: 7 }}
      background={props.filled ? LINK_BLUE : "tertiarySystemFill"}
      clipShape="capsule"
      onTapGesture={props.onTap}
    >
      <Image systemName={props.icon} font={11} foregroundStyle={props.filled ? "white" : "secondaryLabel"} />
      <Text font={12} fontWeight="semibold" foregroundStyle={foreground} lineLimit={1}>
        {props.label}
      </Text>
    </HStack>
  )
}

function TabChip(props: {
  label: string
  count: number
  active: boolean
  onTap: () => void
}): VirtualNode {
  const tint: Color = props.active ? LINK_BLUE : "secondaryLabel"
  return (
    <HStack
      spacing={5}
      padding={{ horizontal: 8, vertical: 8 }}
      frame={{ maxWidth: "infinity" }}
      background={props.active ? PLAY_SOFT_BG : "tertiarySystemFill"}
      clipShape="capsule"
      onTapGesture={props.onTap}
    >
      <Text font={12} fontWeight={props.active ? "semibold" : "medium"} foregroundStyle={tint} lineLimit={1}>
        {props.label}
      </Text>
      <Text
        font={10}
        fontWeight="bold"
        monospacedDigit
        foregroundStyle={props.active ? LINK_BLUE : "tertiaryLabel"}
        padding={{ horizontal: 4, vertical: 1 }}
        background={props.active ? "rgba(10,132,255,0.18)" : "secondarySystemFill"}
        clipShape="capsule"
      >
        {props.count}
      </Text>
    </HStack>
  )
}

function EmptyState(props: { icon: string; title: string; hint?: string }): VirtualNode {
  return (
    <VStack spacing={8} frame={{ maxWidth: "infinity", minHeight: 220 }} padding={{ horizontal: 32 }}>
      <Image systemName={props.icon} font={32} foregroundStyle="tertiaryLabel" />
      <Text font={14} fontWeight="medium" foregroundStyle="secondaryLabel" multilineTextAlignment="center">
        {props.title}
      </Text>
      {props.hint
        ? <Text font={12} foregroundStyle="tertiaryLabel" multilineTextAlignment="center">{props.hint}</Text>
        : null}
    </VStack>
  )
}

function RowAction(props: { icon: string; label: string; destructive?: boolean; onTap: () => void }): VirtualNode {
  const tint: Color = props.destructive ? DANGER_RED : "secondaryLabel"
  return (
    <HStack
      spacing={4}
      padding={{ horizontal: 9, vertical: 4 }}
      background={props.destructive ? "rgba(255,59,48,0.14)" : "tertiarySystemFill"}
      clipShape="capsule"
      onTapGesture={props.onTap}
    >
      <Image systemName={props.icon} font={10} foregroundStyle={tint} />
      <Text font={11} fontWeight="medium" foregroundStyle={tint} lineLimit={1}>{props.label}</Text>
    </HStack>
  )
}

function PlaylistCover(props: { playlist: CustomPlaylist; size: number }): VirtualNode {
  const coverUrl: string = props.playlist.items[0]?.thumbnailUrl ?? ""
  return (
    <ZStack
      frame={{ width: props.size, height: props.size }}
      background={PLAY_SOFT_BG}
      clipShape={{ type: "rect", cornerRadius: 10 }}
      clipped
    >
      {coverUrl
        ? <Image imageUrl={coverUrl} resizable scaleToFill frame={{ width: props.size, height: props.size }} />
        : <Image systemName="music.note.list" font={Math.round(props.size * 0.36)} foregroundStyle={LINK_BLUE} />}
    </ZStack>
  )
}

// ─── Rows ───────────────────────────────────────────────────────────────────

function HistoryRow(props: {
  entry: WatchHistoryEntry
  onPlay: () => void
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
}): VirtualNode {
  const entry: WatchHistoryEntry = props.entry
  const total: number = entry.duration || entry.item.duration || 0
  const pageLabel: string | null =
    entry.item.provider === "bili" && entry.page !== undefined && entry.page > 1 ? `P${entry.page}` : null

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
      <VideoCard
        item={entry.item}
        layout="row"
        progressSeconds={entry.position}
        onSelect={props.onPlay}
        onOpenChannel={props.onOpenChannel}
      />
      <HStack
        spacing={6}
        frame={{ maxWidth: "infinity" }}
        padding={{ leading: ROW_TEXT_INSET, trailing: 14, bottom: 10 }}
      >
        <Image systemName="clock" font={10} foregroundStyle="tertiaryLabel" />
        <Text font={11} foregroundStyle="tertiaryLabel" lineLimit={1}>
          {total > 0
            ? `已看 ${formatDuration(entry.position)} / ${formatDuration(total)}`
            : `已看 ${formatDuration(entry.position)}`}
        </Text>
        {pageLabel
          ? (
            <Text
              font={9}
              fontWeight="bold"
              foregroundStyle={entry.item.provider === "bili" ? providerAccentColor("bili") : LINK_BLUE}
              padding={{ horizontal: 4, vertical: 1 }}
              background={providerSoftBgColor(entry.item.provider)}
              clipShape={{ type: "rect", cornerRadius: 3 }}
            >
              {pageLabel}
            </Text>
          )
          : null}
        <Spacer />
        <Text font={10} foregroundStyle="tertiaryLabel" lineLimit={1}>{relativeTime(entry.watchedAt)}</Text>
      </HStack>
    </VStack>
  )
}

function PlaylistCard(props: {
  playlist: CustomPlaylist
  onOpen: () => void
  onPlay: () => void
  onDelete: () => void
}): VirtualNode {
  const playlist: CustomPlaylist = props.playlist
  const meta: string = `${playlist.items.length} 部影片 • ${relativeTime(playlist.updatedAt)}`

  return (
    <HStack
      spacing={8}
      padding={10}
      frame={{ maxWidth: "infinity" }}
      background="tertiarySystemFill"
      clipShape={{ type: "rect", cornerRadius: 14 }}
    >
      <HStack spacing={10} frame={{ maxWidth: "infinity" }} onTapGesture={props.onOpen}>
        <PlaylistCover playlist={playlist} size={62} />
        <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity" }}>
          <Text font={14} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>{playlist.name}</Text>
          <Text font={11} foregroundStyle="secondaryLabel" lineLimit={1}>{meta}</Text>
          {playlist.description
            ? <Text font={11} foregroundStyle="tertiaryLabel" lineLimit={1}>{playlist.description}</Text>
            : null}
        </VStack>
      </HStack>
      <HStack spacing={6}>
        <CircleIcon icon="play.fill" size={30} tint={LINK_BLUE} background={PLAY_SOFT_BG} onTap={props.onPlay} />
        <CircleIcon icon="trash" size={30} tint={DANGER_RED} background="rgba(255,59,48,0.14)" onTap={props.onDelete} />
      </HStack>
    </HStack>
  )
}

// ─── View ───────────────────────────────────────────────────────────────────

export function LibraryView(props: LibraryViewProps): VirtualNode {
  const [history, setHistory] = useState<WatchHistoryEntry[]>(getWatchHistory())
  const [watchLater, setWatchLater] = useState<UnifiedVideoItem[]>(getWatchLater())
  const [playlists, setPlaylists] = useState<CustomPlaylist[]>(getPlaylists())
  const [filter, setFilter] = useState<LibraryFilter>("all")
  const [tab, setTab] = useState<LibraryTab>("history")
  const [query, setQuery] = useState<string>("")
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null)

  const refresh = (): void => {
    setHistory(getWatchHistory())
    setWatchLater(getWatchLater())
    setPlaylists(getPlaylists())
  }

  useEffect(() => {
    refresh()
    return subscribeStorageChanges(refresh)
  }, [])

  const keyword: string = query.trim().toLowerCase()

  const filteredHistory: WatchHistoryEntry[] = history.filter((entry: WatchHistoryEntry): boolean => {
    if (filter !== "all" && entry.item.provider !== filter) return false
    return matchesKeyword(entry.item, keyword)
  })
  const filteredWatchLater: UnifiedVideoItem[] = watchLater.filter(
    (item: UnifiedVideoItem): boolean => filter === "all" || item.provider === filter,
  )

  const selectedPlaylist: CustomPlaylist | null = selectedPlaylistId
    ? playlists.find((playlist: CustomPlaylist): boolean => playlist.id === selectedPlaylistId) ?? null
    : null
  const playlistItems: UnifiedVideoItem[] = selectedPlaylist
    ? selectedPlaylist.items.filter((item: UnifiedVideoItem): boolean => filter === "all" || item.provider === filter)
    : []

  const openEntry = (entry: WatchHistoryEntry, queue: UnifiedVideoItem[]): void => {
    void openVideo(entry.item, {
      cid: entry.cid,
      page: entry.page,
      startSeconds: entry.position,
      queue,
    })
  }

  const playHistoryFrom = (entries: WatchHistoryEntry[]): void => {
    const first: WatchHistoryEntry | undefined = entries[0]
    if (!first) return
    openEntry(first, entries.map((entry: WatchHistoryEntry): UnifiedVideoItem => entry.item))
  }

  const playQueue = (items: UnifiedVideoItem[], random: boolean): void => {
    if (items.length === 0) return
    const ordered: UnifiedVideoItem[] = random ? shuffle(items) : items
    void openVideo(ordered[0], { queue: ordered })
  }

  const confirmClearHistory = async (): Promise<void> => {
    const confirmed: boolean = await Dialog.confirm({
      title: "清空觀看紀錄",
      message: "所有觀看進度與紀錄都會被刪除，此動作無法復原。",
      confirmLabel: "清空",
      cancelLabel: "取消",
    })
    if (!confirmed) return
    clearWatchHistory()
  }

  const createPlaylistFlow = async (): Promise<void> => {
    const name: string | null = await Dialog.prompt({
      title: "新增播放清單",
      message: "輸入清單名稱",
      placeholder: "例如：通勤必看",
      confirmLabel: "下一步",
    })
    if (name === null) return
    const trimmed: string = name.trim()
    if (!trimmed) return
    const description: string | null = await Dialog.prompt({
      title: "清單描述",
      message: "選填，可直接略過",
      placeholder: "這個清單要收藏什麼？",
      cancelLabel: "略過",
      confirmLabel: "建立",
    })
    createPlaylist(trimmed, (description ?? "").trim() || undefined)
  }

  const confirmDeletePlaylist = async (playlist: CustomPlaylist): Promise<void> => {
    const confirmed: boolean = await Dialog.confirm({
      title: "刪除播放清單",
      message: `「${playlist.name}」與其中的 ${playlist.items.length} 部影片都會被移除。`,
      confirmLabel: "刪除",
      cancelLabel: "取消",
    })
    if (!confirmed) return
    if (selectedPlaylistId === playlist.id) setSelectedPlaylistId(null)
    deletePlaylist(playlist.id)
  }

  // ─── Header + tabs ────────────────────────────────────────────────────────

  const header: VirtualNode = (
    <VStack spacing={10} padding={{ horizontal: 14, top: 10, bottom: 8 }} frame={{ maxWidth: "infinity" }}>
      <HStack spacing={6} frame={{ maxWidth: "infinity" }}>
        <Text font="title2" fontWeight="bold" foregroundStyle="label">媒體庫</Text>
        <Spacer />
        {FILTERS.map((item: { label: string; value: LibraryFilter }) => (
          <FilterChip
            key={item.value}
            label={item.label}
            value={item.value}
            active={filter === item.value}
            onTap={() => setFilter(item.value)}
          />
        ))}
        {props.onOpenSettings
          ? <CircleIcon icon="gearshape.fill" size={30} onTap={props.onOpenSettings} />
          : null}
      </HStack>
      <HStack spacing={6} frame={{ maxWidth: "infinity" }}>
        <TabChip
          label="觀看歷史"
          count={history.length}
          active={tab === "history"}
          onTap={() => setTab("history")}
        />
        <TabChip
          label="稍後觀看"
          count={watchLater.length}
          active={tab === "watchLater"}
          onTap={() => setTab("watchLater")}
        />
        <TabChip
          label="自訂清單"
          count={playlists.length}
          active={tab === "playlists"}
          onTap={() => setTab("playlists")}
        />
      </HStack>
    </VStack>
  )

  // ─── Tab content: history ─────────────────────────────────────────────────

  const searchBar: VirtualNode = (
    <HStack
      spacing={6}
      padding={{ horizontal: 10, vertical: 8 }}
      background="tertiarySystemFill"
      clipShape={{ type: "rect", cornerRadius: 10 }}
      frame={{ maxWidth: "infinity" }}
    >
      <Image systemName="magnifyingglass" font={13} foregroundStyle="secondaryLabel" />
      <TextField
        title="搜尋觀看紀錄"
        value={query}
        onChanged={setQuery}
        prompt="搜尋觀看紀錄…"
        font={13}
        submitLabel="search"
        frame={{ maxWidth: "infinity" }}
      />
      {query.length > 0
        ? (
          <HStack spacing={0} onTapGesture={() => setQuery("")}>
            <Image systemName="xmark.circle.fill" font={14} foregroundStyle="tertiaryLabel" />
          </HStack>
        )
        : null}
    </HStack>
  )

  const historyContent: VirtualNode = (
    <VStack spacing={10} frame={{ maxWidth: "infinity" }} padding={{ horizontal: 14 }}>
      {searchBar}
      <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
        <Text font={11} foregroundStyle="secondaryLabel">
          {`${filteredHistory.length} 部影片`}
        </Text>
        <Spacer />
        <PillButton
          icon="play.fill"
          label="全部播放"
          filled
          onTap={() => playHistoryFrom(filteredHistory)}
        />
        <PillButton
          icon="trash"
          label="清空紀錄"
          onTap={() => {
            void confirmClearHistory()
          }}
        />
      </HStack>
      {filteredHistory.length === 0
        ? (
          <EmptyState
            icon="clock.arrow.circlepath"
            title={history.length === 0 ? "尚無觀看歷史" : "沒有符合的觀看紀錄"}
            hint={history.length === 0 ? "看過的影片會自動出現在這裡，並保留上次播放進度。" : "換個關鍵字或切換平台篩選試試。"}
          />
        )
        : (
          <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
            {filteredHistory.map((entry: WatchHistoryEntry) => (
              <HistoryRow
                key={entryKey(entry)}
                entry={entry}
                onPlay={() => openEntry(entry, filteredHistory.map((item: WatchHistoryEntry): UnifiedVideoItem => item.item))}
                onOpenChannel={props.onOpenChannel}
              />
            ))}
          </VStack>
        )}
    </VStack>
  )

  // ─── Tab content: watch later ─────────────────────────────────────────────

  const watchLaterContent: VirtualNode = (
    <VStack spacing={10} frame={{ maxWidth: "infinity" }} padding={{ horizontal: 14 }}>
      <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
        <Text font={11} foregroundStyle="secondaryLabel">
          {`共 ${filteredWatchLater.length} 部`}
        </Text>
        <Spacer />
        <PillButton
          icon="play.fill"
          label="全部播放"
          filled
          onTap={() => playQueue(filteredWatchLater, false)}
        />
        <PillButton
          icon="shuffle"
          label="隨機播放"
          onTap={() => playQueue(filteredWatchLater, true)}
        />
      </HStack>
      {filteredWatchLater.length === 0
        ? (
          <EmptyState
            icon="bookmark"
            title="稍後觀看清單是空的"
            hint="從影片卡片的「⋯」選單把想看的影片收進來。"
          />
        )
        : (
          <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
            {filteredWatchLater.map((item: UnifiedVideoItem) => (
              <VStack key={item.id} spacing={0} frame={{ maxWidth: "infinity" }}>
                <VideoCard
                  item={item}
                  layout="row"
                  onSelect={() => {
                    void openVideo(item, { queue: filteredWatchLater })
                  }}
                  onOpenChannel={props.onOpenChannel}
                />
                <HStack
                  spacing={6}
                  frame={{ maxWidth: "infinity" }}
                  padding={{ leading: ROW_TEXT_INSET, trailing: 14, bottom: 10 }}
                >
                  <Text font={10} foregroundStyle="tertiaryLabel" lineLimit={1}>{item.authorName}</Text>
                  <Spacer />
                  <RowAction
                    icon="trash"
                    label="移除"
                    destructive
                    onTap={() => {
                      toggleWatchLater(item)
                    }}
                  />
                </HStack>
              </VStack>
            ))}
          </VStack>
        )}
    </VStack>
  )

  // ─── Tab content: playlists ───────────────────────────────────────────────

  const playlistOverview: VirtualNode = (
    <VStack spacing={10} frame={{ maxWidth: "infinity" }} padding={{ horizontal: 14 }}>
      <HStack
        spacing={8}
        padding={{ horizontal: 12, vertical: 11 }}
        frame={{ maxWidth: "infinity" }}
        background={PLAY_SOFT_BG}
        clipShape={{ type: "rect", cornerRadius: 12 }}
        onTapGesture={() => {
          void createPlaylistFlow()
        }}
      >
        <Image systemName="plus.circle.fill" font={18} foregroundStyle={LINK_BLUE} />
        <Text font={14} fontWeight="semibold" foregroundStyle={LINK_BLUE}>新增播放清單</Text>
        <Spacer />
      </HStack>
      {playlists.length === 0
        ? (
          <EmptyState
            icon="music.note.list"
            title="還沒有播放清單"
            hint="建立清單，把不同平台的影片收在一起。"
          />
        )
        : (
          playlists.map((playlist: CustomPlaylist) => (
            <PlaylistCard
              key={playlist.id}
              playlist={playlist}
              onOpen={() => setSelectedPlaylistId(playlist.id)}
              onPlay={() => playQueue(playlist.items, false)}
              onDelete={() => {
                void confirmDeletePlaylist(playlist)
              }}
            />
          ))
        )}
    </VStack>
  )

  const playlistDetail: VirtualNode = selectedPlaylist
    ? (
      <VStack spacing={10} frame={{ maxWidth: "infinity" }} padding={{ horizontal: 14 }}>
        <HStack spacing={4} onTapGesture={() => setSelectedPlaylistId(null)}>
          <Image systemName="chevron.left" font={12} fontWeight="semibold" foregroundStyle={LINK_BLUE} />
          <Text font={13} fontWeight="medium" foregroundStyle={LINK_BLUE}>返回所有清單</Text>
          <Spacer />
        </HStack>

        <HStack alignment="top" spacing={10} frame={{ maxWidth: "infinity" }}>
          <PlaylistCover playlist={selectedPlaylist} size={56} />
          <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity" }}>
            <Text font="title3" fontWeight="bold" foregroundStyle="label" lineLimit={2} multilineTextAlignment="leading">
              {selectedPlaylist.name}
            </Text>
            <Text font={11} foregroundStyle="secondaryLabel" lineLimit={1}>
              {`${playlistItems.length} 部影片 • ${relativeTime(selectedPlaylist.updatedAt)}`}
            </Text>
            {selectedPlaylist.description
              ? <Text font={11} foregroundStyle="tertiaryLabel" lineLimit={2}>{selectedPlaylist.description}</Text>
              : null}
          </VStack>
        </HStack>

        <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
          <PillButton
            icon="play.fill"
            label="全部播放"
            filled
            onTap={() => playQueue(playlistItems, false)}
          />
          <PillButton
            icon="shuffle"
            label="隨機播放"
            onTap={() => playQueue(playlistItems, true)}
          />
          <Spacer />
        </HStack>

        {playlistItems.length === 0
          ? (
            <EmptyState
              icon="tray"
              title="這個清單還沒有影片"
              hint="從任何影片卡片的「⋯」選單，或播放頁面把影片加入這個清單。"
            />
          )
          : (
            <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
              {playlistItems.map((item: UnifiedVideoItem) => (
                <VStack key={item.id} spacing={0} frame={{ maxWidth: "infinity" }}>
                  <VideoCard
                    item={item}
                    layout="row"
                    onSelect={() => {
                      void openVideo(item, { queue: playlistItems })
                    }}
                    onOpenChannel={props.onOpenChannel}
                  />
                  <HStack
                    spacing={6}
                    frame={{ maxWidth: "infinity" }}
                    padding={{ leading: ROW_TEXT_INSET, trailing: 14, bottom: 10 }}
                  >
                    <Text font={10} foregroundStyle="tertiaryLabel" lineLimit={1}>{item.authorName}</Text>
                    <Spacer />
                    <RowAction
                      icon="minus.circle"
                      label="從清單移除"
                      destructive
                      onTap={() => {
                        removeVideoFromPlaylist(selectedPlaylist.id, item.id)
                      }}
                    />
                  </HStack>
                </VStack>
              ))}
            </VStack>
          )}
      </VStack>
    )
    : playlistOverview

  const tabContent: VirtualNode = tab === "history"
    ? historyContent
    : tab === "watchLater"
      ? watchLaterContent
      : playlistDetail

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background="systemBackground">
      {header}
      <ScrollView
        axes="vertical"
        scrollIndicator="automatic"
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      >
        <VStack spacing={12} frame={{ maxWidth: "infinity" }} padding={{ top: 2, bottom: 4 }}>
          {tabContent}
          <Spacer frame={{ height: 96 }} />
        </VStack>
      </ScrollView>
    </VStack>
  )
}
