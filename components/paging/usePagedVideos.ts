import { useRef, useState } from "scripting"
import type { ScrollPhase, ScrollPhaseChangeContext, ScrollVisibilityChangeOptions } from "scripting"
import type { UnifiedVideoItem, VideoPage } from "../../types/index"
import { appendUnique, prefetchIndexFor } from "../../utils/paging"
import { usePrefetchTrigger } from "./usePrefetchTrigger"

export type VideoPageLoader = (cursor?: string) => Promise<VideoPage>

export type ScrollPhaseHandler = (old: ScrollPhase, next: ScrollPhase, context: ScrollPhaseChangeContext) => void

export interface PagedVideos {
  items: UnifiedVideoItem[]
  loading: boolean
  loadingMore: boolean
  failed: boolean
  hasMore: boolean
  prefetchIndex: number
  prefetchObserver: ScrollVisibilityChangeOptions
  onScrollPhaseChange: ScrollPhaseHandler
  reload: (loader: VideoPageLoader, options?: { clear?: boolean }) => Promise<void>
  loadMore: () => Promise<void>
  reset: () => void
}

const PREFETCH_LEAD_COUNT: number = 5
const MAX_EMPTY_PAGES: number = 3
const LOAD_MORE_DISTANCE: number = 600
const DECEL_LOOKAHEAD_S: number = 0.4
const MAX_LOOKAHEAD_PX: number = 900

export function usePagedVideos(options: { initialLoading?: boolean } = {}): PagedVideos {
  const [items, setItems] = useState<UnifiedVideoItem[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState<boolean>(options.initialLoading === true)
  const [loadingMore, setLoadingMore] = useState<boolean>(false)
  const [failed, setFailed] = useState<boolean>(false)
  const seqRef = useRef<number>(0)
  const loaderRef = useRef<VideoPageLoader | null>(null)
  const itemsRef = useRef<UnifiedVideoItem[]>([])
  const cursorRef = useRef<string | undefined>(undefined)
  const loadingMoreRef = useRef<boolean>(false)
  const loadingRef = useRef<boolean>(options.initialLoading === true)

  const commit = (nextItems: UnifiedVideoItem[], nextCursor: string | undefined): void => {
    itemsRef.current = nextItems
    cursorRef.current = nextCursor
    setItems(nextItems)
    setCursor(nextCursor)
  }

  const reset = (): void => {
    seqRef.current++
    loaderRef.current = null
    loadingMoreRef.current = false
    loadingRef.current = false
    commit([], undefined)
    setLoading(false)
    setLoadingMore(false)
    setFailed(false)
  }

  const reload = async (loader: VideoPageLoader, reloadOptions: { clear?: boolean } = {}): Promise<void> => {
    const seq: number = ++seqRef.current
    loaderRef.current = loader
    loadingMoreRef.current = false
    loadingRef.current = true
    if (reloadOptions.clear) commit([], undefined)
    setLoadingMore(false)
    setLoading(true)
    setFailed(false)
    try {
      const page: VideoPage = await loader()
      if (seq !== seqRef.current) return
      commit(appendUnique([], page.videos), page.nextPageToken)
    } catch {
      if (seq !== seqRef.current) return
      commit([], undefined)
      setFailed(true)
    }
    if (seq === seqRef.current) {
      loadingRef.current = false
      setLoading(false)
    }
  }

  const loadMore = async (): Promise<void> => {
    const loader: VideoPageLoader | null = loaderRef.current
    if (!loader || loadingRef.current || loadingMoreRef.current || !cursorRef.current) return
    const seq: number = seqRef.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      for (let attempt = 0; attempt < MAX_EMPTY_PAGES && cursorRef.current; attempt++) {
        const page: VideoPage = await loader(cursorRef.current)
        if (seq !== seqRef.current) return
        const merged: UnifiedVideoItem[] = appendUnique(itemsRef.current, page.videos)
        const grew: boolean = merged.length > itemsRef.current.length
        commit(merged, page.nextPageToken)
        if (grew) break
      }
    } catch {
    } finally {
      if (seq === seqRef.current) {
        loadingMoreRef.current = false
        setLoadingMore(false)
      }
    }
  }

  const prefetchObserver: ScrollVisibilityChangeOptions = usePrefetchTrigger((): void => {
    void loadMore()
  })

  const onScrollPhaseChange: ScrollPhaseHandler = (
    _old: ScrollPhase,
    next: ScrollPhase,
    context: ScrollPhaseChangeContext,
  ): void => {
    const phase: string = String(next)
    if (phase !== "idle" && phase !== "decelerating") return
    if (!cursorRef.current || loadingRef.current || loadingMoreRef.current) return
    const velocityY: number = phase === "decelerating" && context.velocity ? Math.max(0, context.velocity.dy) : 0
    const lookahead: number = Math.min(velocityY * DECEL_LOOKAHEAD_S, MAX_LOOKAHEAD_PX)
    const geometry = context.geometry
    const remaining: number = geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height
    if (remaining - lookahead > LOAD_MORE_DISTANCE) return
    void loadMore()
  }

  const hasMore: boolean = !!cursor && items.length > 0

  return {
    items,
    loading,
    loadingMore,
    failed,
    hasMore,
    prefetchIndex: prefetchIndexFor(items.length, hasMore, PREFETCH_LEAD_COUNT),
    prefetchObserver,
    onScrollPhaseChange,
    reload,
    loadMore,
    reset,
  }
}
