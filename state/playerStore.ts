import { AppEvents, fetch, useEffect, useState } from "scripting"
import type { ScenePhase } from "scripting"
import type {
  CommentItem,
  CommentPage,
  CommentSort,
  OfflineDownload,
  PlayerSettings,
  SponsorSegment,
  StreamManifest,
  SubtitleTrackInfo,
  UnifiedVideoItem,
  VideoChapter,
  VideoDetail,
  VideoPagePart,
  VideoQualityTrack,
  YoutubeStreamPreference,
} from "../types"
import {
  fetchBiliDanmakuXml,
  fetchSponsorSegments,
  findActiveSponsorSegment,
  findDownload,
  getCommentPage,
  getCommentReplies,
  getSavedPosition,
  getSettings,
  getVideoDetail,
  getYoutubeLiveViewers,
  recordWatchHistory,
  releaseAllPrefetchers,
  resolveOfflineSource,
  resolveStream,
  setBiliLineSwitchListener,
  updateSettings,
  warmStreamStart,
} from "../services"
import { SPONSOR_CATEGORY_LABELS } from "../utils/format"
import { biliSubtitleToVtt, toCleanVtt } from "../utils/subtitles"

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
  comments: CommentItem[]
  commentsLoading: boolean
  commentsSort: CommentSort
  commentsCursor: string | null
  commentsLoadingMore: boolean
  /** 正在載入回覆的留言 id。 */
  repliesLoading: Record<string, boolean>
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
  isPiPActive: boolean
  /** 目前片源能否進子母畫面：只有 native 後端可以，system（HLS）不行。 */
  pipAvailable: boolean
  danmakuEnabled: boolean
  danmakuCount: number
  /** 播放器左上角的網速與檔案資訊面板。 */
  statsVisible: boolean
  queue: UnifiedVideoItem[]
  queueIndex: number
  settings: PlayerSettings
}

export interface PlayerProgressSnapshot {
  position: number
  duration: number
  /** 播放器已緩衝到的時間點（秒）。 */
  bufferedUntil: number
  activeChapter: VideoChapter | null
}

let controllerInstance: VideoPlaybackController | null = null
let audioSessionReady: boolean = false
let openRequestSeq: number = 0
let lastHistorySaveAt: number = 0
/**
 * 換片期間（上一支還在播 → 新串流 open() 完成）：controller 吐出的事件都是舊片的。
 * 照收就會把舊片的位置寫成新片的觀看紀錄，下次進來就從那裡續播；狀態也會蓋掉 loading。
 */
let streamSwitchPending: boolean = false
let lastSkippedSegmentUuid: string = ""
let dismissedSegmentUuid: string = ""
let toastTimer: number | null = null
let savedRateBeforeBoost: number = 1
let savedOrientations: typeof Device.supportedInterfaceOrientations | null = null
/** 直播人數每分鐘重抓一次；換片、收掉播放器都要停。 */
let liveViewerTimer: number | null = null
const LIVE_VIEWER_TICK_MS: number = 60_000
/**
 * 直播即時人數。
 *
 * 不進 `storeState`：那裡一改就是全播放頁重畫，人數每分鐘變一次不值得。
 * 自己一組訂閱，只有顯示人數的那個元件會收到通知。
 */
export interface LiveViewerSnapshot {
  videoId: string
  count: number | null
}

let liveViewerState: LiveViewerSnapshot = { videoId: "", count: null }
const liveViewerListeners: Set<() => void> = new Set()

const storeListeners: Set<() => void> = new Set()
const progressListeners: Set<() => void> = new Set()

let storeState: PlayerStoreSnapshot = {
  presentationMode: "hidden",
  currentItem: null,
  detail: null,
  manifest: null,
  comments: [],
  commentsLoading: false,
  commentsSort: "top",
  commentsCursor: null,
  commentsLoadingMore: false,
  repliesLoading: {},
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
  isPiPActive: false,
  pipAvailable: false,
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

/** 直播沒有可跳轉的時間軸：不續播、不存位置，seek 一律視為無效。 */
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
    } catch {
      // 單一訂閱者出錯不影響其他人
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

/** 上次送出的快照；用來在「什麼都沒變」時不要吵醒訂閱者。 */
let lastEmittedStore: PlayerStoreSnapshot | null = null
/** 同上，給播放進度用。 */
let lastEmittedProgress: PlayerProgressSnapshot | null = null
/** 使用者正在捲動內容時凍結進度通知，捲完再補上。 */
let progressPaused: boolean = false

function sameProgress(next: PlayerProgressSnapshot, previous: PlayerProgressSnapshot | null): boolean {
  if (previous === null) return false
  // 播放器每 250ms 發一次，但畫面上看得到的最小單位就是「秒」（時間文字、進度條位置）。
  // 以 1 秒為粒度，重畫從每秒 4 次降到 1 次；暫停與拖曳時照樣一動都不通知。
  return (
    Math.floor(next.position) === Math.floor(previous.position) &&
    Math.floor(next.duration) === Math.floor(previous.duration) &&
    Math.floor(next.bufferedUntil) === Math.floor(previous.bufferedUntil) &&
    next.activeChapter === previous.activeChapter
  )
}

function sameSnapshot(next: PlayerStoreSnapshot, previous: PlayerStoreSnapshot | null): boolean {
  if (previous === null) return false
  const keys: (keyof PlayerStoreSnapshot)[] = Object.keys(next) as (keyof PlayerStoreSnapshot)[]
  if (keys.length !== Object.keys(previous).length) return false
  for (const key of keys) {
    if (!Object.is(next[key], previous[key])) return false
  }
  return true
}

function emitStore(): void {
  const next: PlayerStoreSnapshot = { ...storeState }
  // 很多欄位（彈幕數、供應片段）會在每個 timeupdate 被重寫成同一個值；
  // 那種時候 notify 只會讓播放頁與控制列白重畫一次。
  if (sameSnapshot(next, lastEmittedStore)) return
  // next 與 storeState 必須是不同物件：storeState 之後會被就地改寫，
  // 拿去當基準就會把改動也一起改掉，永遠比對不到差異。
  lastEmittedStore = next
  storeState = { ...next }
  for (const listener of Array.from(storeListeners)) {
    try {
      listener()
    } catch {
      // Ignore listener errors
    }
  }
}

function emitProgress(): void {
  if (progressPaused) return
  const next: PlayerProgressSnapshot = { ...progressState }
  // 播放器暫停後仍然每 250ms 發一次 progress，位置卻沒有動。
  // 每次都通知，就等於讓所有顯示時間的元件（章節列、進度條、迷你列）每秒重畫四次。
  if (sameProgress(next, lastEmittedProgress)) return
  lastEmittedProgress = next
  progressState = { ...next }
  for (const listener of Array.from(progressListeners)) {
    try {
      listener()
    } catch {
      // Ignore listener errors
    }
  }
}

/**
 * 使用者正在捲動觀看頁時凍結進度通知：這段時間裡一個訂閱者都不叫醒。
 * 停止捲動後補上最新值，所以進度條不會停在凍結那一刻。
 */
export function setProgressUpdatesPaused(paused: boolean): void {
  if (progressPaused === paused) return
  progressPaused = paused
  if (paused) return
  lastEmittedProgress = null
  emitProgress()
}

/** 播放器 seek／stop 在等代理回資料時可能一直不回來，不能讓介面跟著等。 */function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | "timeout"> {
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
    // 其他 seek 失敗就從頭播
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
    await SharedAudioSession.setCategory("playback", ["mixWithOthers"])
    await SharedAudioSession.setActive(true)
    audioSessionReady = true
  } catch {
    // Preview / non-main-app context may restrict audio session changes
  }
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

// 子母畫面只有 native（自訂解碼）後端支援；system（HLS）目前一律 possible=false。
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

  // bili 線路在代理層自己換，這裡只負責告知。
  setBiliLineSwitchListener((): void => {
    showSkippedToast("已切換線路")
  })

  ctrl.on("state", (snap: VideoPlaybackSnapshot) => {
    if (streamSwitchPending) return
    const mapped: PlaybackStatus = mapControllerState(snap.state)
    if (storeState.status !== mapped) {
      storeState.status = mapped
      emitStore()
    }
  })

  // 播放中退到背景就自動接上子母畫面；暫停、收掉或後端不支援就不搶畫面。
  // 鎖屏時系統不給開 PiP，失敗就靜默。
  AppEvents.scenePhase.addListener((phase: ScenePhase) => {
    if (phase !== "background") return
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

    const now: number = Date.now()
    if (storeState.currentItem && pos > 1 && now - lastHistorySaveAt >= 4500) {
      lastHistorySaveAt = now
      recordWatchHistory({
        item: storeState.currentItem,
        // 直播的位置沒有意義，存了下次進來就會拿去 seek。
        position: storeState.currentItem.isLive ? 0 : pos,
        duration: dur,
        watchedAt: now,
        cid: storeState.activeCid,
        page: storeState.activePage,
      })
    }

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
        } else if (dismissedSegmentUuid !== seg.uuid) {
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
    // 舊片剛好播完不該把新片的 loading 蓋成 ended。
    if (streamSwitchPending) return
    // 最後一次 progress 可能差一點點，進度條停在滿格才像「播完了」。
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

/** 只有顯示直播人數的元件要訂閱這個，不跟整個播放器快照绑在一起。 */
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
  /** Explicit start position in seconds; takes precedence over saved history. */
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
  let bestDelta: number = Math.abs((best.height || preferredHeight) - preferredHeight)
  for (const track of manifest.qualities) {
    const delta: number = Math.abs((track.height || preferredHeight) - preferredHeight)
    if (delta < bestDelta) {
      bestDelta = delta
      best = track
    }
  }
  return { id: best.id, label: best.label }
}

/** 彈幕 XML 換畫質後要重新載入；同一個 cid 不必重抓。 */
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
  } catch {
    // Danmaku failure should not interrupt video playback
  }
}

export async function openVideo(item: UnifiedVideoItem, options: OpenVideoOptions = {}): Promise<void> {
  const requestId: number = ++openRequestSeq
  const ctrl: VideoPlaybackController = getPlayerController()
  const settings: PlayerSettings = getSettings()
  // 換流要解析、等代理，好幾秒；這段時間不能讓上一支繼續出聲。
  // 先暫停（畫面留在最後一幀），順便擋掉它接下來的事件與 progress。
  streamSwitchPending = true
  try {
    ctrl.pause()
  } catch {
    // 沒在播就沒事
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
    comments: [],
    commentsLoading: true,
    commentsSort: "top",
    commentsCursor: null,
    commentsLoadingMore: false,
    repliesLoading: {},
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
  emitStore()

  if (item.provider === "yt" && item.isLive) {
    startLiveViewerRefresh(item)
  } else {
    stopLiveViewerRefresh()
    publishLiveViewers("", null)
  }

  try {
    ctrl.clearSubtitles()
    ctrl.clearDanmaku()
  } catch {
    // Ignore cleanup errors before open
  }
  subtitleVttCache.clear()
  danmakuXmlCache.clear()

  // Kick off detail, comments, and SponsorBlock in parallel so video opens as fast as possible
  void getVideoDetail(item.provider, item.rawId)
    .then((detail: VideoDetail) => {
      if (requestId !== openRequestSeq) return
      const resolvedCid: number | undefined =
        storeState.activeCid ?? detail.cid ?? detail.pages?.[0]?.cid
      storeState.detail = detail
      if (detail.isLive && (detail.viewCount ?? 0) > 0) {
        publishLiveViewers(detail.id, detail.viewCount ?? null)
      }
      if (resolvedCid && !storeState.activeCid) {
        storeState.activeCid = resolvedCid
      }
      if (detail.duration > 0 && progressState.duration <= 0) {
        progressState.duration = detail.duration
        emitProgress()
      }
      emitStore()
    })
    .catch(() => {})

  // 直播的分頁是聊天室，一般留言不拉。
  if (!item.isLive) {
    void getCommentPage(item.provider, item.rawId, { sort: storeState.commentsSort })
      .then((page: CommentPage) => {
        if (requestId !== openRequestSeq) return
        storeState.comments = page.comments
        storeState.commentsCursor = page.cursor
        storeState.commentsLoading = false
        emitStore()
      })
      .catch(() => {
        if (requestId !== openRequestSeq) return
        storeState.commentsLoading = false
        emitStore()
      })
  } else {
    storeState.commentsLoading = false
  }

  if (settings.sponsorBlockEnabled) {
    void fetchSponsorSegments(item.provider, item.rawId, settings.sponsorBlockCategories)
      .then((segments: SponsorSegment[]) => {
        if (requestId !== openRequestSeq) return
        storeState.sponsorSegments = segments
        emitStore()
      })
      .catch(() => {})
  }

  try {
    const offline: OfflineDownload | null = findDownload(item.id, initialCid)
    let cachedSource: VideoPlaybackCachedSource | null = null
    if (offline) {
      try {
        cachedSource = await resolveOfflineSource(offline)
      } catch {
        cachedSource = null
      }
    }

    let manifest: StreamManifest | null = null
    let activeCid: number | undefined = initialCid ?? storeState.activeCid

    if (cachedSource) {
      activeCid = offline?.cid ?? activeCid
      storeState.selectedQualityLabel = `${offline?.qualityLabel ?? "離線"} · 離線`
      storeState.activeCid = activeCid
      const offlineDuration: number = offline?.duration ?? item.duration
      if (offlineDuration > 0) {
        progressState.duration = offlineDuration
        emitProgress()
      }
      emitStore()
    } else {
      manifest = await resolveStream(item.provider, item.rawId, {
        cid: initialCid,
        mode: settings.youtubeStreamMode,
        preferredHeight: settings.preferredQualityHeight,
        isLive: item.isLive === true,
      })
      const picked = pickInitialQualityTrack(manifest, settings.preferredQualityHeight)
      activeCid = manifest.cid ?? initialCid ?? storeState.activeCid

      storeState.manifest = manifest
      storeState.selectedQualityId = picked.id
      storeState.selectedQualityLabel = picked.label
      storeState.activeCid = activeCid
      if (manifest.duration > 0) {
        progressState.duration = manifest.duration
        emitProgress()
      }
      emitStore()
    }

    if (requestId !== openRequestSeq) {
      if (cachedSource) await cachedSource.dispose()
      return
    }

    // 續播點在開片前就知道，先把那裡的片段抓起來，跟 open() 同時進行。
    // 直播沒有時間軸：續播位置只會讓播放器對直播窗格 seek，然後報錯。
    let resumeAt: number = 0
    if (!item.isLive) {
      if (options.startSeconds !== undefined && options.startSeconds > 0) {
        resumeAt = options.startSeconds
      } else if (options.resumeFromHistory !== false) {
        const savedPos: number = getSavedPosition(item.id, activeCid)
        const totalDur: number = manifest?.duration || offline?.duration || item.duration || 0
        if (savedPos > 5 && (totalDur <= 0 || savedPos < totalDur - 8)) resumeAt = savedPos
      }
    }

    if (cachedSource) {
      await ctrl.open(cachedSource)
      if (requestId !== openRequestSeq) return
      await cachedSource.dispose()
    } else if (manifest) {
      const url: string = manifest.primaryUrl
      const backend = manifest.backend
      const headers = manifest.headers
      if (resumeAt > 0) warmStreamStart(url, resumeAt)
      await ctrl.open(url, { backend, headers })
      if (requestId !== openRequestSeq) return
    }
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
    // 字幕不擋第一幀，開播後才去拿，拿到再補進 manifest。
    const pendingSubtitles = manifest?.resolveSubtitles
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
  } catch {
    // Ignore superseded seek
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
    const backend = resolved.backend
    const headers = resolved.headers ?? manifest.headers
    if (currentPos > 0.5 && !isLivePlayback()) warmStreamStart(url, currentPos)
    await ctrl.open(url, { backend, headers })
    if (currentPos > 0.5 && !isLivePlayback()) {
      try {
        await ctrl.seek(currentPos)
      } catch {
        // Ignore seek failure
      }
    }
    // 先回到原位再重套字幕與彈幕，字幕下載不卡住續播點。
    await restoreControllerSettings()
    // open() 也會清掉彈幕內容，只留「已開啟」的開關。
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

export async function selectYoutubeStreamMode(mode: YoutubeStreamPreference): Promise<void> {
  const nextSettings: PlayerSettings = updateSettings({ youtubeStreamMode: mode })
  storeState.settings = nextSettings
  emitStore()

  const item: UnifiedVideoItem | null = storeState.currentItem
  if (!item || item.provider !== "yt") return

  const currentPos: number = progressState.position
  const ctrl: VideoPlaybackController = getPlayerController()
  storeState.status = "buffering"
  emitStore()

  try {
    const manifest: StreamManifest = await resolveStream("yt", item.rawId, {
      mode,
      preferredHeight: nextSettings.preferredQualityHeight,
      isLive: item.isLive === true,
    })
    const picked = pickInitialQualityTrack(manifest, nextSettings.preferredQualityHeight)
    storeState.manifest = manifest
    storeState.selectedQualityId = picked.id
    storeState.selectedQualityLabel = picked.label
    emitStore()

    const url: string = manifest.primaryUrl
    const backend = manifest.backend
    const headers = manifest.headers
    await ctrl.open(url, { backend, headers })
    if (currentPos > 0.5 && !isLivePlayback()) {
      try {
        await ctrl.seek(currentPos)
      } catch {
        // Ignore
      }
    }
    await restoreControllerSettings()
    await ctrl.play()
  } catch (err: unknown) {
    storeState.status = "error"
    storeState.errorText = err instanceof Error ? err.message : "切換串流引擎失敗"
    emitStore()
  }
}

/** 同一條字幕在同一次播放裡不必重抓（bili 的網址每次解析都不同）；換片時清掉。 */
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

/**
 * 重開串流（切畫質、換分 P、換引擎、重試）後把控制項狀態再套一次。
 * open() 會把控制器自己的字幕與彈幕設定清掉，只留 store 顯示「已開啟」就會跟實際不符。
 */
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
      // 新 manifest 沒有這條字幕（換分 P、換引擎），不要留一個開不了的開關。
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
  // 同 openVideo：換分P之前先停掉舊串流，不然它的事件會蓋掉位置也寫錯紀錄。
  streamSwitchPending = true
  try {
    ctrl.pause()
  } catch {
    // 沒在播就沒事
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
    if (manifest.duration > 0) {
      progressState.duration = manifest.duration
      emitProgress()
    }
    emitStore()

    const url: string = manifest.primaryUrl
    const backend = manifest.backend
    const headers = manifest.headers
    await ctrl.open(url, { backend, headers })
    streamSwitchPending = false
    await restoreControllerSettings()
    void loadBiliDanmakuForCid(pagePart.cid)
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

export function setFullscreen(fullscreen: boolean): void {
  if (storeState.isFullscreen === fullscreen) return
  try {
    if (fullscreen) {
      savedOrientations = Device.supportedInterfaceOrientations
      Device.supportedInterfaceOrientations = ["landscape"]
    } else {
      Device.supportedInterfaceOrientations =
        savedOrientations && savedOrientations.length > 0 ? savedOrientations : ["portrait"]
      savedOrientations = null
    }
  } catch {
    // Orientation lock not supported on all devices
  }
  storeState.isFullscreen = fullscreen
  emitStore()
}

export function toggleFullscreen(): void {
  setFullscreen(!storeState.isFullscreen)
}

// 迷你播放器只是監視窗，字幕與彈幕在那麼小的畫面裡只會糊成一團，收起時關掉、展開再依原本的選擇還原。
function applyOverlayVisibility(visible: boolean): void {
  const ctrl: VideoPlaybackController = getPlayerController()
  const isBili: boolean = storeState.currentItem?.provider === "bili"
  ctrl.subtitlesEnabled = visible && storeState.selectedSubtitleId !== null
  if (isBili) ctrl.danmakuEnabled = visible && storeState.danmakuEnabled
}

export function minimizeToMiniPlayer(): void {
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
  if (storeState.isFullscreen) {
    setFullscreen(false)
  }
  const ctrl: VideoPlaybackController = getPlayerController()
  // 讓還在跑的開片流程停在下一個檢查點。
  openRequestSeq++
  stopLiveViewerRefresh()
  publishLiveViewers("", null)
  // 先放掉預抓：播放器在等的代理請求會立刻失敗返回，stop 才有機會結束。
  releaseAllPrefetchers()
  try {
    await withTimeout(ctrl.stop(), STOP_TIMEOUT_MS)
  } catch {
    // Ignore
  }
  storeState.presentationMode = "hidden"
  storeState.currentItem = null
  storeState.pipAvailable = false
  storeState.detail = null
  storeState.manifest = null
  storeState.activeSponsorPrompt = null
  storeState.status = "idle"
  emitStore()
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
  const sort: CommentSort = storeState.commentsSort
  storeState.commentsLoading = true
  storeState.commentsCursor = null
  emitStore()
  try {
    const page: CommentPage = await getCommentPage(item.provider, item.rawId, { sort })
    if (storeState.currentItem?.id !== item.id || storeState.commentsSort !== sort) return
    storeState.comments = page.comments
    storeState.commentsCursor = page.cursor
  } catch {
    // Ignore
  } finally {
    if (storeState.currentItem?.id === item.id) {
      storeState.commentsLoading = false
      emitStore()
    }
  }
}

/** 換排序：清掉現有留言，從第一頁重載。 */
export async function setCommentsSort(sort: CommentSort): Promise<void> {
  if (storeState.commentsSort === sort) return
  storeState.commentsSort = sort
  await reloadComments()
}

/** 接續下一批留言；沒有游標就什麼都不做。 */
export async function loadMoreComments(): Promise<void> {
  const item: UnifiedVideoItem | null = storeState.currentItem
  const cursor: string | null = storeState.commentsCursor
  if (!item || !cursor || storeState.commentsLoading || storeState.commentsLoadingMore) return

  const sort: CommentSort = storeState.commentsSort
  storeState.commentsLoadingMore = true
  emitStore()
  try {
    const page: CommentPage = await getCommentPage(item.provider, item.rawId, { sort, cursor })
    if (storeState.currentItem?.id !== item.id || storeState.commentsSort !== sort) return
    const seen: Set<string> = new Set(storeState.comments.map((comment: CommentItem): string => comment.id))
    const fresh: CommentItem[] = page.comments.filter((comment: CommentItem): boolean => !seen.has(comment.id))
    storeState.comments = fresh.length > 0 ? [...storeState.comments, ...fresh] : storeState.comments
    storeState.commentsCursor = page.cursor
  } catch {
    // Keep the cursor so the user can retry
  } finally {
    storeState.commentsLoadingMore = false
    emitStore()
  }
}

/** 載入某則留言的下一批回覆（第一次就是展開）。 */
export async function loadCommentReplies(commentId: string): Promise<void> {
  const item: UnifiedVideoItem | null = storeState.currentItem
  const target: CommentItem | undefined = storeState.comments.find(
    (comment: CommentItem): boolean => comment.id === commentId,
  )
  const cursor: string | null | undefined = target?.replyCursor
  if (!item || !target || !cursor) return
  if (storeState.repliesLoading[commentId] === true) return

  storeState.repliesLoading = { ...storeState.repliesLoading, [commentId]: true }
  emitStore()
  try {
    const page: CommentPage = await getCommentReplies(item.provider, item.rawId, commentId, cursor)
    if (storeState.currentItem?.id !== item.id) return
    storeState.comments = storeState.comments.map((comment: CommentItem): CommentItem => {
      if (comment.id !== commentId) return comment
      const existing: CommentItem[] = comment.replies ?? []
      const seen: Set<string> = new Set(existing.map((reply: CommentItem): string => reply.id))
      const fresh: CommentItem[] = page.comments.filter((reply: CommentItem): boolean => !seen.has(reply.id))
      return { ...comment, replies: [...existing, ...fresh], replyCursor: page.cursor }
    })
  } catch {
    // Keep the cursor so the user can retry
  } finally {
    storeState.repliesLoading = { ...storeState.repliesLoading, [commentId]: false }
    emitStore()
  }
}
