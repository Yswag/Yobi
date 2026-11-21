import type {
  CustomPlaylist,
  PlayerSettings,
  SubscriptionChannel,
  UnifiedVideoItem,
  WatchHistoryEntry,
} from "../types"

const KEYS = {
  settings: "yobi.settings.v1",
  subscriptions: "yobi.subscriptions.v1",
  history: "yobi.history.v1",
  watchLater: "yobi.watchLater.v1",
  playlists: "yobi.playlists.v1",
  searchHistory: "yobi.searchHistory.v1",
} as const

const HISTORY_LIMIT = 300
const SEARCH_HISTORY_LIMIT = 20

export const DEFAULT_SETTINGS: PlayerSettings = {
  youtubeStreamMode: "auto",
  videoBackend: "native",
  preferredQualityHeight: 1080,
  defaultPlaybackRate: 1,
  sponsorBlockEnabled: true,
  sponsorBlockAutoSkip: true,
  sponsorBlockCategories: [
    "sponsor",
    "selfpromo",
    "interaction",
    "intro",
    "outro",
  ],
  danmakuEnabled: true,
  danmakuOpacity: 0.9,
  danmakuSpeed: 1,
  danmakuArea: 0.5,
  danmakuBlockedWords: [],
  biliLineSwitch: false,
}

const listeners = new Set<() => void>()
let settingsCache: PlayerSettings | null = null

let subscriptionsCache: SubscriptionChannel[] | null = null
let historyCache: WatchHistoryEntry[] | null = null
let positionById: Map<string, number> = new Map()
let positionByIdCid: Map<string, number> = new Map()

function notify(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener()
    } catch {
    }
  }
}

function readArray<T>(key: string): T[] {
  const value = Storage.get<T[]>(key)
  return Array.isArray(value) ? value : []
}

function writeArray<T>(key: string, value: T[]): void {
  Storage.set(key, value)
}

function cloneSettings(settings: PlayerSettings): PlayerSettings {
  return {
    ...settings,
    sponsorBlockCategories: [...settings.sponsorBlockCategories],
    danmakuBlockedWords: [...settings.danmakuBlockedWords],
  }
}

function normalizeSettings(patch: Partial<PlayerSettings>): PlayerSettings {
  const merged: PlayerSettings = { ...DEFAULT_SETTINGS, ...(patch as PlayerSettings) }
  if (!Array.isArray(merged.sponsorBlockCategories)) {
    merged.sponsorBlockCategories = [...DEFAULT_SETTINGS.sponsorBlockCategories]
  }
  if (!Array.isArray(merged.danmakuBlockedWords)) {
    merged.danmakuBlockedWords = []
  }
  if (typeof merged.danmakuArea !== "number") merged.danmakuArea = DEFAULT_SETTINGS.danmakuArea
  if (typeof merged.danmakuOpacity !== "number") merged.danmakuOpacity = DEFAULT_SETTINGS.danmakuOpacity
  if (typeof merged.danmakuSpeed !== "number") merged.danmakuSpeed = DEFAULT_SETTINGS.danmakuSpeed
  if (typeof merged.preferredQualityHeight !== "number") {
    merged.preferredQualityHeight = DEFAULT_SETTINGS.preferredQualityHeight
  }
  if (typeof merged.biliLineSwitch !== "boolean") merged.biliLineSwitch = DEFAULT_SETTINGS.biliLineSwitch
  delete (merged as Partial<PlayerSettings> & { playbackBackend?: unknown }).playbackBackend
  if (!["auto", "native", "system", "remux"].includes(merged.videoBackend)) {
    merged.videoBackend = DEFAULT_SETTINGS.videoBackend
  }
  return merged
}

export function getSettings(): PlayerSettings {
  if (!settingsCache) {
    const stored = Storage.get<Partial<PlayerSettings>>(KEYS.settings)
    settingsCache = normalizeSettings(stored ?? {})
  }
  return cloneSettings(settingsCache)
}

export function updateSettings(patch: Partial<PlayerSettings>): PlayerSettings {
  const next = normalizeSettings({ ...getSettings(), ...patch })
  settingsCache = next
  Storage.set(KEYS.settings, next)
  notify()
  return cloneSettings(next)
}

function loadSubscriptions(): SubscriptionChannel[] {
  if (subscriptionsCache === null) subscriptionsCache = readArray<SubscriptionChannel>(KEYS.subscriptions)
  return subscriptionsCache
}

function saveSubscriptions(list: SubscriptionChannel[]): void {
  writeArray(KEYS.subscriptions, list)
  subscriptionsCache = list
}

export function getSubscriptions(): SubscriptionChannel[] {
  return loadSubscriptions()
}

export function isSubscribed(id: string): boolean {
  return loadSubscriptions().some(channel => channel.id === id)
}

export function toggleSubscription(channel: SubscriptionChannel): boolean {
  const list = loadSubscriptions().slice()
  const index = list.findIndex(entry => entry.id === channel.id)
  if (index >= 0) {
    list.splice(index, 1)
    saveSubscriptions(list)
    notify()
    return false
  }
  list.unshift({ ...channel, subscribedAt: Date.now() })
  saveSubscriptions(list)
  notify()
  return true
}

function rebuildHistoryCache(entries: WatchHistoryEntry[]): void {
  const sorted = entries.slice().sort((a, b) => b.watchedAt - a.watchedAt)
  const byId = new Map<string, number>()
  const byIdCid = new Map<string, number>()
  for (const entry of sorted) {
    if (!byId.has(entry.item.id)) byId.set(entry.item.id, entry.position)
    const cid = entry.cid ?? entry.item.cid
    if (cid !== undefined) {
      const key = `${entry.item.id}|${cid}`
      if (!byIdCid.has(key)) byIdCid.set(key, entry.position)
    }
  }
  historyCache = sorted
  positionById = byId
  positionByIdCid = byIdCid
}

function loadHistory(): WatchHistoryEntry[] {
  if (historyCache === null) rebuildHistoryCache(readArray<WatchHistoryEntry>(KEYS.history))
  return historyCache ?? []
}

function saveHistory(entries: WatchHistoryEntry[]): void {
  const limited = entries.slice(0, HISTORY_LIMIT)
  writeArray(KEYS.history, limited)
  rebuildHistoryCache(limited)
}

export function getWatchHistory(): WatchHistoryEntry[] {
  return loadHistory()
}

export function recordWatchHistory(entry: WatchHistoryEntry): void {
  if (!entry || !entry.item) return
  const cid = entry.cid ?? entry.item.cid
  const next = loadHistory().filter(existing => {
    const existingCid = existing.cid ?? existing.item.cid
    return !(existing.item.id === entry.item.id && existingCid === cid)
  })
  next.unshift({
    ...entry,
    cid,
    item: { ...entry.item, cid: entry.item.cid ?? cid },
    duration: entry.duration || entry.item.duration,
    watchedAt: entry.watchedAt || Date.now(),
  })
  saveHistory(next)
  notify()
}

export function getSavedPosition(id: string, cid?: number): number {
  loadHistory()
  if (cid === undefined) return positionById.get(id) ?? 0
  return positionByIdCid.get(`${id}|${cid}`) ?? 0
}

export function clearWatchHistory(): void {
  saveHistory([])
  notify()
}

export function getWatchLater(): UnifiedVideoItem[] {
  return readArray<UnifiedVideoItem>(KEYS.watchLater)
}

export function isInWatchLater(id: string): boolean {
  return getWatchLater().some(item => item.id === id)
}

export function toggleWatchLater(item: UnifiedVideoItem): boolean {
  const list = getWatchLater()
  const index = list.findIndex(entry => entry.id === item.id)
  if (index >= 0) {
    list.splice(index, 1)
    writeArray(KEYS.watchLater, list)
    notify()
    return false
  }
  list.unshift({ ...item })
  writeArray(KEYS.watchLater, list)
  notify()
  return true
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function getPlaylists(): CustomPlaylist[] {
  const list = readArray<CustomPlaylist>(KEYS.playlists)
  return list.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function createPlaylist(name: string, description?: string): CustomPlaylist {
  const now = Date.now()
  const playlist: CustomPlaylist = {
    id: makeId("pl"),
    name: name.trim() || "未命名播放清單",
    description,
    createdAt: now,
    updatedAt: now,
    items: [],
  }
  const list = readArray<CustomPlaylist>(KEYS.playlists)
  list.unshift(playlist)
  writeArray(KEYS.playlists, list)
  notify()
  return playlist
}

export function deletePlaylist(id: string): void {
  const list = readArray<CustomPlaylist>(KEYS.playlists)
  const next = list.filter(playlist => playlist.id !== id)
  if (next.length === list.length) return
  writeArray(KEYS.playlists, next)
  notify()
}

export function addVideoToPlaylist(playlistId: string, item: UnifiedVideoItem): void {
  const list = readArray<CustomPlaylist>(KEYS.playlists)
  const playlist = list.find(entry => entry.id === playlistId)
  if (!playlist) return
  playlist.items = playlist.items.filter(entry => entry.id !== item.id)
  playlist.items.unshift({ ...item })
  playlist.updatedAt = Date.now()
  writeArray(KEYS.playlists, list)
  notify()
}

export function removeVideoFromPlaylist(playlistId: string, videoId: string): void {
  const list = readArray<CustomPlaylist>(KEYS.playlists)
  const playlist = list.find(entry => entry.id === playlistId)
  if (!playlist) return
  const next = playlist.items.filter(entry => entry.id !== videoId)
  if (next.length === playlist.items.length) return
  playlist.items = next
  playlist.updatedAt = Date.now()
  writeArray(KEYS.playlists, list)
  notify()
}

export function getSearchHistory(): string[] {
  return readArray<string>(KEYS.searchHistory).filter(
    entry => typeof entry === "string" && entry.length > 0,
  )
}

export function addSearchHistory(query: string): void {
  const trimmed = query.trim()
  if (!trimmed) return
  const next = getSearchHistory().filter(entry => entry !== trimmed)
  next.unshift(trimmed)
  writeArray(KEYS.searchHistory, next.slice(0, SEARCH_HISTORY_LIMIT))
  notify()
}

export function clearSearchHistory(): void {
  writeArray(KEYS.searchHistory, [])
  notify()
}

export function exportAllData(): string {
  return JSON.stringify(
    {
      version: 1,
      exportedAt: Date.now(),
      settings: getSettings(),
      subscriptions: getSubscriptions(),
      watchHistory: getWatchHistory(),
      watchLater: getWatchLater(),
      playlists: getPlaylists(),
      searchHistory: getSearchHistory(),
    },
    null,
    2,
  )
}

export function importAllData(jsonText: string): boolean {
  let parsed: any = null
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== "object") return false

  try {
    if (parsed.settings && typeof parsed.settings === "object") {
      const next = normalizeSettings(parsed.settings)
      settingsCache = next
      Storage.set(KEYS.settings, next)
    }
    if (Array.isArray(parsed.subscriptions)) {
      saveSubscriptions(parsed.subscriptions)
    }
    if (Array.isArray(parsed.watchHistory)) {
      saveHistory(parsed.watchHistory)
    }
    if (Array.isArray(parsed.watchLater)) {
      writeArray(KEYS.watchLater, parsed.watchLater)
    }
    if (Array.isArray(parsed.playlists)) {
      writeArray(KEYS.playlists, parsed.playlists)
    }
    if (Array.isArray(parsed.searchHistory)) {
      writeArray(
        KEYS.searchHistory,
        parsed.searchHistory
          .filter((entry: unknown) => typeof entry === "string" && entry.length > 0)
          .slice(0, SEARCH_HISTORY_LIMIT),
      )
    }
    notify()
    return true
  } catch {
    return false
  }
}

export function subscribeStorageChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
