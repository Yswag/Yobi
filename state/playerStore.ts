import { fetch, useEffect, useState } from "scripting"
import type {
  CommentItem,
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
  getComments,
  getSavedPosition,
  getSettings,
  getVideoDetail,
  recordWatchHistory,
  resolveOfflineSource,
  resolveStream,
  updateSettings,
} from "../services"
import { SPONSOR_CATEGORY_LABELS } from "../utils/format"

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
  danmakuEnabled: boolean
  danmakuCount: number
  queue: UnifiedVideoItem[]
  queueIndex: number
  settings: PlayerSettings
}

export interface PlayerProgressSnapshot {
  position: number
  duration: number
  activeChapter: VideoChapter | null
}

let controllerInstance: VideoPlaybackController | null = null
let audioSessionReady: boolean = false
let openRequestSeq: number = 0
let lastHistorySaveAt: number = 0
let lastSkippedSegmentUuid: string = ""
let dismissedSegmentUuid: string = ""
let toastTimer: number | null = null
let savedRateBeforeBoost: number = 1
let savedOrientations: typeof Device.supportedInterfaceOrientations | null = null

const storeListeners: Set<() => void> = new Set()
const progressListeners: Set<() => void> = new Set()

let storeState: PlayerStoreSnapshot = {
  presentationMode: "hidden",
  currentItem: null,
  detail: null,
  manifest: null,
  comments: [],
  commentsLoading: false,
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
  danmakuEnabled: true,
  danmakuCount: 0,
  queue: [],
  queueIndex: -1,
  settings: getSettings(),
}

let progressState: PlayerProgressSnapshot = {
  position: 0,
  duration: 0,
  activeChapter: null,
}

function emitStore(): void {
  storeState = { ...storeState }
  for (const listener of Array.from(storeListeners)) {
    try {
      listener()
    } catch {
      // Ignore listener errors
    }
  }
}

function emitProgress(): void {
  progressState = { ...progressState }
  for (const listener of Array.from(progressListeners)) {
    try {
      listener()
    } catch {
      // Ignore listener errors
    }
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

export function getPlayerController(): VideoPlaybackController {
  if (controllerInstance) return controllerInstance
  const ctrl: VideoPlaybackController = new VideoPlaybackController()
  controllerInstance = ctrl

  ctrl.on("state", (snap: VideoPlaybackSnapshot) => {
    const mapped: PlaybackStatus = mapControllerState(snap.state)
    if (storeState.status !== mapped) {
      storeState.status = mapped
      emitStore()
    }
  })

  ctrl.on("ready", (snap: VideoPlaybackSnapshot) => {
    if (typeof snap.duration === "number" && snap.duration > 0) {
      progressState.duration = snap.duration
      emitProgress()
    }
  })

  ctrl.on("progress", (snap: VideoPlaybackSnapshot) => {
    const pos: number = Number.isFinite(snap.position) ? snap.position : 0
    const dur: number =
      typeof snap.duration === "number" && snap.duration > 0
        ? snap.duration
        : progressState.duration || storeState.manifest?.duration || storeState.currentItem?.duration || 0

    progressState.position = pos
    progressState.duration = dur
    progressState.activeChapter = findChapterAt(storeState.detail?.chapters, pos)
    emitProgress()

    const now: number = Date.now()
    if (storeState.currentItem && pos > 1 && now - lastHistorySaveAt >= 4500) {
      lastHistorySaveAt = now
      recordWatchHistory({
        item: storeState.currentItem,
        position: pos,
        duration: dur,
        watchedAt: now,
        cid: storeState.activeCid,
        page: storeState.activePage,
      })
    }

    if (storeState.settings.sponsorBlockEnabled && storeState.sponsorSegments.length > 0) {
      const seg: SponsorSegment | null = findActiveSponsorSegment(storeState.sponsorSegments, pos)
      if (seg) {
        if (storeState.settings.sponsorBlockAutoSkip && seg.actionType === "skip") {
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
    storeState.status = "ended"
    emitStore()
  })

  ctrl.on("error", (err: { message: string }) => {
    storeState.status = "error"
    storeState.errorText = err.message || "播放器發生錯誤"
    emitStore()
  })

  ctrl.on("pictureInPicture", (pip: VideoPictureInPictureState) => {
    const active: boolean = Boolean(pip.active)
    if (storeState.isPiPActive !== active) {
      storeState.isPiPActive = active
      emitStore()
    }
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

async function loadBiliDanmakuForCid(cid: number): Promise<void> {
  const ctrl: VideoPlaybackController = getPlayerController()
  try {
    const xml: string = await fetchBiliDanmakuXml(cid)
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

  try {
    ctrl.clearSubtitles()
    ctrl.clearDanmaku()
  } catch {
    // Ignore cleanup errors before open
  }

  // Kick off detail, comments, and SponsorBlock in parallel so video opens as fast as possible
  void getVideoDetail(item.provider, item.rawId)
    .then((detail: VideoDetail) => {
      if (requestId !== openRequestSeq) return
      const resolvedCid: number | undefined =
        storeState.activeCid ?? detail.cid ?? detail.pages?.[0]?.cid
      storeState.detail = detail
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

  void getComments(item.provider, item.rawId)
    .then((comments: CommentItem[]) => {
      if (requestId !== openRequestSeq) return
      storeState.comments = comments
      storeState.commentsLoading = false
      emitStore()
    })
    .catch(() => {
      if (requestId !== openRequestSeq) return
      storeState.commentsLoading = false
      emitStore()
    })

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

    ctrl.backgroundAudioEnabled = settings.backgroundAudioEnabled
    ctrl.playbackRate = settings.defaultPlaybackRate || 1
    ctrl.danmakuEnabled = settings.danmakuEnabled && item.provider === "bili"
    ctrl.danmakuOpacity = settings.danmakuOpacity
    ctrl.setDanmakuStyle({
      speed: settings.danmakuSpeed,
      area: settings.danmakuArea,
      blockedWords: settings.danmakuBlockedWords,
    })

    if (cachedSource) {
      await ctrl.open(cachedSource)
      if (requestId !== openRequestSeq) return
      await cachedSource.dispose()
    } else if (manifest) {
      await ctrl.open(manifest.primaryUrl, {
        backend: manifest.backend,
        headers: manifest.headers,
      })
      if (requestId !== openRequestSeq) return
    }

    if (options.startSeconds !== undefined && options.startSeconds > 0) {
      try {
        await ctrl.seek(options.startSeconds)
      } catch {
        // Ignore initial seek failure
      }
    } else if (options.resumeFromHistory !== false) {
      const savedPos: number = getSavedPosition(item.id, activeCid)
      const totalDur: number = manifest?.duration || offline?.duration || item.duration || 0
      if (savedPos > 5 && (totalDur <= 0 || savedPos < totalDur - 8)) {
        try {
          await ctrl.seek(savedPos)
        } catch {
          // Ignore initial seek failure
        }
      }
    }

    if (item.provider === "bili" && activeCid) {
      void loadBiliDanmakuForCid(activeCid)
    }

    await ctrl.play()
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
      await ctrl.seek(0)
    }
    await ctrl.play()
  } catch (err: unknown) {
    storeState.errorText = err instanceof Error ? err.message : "播放失敗"
    emitStore()
  }
}

export async function seekTo(seconds: number): Promise<void> {
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
  const wasPlaying: boolean = storeState.status === "playing"

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

    await ctrl.open(resolved.url, {
      backend: resolved.backend,
      headers: resolved.headers ?? manifest.headers,
    })
    if (currentPos > 0.5) {
      try {
        await ctrl.seek(currentPos)
      } catch {
        // Ignore seek failure
      }
    }
    if (wasPlaying) {
      await ctrl.play()
    }
  } catch (err: unknown) {
    storeState.status = "error"
    storeState.errorText = err instanceof Error ? err.message : "切換畫質失敗"
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
    })
    const picked = pickInitialQualityTrack(manifest, nextSettings.preferredQualityHeight)
    storeState.manifest = manifest
    storeState.selectedQualityId = picked.id
    storeState.selectedQualityLabel = picked.label
    emitStore()

    await ctrl.open(manifest.primaryUrl, {
      backend: manifest.backend,
      headers: manifest.headers,
    })
    if (currentPos > 0.5) {
      try {
        await ctrl.seek(currentPos)
      } catch {
        // Ignore
      }
    }
    await ctrl.play()
  } catch (err: unknown) {
    storeState.status = "error"
    storeState.errorText = err instanceof Error ? err.message : "切換串流引擎失敗"
    emitStore()
  }
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
    const response = await fetch(sub.url, { timeout: 20, debugLabel: "Yobi Subtitle" })
    if (!response.ok) return
    const text: string = await response.text()
    const format: "vtt" | "srt" = sub.format === "srt" ? "srt" : "vtt"
    await ctrl.loadSubtitles(text, format)
    ctrl.subtitlesEnabled = true
  } catch {
    // Ignore subtitle fetch error
  }
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
    activeChapter: null,
  }
  emitProgress()
  emitStore()

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

    await ctrl.open(manifest.primaryUrl, {
      backend: manifest.backend,
      headers: manifest.headers,
    })
    void loadBiliDanmakuForCid(pagePart.cid)
    await ctrl.play()
  } catch (err: unknown) {
    storeState.status = "error"
    storeState.errorText = err instanceof Error ? err.message : "切換分P失敗"
    emitStore()
  }
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

export function minimizeToMiniPlayer(): void {
  if (storeState.isFullscreen) {
    setFullscreen(false)
  }
  if (!storeState.currentItem) return
  storeState.presentationMode = "mini"
  emitStore()
}

export function expandFromMiniPlayer(): void {
  if (!storeState.currentItem) return
  storeState.presentationMode = "expanded"
  emitStore()
}

export async function closePlayer(): Promise<void> {
  if (storeState.isFullscreen) {
    setFullscreen(false)
  }
  const ctrl: VideoPlaybackController = getPlayerController()
  try {
    await ctrl.stop()
  } catch {
    // Ignore
  }
  storeState.presentationMode = "hidden"
  storeState.currentItem = null
  storeState.detail = null
  storeState.manifest = null
  storeState.activeSponsorPrompt = null
  storeState.status = "idle"
  emitStore()
}

export async function startPiP(): Promise<void> {
  const ctrl: VideoPlaybackController = getPlayerController()
  try {
    await ctrl.startPictureInPicture()
  } catch {
    // Ignore when PiP is unavailable
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
  if (progressState.position > 5) {
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
  storeState.commentsLoading = true
  emitStore()
  try {
    const comments: CommentItem[] = await getComments(item.provider, item.rawId)
    storeState.comments = comments
  } catch {
    // Ignore
  } finally {
    storeState.commentsLoading = false
    emitStore()
  }
}
