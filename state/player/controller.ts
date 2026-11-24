import { AppEvents } from "scripting"
import type { ScenePhase } from "scripting"
import { setBiliLineSwitchListener } from "../../services/index"
import { reportError } from "../../services/errors"
import type { LiveWindow, PlaybackStatus } from "./types"
import {
  emitProgress,
  emitStore,
  findChapterAt,
  isLivePlayback,
  mapControllerState,
  patchProgress,
  patchStore,
  readDraftProgress,
  readDraftStore,
  runtime,
  saveCurrentHistory,
  showSkippedToast,
} from "./store"
import { handleSponsorProgress } from "./sponsor"
import { readLiveWindow } from "./liveWindow"

let controllerInstance: VideoPlaybackController | null = null
let audioSessionReady: boolean = false
let resumeRecoveryArmed: boolean = false
let resumeArmedPosition: number = 0
let resumeRecoveryInFlight: boolean = false
let playbackErrorRecovery: ((resume: boolean) => Promise<void>) | null = null

export function setPlaybackErrorRecovery(handler: (resume: boolean) => Promise<void>): void {
  playbackErrorRecovery = handler
}

export function recoverAfterResume(resume: boolean, error: unknown): boolean {
  if (resumeRecoveryInFlight) return true
  if (!resumeRecoveryArmed || !playbackErrorRecovery) return false
  resumeRecoveryArmed = false
  resumeRecoveryInFlight = true
  reportError("player", "resume.recover", error)
  void playbackErrorRecovery(resume).finally((): void => {
    resumeRecoveryInFlight = false
  })
  return true
}

function wantsPlayback(status: PlaybackStatus): boolean {
  return status === "playing" || status === "buffering"
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
  if (readDraftStore().audioUnavailable === unavailable) return
  patchStore({ audioUnavailable: unavailable })
  emitStore()
}

export async function ensureAudioSession(): Promise<void> {
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

export function refreshPipAvailability(ctrl: VideoPlaybackController): void {
  let available: boolean = false
  try {
    available = ctrl.mediaInfo?.backend === "native" && ctrl.getPictureInPictureState().supported
  } catch {
    available = false
  }
  if (readDraftStore().pipAvailable !== available) {
    patchStore({ pipAvailable: available })
    emitStore()
  }
}

export function applyOverlayVisibility(visible: boolean): void {
  const ctrl: VideoPlaybackController = getPlayerController()
  const store = readDraftStore()
  const isBili: boolean = store.currentItem?.provider === "bili"
  ctrl.subtitlesEnabled = visible && store.selectedSubtitleId !== null
  if (isBili) ctrl.danmakuEnabled = visible && store.danmakuEnabled
}

export function expandFromMiniPlayer(): void {
  if (!readDraftStore().currentItem) return
  patchStore({ presentationMode: "expanded" })
  applyOverlayVisibility(true)
  emitStore()
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
    const store = readDraftStore()
    if (store.status !== "playing" && ctrl.state !== "playing") return
    try {
      ctrl.pause()
    } catch (error) {
      reportError("player", "interruption.pause", error)
    }
    patchStore({ status: "paused" })
    emitStore()
  })

  ctrl.on("state", (snap: VideoPlaybackSnapshot) => {
    if (runtime.streamSwitchPending) return
    const store = readDraftStore()
    const mapped: PlaybackStatus = mapControllerState(snap.state)
    if (runtime.seekPendingCount > 0 && store.status === "buffering" && (mapped === "paused" || mapped === "ready")) {
      return
    }
    if (mapped === "error" && recoverAfterResume(wantsPlayback(store.status), snap.state)) return
    if (mapped === "paused" || mapped === "ended") saveCurrentHistory(true)
    if (store.status !== mapped) {
      patchStore({ status: mapped })
      emitStore()
    }
  })

  AppEvents.scenePhase.addListener((phase: ScenePhase) => {
    if (phase !== "background") return
    saveCurrentHistory(true)
    const store = readDraftStore()
    if (store.currentItem) {
      resumeRecoveryArmed = true
      resumeArmedPosition = readDraftProgress().position
    }
    if (store.status !== "playing" || !store.currentItem) return
    if (!store.pipAvailable) return
    void ctrl.startPictureInPicture().catch(() => {})
  })

  ctrl.on("ready", (snap: VideoPlaybackSnapshot) => {
    if (typeof snap.duration === "number" && snap.duration > 0) {
      patchProgress({ duration: snap.duration })
      emitProgress()
    }
    refreshPipAvailability(ctrl)
  })

  ctrl.on("progress", (snap: VideoPlaybackSnapshot) => {
    if (runtime.streamSwitchPending) return
    const store = readDraftStore()
    const progress = readDraftProgress()
    const pos: number = Number.isFinite(snap.position) ? snap.position : 0
    if (resumeRecoveryArmed && snap.state === "playing" && Math.abs(pos - resumeArmedPosition) > 1) {
      resumeRecoveryArmed = false
    }
    const dur: number =
      typeof snap.duration === "number" && snap.duration > 0
        ? snap.duration
        : progress.duration || store.manifest?.duration || store.currentItem?.duration || 0
    const liveWindow: LiveWindow | null = isLivePlayback() ? readLiveWindow(ctrl) : null

    patchProgress({
      position: pos,
      duration: dur,
      bufferedUntil: Number.isFinite(snap.bufferedUntil) ? snap.bufferedUntil : 0,
      activeChapter: findChapterAt(store.detail?.chapters, pos),
      liveWindow,
    })
    emitProgress()
    if (store.liveSeekable !== (liveWindow !== null)) {
      patchStore({ liveSeekable: liveWindow !== null })
      emitStore()
    }
    saveCurrentHistory(false)
    handleSponsorProgress(ctrl, pos)
  })

  ctrl.on("ended", () => {
    if (runtime.streamSwitchPending) return
    const progress = readDraftProgress()
    if (progress.duration > 0) {
      patchProgress({
        position: progress.duration,
        bufferedUntil: progress.duration,
      })
      emitProgress()
    }
    patchStore({ status: "ended" })
    emitStore()
  })

  ctrl.on("error", (err: { message: string }) => {
    if (runtime.streamSwitchPending) return
    if (recoverAfterResume(wantsPlayback(readDraftStore().status), err.message)) return
    patchStore({
      status: "error",
      errorText: err.message || "播放器發生錯誤",
    })
    emitStore()
  })

  ctrl.on("pictureInPictureRestoreRequested", () => {
    expandFromMiniPlayer()
  })

  ctrl.on("pictureInPicture", (pip: VideoPictureInPictureState) => {
    const active: boolean = Boolean(pip.active)
    if (readDraftStore().isPiPActive !== active) {
      patchStore({ isPiPActive: active })
      emitStore()
    }
  })

  ctrl.on("pictureInPictureError", (err: { message: string }) => {
    showSkippedToast(`子母畫面：${err.message}`)
  })

  return ctrl
}
