import {
  HStack,
  LazyVStack,
  ScrollView,
  VStack,
  useEffect,
  useObservable,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { LayoutMode, OpenChannel, UnifiedVideoItem, VideoPage } from "../types/index"
import { VideoCard, VideoCardSkeleton } from "../components/VideoCard"
import { LoadMoreFooter } from "../components/paging/LoadMoreFooter"
import { usePagedVideos, type PagedVideos, type VideoPageLoader } from "../components/paging/usePagedVideos"
import {
  DirectLinkCard,
  QueryRow,
  SortMenu,
  sortResults,
  type SearchSortBy,
} from "../components/search/SearchParts"
import {
  addSearchHistory,
  clearSearchHistory,
  getSavedPosition,
  getSearchHistory,
  getSearchSuggestions,
  searchVideos,
  subscribeStorageChanges,
} from "../services/index"
import type { FeedFilter } from "../services/index"
import { detectDirectLink, openDirectLinkTarget } from "../actions/index"
import type { DirectLinkTarget } from "../actions/index"
import { openVideo } from "../state/playerStore"
import {
  ChipBar,
  EmptyState,
  LayoutToggle,
  PROVIDER_FILTERS,
  SectionHeader,
} from "../ui/primitives"
import { space } from "../ui/theme"

export interface SearchViewProps {
  initialQuery?: string
  onOpenChannel?: OpenChannel
}

export function SearchView(props: SearchViewProps): VirtualNode {
  const [query, setQuery] = useState<string>(props.initialQuery ?? "")
  const [submittedQuery, setSubmittedQuery] = useState<string>("")
  const [hasSearched, setHasSearched] = useState<boolean>(false)
  const paged: PagedVideos = usePagedVideos()
  const results: UnifiedVideoItem[] = paged.items
  const loading: boolean = paged.loading
  const [filter, setFilter] = useState<FeedFilter>("all")
  const [sortBy, setSortBy] = useState<SearchSortBy>("default")
  const [layout, setLayout] = useState<LayoutMode>("row")
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [history, setHistory] = useState<string[]>(getSearchHistory())
  const [linkLoading, setLinkLoading] = useState<boolean>(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const searchPresented = useObservable<boolean>(false)

  const loadResults = (keyword: string, nextFilter: FeedFilter): Promise<void> => {
    const loader: VideoPageLoader = (cursor?: string): Promise<VideoPage> => searchVideos(keyword, nextFilter, cursor)
    return paged.reload(loader, { clear: true })
  }

  const runSearch = (rawQuery: string): void => {
    const trimmed: string = rawQuery.trim()
    if (!trimmed) return
    Keyboard.hide()
    setQuery(trimmed)
    setSubmittedQuery(trimmed)
    setHasSearched(true)
    setSuggestions([])
    addSearchHistory(trimmed)
    void loadResults(trimmed, filter)
  }

  const resetSearch = (): void => {
    setSubmittedQuery("")
    setHasSearched(false)
    paged.reset()
    setSuggestions([])
    setLinkError(null)
  }

  const handleQueryChange = (value: string): void => {
    setQuery(value)
    setLinkError(null)
    if (!value.trim() || hasSearched) resetSearch()
  }

  const handleFilterChange = (next: FeedFilter): void => {
    if (next === filter) return
    setFilter(next)
    if (hasSearched && submittedQuery) {
      void loadResults(submittedQuery, next)
    }
  }

  const handleClearHistory = (): void => {
    clearSearchHistory()
    setHistory([])
  }

  const handleDirectPlay = async (target: DirectLinkTarget): Promise<void> => {
    if (linkLoading) return
    setLinkLoading(true)
    setLinkError(null)
    try {
      await openDirectLinkTarget(target, { recordHistory: true })
    } catch {
      setLinkError("無法解析這個連結")
    } finally {
      setLinkLoading(false)
    }
  }

  useEffect(() => {
    setHistory(getSearchHistory())
    return subscribeStorageChanges(() => {
      setHistory(getSearchHistory())
    }, ["searchHistory"])
  }, [])

  useEffect(() => {
    const initial: string = (props.initialQuery ?? "").trim()
    if (!initial) return
    runSearch(initial)
  }, [props.initialQuery])

  useEffect(() => {
    const trimmed: string = query.trim()
    if (hasSearched || !trimmed) {
      setSuggestions([])
      return
    }
    let cancelled: boolean = false
    const timer: number = setTimeout(() => {
      void (async () => {
        let merged: string[] = []
        try {
          const [ytWords, biliWords] = await Promise.all([
            getSearchSuggestions(trimmed, "yt").catch((): string[] => []),
            getSearchSuggestions(trimmed, "bili").catch((): string[] => []),
          ])
          const seen: Set<string> = new Set()
          for (const word of [...ytWords, ...biliWords]) {
            const keyword: string = word.trim()
            const key: string = keyword.toLowerCase()
            if (!keyword || seen.has(key)) continue
            seen.add(key)
            merged.push(keyword)
            if (merged.length >= 12) break
          }
        } catch {
          merged = []
        }
        if (!cancelled) setSuggestions(merged)
      })()
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, hasSearched])

  const directLink: DirectLinkTarget | null = detectDirectLink(query)
  const sortedResults: UnifiedVideoItem[] = sortResults(results, sortBy)

  let content: VirtualNode
  if (hasSearched) {
    let resultList: VirtualNode
    if (loading) {
      resultList = <VideoCardSkeleton layout={layout} />
    } else if (sortedResults.length === 0) {
      resultList = (
        <EmptyState
          icon="magnifyingglass"
          title="沒有結果"
          message={`找不到符合「${submittedQuery}」的影片`}
        />
      )
    } else {
      resultList = (
        <LazyVStack spacing={layout === "grid" ? space.cardGap : 4} frame={{ maxWidth: "infinity" }}>
          {sortedResults.map((item: UnifiedVideoItem, index: number): VirtualNode => (
            <VideoCard
              key={item.id}
              item={item}
              layout={layout}
              progressSeconds={getSavedPosition(item.id, item.cid)}
              scrollVisibility={index === paged.prefetchIndex ? paged.prefetchObserver : undefined}
              onSelect={(selected: UnifiedVideoItem) => {
                void openVideo(selected, { queue: sortedResults })
              }}
              onOpenChannel={props.onOpenChannel}
            />
          ))}
        </LazyVStack>
      )
    }
    content = (
      <VStack spacing={12} frame={{ maxWidth: "infinity" }}>
        <ChipBar
          options={PROVIDER_FILTERS}
          value={filter}
          onChange={handleFilterChange}
          trailing={
            <HStack spacing={0}>
              <SortMenu value={sortBy} onChange={setSortBy} />
              <LayoutToggle layout={layout} onChange={setLayout} />
            </HStack>
          }
        />
        {resultList}
        {!loading && paged.hasMore ? (
          <LoadMoreFooter loading={paged.loadingMore} hasMore label="載入更多影片" onLoadMore={() => void paged.loadMore()} />
        ) : null}
      </VStack>
    )
  } else if (query.trim().length > 0) {
    content = (
      <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
        {suggestions.map((word: string): VirtualNode => (
          <QueryRow key={`sg-${word}`} icon="magnifyingglass" text={word} onTap={() => runSearch(word)} />
        ))}
      </VStack>
    )
  } else if (history.length > 0) {
    content = (
      <VStack spacing={4} frame={{ maxWidth: "infinity" }}>
        <SectionHeader title="最近搜尋" action={{ label: "清除", onTap: handleClearHistory }} />
        <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
          {history.map((keyword: string): VirtualNode => (
            <QueryRow key={`hs-${keyword}`} icon="clock.arrow.circlepath" text={keyword} onTap={() => runSearch(keyword)} />
          ))}
        </VStack>
      </VStack>
    )
  } else {
    content = (
      <EmptyState
        icon="play.rectangle.on.rectangle"
        title="搜尋 YouTube 與 BiliBili"
        message="關鍵字、影片網址，或 BV／AV 番號"
      />
    )
  }

  return (
    <ScrollView
      axes="vertical"
      scrollIndicator="hidden"
      scrollDismissesKeyboard="immediately"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      onScrollPhaseChange={paged.onScrollPhaseChange}
      navigationTitle="搜尋"
      navigationBarTitleDisplayMode="large"
      searchable={{
        value: query,
        onChanged: handleQueryChange,
        prompt: "影片、頻道、連結或 BV 號",
        presented: searchPresented,
      }}
      onSubmit={{ triggers: "search", action: () => runSearch(query) }}
    >
      <VStack spacing={16} frame={{ maxWidth: "infinity" }} padding={{ top: 8, bottom: 16 }}>
        {directLink ? (
          <VStack padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity" }}>
            <DirectLinkCard
              target={directLink}
              loading={linkLoading}
              error={linkError}
              onPlay={() => void handleDirectPlay(directLink)}
            />
          </VStack>
        ) : null}
        {content}
      </VStack>
    </ScrollView>
  )
}
