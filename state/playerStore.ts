import { AppEvents, fetch, useEffect, useState } from "scripting"
import type { ScenePhase } from "scripting"
import type {
  CommentItem,
  CommentPage,
  CommentSort,
  PlaybackBackend,
  PlayerSettings,
  SponsorSegment,
  StreamManifest,
  SubtitleTrackInfo,
  UnifiedVideoItem,
  VideoChapter,
  VideoDetail,
  VideoPagePart,
  VideoQualityTrack,
} from "../types"
import {
  fetchBiliDanmakuXml,
  fetchSponsorSegments,
  filterSegmentsForCid,
  findActiveSponsorSegment,
  getCommentPage,
  getCommentReplies,
  getSavedPosition,
  getSettings,
  getVideoDetail,
  getYoutubeLiveViewers,
  recordWatchHistory,
  releaseAllPrefetchers,
  resolveStream,
  setBiliLineSwitchListener,
  subscribeStorageChanges,
  updateSettings,
  warmStreamStart,
} from "../services"
import { effectiveResolution, SPONSOR_CATEGORY_LABELS } from "../utils/format"
import { biliSubtitleToVtt, toCleanVtt } from "../utils/subtitles"
import { reportError } from "../services/errors"

export type PlayerPresentationMode = "hidden" | "expanded" | "mini"

export type PlaybackStatus =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "buffering"
  | "ended"
  | "error"

export interface PlayerStoreSnapshot {
  presentationMode: PlayerPresentationMode
  currentItem: UnifiedVideoItem | null
  detail: VideoDetail | null
  manifest: StreamManifest | null
  sponsorSegments: SponsorSegment[]
  activeSponsorPrompt: SponsorSegment | null
  skippedToast: string | null
  status: PlaybackStatus
  errorText: string | null
  playbackRate: number
  isBoosting2x: boolean
  selectedQualityId: string
  selectedQualityLabel: string
  selectedSubtitleId: string | null
  activeCid?: number
  activePage: number
  isFullscreen: boolean
  isPortraitFullscreen: boolean
  isPiPActive: boolean
  pipAvailable: boolean
  audioUnavailable: boolean
  danmakuEnabled: boolean
  danmakuCount: number
  statsVisible: boolean
  queue: UnifiedVideoItem[]
  queueIndex: number
  settings: PlayerSettings
}

export interface CommentsStoreSnapshot {
  comments: CommentItem[]
  loading: boolean
  sort: CommentSort
  cursor: string | null
  loadingMore: boolean
  repliesLoading: Record<string, boolean>
}

export interface PlayerRootSnapshot {
  isFullscreen: boolean
  hasItem: boolean
}

export interface PlayerProgressSnapshot {
  position: number
  duration: number
  bufferedUntil: number
  activeChapter: VideoChapter | null
}

let controllerInstance: VideoPlaybackController | null = null
let audioSessionReady: boolean = false
let openRequestSeq: number = 0
let lastHistorySaveAt: number = 0
let streamSwitchPending: boolean = false
let lastSkippedSegmentUuid: string = ""
let dismissedSegmentUuid: string = ""
let sponsorSegmentsAll: SponsorSegment[] = []
let toastTimer: number | null = null
let savedRateBeforeBoost: number = 1
let savedOrientations: typeof Device.supportedInterfaceOrientations | null = null
let waitForLandscapeBeforeAutoExit: boolean = false
let waitForPortraitBeforeAutoEnter: boolean = false
let lastPhysicalOrientation: "portrait" | "landscape" | null = null
let liveViewerTimer: number | null = null
const HISTORY_SAVE_INTERVAL_MS: number = 15_000
const LIVE_VIEWER_TICK_MS: number = 60_000
export interface LiveViewerSnapshot {
  videoId: string
  count: number | null
}

let liveViewerState: LiveViewerSnapshot = { videoId: "", count: null }
const liveViewerListeners: Set<() => void> = new Set()

const storeListeners: Set<() => void> = new Set()
const progressListeners: Set<() => void> = new Set()
const commentsListeners: Set<() => void> = new Set()

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

let commentsState: CommentsStoreSnapshot = {
  comments: [],
  loading: false,
  sort: "top",
  cursor: null,
  loadingMore: false,
  repliesLoading: {},
}

let progressState: PlayerProgressSnapshot = {
  position: 0,
  duration: 0,
  bufferedUntil: 0,
  activeChapter: null,
}

function pickBackend(sourceBackend: PlaybackBackend): PlaybackBackend {
  if (isLivePlayback() || sourceBackend === "system") return sourceBackend
  return storeState.settings.videoBackend
}

export function isLivePlayback(): boolean {
  return storeState.currentItem?.isLive === true
}

function stopLiveViewerRefresh(): void {
  if (liveViewerTimer !== null) {
    clearInterval(liveViewerTimer)
    liveViewerTimer = null
  }
}

function publishLiveViewers(videoId: string, count: number | null): void {
  if (liveViewerState.videoId === videoId && liveViewerState.count === count) return
  liveViewerState = { videoId, count }
  for (const listener of Array.from(liveViewerListeners)) {
    try {
      listener()
    } catch (error) {
      reportError("player", "liveViewers.listener", error)
    }
  }
}

function startLiveViewerRefresh(item: UnifiedVideoItem): void {
  stopLiveViewerRefresh()
  publishLiveViewers(item.id, item.viewCount && item.viewCount > 0 ? item.viewCount : null)
  liveViewerTimer = setInterval((): void => {
    void getYoutubeLiveViewers(item.rawId).then((viewers: number | undefined): void => {
      if (viewers === undefined || storeState.currentItem?.id !== item.id) return
      publishLiveViewers(item.id, viewers)
    })
  }, LIVE_VIEWER_TICK_MS)
}

let lastEmittedStore: PlayerStoreSnapshot | null = null
let lastEmittedProgress: PlayerProgressSnapshot | null = null
let lastEmittedComments: CommentsStoreSnapshot | null = null
let progressPaused: boolean = false

function sameProgress(next: PlayerProgressSnapshot, previous: PlayerProgressSnapshot | null): boolean {
  if (previous === null) return false
  return (
    Math.floor(next.position) === Math.floor(previous.position) &&
    Math.floor(next.duration) === Math.floor(previous.duration) &&
    Math.floor(next.bufferedUntil) === Math.floor(previous.bufferedUntil) &&
    next.activeChapter === previous.activeChapter
  )
}

function sameObject<T extends object>(next: T, previous: T | null): boolean {
  if (previous === null) return false
  const keys: (keyof T)[] = Object.keys(next) as (keyof T)[]
  if (keys.length !== Object.keys(previous).length) return false
  for (const key of keys) {
    if (!Object.is(next[key], previous[key])) return false
  }
  return true
}

function emitStore(): void {
  const next: PlayerStoreSnapshot = { ...storeState }
  if (sameObject(next, lastEmittedStore)) return
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

function emitComments(): void {
  const next: CommentsStoreSnapshot = { ...commentsState }
  if (sameObject(next, lastEmittedComments)) return
  lastEmittedComments = next
  commentsState = { ...next }
  for (const listener of Array.from(commentsListeners)) {
    try {
      listener()
    } catch (error) {
      reportError("player", "comments.listener", error)
    }
  }
}

function saveCurrentHistory(force: boolean = false): void {
  const item: UnifiedVideoItem | null = storeState.currentItem
  if (!item || streamSwitchPending) return
  if (!force && (progressPaused || storeState.status !== "playing")) return
  const pos: number = progressState.position
  if (pos <= 1) return
  const now: number = Date.now()
  if (!force && now - lastHistorySaveAt < HISTORY_SAVE_INTERVAL_MS) return
  lastHistorySaveAt = now
  recordWatchHistory({
    item,
    position: item.isLive ? 0 : pos,
    duration: progressState.duration || storeState.manifest?.duration || item.duration || 0,
    watchedAt: now,
    cid: storeState.activeCid,
    page: storeState.activePage,
  })
}

function emitProgress(): void {
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

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | "timeout"> {
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

const RESUME_SEEK_TIMEOUT_MS: number = 20_000
const STOP_TIMEOUT_MS: number = 3000

async function seekForResume(ctrl: VideoPlaybackController, seconds: number): Promise<void> {
  try {
    const result: number | "timeout" = await withTimeout(ctrl.seek(seconds), RESUME_SEEK_TIMEOUT_MS)
    if (result === "timeout") throw new Error("載入續播位置逾時")
  } catch (error) {
    if (error instanceof Error && error.message === "載入續播位置逾時") throw error
  }
}

function showSkippedToast(message: string): void {
  if (toastTimer !== null) {
    clearTimeout(toastTimer)
    toastTimer = null
  }
  storeState.skippedToast = message
  emitStore()
  toastTimer = setTimeout(() => {
    storeState.skippedToast = null
    toastTimer = null
    emitStore()
  }, 2600)
}

function findChapterAt(chapters: VideoChapter[] | undefined, seconds: number): VideoChapter | null {
  if (!chapters || chapters.length === 0 || !Number.isFinite(seconds)) return null
  for (const chapter of chapters) {
    if (seconds >= chapter.startTime && seconds < chapter.endTime) {
      return chapter
    }
  }
  return null
}

async function ensureAudioSession(): Promise<void> {
  if (audioSessionReady) return
  try {
    await SharedAudioSession.setCategory("playback", [])
    await SharedAudioSession.setActive(true)
    audioSessionReady = true
    setAudioUnavailable(false)
  } catch (error) {
    reportError("player", "audioSession.configure", error)
    setAudioUnavailable(true)
    if (await playbackCategorySupported()) showSkippedToast("音訊初始化失敗，可能沒有聲音")
  }
}

async function playbackCategorySupported(): Promise<boolean | null> {
  try {
    const categories = await SharedAudioSession.availableCategories
    return categories.includes("playback")
  } catch (error) {
    reportError("player", "audioSession.capabilities", error)
    return null
  }
}

function setAudioUnavailable(unavailable: boolean): void {
  if (storeState.audioUnavailable === unavailable) return
  storeState.audioUnavailable = unavailable
  emitStore()
}

function mapControllerState(rawState: VideoPlaybackState): PlaybackStatus {
  switch (rawState) {
    case "playing":
      return "playing"
    case "paused":
      return "paused"
    case "buffering":
    case "loading":
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

function refreshPipAvailability(ctrl: VideoPlaybackController): void {
  let available: boolean = false
  try {
    available = ctrl.mediaInfo?.backend === "native" && ctrl.getPictureInPictureState().supported
  } catch {
    available = false
  }
  if (storeState.pipAvailable !== available) {
    storeState.pipAvailable = available
    emitStore()
  }
}

export function getPlayerController(): VideoPlaybackController {
  if (controllerInstance) return controllerInstance
  const ctrl: VideoPlaybackController = new VideoPlaybackController()
  controllerInstance = ctrl

  setBiliLineSwitchListener((): void => {
    showSkippedToast("已切換線路")
  })

  SharedAudioSession.addInterruptionListener((type: AudioSessionInterruptionType): void => {
    if (type !== "began") return
    audioSessionReady = false
    if (storeState.status !== "playing" && ctrl.state !== "playing") return
    try {
      ctrl.pause()
    } catch (error) {
      reportError("player", "interruption.pause", error)
    }
    storeState.status = "paused"
    emitStore()
  })

  ctrl.on("state", (snap: VideoPlaybackSnapshot) => {
    if (streamSwitchPending) return
    const mapped: PlaybackStatus = mapControllerState(snap.state)
    if (mapped === "paused" || mapped === "ended") saveCurrentHistory(true)
    if (storeState.status !== mapped) {
      storeState.status = mapped
      emitStore()
    }
  })

  AppEvents.scenePhase.addListener((phase: ScenePhase) => {
    if (phase !== "background") return
    saveCurrentHistory(true)
    if (storeState.status !== "playing" || !storeState.currentItem) return
    if (!storeState.pipAvailable) return
    void ctrl.startPictureInPicture().catch(() => {})
  })

  ctrl.on("ready", (snap: VideoPlaybackSnapshot) => {
    if (typeof snap.duration === "number" && snap.duration > 0) {
      progressState.duration = snap.duration
      emitProgress()
    }
    refreshPipAvailability(ctrl)
  })

  ctrl.on("progress", (snap: VideoPlaybackSnapshot) => {
    if (streamSwitchPending) return
    const pos: number = Number.isFinite(snap.position) ? snap.position : 0
    const dur: number =
      typeof snap.duration === "number" && snap.duration > 0
        ? snap.duration
        : progressState.duration || storeState.manifest?.duration || storeState.currentItem?.duration || 0

    progressState.position = pos
    progressState.duration = dur
    progressState.bufferedUntil = Number.isFinite(snap.bufferedUntil) ? snap.bufferedUntil : 0
    progressState.activeChapter = findChapterAt(storeState.detail?.chapters, pos)
    emitProgress()
    saveCurrentHistory(false)

    if (storeState.settings.sponsorBlockEnabled && storeState.sponsorSegments.length > 0) {
      const seg: SponsorSegment | null = findActiveSponsorSegment(storeState.sponsorSegments, pos)
      if (seg) {
        if (storeState.settings.sponsorBlockAutoSkip && seg.actionType === "skip" && !isLivePlayback()) {
          if (lastSkippedSegmentUuid !== seg.uuid && seg.endTime > pos + 0.5) {
            lastSkippedSegmentUuid = seg.uuid
            void ctrl.seek(seg.endTime).catch(() => {})
            const label: string = SPONSOR_CATEGORY_LABELS[seg.category] ?? "片段"
            showSkippedToast(`已自動跳過：${label}`)
          }
        } else if (dismissedSegmentUuid !== seg.uuid && !isLivePlayback()) {
          if (storeState.activeSponsorPrompt?.uuid !== seg.uuid) {
            storeState.activeSponsorPrompt = seg
            emitStore()
          }
        }
      } else if (storeState.activeSponsorPrompt !== null) {
        storeState.activeSponsorPrompt = null
        emitStore()
      }
    }
  })

  ctrl.on("ended", () => {
    if (streamSwitchPending) return
    if (progressState.duration > 0) {
      progressState.position = progressState.duration
      progressState.bufferedUntil = progressState.duration
      emitProgress()
    }
    storeState.status = "ended"
    emitStore()
  })

  ctrl.on("error", (err: { message: string }) => {
    storeState.status = "error"
    storeState.errorText = err.message || "播放器發生錯誤"
    emitStore()
  })

  ctrl.on("pictureInPictureRestoreRequested", () => {
    expandFromMiniPlayer()
  })

  ctrl.on("pictureInPicture", (pip: VideoPictureInPictureState) => {
    const active: boolean = Boolean(pip.active)
    if (storeState.isPiPActive !== active) {
      storeState.isPiPActive = active
      emitStore()
    }
  })

  ctrl.on("pictureInPictureError", (err: { message: string }) => {
    showSkippedToast(`子母畫面：${err.message}`)
  })

  return ctrl
}

export function getPlayerStoreSnapshot(): PlayerStoreSnapshot {
  return storeState
}

export function getPlayerProgressSnapshot(): PlayerProgressSnapshot {
  return progressState
}

export function getCommentsStoreSnapshot(): CommentsStoreSnapshot {
  return commentsState
}

export function subscribePlayerStore(listener: () => void): () => void {
  storeListeners.add(listener)
  return () => {
    storeListeners.delete(listener)
  }
}

export function subscribePlayerProgress(listener: () => void): () => void {
  progressListeners.add(listener)
  return () => {
    progressListeners.delete(listener)
  }
}

export function subscribeCommentsStore(listener: () => void): () => void {
  commentsListeners.add(listener)
  return () => {
    commentsListeners.delete(listener)
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

function readPlayerRootSnapshot(): PlayerRootSnapshot {
  return {
    isFullscreen: storeState.isFullscreen,
    hasItem: storeState.currentItem !== null,
  }
}

export function usePlayerRootState(): PlayerRootSnapshot {
  const [snap, setSnap] = useState<PlayerRootSnapshot>(() => readPlayerRootSnapshot())
  useEffect(() => {
    const sync = (): void => {
      const next: PlayerRootSnapshot = readPlayerRootSnapshot()
      setSnap((previous: PlayerRootSnapshot): PlayerRootSnapshot =>
        previous.isFullscreen === next.isFullscreen && previous.hasItem === next.hasItem ? previous : next,
      )
    }
    sync()
    return subscribePlayerStore(sync)
  }, [])
  return snap
}

export function useCommentsStore(): CommentsStoreSnapshot {
  const [snap, setSnap] = useState<CommentsStoreSnapshot>(() => getCommentsStoreSnapshot())
  useEffect(() => {
    setSnap(getCommentsStoreSnapshot())
    return subscribeCommentsStore(() => {
      setSnap(getCommentsStoreSnapshot())
    })
  }, [])
  return snap
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

export function getLiveViewerSnapshot(): LiveViewerSnapshot {
  return liveViewerState
}

export function subscribeLiveViewers(listener: () => void): () => void {
  liveViewerListeners.add(listener)
  return (): void => {
    liveViewerListeners.delete(listener)
  }
}

export function useLiveViewers(): LiveViewerSnapshot {
  const [snap, setSnap] = useState<LiveViewerSnapshot>(() => getLiveViewerSnapshot())
  useEffect(() => {
    setSnap(getLiveViewerSnapshot())
    return subscribeLiveViewers(() => {
      setSnap(getLiveViewerSnapshot())
    })
  }, [])
  return snap
}

export interface OpenVideoOptions {
  cid?: number
  page?: number
  startSeconds?: number
  queue?: UnifiedVideoItem[]
  autoExpand?: boolean
  resumeFromHistory?: boolean
}

function pickInitialQualityTrack(
  manifest: StreamManifest,
  preferredHeight: number,
): { id: string; label: string } {
  if (!manifest.qualities || manifest.qualities.length === 0) {
    return { id: "auto", label: "自動" }
  }
  const matched: VideoQualityTrack | undefined = manifest.qualities.find(
    (track: VideoQualityTrack): boolean => track.url === manifest.primaryUrl,
  )
  if (matched) {
    return { id: matched.id, label: matched.label }
  }
  let best: VideoQualityTrack = manifest.qualities[0]
  let bestDelta: number = Math.abs((effectiveResolution(best.width, best.height) || preferredHeight) - preferredHeight)
  for (const track of manifest.qualities) {
    const delta: number = Math.abs((effectiveResolution(track.width, track.height) || preferredHeight) - preferredHeight)
    if (delta < bestDelta) {
      bestDelta = delta
      best = track
    }
  }
  return { id: best.id, label: best.label }
}

function enrichItem(item: UnifiedVideoItem, detail: VideoDetail): UnifiedVideoItem {
  const merged: UnifiedVideoItem = {
    ...item,
    title: detail.title || item.title,
    thumbnailUrl: item.thumbnailUrl || detail.thumbnailUrl,
    duration: detail.duration || item.duration,
    authorId: detail.authorId || item.authorId,
    authorName: detail.authorName || item.authorName,
  }
  if (detail.authorAvatar) merged.authorAvatar = detail.authorAvatar
  if (detail.viewCount !== undefined) merged.viewCount = detail.viewCount
  if (detail.likeCount !== undefined) merged.likeCount = detail.likeCount
  if (detail.danmakuCount !== undefined) merged.danmakuCount = detail.danmakuCount
  if (detail.publishedText) merged.publishedText = detail.publishedText
  if (detail.publishedAt !== undefined) merged.publishedAt = detail.publishedAt
  if (detail.isLive !== undefined) merged.isLive = detail.isLive
  if (detail.cid !== undefined) merged.cid = detail.cid
  if (detail.aid !== undefined) merged.aid = detail.aid
  return merged
}

const danmakuXmlCache: Map<number, string> = new Map()

async function loadBiliDanmakuForCid(cid: number): Promise<void> {
  const ctrl: VideoPlaybackController = getPlayerController()
  try {
    let xml: string | undefined = danmakuXmlCache.get(cid)
    if (xml === undefined) {
      xml = await fetchBiliDanmakuXml(cid)
      if (xml) danmakuXmlCache.set(cid, xml)
    }
    if (!xml || !xml.includes("<d")) return
    const report = await ctrl.loadDanmakuText(xml, "xml")
    storeState.danmakuCount = report.loaded
    emitStore()
  } catch (error) {
    reportError("player", "danmaku.load", error)
  }
}

function applySponsorSegmentsForCid(): void {
  storeState.sponsorSegments = filterSegmentsForCid(sponsorSegmentsAll, storeState.activeCid)
}

function sponsorConfigSignature(settings: PlayerSettings): string {
  return `${settings.sponsorBlockEnabled}|${settings.sponsorBlockAutoSkip}|${[...settings.sponsorBlockCategories].sort().join(",")}`
}

let sponsorConfig: string = sponsorConfigSignature(storeState.settings)
let sponsorReloadSeq: number = 0

subscribeStorageChanges(() => {
  const next: PlayerSettings = getSettings()
  const signature: string = sponsorConfigSignature(next)
  if (signature === sponsorConfig) return
  sponsorConfig = signature

  storeState.settings = {
    ...storeState.settings,
    sponsorBlockEnabled: next.sponsorBlockEnabled,
    sponsorBlockAutoSkip: next.sponsorBlockAutoSkip,
    sponsorBlockCategories: next.sponsorBlockCategories,
  }
  storeState.activeSponsorPrompt = null

  const item: UnifiedVideoItem | null = storeState.currentItem
  const reload: number = ++sponsorReloadSeq
  if (!next.sponsorBlockEnabled || !item) {
    sponsorSegmentsAll = []
    storeState.sponsorSegments = []
    emitStore()
    return
  }

  emitStore()
  void fetchSponsorSegments(item.provider, item.rawId, next.sponsorBlockCategories)
    .then((segments: SponsorSegment[]) => {
      if (reload !== sponsorReloadSeq || storeState.currentItem?.id !== item.id) return
      sponsorSegmentsAll = segments
      applySponsorSegmentsForCid()
      emitStore()
    })
    .catch((error: unknown) => {
      reportError("player", "sponsor.reload", error)
    })
}, ["settings"])

export async function openVideo(item: UnifiedVideoItem, options: OpenVideoOptions = {}): Promise<void> {
  const requestId: number = ++openRequestSeq
  const ctrl: VideoPlaybackController = getPlayerController()
  const settings: PlayerSettings = getSettings()
  streamSwitchPending = true
  saveCurrentHistory(true)
  try {
    ctrl.pause()
  } catch (error) {
    reportError("player", "open.pause", error)
  }
  await ensureAudioSession()

  const nextQueue: UnifiedVideoItem[] = options.queue && options.queue.length > 0 ? options.queue : [item]
  const idx: number = Math.max(
    0,
    nextQueue.findIndex((entry: UnifiedVideoItem): boolean => entry.id === item.id),
  )

  const initialCid: number | undefined = options.cid ?? item.cid
  const initialPage: number = options.page ?? 1

  lastSkippedSegmentUuid = ""
  dismissedSegmentUuid = ""
  sponsorSegmentsAll = []
  progressState = {
    position: Math.max(0, options.startSeconds ?? 0),
    duration: item.duration || 0,
    bufferedUntil: 0,
    activeChapter: null,
  }
  emitProgress()

  storeState = {
    ...storeState,
    presentationMode: options.autoExpand === false ? "mini" : "expanded",
    currentItem: item,
    detail: null,
    manifest: null,
    sponsorSegments: [],
    activeSponsorPrompt: null,
    skippedToast: null,
    status: "loading",
    errorText: null,
    playbackRate: settings.defaultPlaybackRate || 1,
    isBoosting2x: false,
    selectedQualityId: "auto",
    selectedQualityLabel: "自動",
    selectedSubtitleId: null,
    activeCid: initialCid,
    activePage: initialPage,
    danmakuEnabled: settings.danmakuEnabled,
    danmakuCount: 0,
    queue: nextQueue,
    queueIndex: idx,
    settings,
  }
  sponsorConfig = sponsorConfigSignature(settings)
  commentsState = {
    comments: [],
    loading: !item.isLive,
    sort: "top",
    cursor: null,
    loadingMore: false,
    repliesLoading: {},
  }
  emitStore()
  emitComments()

  if (item.provider === "yt" && item.isLive) {
    startLiveViewerRefresh(item)
  } else {
    stopLiveViewerRefresh()
    publishLiveViewers("", null)
  }

  try {
    ctrl.clearSubtitles()
    ctrl.clearDanmaku()
  } catch (error) {
    reportError("player", "open.clearTracks", error)
  }
  subtitleVttCache.clear()
  danmakuXmlCache.clear()

  void getVideoDetail(item.provider, item.rawId)
    .then((detail: VideoDetail) => {
      if (requestId !== openRequestSeq) return
      const resolvedCid: number | undefined =
        storeState.activeCid ?? detail.cid ?? detail.pages?.[0]?.cid
      storeState.detail = detail
      if (storeState.currentItem) {
        const enriched: UnifiedVideoItem = enrichItem(storeState.currentItem, detail)
        storeState.currentItem = enriched
        if (storeState.queue[storeState.queueIndex]?.id === enriched.id) {
          const queue: UnifiedVideoItem[] = storeState.queue.slice()
          queue[storeState.queueIndex] = enriched
          storeState.queue = queue
        }
      }
      if (detail.isLive && (detail.viewCount ?? 0) > 0) {
        publishLiveViewers(detail.id, detail.viewCount ?? null)
      }
      if (resolvedCid && !storeState.activeCid) {
        storeState.activeCid = resolvedCid
        applySponsorSegmentsForCid()
      }
      if (detail.duration > 0 && progressState.duration <= 0) {
        progressState.duration = detail.duration
        emitProgress()
      }
      emitStore()
    })
    .catch((error: unknown) => {
      reportError("player", "detail.load", error)
    })

  if (!item.isLive) {
    void getCommentPage(item.provider, item.rawId, { sort: commentsState.sort })
      .then((page: CommentPage) => {
        if (requestId !== openRequestSeq) return
        commentsState.comments = page.comments
        commentsState.cursor = page.cursor
        commentsState.loading = false
        emitComments()
      })
      .catch((error: unknown) => {
        if (requestId !== openRequestSeq) return
        reportError("player", "comments.load", error)
        commentsState.loading = false
        emitComments()
      })
  }

  if (settings.sponsorBlockEnabled) {
    void fetchSponsorSegments(item.provider, item.rawId, settings.sponsorBlockCategories)
      .then((segments: SponsorSegment[]) => {
        if (requestId !== openRequestSeq) return
        sponsorSegmentsAll = segments
        applySponsorSegmentsForCid()
        emitStore()
      })
      .catch((error: unknown) => {
        reportError("player", "sponsor.load", error)
      })
  }

  try {
    const manifest: StreamManifest = await resolveStream(item.provider, item.rawId, {
      cid: initialCid,
      mode: settings.youtubeStreamMode,
      preferredHeight: settings.preferredQualityHeight,
      isLive: item.isLive === true,
    })
    const picked = pickInitialQualityTrack(manifest, settings.preferredQualityHeight)
    const activeCid: number | undefined = manifest.cid ?? initialCid ?? storeState.activeCid

    storeState.manifest = manifest
    storeState.selectedQualityId = picked.id
    storeState.selectedQualityLabel = picked.label
    storeState.activeCid = activeCid
    if (storeState.isFullscreen) syncFullscreenOrientation()
    applySponsorSegmentsForCid()
    if (manifest.duration > 0) {
      progressState.duration = manifest.duration
      emitProgress()
    }
    emitStore()

    if (manifest.warnings && manifest.warnings.length > 0) showSkippedToast(manifest.warnings[0])

    if (requestId !== openRequestSeq) return

    let resumeAt: number = 0
    if (!item.isLive) {
      if (options.startSeconds !== undefined && options.startSeconds > 0) {
        resumeAt = options.startSeconds
      } else if (options.resumeFromHistory !== false) {
        const savedPos: number = getSavedPosition(item.id, activeCid)
        const totalDur: number = manifest.duration || item.duration || 0
        if (savedPos > 5 && (totalDur <= 0 || savedPos < totalDur - 8)) resumeAt = savedPos
      }
    }

    const url: string = manifest.primaryUrl
    const backend: PlaybackBackend = pickBackend(manifest.backend)
    const headers = manifest.headers
    if (resumeAt > 0) warmStreamStart(url, resumeAt)
    await ctrl.open(url, { backend, headers })
    if (requestId !== openRequestSeq) return
    streamSwitchPending = false
    await restoreControllerSettings()
    if (requestId !== openRequestSeq) return

    if (resumeAt > 0) {
      await seekForResume(ctrl, resumeAt)
      if (requestId !== openRequestSeq) return
    }
    if (item.provider === "bili" && activeCid) {
      void loadBiliDanmakuForCid(activeCid)
    }

    await ctrl.play()
    if (requestId !== openRequestSeq) return
    const pendingSubtitles = manifest.resolveSubtitles
    if (pendingSubtitles) {
      void pendingSubtitles()
        .then((tracks: SubtitleTrackInfo[]) => {
          if (requestId !== openRequestSeq) return
          const current = storeState.manifest
          if (!current) return
          storeState.manifest = { ...current, subtitles: tracks }
          emitStore()
        })
        .catch(() => {})
    }
  } catch (err: unknown) {
    if (requestId !== openRequestSeq) return
    const message: string = err instanceof Error ? err.message : String(err)
    storeState.status = "error"
    storeState.errorText = message || "無法載入影片串流"
    emitStore()
  }
}

export async function togglePlayPause(): Promise<void> {
  const ctrl: VideoPlaybackController = getPlayerController()
  try {
    if (storeState.status === "playing" || ctrl.state === "playing") {
      ctrl.pause()
      storeState.status = "paused"
      emitStore()
      return
    }
    if (storeState.status === "ended" || ctrl.state === "ended") {
      if (isLivePlayback()) {
        await ctrl.play()
        return
      }
      await ctrl.seek(0)
    }
    await ensureAudioSession()
    await ctrl.play()
  } catch (err: unknown) {
    storeState.errorText = err instanceof Error ? err.message : "播放失敗"
    emitStore()
  }
}

export async function seekTo(seconds: number): Promise<void> {
  if (isLivePlayback()) return
  const ctrl: VideoPlaybackController = getPlayerController()
  const target: number = Math.max(0, seconds)
  progressState.position = target
  progressState.activeChapter = findChapterAt(storeState.detail?.chapters, target)
  emitProgress()
  try {
    await ctrl.seek(target)
  } catch (error) {
    reportError("player", "seek", error)
  }
}

export async function seekBy(deltaSeconds: number): Promise<void> {
  if (isLivePlayback()) return
  const dur: number = progressState.duration
  const raw: number = progressState.position + deltaSeconds
  const clamped: number = dur > 0 ? Math.min(dur, Math.max(0, raw)) : Math.max(0, raw)
  await seekTo(clamped)
}

export function setPlaybackRate(rate: number): void {
  const ctrl: VideoPlaybackController = getPlayerController()
  const safeRate: number = Math.min(4, Math.max(0.25, rate))
  ctrl.playbackRate = safeRate
  storeState.playbackRate = safeRate
  storeState.isBoosting2x = false
  emitStore()
}

export function setTemporaryBoost2x(boosting: boolean): void {
  const ctrl: VideoPlaybackController = getPlayerController()
  if (boosting) {
    if (!storeState.isBoosting2x) {
      savedRateBeforeBoost = storeState.playbackRate || 1
      ctrl.playbackRate = 2
      storeState.isBoosting2x = true
      emitStore()
    }
  } else if (storeState.isBoosting2x) {
    ctrl.playbackRate = savedRateBeforeBoost || 1
    storeState.playbackRate = savedRateBeforeBoost || 1
    storeState.isBoosting2x = false
    emitStore()
  }
}

export async function selectQuality(qualityId: string): Promise<void> {
  const manifest: StreamManifest | null = storeState.manifest
  if (!manifest) return
  const ctrl: VideoPlaybackController = getPlayerController()
  const currentPos: number = progressState.position
  const wasPlaying: boolean = storeState.status === "playing" || storeState.status === "error"

  const track: VideoQualityTrack | undefined = manifest.qualities.find(
    (entry: VideoQualityTrack): boolean => entry.id === qualityId,
  )
  const label: string = track?.label ?? (qualityId === "auto" ? "自動" : qualityId)

  storeState.selectedQualityId = qualityId
  storeState.selectedQualityLabel = label
  storeState.status = "buffering"
  emitStore()

  try {
    const resolved = manifest.resolveQuality
      ? await manifest.resolveQuality(qualityId)
      : {
          url: track?.url ?? manifest.primaryUrl,
          backend: manifest.backend,
          headers: track?.headers ?? manifest.headers,
        }

    const url: string = resolved.url
    const backend: PlaybackBackend = pickBackend(resolved.backend)
    const headers = resolved.headers ?? manifest.headers
    if (currentPos > 0.5 && !isLivePlayback()) warmStreamStart(url, currentPos)
    await ctrl.open(url, { backend, headers })
    if (currentPos > 0.5 && !isLivePlayback()) {
      try {
        await ctrl.seek(currentPos)
      } catch (error) {
        reportError("player", "quality.seek", error)
      }
    }
    await restoreControllerSettings()
    const activeCid: number | undefined = storeState.activeCid
    if (storeState.currentItem?.provider === "bili" && activeCid && storeState.danmakuEnabled) {
      void loadBiliDanmakuForCid(activeCid)
    }
    if (wasPlaying) {
      await ctrl.play()
    }
  } catch (err: unknown) {
    const message: string = err instanceof Error ? err.message : "切換畫質失敗"
    storeState.status = "error"
    storeState.errorText = message
    emitStore()
  }
}

const subtitleVttCache: Map<string, string> = new Map()

async function fetchSubtitleVtt(sub: SubtitleTrackInfo): Promise<string> {
  const key: string = `${storeState.currentItem?.id ?? ""}:${sub.id}`
  const cached: string | undefined = subtitleVttCache.get(key)
  if (cached) return cached
  const response = await fetch(sub.url, {
    timeout: 20,
    headers: sub.headers,
    debugLabel: "Yobi Subtitle",
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const text: string = await response.text()
  const vtt: string = sub.format === "bili" ? biliSubtitleToVtt(text) : toCleanVtt(text)
  if (!vtt) throw new Error("empty subtitles")
  subtitleVttCache.set(key, vtt)
  return vtt
}

export async function selectSubtitle(subtitleId: string | null): Promise<void> {
  const ctrl: VideoPlaybackController = getPlayerController()
  if (!subtitleId) {
    ctrl.clearSubtitles()
    ctrl.subtitlesEnabled = false
    storeState.selectedSubtitleId = null
    emitStore()
    return
  }

  const sub: SubtitleTrackInfo | undefined = storeState.manifest?.subtitles.find(
    (entry: SubtitleTrackInfo): boolean => entry.id === subtitleId,
  )
  if (!sub) return

  storeState.selectedSubtitleId = subtitleId
  emitStore()

  try {
    const vtt: string = await fetchSubtitleVtt(sub)
    if (storeState.selectedSubtitleId !== subtitleId) return
    await ctrl.loadSubtitles(vtt, "vtt")
    ctrl.subtitlesEnabled = true
  } catch {
    if (storeState.selectedSubtitleId !== subtitleId) return
    storeState.selectedSubtitleId = null
    emitStore()
    showSkippedToast("字幕載入失敗")
  }
}

async function restoreControllerSettings(): Promise<void> {
  const ctrl: VideoPlaybackController = getPlayerController()
  const settings: PlayerSettings = storeState.settings
  ctrl.playbackRate = storeState.isBoosting2x ? 2 : storeState.playbackRate || 1
  ctrl.danmakuOpacity = settings.danmakuOpacity
  ctrl.setDanmakuStyle({
    speed: settings.danmakuSpeed,
    area: settings.danmakuArea,
    blockedWords: settings.danmakuBlockedWords,
  })

  const subtitleId: string | null = storeState.selectedSubtitleId
  if (subtitleId !== null) {
    const sub: SubtitleTrackInfo | undefined = storeState.manifest?.subtitles.find(
      (entry: SubtitleTrackInfo): boolean => entry.id === subtitleId,
    )
    if (!sub) {
      storeState.selectedSubtitleId = null
    } else {
      try {
        await ctrl.loadSubtitles(await fetchSubtitleVtt(sub), "vtt")
      } catch {
        storeState.selectedSubtitleId = null
        showSkippedToast("字幕載入失敗")
      }
    }
  }

  applyOverlayVisibility(storeState.presentationMode !== "mini")
  emitStore()
}

export async function selectPage(pagePart: VideoPagePart): Promise<void> {
  const item: UnifiedVideoItem | null = storeState.currentItem
  if (!item || item.provider !== "bili") return

  const ctrl: VideoPlaybackController = getPlayerController()
  const settings: PlayerSettings = storeState.settings
  storeState.activeCid = pagePart.cid
  storeState.activePage = pagePart.page
  lastSkippedSegmentUuid = ""
  storeState.activeSponsorPrompt = null
  applySponsorSegmentsForCid()
  storeState.status = "loading"
  storeState.errorText = null
  progressState = {
    position: 0,
    duration: pagePart.duration || progressState.duration,
    bufferedUntil: 0,
    activeChapter: null,
  }
  emitProgress()
  emitStore()
  streamSwitchPending = true
  try {
    ctrl.pause()
  } catch (error) {
    reportError("player", "switch.pause", error)
  }

  try {
    ctrl.clearDanmaku()
    const manifest: StreamManifest = await resolveStream("bili", item.rawId, {
      cid: pagePart.cid,
      preferredHeight: settings.preferredQualityHeight,
    })
    const picked = pickInitialQualityTrack(manifest, settings.preferredQualityHeight)
    storeState.manifest = manifest
    storeState.selectedQualityId = picked.id
    storeState.selectedQualityLabel = picked.label
    if (storeState.isFullscreen) syncFullscreenOrientation()
    if (manifest.duration > 0) {
      progressState.duration = manifest.duration
      emitProgress()
    }
    emitStore()

    const url: string = manifest.primaryUrl
    const backend: PlaybackBackend = pickBackend(manifest.backend)
    const headers = manifest.headers
    await ctrl.open(url, { backend, headers })
    streamSwitchPending = false
    await restoreControllerSettings()
    void loadBiliDanmakuForCid(pagePart.cid)
    await ensureAudioSession()
    await ctrl.play()
  } catch (err: unknown) {
    storeState.status = "error"
    storeState.errorText = err instanceof Error ? err.message : "切換分P失敗"
    emitStore()
  }
}

export function setStatsVisible(visible: boolean): void {
  if (storeState.statsVisible === visible) return
  storeState.statsVisible = visible
  emitStore()
}

export function toggleDanmaku(): void {
  const ctrl: VideoPlaybackController = getPlayerController()
  const next: boolean = !storeState.danmakuEnabled
  const nextSettings: PlayerSettings = updateSettings({ danmakuEnabled: next })
  ctrl.danmakuEnabled = next
  storeState.danmakuEnabled = next
  storeState.settings = nextSettings
  emitStore()
}

export function updateDanmakuSettings(
  patch: Partial<Pick<PlayerSettings, "danmakuEnabled" | "danmakuOpacity" | "danmakuSpeed" | "danmakuArea">>,
): void {
  const ctrl: VideoPlaybackController = getPlayerController()
  const nextSettings: PlayerSettings = updateSettings(patch)
  ctrl.danmakuEnabled = nextSettings.danmakuEnabled
  ctrl.danmakuOpacity = nextSettings.danmakuOpacity
  ctrl.setDanmakuStyle({
    speed: nextSettings.danmakuSpeed,
    area: nextSettings.danmakuArea,
    blockedWords: nextSettings.danmakuBlockedWords,
  })
  storeState.danmakuEnabled = nextSettings.danmakuEnabled
  storeState.settings = nextSettings
  emitStore()
}

export function skipActiveSponsorSegment(): void {
  const seg: SponsorSegment | null = storeState.activeSponsorPrompt
  if (!seg) return
  const ctrl: VideoPlaybackController = getPlayerController()
  lastSkippedSegmentUuid = seg.uuid
  storeState.activeSponsorPrompt = null
  emitStore()
  void seekTo(seg.endTime)
  const label: string = SPONSOR_CATEGORY_LABELS[seg.category] ?? "片段"
  showSkippedToast(`已跳過：${label}`)
}

export function dismissActiveSponsorSegment(): void {
  const seg: SponsorSegment | null = storeState.activeSponsorPrompt
  if (!seg) return
  dismissedSegmentUuid = seg.uuid
  storeState.activeSponsorPrompt = null
  emitStore()
}

function isCurrentVideoPortrait(): boolean {
  const manifest: StreamManifest | null = storeState.manifest
  if (!manifest) return false
  const selected: VideoQualityTrack | undefined = manifest.qualities.find(
    (track: VideoQualityTrack): boolean => track.id === storeState.selectedQualityId,
  )
  const track: VideoQualityTrack | undefined =
    selected && selected.width > 0 && selected.height > 0
      ? selected
      : manifest.qualities.find((entry: VideoQualityTrack): boolean => entry.width > 0 && entry.height > 0)
  return Boolean(track && track.height > track.width)
}

function applyFullscreenOrientation(fullscreen: boolean, portrait: boolean): void {
  try {
    if (fullscreen && !portrait) {
      if (savedOrientations === null) savedOrientations = Device.supportedInterfaceOrientations
      Device.supportedInterfaceOrientations = ["landscape"]
    } else if (savedOrientations !== null) {
      Device.supportedInterfaceOrientations =
        savedOrientations.length > 0 ? savedOrientations : ["portrait"]
      savedOrientations = null
    }
  } catch (error) {
    reportError("player", "fullscreen.orientation", error)
  }
}

function syncFullscreenOrientation(): void {
  const portrait: boolean = storeState.isFullscreen && isCurrentVideoPortrait()
  applyFullscreenOrientation(storeState.isFullscreen, portrait)
  storeState.isPortraitFullscreen = portrait
}

export function setFullscreen(fullscreen: boolean): void {
  if (storeState.isFullscreen === fullscreen) return
  const portrait: boolean = fullscreen && isCurrentVideoPortrait()
  if (fullscreen && !portrait) {
    waitForLandscapeBeforeAutoExit = lastPhysicalOrientation !== "landscape"
    waitForPortraitBeforeAutoEnter = false
  } else if (!fullscreen) {
    waitForLandscapeBeforeAutoExit = false
    waitForPortraitBeforeAutoEnter = lastPhysicalOrientation === "landscape"
  }
  applyFullscreenOrientation(fullscreen, portrait)
  storeState.isFullscreen = fullscreen
  storeState.isPortraitFullscreen = portrait
  emitStore()
}

export function startOrientationAutoFullscreen(): () => void {
  const onOrientation = (orientation: Device.Orientation): void => {
    const isLandscape: boolean = orientation === "landscapeLeft" || orientation === "landscapeRight"
    const isPortrait: boolean = orientation === "portrait"
    if (!isLandscape && !isPortrait) return
    lastPhysicalOrientation = isLandscape ? "landscape" : "portrait"

    if (storeState.presentationMode !== "expanded" || !storeState.currentItem) {
      waitForLandscapeBeforeAutoExit = false
      waitForPortraitBeforeAutoEnter = false
      return
    }
    if (isCurrentVideoPortrait()) return

    if (isLandscape) {
      waitForLandscapeBeforeAutoExit = false
      if (!storeState.isFullscreen && !waitForPortraitBeforeAutoEnter) {
        setFullscreen(true)
      }
      return
    }

    waitForPortraitBeforeAutoEnter = false
    if (storeState.isFullscreen && !storeState.isPortraitFullscreen && !waitForLandscapeBeforeAutoExit) {
      setFullscreen(false)
    }
  }

  try {
    const initial: Device.Orientation = Device.orientation
    if (initial === "landscapeLeft" || initial === "landscapeRight") lastPhysicalOrientation = "landscape"
    else if (initial === "portrait") lastPhysicalOrientation = "portrait"
    Device.addOrientationListener(onOrientation)
  } catch (error) {
    reportError("player", "orientation.listen", error)
  }

  return (): void => {
    try {
      Device.removeOrientationListener(onOrientation)
    } catch {
    }
  }
}

export function toggleFullscreen(): void {
  setFullscreen(!storeState.isFullscreen)
}

function applyOverlayVisibility(visible: boolean): void {
  const ctrl: VideoPlaybackController = getPlayerController()
  const isBili: boolean = storeState.currentItem?.provider === "bili"
  ctrl.subtitlesEnabled = visible && storeState.selectedSubtitleId !== null
  if (isBili) ctrl.danmakuEnabled = visible && storeState.danmakuEnabled
}

export function minimizeToMiniPlayer(): void {
  saveCurrentHistory(true)
  if (storeState.isFullscreen) {
    setFullscreen(false)
  }
  if (!storeState.currentItem) return
  storeState.presentationMode = "mini"
  applyOverlayVisibility(false)
  emitStore()
}

export function expandFromMiniPlayer(): void {
  if (!storeState.currentItem) return
  storeState.presentationMode = "expanded"
  applyOverlayVisibility(true)
  emitStore()
}

export async function closePlayer(): Promise<void> {
  saveCurrentHistory(true)
  if (storeState.isFullscreen) {
    setFullscreen(false)
  }
  const ctrl: VideoPlaybackController = getPlayerController()
  openRequestSeq++
  stopLiveViewerRefresh()
  publishLiveViewers("", null)
  releaseAllPrefetchers()
  try {
    await withTimeout(ctrl.stop(), STOP_TIMEOUT_MS)
  } catch (error) {
    reportError("player", "close.stop", error)
  }
  storeState.presentationMode = "hidden"
  storeState.currentItem = null
  storeState.pipAvailable = false
  storeState.detail = null
  storeState.manifest = null
  storeState.activeSponsorPrompt = null
  storeState.status = "idle"
  commentsState = {
    comments: [],
    loading: false,
    sort: "top",
    cursor: null,
    loadingMore: false,
    repliesLoading: {},
  }
  emitStore()
  emitComments()
}

export async function startPiP(): Promise<void> {
  const ctrl: VideoPlaybackController = getPlayerController()
  refreshPipAvailability(ctrl)
  if (!storeState.pipAvailable) {
    showSkippedToast("這個片源不支援子母畫面（HLS 播放）")
    return
  }
  try {
    await ctrl.startPictureInPicture()
  } catch (err: unknown) {
    showSkippedToast(`子母畫面失敗：${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function playNext(): Promise<void> {
  const nextIndex: number = storeState.queueIndex + 1
  const nextItem: UnifiedVideoItem | undefined = storeState.queue[nextIndex]
  if (nextItem) {
    await openVideo(nextItem, { queue: storeState.queue })
    return
  }
  const firstRelated: UnifiedVideoItem | undefined = storeState.detail?.relatedVideos?.[0]
  if (firstRelated) {
    await openVideo(firstRelated)
  }
}

export async function playPrevious(): Promise<void> {
  if (!isLivePlayback() && progressState.position > 5) {
    await seekTo(0)
    return
  }
  const prevIndex: number = storeState.queueIndex - 1
  const prevItem: UnifiedVideoItem | undefined = storeState.queue[prevIndex]
  if (prevItem) {
    await openVideo(prevItem, { queue: storeState.queue })
  }
}

export async function reloadComments(): Promise<void> {
  const item: UnifiedVideoItem | null = storeState.currentItem
  if (!item) return
  const sort: CommentSort = commentsState.sort
  commentsState.loading = true
  commentsState.cursor = null
  emitComments()
  try {
    const page: CommentPage = await getCommentPage(item.provider, item.rawId, { sort })
    if (storeState.currentItem?.id !== item.id || commentsState.sort !== sort) return
    commentsState.comments = page.comments
    commentsState.cursor = page.cursor
  } catch (error) {
    reportError("player", "comments.reload", error)
  } finally {
    if (storeState.currentItem?.id === item.id) {
      commentsState.loading = false
      emitComments()
    }
  }
}

export async function setCommentsSort(sort: CommentSort): Promise<void> {
  if (commentsState.sort === sort) return
  commentsState.sort = sort
  await reloadComments()
}

export async function loadMoreComments(): Promise<void> {
  const item: UnifiedVideoItem | null = storeState.currentItem
  const cursor: string | null = commentsState.cursor
  if (!item || !cursor || commentsState.loading || commentsState.loadingMore) return

  const sort: CommentSort = commentsState.sort
  commentsState.loadingMore = true
  emitComments()
  try {
    const page: CommentPage = await getCommentPage(item.provider, item.rawId, { sort, cursor })
    if (storeState.currentItem?.id !== item.id || commentsState.sort !== sort) return
    const seen: Set<string> = new Set(commentsState.comments.map((comment: CommentItem): string => comment.id))
    const fresh: CommentItem[] = page.comments.filter((comment: CommentItem): boolean => !seen.has(comment.id))
    commentsState.comments = fresh.length > 0 ? [...commentsState.comments, ...fresh] : commentsState.comments
    commentsState.cursor = page.cursor
  } catch (error) {
    reportError("player", "comments.more", error)
  } finally {
    commentsState.loadingMore = false
    emitComments()
  }
}

export async function loadCommentReplies(commentId: string): Promise<void> {
  const item: UnifiedVideoItem | null = storeState.currentItem
  const target: CommentItem | undefined = commentsState.comments.find(
    (comment: CommentItem): boolean => comment.id === commentId,
  )
  const cursor: string | null | undefined = target?.replyCursor
  if (!item || !target || !cursor) return
  if (commentsState.repliesLoading[commentId] === true) return

  commentsState.repliesLoading = { ...commentsState.repliesLoading, [commentId]: true }
  emitComments()
  try {
    const page: CommentPage = await getCommentReplies(item.provider, item.rawId, commentId, cursor)
    if (storeState.currentItem?.id !== item.id) return
    commentsState.comments = commentsState.comments.map((comment: CommentItem): CommentItem => {
      if (comment.id !== commentId) return comment
      const existing: CommentItem[] = comment.replies ?? []
      const seen: Set<string> = new Set(existing.map((reply: CommentItem): string => reply.id))
      const fresh: CommentItem[] = page.comments.filter((reply: CommentItem): boolean => !seen.has(reply.id))
      return { ...comment, replies: [...existing, ...fresh], replyCursor: page.cursor }
    })
  } catch (error) {
    reportError("player", "comments.replies", error)
  } finally {
    commentsState.repliesLoading = { ...commentsState.repliesLoading, [commentId]: false }
    emitComments()
  }
}
