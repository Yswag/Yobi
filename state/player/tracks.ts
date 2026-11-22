import { fetch } from "scripting"
import type { PlayerSettings, SubtitleTrackInfo } from "../../types/index"
import { fetchBiliDanmakuXml, updateSettings } from "../../services/index"
import { reportError } from "../../services/errors"
import { biliSubtitleToVtt, toCleanVtt } from "../../utils/subtitles"
import {
  emitStore,
  patchStore,
  readDraftStore,
  runtime,
  showSkippedToast,
} from "./store"
import { applyOverlayVisibility, getPlayerController } from "./controller"

const danmakuXmlCache: Map<number, string> = new Map()
const subtitleVttCache: Map<string, string> = new Map()

export function clearTrackCaches(): void {
  subtitleVttCache.clear()
  danmakuXmlCache.clear()
}

export async function loadBiliDanmakuForCid(cid: number, expectedActionSeq: number): Promise<void> {
  const ctrl: VideoPlaybackController = getPlayerController()
  try {
    let xml: string | undefined = danmakuXmlCache.get(cid)
    if (xml === undefined) {
      xml = await fetchBiliDanmakuXml(cid)
      if (xml) danmakuXmlCache.set(cid, xml)
    }
    if (expectedActionSeq !== runtime.streamActionSeq || readDraftStore().activeCid !== cid) return
    if (!xml || !xml.includes("<d")) return
    const report = await ctrl.loadDanmakuText(xml, "xml")
    if (expectedActionSeq !== runtime.streamActionSeq || readDraftStore().activeCid !== cid) return
    patchStore({ danmakuCount: report.loaded })
    emitStore()
  } catch (error) {
    reportError("player", "danmaku.load", error)
  }
}

async function fetchSubtitleVtt(sub: SubtitleTrackInfo): Promise<string> {
  const key: string = `${readDraftStore().currentItem?.id ?? ""}:${sub.id}`
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
    patchStore({ selectedSubtitleId: null })
    emitStore()
    return
  }

  const store = readDraftStore()
  const sub: SubtitleTrackInfo | undefined = store.manifest?.subtitles.find(
    (entry: SubtitleTrackInfo): boolean => entry.id === subtitleId,
  )
  if (!sub) return

  const itemId: string = store.currentItem?.id ?? ""
  patchStore({ selectedSubtitleId: subtitleId })
  emitStore()

  try {
    const vtt: string = await fetchSubtitleVtt(sub)
    const latest = readDraftStore()
    if (latest.currentItem?.id !== itemId || latest.selectedSubtitleId !== subtitleId) return
    await ctrl.loadSubtitles(vtt, "vtt")
    ctrl.subtitlesEnabled = true
  } catch {
    const latest = readDraftStore()
    if (latest.currentItem?.id !== itemId || latest.selectedSubtitleId !== subtitleId) return
    patchStore({ selectedSubtitleId: null })
    emitStore()
    showSkippedToast("字幕載入失敗")
  }
}

export async function restoreControllerSettings(): Promise<void> {
  const ctrl: VideoPlaybackController = getPlayerController()
  const store = readDraftStore()
  const settings: PlayerSettings = store.settings
  ctrl.playbackRate = store.isBoosting2x ? 2 : store.playbackRate || 1
  ctrl.danmakuOpacity = settings.danmakuOpacity
  ctrl.setDanmakuStyle({
    speed: settings.danmakuSpeed,
    area: settings.danmakuArea,
    blockedWords: settings.danmakuBlockedWords,
  })

  const subtitleId: string | null = store.selectedSubtitleId
  if (subtitleId !== null) {
    const sub: SubtitleTrackInfo | undefined = store.manifest?.subtitles.find(
      (entry: SubtitleTrackInfo): boolean => entry.id === subtitleId,
    )
    if (!sub) {
      patchStore({ selectedSubtitleId: null })
    } else {
      try {
        await ctrl.loadSubtitles(await fetchSubtitleVtt(sub), "vtt")
      } catch {
        patchStore({ selectedSubtitleId: null })
        showSkippedToast("字幕載入失敗")
      }
    }
  }

  applyOverlayVisibility(readDraftStore().presentationMode !== "mini")
  emitStore()
}

export function toggleDanmaku(): void {
  const ctrl: VideoPlaybackController = getPlayerController()
  const next: boolean = !readDraftStore().danmakuEnabled
  const nextSettings: PlayerSettings = updateSettings({ danmakuEnabled: next })
  ctrl.danmakuEnabled = next
  patchStore({
    danmakuEnabled: next,
    settings: nextSettings,
  })
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
  patchStore({
    danmakuEnabled: nextSettings.danmakuEnabled,
    settings: nextSettings,
  })
  emitStore()
}
