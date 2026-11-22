import { useEffect, useState } from "scripting"
import type { UnifiedVideoItem } from "../../types"
import { getYoutubeLiveViewers } from "../../services/index"
import { reportError } from "../../services/errors"
import type { LiveViewerSnapshot } from "./types"
import { readDraftStore } from "./store"

const LIVE_VIEWER_TICK_MS: number = 60_000

let liveViewerTimer: number | null = null
let liveViewerState: LiveViewerSnapshot = { videoId: "", count: null }
const liveViewerListeners: Set<() => void> = new Set()

export function stopLiveViewerRefresh(): void {
  if (liveViewerTimer !== null) {
    clearInterval(liveViewerTimer)
    liveViewerTimer = null
  }
}

export function publishLiveViewers(videoId: string, count: number | null): void {
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

export function startLiveViewerRefresh(item: UnifiedVideoItem): void {
  stopLiveViewerRefresh()
  publishLiveViewers(item.id, item.viewCount && item.viewCount > 0 ? item.viewCount : null)
  liveViewerTimer = setInterval((): void => {
    void getYoutubeLiveViewers(item.rawId).then((viewers: number | undefined): void => {
      if (viewers === undefined || readDraftStore().currentItem?.id !== item.id) return
      publishLiveViewers(item.id, viewers)
    })
  }, LIVE_VIEWER_TICK_MS)
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
