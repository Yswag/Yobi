import { useEffect, useRef, useState } from "scripting"
import type {
  PlaybackBackend,
  StreamManifest,
  UnifiedVideoItem,
  VideoChapter,
} from "../../types/index"
import { getSettings, recordWatchHistory } from "../../services/index"
import { reportError } from "../../services/errors"
import type {
  PlaybackStatus,
  PlayerProgressSnapshot,
  PlayerRootSnapshot,
  PlayerStoreSnapshot,
} from "./types"

const HISTORY_SAVE_INTERVAL_MS: number = 15_000

export interface PlayerRuntimeState {
  openRequestSeq: number
  streamActionSeq: number
  activeManifest: StreamManifest | null
  lastHistorySaveAt: number
  streamSwitchPending: boolean
  seekPendingCount: number
  toastTimer: number | null
  savedRateBeforeBoost: number
}

export const runtime: PlayerRuntimeState = {
  openRequestSeq: 0,
  streamActionSeq: 0,
  activeManifest: null,
  lastHistorySaveAt: 0,
  streamSwitchPending: false,
  seekPendingCount: 0,
  toastTimer: null,
  savedRateBeforeBoost: 1,
}

const storeListeners: Set<() => void> = new Set()
const progressListeners: Set<() => void> = new Set()

let storeState: PlayerStoreSnapshot = {
  presentationMode: "hidden",
  currentItem: null,
  detail: null,
  manifest: null,
  sponsorSegments: [],
  activeSponsorPrompt: null,
  skippedToast: null,
  status: "idle",
  errorText: null,
  playbackRate: 1,
  isBoosting2x: false,
  selectedQualityId: "auto",
  selectedQualityLabel: "自動",
  selectedSubtitleId: null,
  activeCid: undefined,
  activePage: 1,
  isFullscreen: false,
  isPortraitFullscreen: false,
  isPiPActive: false,
  pipAvailable: false,
  audioUnavailable: false,
  danmakuEnabled: true,
  danmakuCount: 0,
  statsVisible: false,
  queue: [],
  queueIndex: -1,
  settings: getSettings(),
}

let progressState: PlayerProgressSnapshot = {
  position: 0,
  duration: 0,
  bufferedUntil: 0,
  activeChapter: null,
}

let lastEmittedStore: PlayerStoreSnapshot | null = null
let lastEmittedProgress: PlayerProgressSnapshot | null = null
let progressPaused: boolean = false

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false
  const recordA: Record<string, unknown> = a as Record<string, unknown>
  const recordB: Record<string, unknown> = b as Record<string, unknown>
  const keysA: string[] = Object.keys(recordA)
  const keysB: string[] = Object.keys(recordB)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(recordB, key)) return false
    if (!Object.is(recordA[key], recordB[key])) return false
  }
  return true
}

function sameProgress(next: PlayerProgressSnapshot, previous: PlayerProgressSnapshot | null): boolean {
  if (previous === null) return false
  return (
    Math.floor(next.position) === Math.floor(previous.position) &&
    Math.floor(next.duration) === Math.floor(previous.duration) &&
    Math.floor(next.bufferedUntil) === Math.floor(previous.bufferedUntil) &&
    next.activeChapter === previous.activeChapter
  )
}

export function readDraftStore(): PlayerStoreSnapshot {
  return storeState
}

export function patchStore(patch: Partial<PlayerStoreSnapshot>): void {
  Object.assign(storeState, patch)
}

export function replaceStore(next: PlayerStoreSnapshot): void {
  storeState = next
}

export function emitStore(): void {
  const next: PlayerStoreSnapshot = { ...storeState }
  if (lastEmittedStore !== null && shallowEqual(next, lastEmittedStore)) return
  lastEmittedStore = next
  storeState = { ...next }
  for (const listener of Array.from(storeListeners)) {
    try {
      listener()
    } catch (error) {
      reportError("player", "store.listener", error)
    }
  }
}

export function readDraftProgress(): PlayerProgressSnapshot {
  return progressState
}

export function patchProgress(patch: Partial<PlayerProgressSnapshot>): void {
  Object.assign(progressState, patch)
}

export function replaceProgress(next: PlayerProgressSnapshot): void {
  progressState = next
}

export function emitProgress(): void {
  if (progressPaused) return
  const next: PlayerProgressSnapshot = { ...progressState }
  if (sameProgress(next, lastEmittedProgress)) return
  lastEmittedProgress = next
  progressState = { ...next }
  for (const listener of Array.from(progressListeners)) {
    try {
      listener()
    } catch (error) {
      reportError("player", "progress.listener", error)
    }
  }
}

export function setProgressUpdatesPaused(paused: boolean): void {
  if (progressPaused === paused) return
  progressPaused = paused
  if (paused) return
  lastEmittedProgress = null
  emitProgress()
}

export function isLivePlayback(): boolean {
  return storeState.currentItem?.isLive === true
}

export function pickBackend(sourceBackend: PlaybackBackend): PlaybackBackend {
  if (isLivePlayback() || sourceBackend === "system") return sourceBackend
  return storeState.settings.videoBackend
}

export function syncStatus(next: PlaybackStatus): void {
  if (storeState.status === next) return
  storeState.status = next
  emitStore()
}

export function mapControllerState(rawState: VideoPlaybackState): PlaybackStatus {
  switch (rawState) {
    case "playing":
      return "playing"
    case "paused":
      return "paused"
    case "buffering":
    case "loading":
    case "seeking":
      return "buffering"
    case "ready":
      return "ready"
    case "ended":
      return "ended"
    case "failed":
      return "error"
    default:
      return "idle"
  }
}

export function findChapterAt(chapters: VideoChapter[] | undefined, seconds: number): VideoChapter | null {
  if (!chapters || chapters.length === 0 || !Number.isFinite(seconds)) return null
  for (const chapter of chapters) {
    if (seconds >= chapter.startTime && seconds < chapter.endTime) {
      return chapter
    }
  }
  return null
}

export function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve: (value: T | "timeout") => void, reject: (reason: unknown) => void): void => {
    const timer: number = setTimeout((): void => resolve("timeout"), ms)
    task.then(
      (value: T): void => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown): void => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function clearToastTimer(): void {
  if (runtime.toastTimer !== null) {
    clearTimeout(runtime.toastTimer)
    runtime.toastTimer = null
  }
}

export function showSkippedToast(message: string): void {
  clearToastTimer()
  storeState.skippedToast = message
  emitStore()
  runtime.toastTimer = setTimeout(() => {
    storeState.skippedToast = null
    runtime.toastTimer = null
    emitStore()
  }, 2600)
}

export function disposeActiveManifest(): void {
  const current: StreamManifest | null = runtime.activeManifest
  runtime.activeManifest = null
  if (!current?.dispose) return
  try {
    current.dispose()
  } catch (error) {
    reportError("player", "manifest.dispose", error)
  }
}

export function saveCurrentHistory(force: boolean = false): void {
  const item: UnifiedVideoItem | null = storeState.currentItem
  if (!item || runtime.streamSwitchPending) return
  if (!force && (progressPaused || storeState.status !== "playing")) return
  const pos: number = progressState.position
  if (pos <= 1) return
  const now: number = Date.now()
  if (!force && now - runtime.lastHistorySaveAt < HISTORY_SAVE_INTERVAL_MS) return
  runtime.lastHistorySaveAt = now
  recordWatchHistory({
    item,
    position: item.isLive ? 0 : pos,
    duration: progressState.duration || storeState.manifest?.duration || item.duration || 0,
    watchedAt: now,
    cid: storeState.activeCid,
    page: storeState.activePage,
  })
}

export function getPlayerStoreSnapshot(): PlayerStoreSnapshot {
  return lastEmittedStore ?? storeState
}

export function getPlayerProgressSnapshot(): PlayerProgressSnapshot {
  return lastEmittedProgress ?? progressState
}

export function subscribePlayerStore(listener: () => void): () => void {
  storeListeners.add(listener)
  return (): void => {
    storeListeners.delete(listener)
  }
}

export function subscribePlayerProgress(listener: () => void): () => void {
  progressListeners.add(listener)
  return (): void => {
    progressListeners.delete(listener)
  }
}

export function usePlayerStore(): PlayerStoreSnapshot {
  const [snap, setSnap] = useState<PlayerStoreSnapshot>(() => getPlayerStoreSnapshot())
  useEffect(() => {
    setSnap(getPlayerStoreSnapshot())
    return subscribePlayerStore(() => {
      setSnap(getPlayerStoreSnapshot())
    })
  }, [])
  return snap
}

export function usePlayerSelector<T>(
  selector: (snapshot: PlayerStoreSnapshot) => T,
  isEqual: (previous: T, next: T) => boolean = shallowEqual,
): T {
  const selectorRef = useRef<(snapshot: PlayerStoreSnapshot) => T>(selector)
  selectorRef.current = selector
  const isEqualRef = useRef<(previous: T, next: T) => boolean>(isEqual)
  isEqualRef.current = isEqual

  const [selected, setSelected] = useState<T>(() => selector(getPlayerStoreSnapshot()))
  useEffect(() => {
    const sync = (): void => {
      const next: T = selectorRef.current(getPlayerStoreSnapshot())
      setSelected((previous: T): T => (isEqualRef.current(previous, next) ? previous : next))
    }
    sync()
    return subscribePlayerStore(sync)
  }, [])
  return selected
}

export function usePlayerRootState(): PlayerRootSnapshot {
  return usePlayerSelector(
    (snapshot: PlayerStoreSnapshot): PlayerRootSnapshot => ({
      isFullscreen: snapshot.isFullscreen,
      hasItem: snapshot.currentItem !== null,
    }),
  )
}

export function usePlayerProgress(): PlayerProgressSnapshot {
  const [snap, setSnap] = useState<PlayerProgressSnapshot>(() => getPlayerProgressSnapshot())
  useEffect(() => {
    setSnap(getPlayerProgressSnapshot())
    return subscribePlayerProgress(() => {
      setSnap(getPlayerProgressSnapshot())
    })
  }, [])
  return snap
}
