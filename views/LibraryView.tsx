import {
  Button,
  HStack,
  Image,
  LazyVStack,
  Menu,
  Picker,
  ScrollView,
  TabView,
  Text,
  VStack,
  useEffect,
  useRef,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
import type {
  CustomPlaylist,
  OpenChannel,
  ProviderFilter,
  UnifiedVideoItem,
  WatchHistoryEntry,
} from "../types/index"
import { playVideoQueue } from "../actions/index"
import { VideoCard } from "../components/VideoCard"
import type { CardAction } from "../components/VideoCard"
import {
  PlayActions,
  PlaylistDetailView,
  PlaylistRow,
  entryKey,
  historyMeta,
  matchesKeyword,
  PLAYLIST_COVER_WIDTH,
} from "../components/library/LibraryComponents"
import type { StorageTopic } from "../services/index"
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
} from "../services/index"
import { getPlayerStoreSnapshot, openVideo, subscribePlayerStore } from "../state/playerStore"
import {
  ChipBar,
  EmptyState,
  GlassIconButton,
  PageHeader,
  PROVIDER_FILTERS,
  SearchField,
} from "../ui/primitives"
import { motion, palette, radius, space, type } from "../ui/theme"

export interface LibraryViewProps {
  onOpenChannel?: OpenChannel
  onOpenSettings?: () => void
}

type LibraryTab = "history" | "watchLater" | "playlists"

const LIBRARY_TABS: LibraryTab[] = ["history", "watchLater", "playlists"]

export function LibraryView(props: LibraryViewProps): VirtualNode {
  const [history, setHistory] = useState<WatchHistoryEntry[]>(getWatchHistory())
  const [watchLater, setWatchLater] = useState<UnifiedVideoItem[]>(getWatchLater())
  const [playlists, setPlaylists] = useState<CustomPlaylist[]>(getPlaylists())
  const [filter, setFilter] = useState<ProviderFilter>("all")
  const [tab, setTab] = useState<LibraryTab>("history")
  const [query, setQuery] = useState<string>("")
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null)
  const visibleRef = useRef<boolean>(false)
  const dirtyHistoryRef = useRef<boolean>(false)

  const isVisibleNow = (): boolean =>
    visibleRef.current && getPlayerStoreSnapshot().presentationMode !== "expanded"

  const flushDirtyHistory = (): void => {
    if (!dirtyHistoryRef.current || !isVisibleNow()) return
    dirtyHistoryRef.current = false
    setHistory(getWatchHistory())
  }

  const refresh = (topic?: StorageTopic): void => {
    if (!topic || topic === "history") {
      if (!topic || isVisibleNow()) {
        dirtyHistoryRef.current = false
        setHistory(getWatchHistory())
      } else {
        dirtyHistoryRef.current = true
      }
    }
    if (!topic || topic === "watchLater") setWatchLater(getWatchLater())
    if (!topic || topic === "playlists") setPlaylists(getPlaylists())
  }

  useEffect(() => {
    refresh()
    const unsubscribeStorage: () => void = subscribeStorageChanges(refresh, ["history", "watchLater", "playlists"])
    const unsubscribePlayer: () => void = subscribePlayerStore(flushDirtyHistory)
    return (): void => {
      unsubscribeStorage()
      unsubscribePlayer()
    }
  }, [])

  const keyword: string = query.trim().toLowerCase()
  const byProvider = (item: UnifiedVideoItem): boolean => filter === "all" || item.provider === filter

  const filteredHistory: WatchHistoryEntry[] = history.filter(
    (entry: WatchHistoryEntry): boolean => byProvider(entry.item) && matchesKeyword(entry.item, keyword),
  )
  const filteredWatchLater: UnifiedVideoItem[] = watchLater.filter(byProvider)

  const selectedPlaylist: CustomPlaylist | null = selectedPlaylistId
    ? playlists.find((playlist: CustomPlaylist): boolean => playlist.id === selectedPlaylistId) ?? null
    : null
  const playlistItems: UnifiedVideoItem[] = selectedPlaylist ? selectedPlaylist.items.filter(byProvider) : []

  const openEntry = (entry: WatchHistoryEntry, queue: UnifiedVideoItem[]): void => {
    void openVideo(entry.item, {
      cid: entry.cid,
      page: entry.page,
      startSeconds: entry.position,
      queue,
    })
  }

  const playQueue = (items: UnifiedVideoItem[], random: boolean): void => {
    playVideoQueue(items, { shuffle: random })
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

  const videoList = (items: UnifiedVideoItem[], actionsFor: (item: UnifiedVideoItem) => CardAction[]): VirtualNode => (
    <LazyVStack spacing={4} frame={{ maxWidth: "infinity" }}>
      {items.map((item: UnifiedVideoItem) => (
        <VideoCard
          key={item.id}
          item={item}
          layout="row"
          actions={actionsFor(item)}
          onSelect={() => {
            void openVideo(item, { queue: items })
          }}
          onOpenChannel={props.onOpenChannel}
        />
      ))}
    </LazyVStack>
  )

  if (selectedPlaylist) {
    return (
      <PlaylistDetailView
        playlist={selectedPlaylist}
        items={playlistItems}
        filter={filter}
        onFilterChange={setFilter}
        onBack={() => setSelectedPlaylistId(null)}
        onPlay={() => playQueue(playlistItems, false)}
        onShuffle={() => playQueue(playlistItems, true)}
        onSelectItem={(item: UnifiedVideoItem, queue: UnifiedVideoItem[]) => {
          void openVideo(item, { queue })
        }}
        onRemoveItem={(item: UnifiedVideoItem) => removeVideoFromPlaylist(selectedPlaylist.id, item.id)}
        onOpenChannel={props.onOpenChannel}
      />
    )
  }

  const historyPage = (): VirtualNode => {
    return (
      <VStack spacing={14} frame={{ maxWidth: "infinity" }}>
        {history.length > 0 ? (
          <VStack padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity" }}>
            <SearchField value={query} prompt="搜尋觀看紀錄" onChange={setQuery} />
          </VStack>
        ) : null}
        <ChipBar
          options={PROVIDER_FILTERS}
          value={filter}
          onChange={setFilter}
          trailing={history.length > 0 ? (
            <Menu
              label={
                <HStack spacing={0} frame={{ width: 34, height: 34 }} contentShape="rect">
                  <Image systemName="ellipsis.circle" font={18} foregroundStyle="secondaryLabel" />
                </HStack>
              }
            >
              <Button
                title="全部播放"
                systemImage="play.fill"
                action={() => {
                  const first: WatchHistoryEntry | undefined = filteredHistory[0]
                  if (first) openEntry(first, filteredHistory.map((entry: WatchHistoryEntry) => entry.item))
                }}
              />
              <Button title="清空觀看紀錄" systemImage="trash" role="destructive" action={() => void confirmClearHistory()} />
            </Menu>
          ) : undefined}
        />
        {filteredHistory.length === 0 ? (
          <EmptyState
            icon="clock.arrow.circlepath"
            title={history.length === 0 ? "還沒有觀看紀錄" : "沒有符合的紀錄"}
            message={history.length === 0 ? "看過的影片會留在這裡，並記住播放進度" : undefined}
          />
        ) : (
          <LazyVStack spacing={4} frame={{ maxWidth: "infinity" }}>
            {filteredHistory.map((entry: WatchHistoryEntry) => (
              <VideoCard
                key={entryKey(entry)}
                item={entry.item}
                layout="row"
                progressSeconds={entry.position}
                meta={historyMeta(entry)}
                onSelect={() => openEntry(entry, filteredHistory.map((item: WatchHistoryEntry) => item.item))}
                onOpenChannel={props.onOpenChannel}
              />
            ))}
          </LazyVStack>
        )}
      </VStack>
    )
  }

  const watchLaterPage = (): VirtualNode => {
    return (
      <VStack spacing={14} frame={{ maxWidth: "infinity" }}>
        {filteredWatchLater.length > 0 ? (
          <PlayActions
            onPlay={() => playQueue(filteredWatchLater, false)}
            onShuffle={() => playQueue(filteredWatchLater, true)}
          />
        ) : null}
        <ChipBar options={PROVIDER_FILTERS} value={filter} onChange={setFilter} />
        {filteredWatchLater.length === 0 ? (
          <EmptyState
            icon="bookmark"
            title="稍後觀看是空的"
            message="在影片的「⋯」選單選「加入稍後觀看」"
          />
        ) : videoList(filteredWatchLater, (item: UnifiedVideoItem) => [{
          label: "從稍後觀看移除",
          icon: "bookmark.slash",
          destructive: true,
          onTap: () => {
            toggleWatchLater(item)
          },
        }])}
      </VStack>
    )
  }

  const playlistsPage = (): VirtualNode => {
    return (
      <VStack spacing={8} frame={{ maxWidth: "infinity" }}>
        <HStack
          spacing={12}
          padding={{ horizontal: space.page, vertical: 8 }}
          frame={{ maxWidth: "infinity", alignment: "leading" }}
          contentShape="rect"
          onTapGesture={() => void createPlaylistFlow()}
        >
          <VStack
            frame={{ width: PLAYLIST_COVER_WIDTH, height: Math.round(PLAYLIST_COVER_WIDTH * 9 / 16) }}
            background={{ style: "tertiarySystemFill", shape: { type: "rect", cornerRadius: radius.sm, style: "continuous" } }}
          >
            <Image systemName="plus" font={22} fontWeight="semibold" foregroundStyle={palette.brand} />
          </VStack>
          <Text font={type.cardTitle} fontWeight="semibold" foregroundStyle={palette.brand}>新增播放清單</Text>
        </HStack>
        {playlists.length === 0 ? (
          <EmptyState
            icon="music.note.list"
            title="還沒有播放清單"
            message="把不同平台的影片收在同一個清單"
          />
        ) : (
          playlists.map((playlist: CustomPlaylist) => (
            <PlaylistRow
              key={playlist.id}
              playlist={playlist}
              onOpen={() => setSelectedPlaylistId(playlist.id)}
              onPlay={() => playQueue(playlist.items, false)}
              onShuffle={() => playQueue(playlist.items, true)}
              onDelete={() => void confirmDeletePlaylist(playlist)}
            />
          ))
        )}
      </VStack>
    )
  }

  const pageScroll = (content: VirtualNode, index: number): VirtualNode => (
    <ScrollView axes="vertical" scrollIndicator="hidden" scrollDismissesKeyboard="immediately" tag={index}>
      <VStack spacing={0} frame={{ maxWidth: "infinity" }} padding={{ top: 4, bottom: 16 }}>
        {content}
      </VStack>
    </ScrollView>
  )

  return (
    <VStack
      spacing={14}
      frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}
      onAppear={() => {
        visibleRef.current = true
        flushDirtyHistory()
      }}
      onDisappear={() => {
        visibleRef.current = false
      }}
    >
      <PageHeader
        title="媒體庫"
        trailing={props.onOpenSettings ? <GlassIconButton icon="gearshape" onTap={props.onOpenSettings} /> : undefined}
      />
      <Picker
        title="媒體庫分類"
        value={tab}
        onChanged={(next: string) => withAnimation(motion.move, () => setTab(next as LibraryTab))}
        pickerStyle="segmented"
        padding={{ horizontal: space.page }}
      >
        <Text tag="history">觀看紀錄</Text>
        <Text tag="watchLater">稍後觀看</Text>
        <Text tag="playlists">清單</Text>
      </Picker>
      <TabView
        tabIndex={LIBRARY_TABS.indexOf(tab)}
        onTabIndexChanged={(index: number) => setTab(LIBRARY_TABS[index] ?? "history")}
        tabViewStyle="pageNeverDisplayIndex"
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      >
        {pageScroll(historyPage(), 0)}
        {pageScroll(watchLaterPage(), 1)}
        {pageScroll(playlistsPage(), 2)}
      </TabView>
    </VStack>
  )
}
