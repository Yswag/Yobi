import {
  Button,
  HStack,
  Image,
  LazyVStack,
  Menu,
  ProgressView,
  ScrollView,
  Text,
  VStack,
  useEffect,
  useObservable,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { Provider, UnifiedVideoItem } from "../types"
import { VideoCard, VideoCardSkeleton } from "../components/VideoCard"
import {
  addSearchHistory,
  clearSearchHistory,
  detectInputLink,
  getSavedPosition,
  getSearchHistory,
  getSearchSuggestions,
  getVideoDetail,
  resolveBiliShortUrl,
  searchVideos,
  subscribeStorageChanges,
} from "../services"
import type { FeedFilter } from "../services"
import { providerFullName } from "../utils/format"
import { openVideo } from "../state/playerStore"
import {
  ChipBar,
  EmptyState,
  LayoutToggle,
  PROVIDER_FILTERS,
  ProviderTag,
  SectionHeader,
} from "../ui/primitives"
import { palette, radius, space, type } from "../ui/theme"

export interface SearchViewProps {
  initialQuery?: string
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
}

type SortBy = "default" | "views" | "recent"
type ResultLayout = "row" | "grid"

const SORT_OPTIONS: { label: string; value: SortBy; icon: string }[] = [
  { label: "綜合", value: "default", icon: "sparkles" },
  { label: "觀看數最多", value: "views", icon: "eye" },
  { label: "最新發布", value: "recent", icon: "clock" },
]

interface DirectLinkTarget {
  provider: Provider
  rawId: string
  label: string
}

let searchSeq: number = 0

function detectDirectLink(input: string): DirectLinkTarget | null {
  const trimmed: string = input.trim()
  if (!trimmed) return null

  if (/b23\.tv\/[0-9A-Za-z]+/i.test(trimmed)) {
    return { provider: "bili", rawId: trimmed, label: "BiliBili 短連結" }
  }

  const detected: { provider: Provider; rawId: string } | null = detectInputLink(trimmed)
  if (!detected) return null
  return {
    provider: detected.provider,
    rawId: detected.rawId,
    label: `${providerFullName(detected.provider)} · ${detected.rawId}`,
  }
}

function sortResults(items: UnifiedVideoItem[], sortBy: SortBy): UnifiedVideoItem[] {
  if (sortBy === "default") return items
  const list: UnifiedVideoItem[] = items.slice()
  if (sortBy === "views") {
    list.sort((a: UnifiedVideoItem, b: UnifiedVideoItem): number => (b.viewCount ?? 0) - (a.viewCount ?? 0))
  } else {
    list.sort((a: UnifiedVideoItem, b: UnifiedVideoItem): number => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
  }
  return list
}

function QueryRow(props: { icon: string; text: string; onTap: () => void }): VirtualNode {
  return (
    <HStack
      spacing={14}
      padding={{ horizontal: space.page, vertical: 12 }}
      frame={{ maxWidth: "infinity" }}
      contentShape="rect"
      onTapGesture={props.onTap}
    >
      <Image systemName={props.icon} font={15} foregroundStyle="tertiaryLabel" frame={{ width: 20 }} />
      <Text font={16} foregroundStyle="label" lineLimit={1} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        {props.text}
      </Text>
      <Image systemName="arrow.up.left" font={13} foregroundStyle="tertiaryLabel" />
    </HStack>
  )
}

function SortMenu(props: { value: SortBy; onChange: (value: SortBy) => void }): VirtualNode {
  return (
    <Menu
      label={
        <HStack spacing={0} frame={{ width: 34, height: 34 }} contentShape="rect">
          <Image
            systemName="arrow.up.arrow.down"
            font={15}
            fontWeight="semibold"
            foregroundStyle={props.value === "default" ? "secondaryLabel" : palette.brand}
          />
        </HStack>
      }
    >
      {SORT_OPTIONS.map(option => (
        <Button
          key={`sort-${option.value}`}
          title={option.label}
          systemImage={props.value === option.value ? "checkmark" : option.icon}
          action={() => props.onChange(option.value)}
        />
      ))}
    </Menu>
  )
}

export function SearchView(props: SearchViewProps): VirtualNode {
  const [query, setQuery] = useState<string>(props.initialQuery ?? "")
  const [submittedQuery, setSubmittedQuery] = useState<string>("")
  const [hasSearched, setHasSearched] = useState<boolean>(false)
  const [results, setResults] = useState<UnifiedVideoItem[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [filter, setFilter] = useState<FeedFilter>("all")
  const [sortBy, setSortBy] = useState<SortBy>("default")
  const [layout, setLayout] = useState<ResultLayout>("row")
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [history, setHistory] = useState<string[]>(getSearchHistory())
  const [linkLoading, setLinkLoading] = useState<boolean>(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const searchPresented = useObservable<boolean>(false)

  const loadResults = async (keyword: string, nextFilter: FeedFilter): Promise<void> => {
    const seq: number = ++searchSeq
    setLoading(true)
    setResults([])
    try {
      const found: UnifiedVideoItem[] = await searchVideos(keyword, nextFilter)
      if (seq !== searchSeq) return
      setResults(found)
    } catch {
      if (seq !== searchSeq) return
      setResults([])
    } finally {
      if (seq === searchSeq) setLoading(false)
    }
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
    setResults([])
    setSuggestions([])
    setLoading(false)
    setLinkError(null)
    searchSeq++
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
      let rawId: string = target.rawId
      if (/b23\.tv/i.test(rawId)) {
        const ids: { bvid?: string; aid?: number } | null = await resolveBiliShortUrl(rawId)
        if (!ids) throw new Error("無法展開短連結")
        rawId = ids.bvid ? ids.bvid : `av${ids.aid}`
      }
      const detail: UnifiedVideoItem = await getVideoDetail(target.provider, rawId)
      addSearchHistory(detail.rawId)
      void openVideo(detail, { queue: [detail] })
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

  const directCard: VirtualNode | null = directLink
    ? (
      <HStack
        spacing={12}
        padding={14}
        frame={{ maxWidth: "infinity" }}
        background={{ style: "secondarySystemFill", shape: { type: "rect", cornerRadius: radius.lg, style: "continuous" } }}
      >
        <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <ProviderTag provider={directLink.provider} />
          <Text font={type.cardTitle} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>
            {directLink.label}
          </Text>
          <Text font={type.meta} foregroundStyle={linkError ? palette.danger : "secondaryLabel"} lineLimit={1}>
            {linkError ?? "直接解析播放"}
          </Text>
        </VStack>
        {linkLoading ? (
          <ProgressView controlSize="small" frame={{ width: 44, height: 44 }} />
        ) : (
          <Button action={() => void handleDirectPlay(directLink)} buttonStyle="plain">
            <VStack
              frame={{ width: 44, height: 44 }}
              background={{ style: palette.brand, shape: { type: "rect", cornerRadius: 22 } }}
            >
              <Image systemName="play.fill" font={17} foregroundStyle="white" />
            </VStack>
          </Button>
        )}
      </HStack>
    )
    : null

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
          {sortedResults.map((item: UnifiedVideoItem): VirtualNode => (
            <VideoCard
              key={item.id}
              item={item}
              layout={layout}
              progressSeconds={getSavedPosition(item.id, item.cid)}
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
        {directCard ? (
          <VStack padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity" }}>
            {directCard}
          </VStack>
        ) : null}
        {content}
      </VStack>
    </ScrollView>
  )
}
