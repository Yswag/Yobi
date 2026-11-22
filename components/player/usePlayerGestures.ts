import { useCallback, useRef, useState } from "scripting"
import { minimizeToMiniPlayer, setFullscreen } from "../../state/playerStore"
import type { FullscreenGesture } from "./geometry"

const MINIMIZE_DRAG_RATIO: number = 0.45
const ENTER_FULLSCREEN_MIN_DY: number = 48
const ENTER_FULLSCREEN_PREDICTED_DY: number = 90
const ENTER_FULLSCREEN_FLICK_DY: number = 24
const EXIT_FULLSCREEN_MIN_DY: number = 56
const EXIT_FULLSCREEN_PREDICTED_DY: number = 110
const EXIT_FULLSCREEN_FLICK_DY: number = 28

export interface PlayerGestureController {
  dragTranslation: number | null
  fullscreenGesture: FullscreenGesture | null
  dragTravelRef: { current: number }
  handleMinimizeDragChanged: (dy: number, dx: number) => void
  handleMinimizeDragEnded: (dy: number, dx: number, predictedDy: number) => void
  handleFullscreenDragChanged: (direction: "enter" | "exit", translationY: number) => void
  handleFullscreenDragEnded: (direction: "enter" | "exit", translationY: number, predictedY: number) => void
  handleCancelFullscreenDrag: () => void
}

export function usePlayerGestures(): PlayerGestureController {
  const [dragTranslation, setDragTranslation] = useState<number | null>(null)
  const [fullscreenGesture, setFullscreenGesture] = useState<FullscreenGesture | null>(null)
  const dragTravelRef = useRef<number>(1)
  const thresholdCrossedRef = useRef<boolean>(false)

  const handleMinimizeDragChanged = useCallback((dy: number, dx: number): void => {
    setDragTranslation(dy > 0 && dy > Math.abs(dx) ? dy : 0)
  }, [])
  const handleMinimizeDragEnded = useCallback((dy: number, dx: number, predictedDy: number): void => {
    const travel: number = dragTravelRef.current
    const projected: number = Math.max(dy, Math.min(predictedDy, dy + travel * 0.25))
    if (projected > travel * MINIMIZE_DRAG_RATIO && dy > Math.abs(dx)) minimizeToMiniPlayer()
    setDragTranslation(null)
  }, [])
  const handleFullscreenDragChanged = useCallback((direction: "enter" | "exit", translationY: number): void => {
    const distance: number = Math.max(0, direction === "enter" ? -translationY : translationY)
    const threshold: number = direction === "enter" ? ENTER_FULLSCREEN_MIN_DY : EXIT_FULLSCREEN_MIN_DY
    const crossed: boolean = distance >= threshold
    if (crossed !== thresholdCrossedRef.current) {
      thresholdCrossedRef.current = crossed
      if (crossed) HapticFeedback.lightImpact()
    }
    setFullscreenGesture({ direction, distance })
  }, [])
  const handleFullscreenDragEnded = useCallback(
    (direction: "enter" | "exit", translationY: number, predictedY: number): void => {
      thresholdCrossedRef.current = false
      if (direction === "enter") {
        const dy: number = -translationY
        const pred: number = -predictedY
        if (dy >= ENTER_FULLSCREEN_MIN_DY || (pred >= ENTER_FULLSCREEN_PREDICTED_DY && dy >= ENTER_FULLSCREEN_FLICK_DY)) {
          setFullscreen(true)
        }
      } else {
        const dy: number = translationY
        const pred: number = predictedY
        if (dy >= EXIT_FULLSCREEN_MIN_DY || (pred >= EXIT_FULLSCREEN_PREDICTED_DY && dy >= EXIT_FULLSCREEN_FLICK_DY)) {
          setFullscreen(false)
        }
      }
      setFullscreenGesture(null)
    },
    [],
  )
  const handleCancelFullscreenDrag = useCallback((): void => {
    thresholdCrossedRef.current = false
    setFullscreenGesture(null)
  }, [])

  return {
    dragTranslation,
    fullscreenGesture,
    dragTravelRef,
    handleMinimizeDragChanged,
    handleMinimizeDragEnded,
    handleFullscreenDragChanged,
    handleFullscreenDragEnded,
    handleCancelFullscreenDrag,
  }
}
