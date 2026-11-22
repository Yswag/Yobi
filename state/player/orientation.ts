import type { StreamManifest, VideoQualityTrack } from "../../types/index"
import { reportError } from "../../services/errors"
import { emitStore, patchStore, readDraftStore } from "./store"

let savedOrientations: typeof Device.supportedInterfaceOrientations | null = null
let waitForLandscapeBeforeAutoExit: boolean = false
let waitForPortraitBeforeAutoEnter: boolean = false
let lastPhysicalOrientation: "portrait" | "landscape" | null = null

function isCurrentVideoPortrait(): boolean {
  const store = readDraftStore()
  const manifest: StreamManifest | null = store.manifest
  if (!manifest) return false
  const selected: VideoQualityTrack | undefined = manifest.qualities.find(
    (track: VideoQualityTrack): boolean => track.id === store.selectedQualityId,
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

export function syncFullscreenOrientation(): void {
  const store = readDraftStore()
  const portrait: boolean = store.isFullscreen && isCurrentVideoPortrait()
  applyFullscreenOrientation(store.isFullscreen, portrait)
  patchStore({ isPortraitFullscreen: portrait })
}

export function setFullscreen(fullscreen: boolean): void {
  const store = readDraftStore()
  if (store.isFullscreen === fullscreen) return
  const portrait: boolean = fullscreen && isCurrentVideoPortrait()
  if (fullscreen && !portrait) {
    waitForLandscapeBeforeAutoExit = lastPhysicalOrientation !== "landscape"
    waitForPortraitBeforeAutoEnter = false
  } else if (!fullscreen) {
    waitForLandscapeBeforeAutoExit = false
    waitForPortraitBeforeAutoEnter = lastPhysicalOrientation === "landscape"
  }
  applyFullscreenOrientation(fullscreen, portrait)
  patchStore({
    isFullscreen: fullscreen,
    isPortraitFullscreen: portrait,
  })
  emitStore()
}

export function toggleFullscreen(): void {
  setFullscreen(!readDraftStore().isFullscreen)
}

export function startOrientationAutoFullscreen(): () => void {
  const onOrientation = (orientation: Device.Orientation): void => {
    const isLandscape: boolean = orientation === "landscapeLeft" || orientation === "landscapeRight"
    const isPortrait: boolean = orientation === "portrait"
    if (!isLandscape && !isPortrait) return
    lastPhysicalOrientation = isLandscape ? "landscape" : "portrait"

    const store = readDraftStore()
    if (store.presentationMode !== "expanded" || !store.currentItem) {
      waitForLandscapeBeforeAutoExit = false
      waitForPortraitBeforeAutoEnter = false
      return
    }
    if (isCurrentVideoPortrait()) return

    if (isLandscape) {
      waitForLandscapeBeforeAutoExit = false
      if (!store.isFullscreen && !waitForPortraitBeforeAutoEnter) {
        setFullscreen(true)
      }
      return
    }

    waitForPortraitBeforeAutoEnter = false
    if (store.isFullscreen && !store.isPortraitFullscreen && !waitForLandscapeBeforeAutoExit) {
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
