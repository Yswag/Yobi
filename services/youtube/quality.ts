import type { VideoQualityTrack } from "../../types/index"
import { effectiveResolution } from "../../utils/format"

export function closestQuality(qualities: VideoQualityTrack[], preferredHeight: number): VideoQualityTrack | undefined {
  let best: VideoQualityTrack | undefined
  let bestDelta: number = Number.MAX_SAFE_INTEGER
  for (const quality of qualities) {
    const resolution: number = effectiveResolution(quality.width, quality.height)
    if (quality.delivery === "sabr" && resolution === 0) continue
    const delta: number = Math.abs((resolution || preferredHeight) - preferredHeight)
    if (delta < bestDelta) {
      bestDelta = delta
      best = quality
    }
  }
  return best
}
