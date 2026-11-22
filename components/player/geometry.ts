import type { PlayerPresentationMode } from "../../state/playerStore"

export const MINI_HEIGHT: number = 56
export const MINI_MARGIN: number = 21
export const MINI_RADIUS: number = MINI_HEIGHT / 2
export const MINI_VIDEO_INSET_V: number = 8
export const MINI_VIDEO_INSET_LEADING: number = 10
export const MINI_VIDEO_RADIUS: number = 10
export const TAB_BAR_CLEARANCE: number = 44 + 8
export const MINI_PLAYER_RESERVED_HEIGHT: number = MINI_HEIGHT + 8

export interface Insets {
  top: number
  bottom: number
}

export const FALLBACK_INSETS: Insets = { top: 59, bottom: 34 }

export interface CardGeometry {
  width: number
  height: number
  x: number
  y: number
  rowHeight: number
  videoWidth: number
  videoHeight: number
  videoInset: number
  videoRadius: number
  topInset: number
  radius: number
}

export interface FullscreenGesture {
  direction: "enter" | "exit"
  distance: number
}

export interface PlayerLayoutInput {
  mode: PlayerPresentationMode
  fullscreen: boolean
  restingMini: boolean
  screenWidth: number
  screenHeight: number
  insets: Insets
  dragTranslation: number | null
  fullscreenGesture: FullscreenGesture | null
}

export interface PlayerLayout {
  expanded: CardGeometry
  mini: CardGeometry
  settled: CardGeometry
  geometry: CardGeometry
  isExpanded: boolean
  isMini: boolean
  watchHeight: number
  miniBarWidth: number
  dragTravel: number
  drag: number | null
  morph: number
  enterZooming: boolean
  exitShifting: boolean
  enterProgress: number
  exitProgress: number
  watchOpacity: number
  watchZoomOpacity: number
  controlsOpacity: number
  surfaceOpacity: number
  miniBarOpacity: number
  videoScale: number
  videoCornerRadius: number
  videoOffsetY: number
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export function mix(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

export function blendGeometry(from: CardGeometry, to: CardGeometry, t: number): CardGeometry {
  return {
    width: mix(from.width, to.width, t),
    height: mix(from.height, to.height, t),
    x: mix(from.x, to.x, t),
    y: mix(from.y, to.y, t),
    rowHeight: mix(from.rowHeight, to.rowHeight, t),
    videoWidth: mix(from.videoWidth, to.videoWidth, t),
    videoHeight: mix(from.videoHeight, to.videoHeight, t),
    videoInset: mix(from.videoInset, to.videoInset, t),
    videoRadius: mix(from.videoRadius, to.videoRadius, t),
    topInset: mix(from.topInset, to.topInset, t),
    radius: mix(from.radius, to.radius, t),
  }
}

export function computePlayerLayout(input: PlayerLayoutInput): PlayerLayout {
  const mode: PlayerPresentationMode = input.mode
  const fullscreen: boolean = input.fullscreen
  const screenWidth: number = input.screenWidth
  const screenHeight: number = input.screenHeight
  const insets: Insets = input.insets
  const fullscreenGesture: FullscreenGesture | null = input.fullscreenGesture

  const expanded: CardGeometry = {
    width: screenWidth,
    height: screenHeight,
    x: 0,
    y: 0,
    rowHeight: fullscreen ? screenHeight : Math.round(screenWidth * 9 / 16),
    videoWidth: screenWidth,
    videoHeight: fullscreen ? screenHeight : Math.round(screenWidth * 9 / 16),
    videoInset: 0,
    videoRadius: 0,
    topInset: fullscreen ? 0 : insets.top,
    radius: 0,
  }
  const miniY: number = screenHeight - insets.bottom - TAB_BAR_CLEARANCE - MINI_HEIGHT
  const miniVideoHeight: number = MINI_HEIGHT - MINI_VIDEO_INSET_V * 2
  const mini: CardGeometry = {
    width: screenWidth - MINI_MARGIN * 2,
    height: MINI_HEIGHT,
    x: MINI_MARGIN,
    y: miniY,
    rowHeight: MINI_HEIGHT,
    videoWidth: Math.round(miniVideoHeight * 16 / 9),
    videoHeight: miniVideoHeight,
    videoInset: MINI_VIDEO_INSET_LEADING,
    videoRadius: MINI_VIDEO_RADIUS,
    topInset: 0,
    radius: MINI_RADIUS,
  }
  const settled: CardGeometry = mode === "mini"
    ? mini
    : mode === "expanded"
      ? expanded
      : input.restingMini
        ? { ...mini, y: screenHeight }
        : { ...expanded, y: screenHeight }

  const isExpanded: boolean = mode === "expanded"
  const isMini: boolean = mode === "mini"
  const watchHeight: number = Math.max(0, expanded.height - expanded.topInset - expanded.rowHeight)
  const miniBarWidth: number = mini.width - mini.videoWidth - mini.videoInset
  const dragTravel: number = Math.max(1, mini.y - expanded.y)
  const drag: number | null = isExpanded && !fullscreen && input.dragTranslation !== null
    ? clamp01(input.dragTranslation / dragTravel)
    : null
  const geometry: CardGeometry = drag === null ? settled : blendGeometry(expanded, mini, drag)
  const morph: number = drag !== null ? drag : isMini ? 1 : 0
  const enterZooming: boolean = isExpanded && !fullscreen && fullscreenGesture?.direction === "enter"
  const exitShifting: boolean = fullscreen && fullscreenGesture?.direction === "exit"
  const enterProgress: number = enterZooming && fullscreenGesture ? clamp01(fullscreenGesture.distance / 120) : 0
  const exitProgress: number = exitShifting && fullscreenGesture ? clamp01(fullscreenGesture.distance / 120) : 0
  const watchOpacity: number = isExpanded ? clamp01(1 - morph / 0.3) : 0
  const watchZoomOpacity: number = 1 - enterProgress * 0.55
  const controlsOpacity: number = (1 - clamp01(morph / 0.3)) * (1 - clamp01(exitProgress / 0.35))
  const surfaceOpacity: number = 1 - clamp01((morph - 0.35) / 0.65)
  const miniBarOpacity: number = clamp01((morph - 0.5) / 0.5)
  const videoScale: number = enterZooming && fullscreenGesture
    ? 1 + (fullscreenGesture.distance / (fullscreenGesture.distance + 120)) * 0.14
    : exitShifting
      ? 1 - exitProgress * 0.06
      : 1
  const videoCornerRadius: number = exitShifting ? exitProgress * 16 : geometry.videoRadius
  const videoOffsetY: number = exitShifting && fullscreenGesture
    ? Math.min(
        140,
        fullscreenGesture.distance <= 60
          ? fullscreenGesture.distance * 0.85
          : 51 + (fullscreenGesture.distance - 60) * 0.45,
      )
    : 0

  return {
    expanded,
    mini,
    settled,
    geometry,
    isExpanded,
    isMini,
    watchHeight,
    miniBarWidth,
    dragTravel,
    drag,
    morph,
    enterZooming,
    exitShifting,
    enterProgress,
    exitProgress,
    watchOpacity,
    watchZoomOpacity,
    controlsOpacity,
    surfaceOpacity,
    miniBarOpacity,
    videoScale,
    videoCornerRadius,
    videoOffsetY,
  }
}
