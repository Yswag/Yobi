import type {
  PlaybackBackend,
  PlayerSettings,
  StreamManifest,
  SubtitleTrackInfo,
  UnifiedVideoItem,
  VideoDetail,
  VideoPagePart,
  VideoQualityTrack,
} from "../../types/index"
import {
  clearHlsRelays,
  clearMediaSessions,
  getSavedPosition,
  getSettings,
  getVideoDetail,
  releaseAllPrefetchers,
  resolveStream,
  warmStreamStart,
} from "../../services/index"
import { reportError } from "../../services/errors"
import { effectiveResolution, SPONSOR_CATEGORY_LABELS } from "../../utils/format"
import type { OpenVideoOptions, PlaybackStatus } from "./types"
import {
  clearToastTimer,
  disposeActiveManifest,
  emitProgress,
  emitStore,
  findChapterAt,
  isLivePlayback,
  mapControllerState,
  patchProgress,
  patchStore,
  pickBackend,
  readDraftProgress,
  readDraftStore,
  replaceProgress,
  replaceStore,
  runtime,
  saveCurrentHistory,
  showSkippedToast,
  syncStatus,
  withTimeout,
} from "./store"
import { loadInitialComments, resetCommentsState } from "./comments"
import {
  publishLiveViewers,
  startLiveViewerRefresh,
  stopLiveViewerRefresh,
} from "./liveViewers"
import { setFullscreen, syncFullscreenOrientation } from "./orientation"
import {
  applySponsorSegmentsForCid,
  consumeActiveSponsorPrompt,
  loadSponsorSegments,
  resetSponsorForPageSwitch,
  resetSponsorState,
} from "./sponsor"
import {
  applyOverlayVisibility,
  ensureAudioSession,
  getPlayerController,
  recoverAfterResume,
  refreshPipAvailability,
  setPlaybackErrorRecovery,
} from "./controller"
import {
  clearTrackCaches,
  loadBiliDanmakuForCid,
  restoreControllerSettings,
} from "./tracks"

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

export async function openVideo(item: UnifiedVideoItem, options: OpenVideoOptions = {}): Promise<void> {
  const requestId: number = ++runtime.openRequestSeq
  const actionSeq: number = ++runtime.streamActionSeq
  const isStale = (): boolean => requestId !== runtime.openRequestSeq || actionSeq !== runtime.streamActionSeq
  const ctrl: VideoPlaybackController = getPlayerController()
  const settings: PlayerSettings = getSettings()
  runtime.streamSwitchPending = true
  runtime.seekPendingCount = 0
  saveCurrentHistory(true)
  try {
    ctrl.pause()
  } catch (error) {
    reportError("player", "open.pause", error)
  }
  disposeActiveManifest()
  await ensureAudioSession()
  if (isStale()) return

  const nextQueue: UnifiedVideoItem[] = options.queue && options.queue.length > 0 ? options.queue : [item]
  const idx: number = Math.max(
    0,
    nextQueue.findIndex((entry: UnifiedVideoItem): boolean => entry.id === item.id),
  )

  const initialCid: number | undefined = options.cid ?? item.cid
  const initialPage: number = options.page ?? 1

  resetSponsorState(settings)
  replaceProgress({
    position: Math.max(0, options.startSeconds ?? 0),
    duration: item.duration || 0,
    bufferedUntil: 0,
    activeChapter: null,
  })
  emitProgress()

  replaceStore({
    ...readDraftStore(),
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
  })
  emitStore()
  resetCommentsState(!item.isLive)

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
  clearTrackCaches()

  void getVideoDetail(item.provider, item.rawId)
    .then((detail: VideoDetail) => {
      if (requestId !== runtime.openRequestSeq) return
      const store = readDraftStore()
      const resolvedCid: number | undefined =
        store.activeCid ?? detail.cid ?? detail.pages?.[0]?.cid
      patchStore({ detail })
      if (store.currentItem) {
        const enriched: UnifiedVideoItem = enrichItem(store.currentItem, detail)
        patchStore({ currentItem: enriched })
        if (store.queue[store.queueIndex]?.id === enriched.id) {
          const queue: UnifiedVideoItem[] = store.queue.slice()
          queue[store.queueIndex] = enriched
          patchStore({ queue })
        }
      }
      if (detail.isLive && (detail.viewCount ?? 0) > 0) {
        publishLiveViewers(detail.id, detail.viewCount ?? null)
      }
      if (resolvedCid && !readDraftStore().activeCid) {
        patchStore({ activeCid: resolvedCid })
        applySponsorSegmentsForCid()
      }
      if (detail.duration > 0 && readDraftProgress().duration <= 0) {
        patchProgress({ duration: detail.duration })
        emitProgress()
      }
      emitStore()
    })
    .catch((error: unknown) => {
      reportError("player", "detail.load", error)
    })

  loadInitialComments(item, requestId)
  loadSponsorSegments(item, settings, requestId)

  try {
    const manifest: StreamManifest = await resolveStream(item.provider, item.rawId, {
      cid: initialCid,
      mode: settings.youtubeStreamMode,
      preferredHeight: settings.preferredQualityHeight,
      isLive: item.isLive === true,
    })
    if (isStale()) {
      manifest.dispose?.()
      return
    }
    runtime.activeManifest = manifest
    const picked = pickInitialQualityTrack(manifest, settings.preferredQualityHeight)
    const activeCid: number | undefined = manifest.cid ?? initialCid ?? readDraftStore().activeCid

    patchStore({
      manifest,
      selectedQualityId: picked.id,
      selectedQualityLabel: picked.label,
      activeCid,
    })
    if (readDraftStore().isFullscreen) syncFullscreenOrientation()
    applySponsorSegmentsForCid()
    if (manifest.duration > 0) {
      patchProgress({ duration: manifest.duration })
      emitProgress()
    }
    emitStore()

    if (manifest.warnings && manifest.warnings.length > 0) showSkippedToast(manifest.warnings[0])

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
    if (resumeAt > 0) {
      patchProgress({
        position: resumeAt,
        activeChapter: findChapterAt(readDraftStore().detail?.chapters, resumeAt),
      })
      emitProgress()
      warmStreamStart(url, resumeAt)
    }
    await ctrl.open(url, { backend, headers })
    if (isStale()) return

    if (resumeAt > 0) {
      await seekForResume(ctrl, resumeAt)
      if (isStale()) return
    }
    await restoreControllerSettings()
    if (isStale()) return
    if (item.provider === "bili" && activeCid) {
      void loadBiliDanmakuForCid(activeCid, actionSeq)
    }

    runtime.streamSwitchPending = false
    await ctrl.play()
    if (isStale()) return
    if (mapControllerState(ctrl.state) === "playing") syncStatus("playing")
    const pendingSubtitles = manifest.resolveSubtitles
    if (pendingSubtitles) {
      void pendingSubtitles()
        .then((tracks: SubtitleTrackInfo[]) => {
          if (isStale()) return
          const current = readDraftStore().manifest
          if (!current) return
          patchStore({ manifest: { ...current, subtitles: tracks } })
          emitStore()
        })
        .catch(() => {})
    }
  } catch (err: unknown) {
    if (isStale()) return
    runtime.streamSwitchPending = false
    const message: string = err instanceof Error ? err.message : String(err)
    patchStore({
      status: "error",
      errorText: message || "無法載入影片串流",
    })
    emitStore()
  }
}

export async function togglePlayPause(): Promise<void> {
  const ctrl: VideoPlaybackController = getPlayerController()
  const store = readDraftStore()
  try {
    if (store.status === "playing" || ctrl.state === "playing") {
      ctrl.pause()
      patchStore({ status: "paused" })
      emitStore()
      return
    }
    if (store.status === "ended" || ctrl.state === "ended") {
      if (isLivePlayback()) {
        await ctrl.play()
        return
      }
      await ctrl.seek(0)
    }
    await ensureAudioSession()
    await ctrl.play()
  } catch (err: unknown) {
    if (recoverAfterResume(true, err)) return
    patchStore({ errorText: err instanceof Error ? err.message : "播放失敗" })
    emitStore()
  }
}

export async function seekTo(seconds: number): Promise<void> {
  if (isLivePlayback()) return
  const ctrl: VideoPlaybackController = getPlayerController()
  const target: number = Math.max(0, seconds)
  const store = readDraftStore()
  const shouldShowBuffering: boolean = store.status === "playing" || store.status === "buffering"
  patchProgress({
    position: target,
    activeChapter: findChapterAt(store.detail?.chapters, target),
  })
  emitProgress()
  runtime.seekPendingCount++
  if (shouldShowBuffering && store.status !== "buffering") {
    patchStore({ status: "buffering" })
    emitStore()
  }
  try {
    await ctrl.seek(target)
    if (runtime.seekPendingCount === 1 && !runtime.streamSwitchPending && shouldShowBuffering) {
      const afterSeek: PlaybackStatus = mapControllerState(ctrl.state)
      if (afterSeek === "ready" || afterSeek === "paused") {
        await ctrl.play()
      }
    }
  } catch (error) {
    reportError("player", "seek", error)
  } finally {
    runtime.seekPendingCount = Math.max(0, runtime.seekPendingCount - 1)
    if (runtime.seekPendingCount === 0 && !runtime.streamSwitchPending) {
      const nextStatus: PlaybackStatus = mapControllerState(ctrl.state)
      if (readDraftStore().status !== nextStatus) {
        patchStore({ status: nextStatus })
        emitStore()
      }
    }
  }
}

export async function seekBy(deltaSeconds: number): Promise<void> {
  if (isLivePlayback()) return
  const progress = readDraftProgress()
  const dur: number = progress.duration
  const raw: number = progress.position + deltaSeconds
  const clamped: number = dur > 0 ? Math.min(dur, Math.max(0, raw)) : Math.max(0, raw)
  await seekTo(clamped)
}

export function setPlaybackRate(rate: number): void {
  const ctrl: VideoPlaybackController = getPlayerController()
  const safeRate: number = Math.min(4, Math.max(0.25, rate))
  ctrl.playbackRate = safeRate
  patchStore({
    playbackRate: safeRate,
    isBoosting2x: false,
  })
  emitStore()
}

export function setTemporaryBoost2x(boosting: boolean): void {
  const ctrl: VideoPlaybackController = getPlayerController()
  const store = readDraftStore()
  if (boosting) {
    if (isLivePlayback()) return
    if (!store.isBoosting2x) {
      runtime.savedRateBeforeBoost = store.playbackRate || 1
      ctrl.playbackRate = 2
      patchStore({ isBoosting2x: true })
      emitStore()
    }
  } else if (store.isBoosting2x) {
    const restoredRate: number = runtime.savedRateBeforeBoost || 1
    ctrl.playbackRate = restoredRate
    patchStore({
      playbackRate: restoredRate,
      isBoosting2x: false,
    })
    emitStore()
  }
}

export async function selectQuality(qualityId: string, options: { resume?: boolean } = {}): Promise<void> {
  const store = readDraftStore()
  const manifest: StreamManifest | null = store.manifest
  if (!manifest) return
  const expectedOpenSeq: number = runtime.openRequestSeq
  const actionSeq: number = ++runtime.streamActionSeq
  const isStale = (): boolean =>
    runtime.openRequestSeq !== expectedOpenSeq || runtime.streamActionSeq !== actionSeq
  const ctrl: VideoPlaybackController = getPlayerController()
  const currentPos: number = readDraftProgress().position
  const wasPlaying: boolean = options.resume ?? (store.status === "playing" || store.status === "error")

  const track: VideoQualityTrack | undefined = manifest.qualities.find(
    (entry: VideoQualityTrack): boolean => entry.id === qualityId,
  )
  const label: string = track?.label ?? (qualityId === "auto" ? "自動" : qualityId)

  patchStore({
    selectedQualityId: qualityId,
    selectedQualityLabel: label,
    status: "buffering",
  })
  emitStore()

  try {
    const resolved = manifest.resolveQuality
      ? await manifest.resolveQuality(qualityId)
      : {
          url: track?.url ?? manifest.primaryUrl,
          backend: manifest.backend,
          headers: track?.headers ?? manifest.headers,
        }
    if (isStale()) return

    const url: string = resolved.url
    const backend: PlaybackBackend = pickBackend(resolved.backend)
    const headers = resolved.headers ?? manifest.headers
    runtime.streamSwitchPending = true
    if (currentPos > 0.5 && !isLivePlayback()) warmStreamStart(url, currentPos)
    await ctrl.open(url, { backend, headers })
    if (isStale()) return
    if (currentPos > 0.5 && !isLivePlayback()) {
      try {
        await ctrl.seek(currentPos)
      } catch (error) {
        reportError("player", "quality.seek", error)
      }
      if (isStale()) return
    }
    await restoreControllerSettings()
    if (isStale()) return
    const latest = readDraftStore()
    const activeCid: number | undefined = latest.activeCid
    if (latest.currentItem?.provider === "bili" && activeCid && latest.danmakuEnabled) {
      void loadBiliDanmakuForCid(activeCid, actionSeq)
    }
    runtime.streamSwitchPending = false
    if (wasPlaying) {
      await ctrl.play()
      if (isStale()) return
      if (mapControllerState(ctrl.state) === "playing") syncStatus("playing")
    } else {
      syncStatus("paused")
    }
  } catch (err: unknown) {
    if (isStale()) return
    runtime.streamSwitchPending = false
    const message: string = err instanceof Error ? err.message : "切換畫質失敗"
    patchStore({
      status: "error",
      errorText: message,
    })
    emitStore()
  }
}

export async function selectPage(pagePart: VideoPagePart): Promise<void> {
  const store = readDraftStore()
  const item: UnifiedVideoItem | null = store.currentItem
  if (!item || item.provider !== "bili") return

  const expectedOpenSeq: number = runtime.openRequestSeq
  const actionSeq: number = ++runtime.streamActionSeq
  const isStale = (): boolean =>
    runtime.openRequestSeq !== expectedOpenSeq || runtime.streamActionSeq !== actionSeq
  const ctrl: VideoPlaybackController = getPlayerController()
  const settings: PlayerSettings = store.settings
  patchStore({
    activeCid: pagePart.cid,
    activePage: pagePart.page,
    status: "loading",
    errorText: null,
  })
  resetSponsorForPageSwitch()
  replaceProgress({
    position: 0,
    duration: pagePart.duration || readDraftProgress().duration,
    bufferedUntil: 0,
    activeChapter: null,
  })
  emitProgress()
  emitStore()
  runtime.streamSwitchPending = true
  try {
    ctrl.pause()
  } catch (error) {
    reportError("player", "switch.pause", error)
  }
  disposeActiveManifest()

  try {
    ctrl.clearDanmaku()
    const manifest: StreamManifest = await resolveStream("bili", item.rawId, {
      cid: pagePart.cid,
      preferredHeight: settings.preferredQualityHeight,
    })
    if (isStale()) {
      manifest.dispose?.()
      return
    }
    runtime.activeManifest = manifest
    const picked = pickInitialQualityTrack(manifest, settings.preferredQualityHeight)
    patchStore({
      manifest,
      selectedQualityId: picked.id,
      selectedQualityLabel: picked.label,
    })
    if (readDraftStore().isFullscreen) syncFullscreenOrientation()
    if (manifest.duration > 0) {
      patchProgress({ duration: manifest.duration })
      emitProgress()
    }
    emitStore()

    const url: string = manifest.primaryUrl
    const backend: PlaybackBackend = pickBackend(manifest.backend)
    const headers = manifest.headers
    await ctrl.open(url, { backend, headers })
    if (isStale()) return
    await restoreControllerSettings()
    if (isStale()) return
    void loadBiliDanmakuForCid(pagePart.cid, actionSeq)
    await ensureAudioSession()
    if (isStale()) return
    runtime.streamSwitchPending = false
    await ctrl.play()
    if (isStale()) return
    if (mapControllerState(ctrl.state) === "playing") syncStatus("playing")
  } catch (err: unknown) {
    if (isStale()) return
    runtime.streamSwitchPending = false
    patchStore({
      status: "error",
      errorText: err instanceof Error ? err.message : "切換分P失敗",
    })
    emitStore()
  }
}

export function setStatsVisible(visible: boolean): void {
  if (readDraftStore().statsVisible === visible) return
  patchStore({ statsVisible: visible })
  emitStore()
}

export function skipActiveSponsorSegment(): void {
  const seg = consumeActiveSponsorPrompt()
  if (!seg) return
  void seekTo(seg.endTime)
  const label: string = SPONSOR_CATEGORY_LABELS[seg.category] ?? "片段"
  showSkippedToast(`已跳過：${label}`)
}

export function minimizeToMiniPlayer(): void {
  saveCurrentHistory(true)
  if (readDraftStore().isBoosting2x) {
    setTemporaryBoost2x(false)
  }
  if (readDraftStore().isFullscreen) {
    setFullscreen(false)
  }
  if (!readDraftStore().currentItem) return
  patchStore({ presentationMode: "mini" })
  applyOverlayVisibility(false)
  emitStore()
}

export async function closePlayer(): Promise<void> {
  saveCurrentHistory(true)
  if (readDraftStore().isFullscreen) {
    setFullscreen(false)
  }
  const ctrl: VideoPlaybackController = getPlayerController()
  runtime.openRequestSeq++
  runtime.streamActionSeq++
  runtime.streamSwitchPending = false
  runtime.seekPendingCount = 0
  clearToastTimer()
  stopLiveViewerRefresh()
  publishLiveViewers("", null)
  try {
    await withTimeout(ctrl.stop(), STOP_TIMEOUT_MS)
  } catch (error) {
    reportError("player", "close.stop", error)
  }
  disposeActiveManifest()
  clearMediaSessions()
  clearHlsRelays()
  releaseAllPrefetchers()
  clearTrackCaches()
  patchStore({
    presentationMode: "hidden",
    currentItem: null,
    pipAvailable: false,
    detail: null,
    manifest: null,
    activeSponsorPrompt: null,
    skippedToast: null,
    status: "idle",
  })
  emitStore()
  resetCommentsState(false)
}

export async function retryPlayback(resume?: boolean): Promise<void> {
  const store = readDraftStore()
  if (!store.currentItem) return
  if (store.manifest) {
    await selectQuality(store.selectedQualityId, { resume })
    return
  }
  await openVideo(store.currentItem, { cid: store.activeCid, page: store.activePage })
}

setPlaybackErrorRecovery(retryPlayback)

export async function startPiP(): Promise<void> {
  const ctrl: VideoPlaybackController = getPlayerController()
  refreshPipAvailability(ctrl)
  if (!readDraftStore().pipAvailable) {
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
  const store = readDraftStore()
  const nextIndex: number = store.queueIndex + 1
  const nextItem: UnifiedVideoItem | undefined = store.queue[nextIndex]
  if (nextItem) {
    await openVideo(nextItem, { queue: store.queue })
    return
  }
  const firstRelated: UnifiedVideoItem | undefined = store.detail?.relatedVideos?.[0]
  if (firstRelated) {
    await openVideo(firstRelated)
  }
}

export async function playPrevious(): Promise<void> {
  if (!isLivePlayback() && readDraftProgress().position > 5) {
    await seekTo(0)
    return
  }
  const store = readDraftStore()
  const prevIndex: number = store.queueIndex - 1
  const prevItem: UnifiedVideoItem | undefined = store.queue[prevIndex]
  if (prevItem) {
    await openVideo(prevItem, { queue: store.queue })
  }
}
