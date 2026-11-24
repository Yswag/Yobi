import { useMemo, useRef } from "scripting"
import type { ScrollVisibilityChangeOptions } from "scripting"

export function usePrefetchTrigger(onLoadMore: () => void): ScrollVisibilityChangeOptions {
  const onLoadMoreRef = useRef<() => void>(onLoadMore)
  onLoadMoreRef.current = onLoadMore

  return useMemo(
    () => ({
      threshold: 0.01,
      onChanged: (visible: boolean): void => {
        if (visible) onLoadMoreRef.current()
      },
    }),
    [],
  )
}
