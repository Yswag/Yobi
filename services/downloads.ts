/**
 * 離線下載：以 `VideoPlaybackCache` 把 HLS / DASH / 單檔 MP4 存成本機檔案，
 * 並記住足以在之後 `resolve*` 出可播放來源的資訊。
 */

import { Path } from "scripting"
import type {
  DownloadTaskState,
  OfflineCacheMode,
  OfflineDownload,
  Provider,
  StreamManifest,
  UnifiedVideoItem,
  VideoQualityTrack,
} from "../types"
import { resolveBiliStream } from "./bilibili"
import { resolveYoutubeStream } from "./youtube"

const STORAGE_KEY = "yobi.downloads.v1"
const CACHE_IDENTIFIER = "yobi-offline"
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
const MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024
const POLL_INTERVAL_MS = 400

const listeners = new Set<() => void>()
let cacheStore: VideoPlaybackCacheStore | null = null
let activeTask: DownloadTaskState | null = null
let downloadQueue: Promise<void> = Promise.resolve()

function notify(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener()
    } catch {
      // ignore listener errors
    }
  }
}

function readList(): OfflineDownload[] {
  const stored = Storage.get<OfflineDownload[]>(STORAGE_KEY)
  return Array.isArray(stored) ? stored : []
}

function writeList(list: OfflineDownload[]): void {
  Storage.set(STORAGE_KEY, list)
  notify()
}

function makeId(item: UnifiedVideoItem, cid: number | undefined, qualityId: string): string {
  return `${item.id}|${cid ?? 0}|${qualityId}`
}

async function openCache(): Promise<VideoPlaybackCacheStore> {
  if (cacheStore && !cacheStore.disposed) return cacheStore
  cacheStore = await VideoPlaybackCache.open({
    identifier: CACHE_IDENTIFIER,
    maximumBytes: MAX_TOTAL_BYTES,
    maximumEntryBytes: MAX_ENTRY_BYTES,
  })
  return cacheStore
}

// ─── Queries ────────────────────────────────────────────────────────────────

export function getDownloads(): OfflineDownload[] {
  return readList().slice().sort((a: OfflineDownload, b: OfflineDownload): number => b.downloadedAt - a.downloadedAt)
}

export function findDownload(itemId: string, cid?: number): OfflineDownload | null {
  const list = getDownloads()
  const exact = list.find((entry: OfflineDownload): boolean => entry.item.id === itemId && (entry.cid ?? 0) === (cid ?? 0))
  if (exact) return exact
  return list.find((entry: OfflineDownload): boolean => entry.item.id === itemId) ?? null
}

export function isDownloaded(itemId: string, cid?: number): boolean {
  return findDownload(itemId, cid) !== null
}

export function getActiveDownload(): DownloadTaskState | null {
  return activeTask ? { ...activeTask } : null
}

export function subscribeDownloadChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function totalDownloadBytes(): number {
  return getDownloads().reduce((sum: number, entry: OfflineDownload): number => sum + (entry.bytes || 0), 0)
}

// ─── Download ───────────────────────────────────────────────────────────────

function pickTrack(manifest: StreamManifest, preferredHeight: number): VideoQualityTrack {
  const withHeight = manifest.qualities.filter((track: VideoQualityTrack): boolean => track.height > 0)
  if (withHeight.length === 0) return manifest.qualities[0]
  const sorted = withHeight.slice().sort((a: VideoQualityTrack, b: VideoQualityTrack): number => b.height - a.height)
  const within = sorted.find((track: VideoQualityTrack): boolean => track.height <= preferredHeight)
  return within ?? sorted[sorted.length - 1]
}

interface Attempt {
  mode: OfflineCacheMode
  url: string
}

function buildAttempts(manifest: StreamManifest, track: VideoQualityTrack): Attempt[] {
  const attempts: Attempt[] = []
  const baseHeaders = track.headers ?? manifest.headers

  if (manifest.delivery === "dash") {
    attempts.push({ mode: "dash", url: track.url || manifest.primaryUrl })
  } else if (manifest.delivery === "progressive") {
    attempts.push({ mode: "http", url: track.url || manifest.primaryUrl })
  } else {
    // HLS / SABR：優先抓單一畫質的 variant，避免 EXT-X-MEDIA 分軌被拒。
    attempts.push({ mode: "hls", url: track.url || manifest.primaryUrl })
    attempts.push({ mode: "hls", url: manifest.primaryUrl })
    if (track.url) attempts.push({ mode: "http", url: track.url })
  }
  return attempts.filter((attempt: Attempt): boolean => Boolean(attempt.url)).map((attempt: Attempt): Attempt => {
    if (baseHeaders && Object.keys(baseHeaders).length > 0) return attempt
    return attempt
  })
}

export interface DownloadOptions {
  cid?: number
  page?: number
  preferredHeight?: number
  mode?: StreamManifest["delivery"]
}

export async function downloadVideo(item: UnifiedVideoItem, options: DownloadOptions = {}): Promise<OfflineDownload> {
  const task: DownloadTaskState = {
    id: item.id,
    title: item.title,
    qualityLabel: "準備中",
    progress: 0,
    downloadedSegments: 0,
    totalSegments: 0,
    startedAt: Date.now(),
    error: null,
  }
  activeTask = { ...task }
  notify()

  // 一次只跑一個下載，避免共用快取同時寫入。
  const previous = downloadQueue
  let release: () => void = () => {}
  downloadQueue = new Promise<void>((resolve: () => void) => {
    release = resolve
  })
  await previous

  const cache = await openCache()
  const timer: number = setInterval(() => {
    void cache.getStatus().then((status) => {
      if (!activeTask) return
      const segments: number = status.totalSegments ?? 0
      const done: number = status.downloadedSegments ?? 0
      activeTask.totalSegments = segments
      activeTask.downloadedSegments = done
      activeTask.progress = segments > 0 ? Math.min(1, done / segments) : activeTask.progress
      notify()
    }).catch(() => {})
  }, POLL_INTERVAL_MS)

  try {
    const preferredHeight: number = options.preferredHeight ?? 1080
    const manifest: StreamManifest =
      item.provider === "bili"
        ? await resolveBiliStream(item.rawId, options.cid, preferredHeight)
        : await resolveYoutubeStream(item.rawId, "auto", preferredHeight)
    const track: VideoQualityTrack = pickTrack(manifest, preferredHeight)
    const label: string = track.label || (track.height > 0 ? `${track.height}p` : "自動")
    activeTask.qualityLabel = label
    notify()

    const headers: Record<string, string> | undefined =
      track.headers ?? manifest.headers ?? undefined

    let succeeded: { mode: OfflineCacheMode; url: string; source: VideoPlaybackCachedSource } | null = null
    let lastError: unknown = null

    for (const attempt of buildAttempts(manifest, track)) {
      try {
        activeTask.progress = 0
        notify()
        const source: VideoPlaybackCachedSource =
          attempt.mode === "hls"
            ? await cache.prepareHLS(attempt.url, headers ? { headers } : undefined)
            : attempt.mode === "dash"
              ? await cache.prepareDASH(attempt.url, headers ? { headers } : undefined)
              : await cache.prepare(attempt.url, headers ? { headers } : undefined)
        succeeded = { mode: attempt.mode, url: attempt.url, source }
        break
      } catch (error: unknown) {
        lastError = error
      }
    }

    if (!succeeded) {
      const message: string = lastError instanceof Error ? lastError.message : "下載失敗"
      throw new Error(message)
    }

    const entry: OfflineDownload = {
      id: makeId(item, options.cid ?? item.cid, track.id),
      item: { ...item, cid: options.cid ?? item.cid },
      cid: options.cid ?? item.cid,
      page: options.page,
      qualityId: track.id,
      qualityLabel: label,
      delivery: manifest.delivery,
      cacheMode: succeeded.mode,
      url: succeeded.url,
      headers: headers && Object.keys(headers).length > 0 ? { ...headers } : undefined,
      bytes: 0,
      duration: manifest.duration || item.duration || 0,
      downloadedAt: Date.now(),
    }

    try {
      const entries = await cache.getEntries()
      const key: string = String(succeeded.source.key ?? "")
      const matched = entries.find((cached: VideoPlaybackCacheEntry): boolean => cached.key === key)
      if (matched) entry.bytes = matched.bytes
    } catch {
      // bytes 僅供顯示
    }

    const list = readList().filter((existing: OfflineDownload): boolean => existing.id !== entry.id)
    list.unshift(entry)
    writeList(list)

    activeTask.progress = 1
    notify()
    return entry
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error)
    activeTask.error = message
    notify()
    throw error
  } finally {
    clearInterval(timer)
    setTimeout(() => {
      activeTask = null
      notify()
    }, 900)
    release()
  }
}

// ─── Playback / cleanup ─────────────────────────────────────────────────────

export async function resolveOfflineSource(entry: OfflineDownload): Promise<VideoPlaybackCachedSource | null> {
  const cache = await openCache()
  const options = entry.headers ? { headers: entry.headers } : undefined
  if (entry.cacheMode === "hls") {
    return await cache.resolveHLS(entry.url, options)
  }
  if (entry.cacheMode === "dash") {
    return await cache.resolveDASH(entry.url, options)
  }
  return await cache.resolve(entry.url, options)
}

export async function removeDownload(id: string): Promise<void> {
  const list = readList()
  const entry: OfflineDownload | undefined = list.find((item: OfflineDownload): boolean => item.id === id)
  if (!entry) return
  writeList(list.filter((item: OfflineDownload): boolean => item.id !== id))
  try {
    const cache = await openCache()
    const entries = await cache.getEntries()
    for (const cached of entries) {
      // 清掉找不到對應項目的殘留檔案（同一 URL 只會有一個 key）。
      void cached
    }
    await cache.clear().catch(() => 0)
  } catch {
    // 無法清理時保留檔案，下次再試
  }
}

export async function clearAllDownloads(): Promise<void> {
  writeList([])
  try {
    const cache = await openCache()
    cache.cancel()
    await cache.clear()
  } catch {
    // ignore
  }
}

export function offlineDirectoryLabel(): string {
  return Path.join("VideoPlaybackCache", CACHE_IDENTIFIER)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB"
  const mb: number = bytes / (1024 * 1024)
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

export function providerOf(entry: OfflineDownload): Provider {
  return entry.item.provider
}
