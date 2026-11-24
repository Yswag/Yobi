import type { LiveWindow } from "./types"

const MIN_LIVE_WINDOW_S: number = 30
const LIVE_EDGE_TOLERANCE_S: number = 12

export function readLiveWindow(ctrl: VideoPlaybackController): LiveWindow | null {
  const ranges: readonly VideoPlaybackSeekableRange[] | null = ctrl.liveSeekableRanges
  if (!ranges || ranges.length === 0) return null
  let latest: VideoPlaybackSeekableRange | null = null
  for (const range of ranges) {
    if (!Number.isFinite(range.startTime) || !Number.isFinite(range.endTime)) continue
    if (latest === null || range.endTime > latest.endTime) latest = range
  }
  if (latest === null || latest.endTime - latest.startTime < MIN_LIVE_WINDOW_S) return null
  return { start: latest.startTime, end: latest.endTime }
}

export function clampToLiveWindow(window: LiveWindow, seconds: number): number {
  return Math.min(window.end, Math.max(window.start, seconds))
}

export function isAtLiveEdge(window: LiveWindow, position: number): boolean {
  return window.end - position <= LIVE_EDGE_TOLERANCE_S
}

export function sameLiveWindow(a: LiveWindow | null, b: LiveWindow | null): boolean {
  if (a === null || b === null) return a === b
  return Math.floor(a.start) === Math.floor(b.start) && Math.floor(a.end) === Math.floor(b.end)
}
