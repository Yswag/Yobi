import {
  Button,
  HStack,
  Image,
  LazyVGrid,
  ProgressView,
  ScrollView,
  Spacer,
  Text,
  TextField,
  VStack,
  useEffect,
  useState,
} from "scripting"
import type { Color, VirtualNode } from "scripting"
import type { Provider, UnifiedVideoItem } from "../types"
import { VideoCard } from "../components/VideoCard"
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
import { providerFullName, providerSoftBgColor } from "../utils/format"
import { openVideo } from "../state/playerStore"

export interface SearchViewProps {
  initialQuery?: string
  onOpenChannel?: (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void
}

type SortBy = "default" | "views" | "recent"
type ResultLayout = "row" | "grid"

const SEARCH_ACCENT: Color = "rgba(10,132,255,1)"
const YT_ACCENT: Color = "rgba(255,46,77,1)"
const BILI_ACCENT: Color = "rgba(251,114,153,1)"

const FILTER_OPTIONS: { label: string; value: FeedFilter; activeColor: Color }[] = [
  { label: "雙平台交錯", value: "all", activeColor: SEARCH_ACCENT },
  { label: "YouTube", value: "yt", activeColor: YT_ACCENT },
  { label: "BiliBili", value: "bili", activeColor: BILI_ACCENT },
]

const SORT_OPTIONS: { label: string; value: SortBy }[] = [
  { label: "預設綜合", value: "default" },
  { label: "觀看數最多", value: "views" },
  { label: "最新發布", value: "recent" },
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
    return {
      provider: "bili",
      rawId: trimmed,
      label: "偵測到 BiliBili 短連結",
    }
  }

  const detected: { provider: Provider; rawId: string } | null = detectInputLink(trimmed)
  if (!detected) return null

  const name: string = providerFullName(detected.provider)
  return {
    provider: detected.provider,
    rawId: detected.rawId,
    label: `偵測到 ${name} 影片：${detected.rawId}`,
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

function FilterChip(props: {
  label: string
  active: boolean
  activeColor: Color
  onTap: () => void
}): VirtualNode {
  return (
    <HStack
      spacing={0}
      padding={{ horizontal: 11, vertical: 6 }}
      background={props.active ? props.activeColor : "tertiarySystemFill"}
      clipShape="capsule"
      onTapGesture={props.onTap}
    >
      <Text
        font={12}
        fontWeight={props.active ? "semibold" : "medium"}
        foregroundStyle={props.active ? "white" : "label"}
        lineLimit={1}
      >
        {props.label}
      </Text>
    </HStack>
  )
}

function SortChip(props: { label: string; active: boolean; onTap: () => void }): VirtualNode {
  return (
    <HStack
      spacing={0}
      padding={{ horizontal: 10, vertical: 5 }}
      background={props.active ? "rgba(10,132,255,0.16)" : "tertiarySystemFill"}
      clipShape="capsule"
      onTapGesture={props.onTap}
    >
      <Text
        font={11}
        fontWeight={props.active ? "semibold" : "regular"}
        foregroundStyle={props.active ? SEARCH_ACCENT : "secondaryLabel"}
        lineLimit={1}
      >
        {props.label}
      </Text>
    </HStack>
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
    setQuery(trimmed)
    setSubmittedQuery(trimmed)
    setHasSearched(true)
    setSuggestions([])
    addSearchHistory(trimmed)
    void loadResults(trimmed, filter)
  }

  const handleQueryChange = (value: string): void => {
    setQuery(value)
    setLinkError(null)
    if (hasSearched) {
      setHasSearched(false)
      setSubmittedQuery("")
      setResults([])
      setLoading(false)
      searchSeq++
    }
  }

  const handleClear = (): void => {
    setQuery("")
    setSubmittedQuery("")
    setHasSearched(false)
    setResults([])
    setSuggestions([])
    setLoading(false)
    setLinkError(null)
    searchSeq++
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
      setQuery(detail.rawId)
      void openVideo(detail, { queue: [detail] })
    } catch {
      setLinkError("無法解析這個連結，請確認後再試")
    } finally {
      setLinkLoading(false)
    }
  }

  useEffect(() => {
    setHistory(getSearchHistory())
    return subscribeStorageChanges(() => {
      setHistory(getSearchHistory())
    })
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
  const screenWidth: number = Device.screen.width

  const searchBar: VirtualNode = (
    <HStack spacing={8} padding={{ horizontal: 14, vertical: 8 }}>
      <HStack
        spacing={6}
        padding={{ horizontal: 10, vertical: 8 }}
        background="tertiarySystemFill"
        clipShape={{ type: "rect", cornerRadius: 10 }}
        frame={{ maxWidth: "infinity" }}
      >
        <Image systemName="magnifyingglass" font={14} foregroundStyle="secondaryLabel" />
        <TextField
          title="搜尋 YouTube、BiliBili 或貼上連結 / BV 號"
          value={query}
          onChanged={handleQueryChange}
          prompt="搜尋影片、UP 主或貼上連結..."
          font={14}
          submitLabel="search"
          frame={{ maxWidth: "infinity" }}
        />
        {query.length > 0
          ? (
            <HStack spacing={0} onTapGesture={handleClear}>
              <Image systemName="xmark.circle.fill" font={15} foregroundStyle="tertiaryLabel" />
            </HStack>
          )
          : null}
      </HStack>
      <Button
        title="搜尋"
        action={() => runSearch(query)}
        font={14}
        fontWeight="semibold"
        foregroundStyle="white"
        padding={{ horizontal: 14, vertical: 9 }}
        background={SEARCH_ACCENT}
        clipShape="capsule"
        buttonStyle="borderless"
      />
    </HStack>
  )

  const directBanner: VirtualNode | null = directLink
    ? (
      <HStack
        spacing={10}
        padding={{ horizontal: 12, vertical: 10 }}
        background={providerSoftBgColor(directLink.provider)}
        clipShape={{ type: "rect", cornerRadius: 12 }}
        frame={{ maxWidth: "infinity" }}
      >
        <Image
          systemName="bolt.horizontal.circle.fill"
          font={20}
          foregroundStyle={directLink.provider === "bili" ? BILI_ACCENT : YT_ACCENT}
        />
        <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity" }}>
          <Text font={13} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>
            {directLink.label}
          </Text>
          <Text font={11} foregroundStyle="secondaryLabel" lineLimit={1}>
            {linkError ?? "免搜尋，直接解析播放"}
          </Text>
        </VStack>
        <Button
          title={linkLoading ? "解析中..." : "立即播放"}
          disabled={linkLoading}
          action={() => {
            void handleDirectPlay(directLink)
          }}
          font={12}
          fontWeight="semibold"
          foregroundStyle="white"
          padding={{ horizontal: 12, vertical: 7 }}
          background={directLink.provider === "bili" ? BILI_ACCENT : YT_ACCENT}
          clipShape="capsule"
          buttonStyle="borderless"
        />
      </HStack>
    )
    : null

  const platformRow: VirtualNode = (
    <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
      {FILTER_OPTIONS.map((option: { label: string; value: FeedFilter; activeColor: Color }): VirtualNode => (
        <FilterChip
          key={option.value}
          label={option.label}
          active={filter === option.value}
          activeColor={option.activeColor}
          onTap={() => handleFilterChange(option.value)}
        />
      ))}
      <Spacer />
    </HStack>
  )

  const sortRow: VirtualNode = (
    <HStack spacing={7} padding={{ horizontal: 14, vertical: 4 }}>
      <Text font={11} foregroundStyle="tertiaryLabel">排序</Text>
      {SORT_OPTIONS.map((option: { label: string; value: SortBy }): VirtualNode => (
        <SortChip
          key={option.value}
          label={option.label}
          active={sortBy === option.value}
          onTap={() => setSortBy(option.value)}
        />
      ))}
      <Spacer />
      <HStack
        spacing={0}
        frame={{ width: 30, height: 30 }}
        background="tertiarySystemFill"
        clipShape="circle"
        onTapGesture={() => setLayout(layout === "row" ? "grid" : "row")}
      >
        <Image
          systemName={layout === "row" ? "square.grid.2x2" : "list.bullet"}
          font={14}
          foregroundStyle="secondaryLabel"
        />
      </HStack>
    </HStack>
  )

  let content: VirtualNode
  if (hasSearched) {
    if (loading) {
      content = (
        <VStack spacing={10} frame={{ maxWidth: "infinity" }} padding={{ top: 56 }}>
          <ProgressView />
          <Text font={13} foregroundStyle="secondaryLabel">正在搜尋...</Text>
        </VStack>
      )
    } else if (sortedResults.length === 0) {
      content = (
        <VStack spacing={8} frame={{ maxWidth: "infinity" }} padding={{ top: 56, horizontal: 24 }}>
          <Image systemName="magnifyingglass" font={32} foregroundStyle="tertiaryLabel" />
          <Text font={14} foregroundStyle="secondaryLabel" multilineTextAlignment="center">
            {`找不到符合「${submittedQuery}」的影片`}
          </Text>
        </VStack>
      )
    } else if (layout === "row") {
      content = (
        <ScrollView frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
          <VStack spacing={2}>
            {sortedResults.map((item: UnifiedVideoItem): VirtualNode => (
              <VideoCard
                key={item.id}
                item={item}
                layout="row"
                progressSeconds={getSavedPosition(item.id, item.cid)}
                onSelect={(selected: UnifiedVideoItem) => {
                  void openVideo(selected, { queue: sortedResults })
                }}
                onOpenChannel={props.onOpenChannel}
              />
            ))}
            <Spacer frame={{ height: 96 }} />
          </VStack>
        </ScrollView>
      )
    } else {
      const columnCount: number = screenWidth >= 600 ? 3 : 2
      content = (
        <ScrollView frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
          <VStack spacing={0}>
            <LazyVGrid
              columns={Array.from({ length: columnCount }, (): { size: { type: "flexible" }; spacing: number } => ({
                size: { type: "flexible" },
                spacing: 12,
              }))}
              alignment="leading"
              spacing={12}
              padding={{ horizontal: 12, vertical: 6 }}
            >
              {sortedResults.map((item: UnifiedVideoItem): VirtualNode => (
                <VideoCard
                  key={item.id}
                  item={item}
                  layout="grid"
                  progressSeconds={getSavedPosition(item.id, item.cid)}
                  onSelect={(selected: UnifiedVideoItem) => {
                    void openVideo(selected, { queue: sortedResults })
                  }}
                  onOpenChannel={props.onOpenChannel}
                />
              ))}
            </LazyVGrid>
            <Spacer frame={{ height: 96 }} />
          </VStack>
        </ScrollView>
      )
    }
  } else if (query.trim().length > 0) {
    content = (
      <ScrollView frame={{ maxWidth: "infinity", maxHeight: "infinity" }} scrollDismissesKeyboard="immediately">
        <VStack spacing={0} padding={{ top: 4 }}>
          {suggestions.map((word: string): VirtualNode => (
            <HStack
              key={word}
              spacing={10}
              padding={{ horizontal: 16, vertical: 11 }}
              onTapGesture={() => runSearch(word)}
            >
              <Image systemName="magnifyingglass" font={13} foregroundStyle="secondaryLabel" />
              <Text font={14} foregroundStyle="label" lineLimit={1} frame={{ maxWidth: "infinity" }}>
                {word}
              </Text>
              <Image systemName="arrow.up.left" font={12} foregroundStyle="tertiaryLabel" />
            </HStack>
          ))}
          {suggestions.length === 0
            ? (
              <Text font={12} foregroundStyle="tertiaryLabel" padding={{ horizontal: 16, vertical: 14 }}>
                按「搜尋」查看結果
              </Text>
            )
            : null}
          <Spacer frame={{ height: 96 }} />
        </VStack>
      </ScrollView>
    )
  } else {
    content = (
      <ScrollView frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <VStack spacing={0}>
          <HStack padding={{ horizontal: 16, vertical: 8 }}>
            <Text font={13} fontWeight="semibold" foregroundStyle="label">搜尋紀錄</Text>
            <Spacer />
            {history.length > 0
              ? (
                <HStack spacing={0} onTapGesture={handleClearHistory}>
                  <Text font={13} foregroundStyle={SEARCH_ACCENT}>清除</Text>
                </HStack>
              )
              : null}
          </HStack>

          {history.length === 0
            ? (
              <VStack spacing={8} padding={{ top: 48, horizontal: 28 }}>
                <Image systemName="clock.arrow.circlepath" font={32} foregroundStyle="tertiaryLabel" />
                <Text font={14} fontWeight="medium" foregroundStyle="secondaryLabel" multilineTextAlignment="center">
                  搜尋 YouTube、BiliBili 影片
                </Text>
                <Text font={12} foregroundStyle="tertiaryLabel" multilineTextAlignment="center">
                  輸入關鍵字、貼上影片網址，或直接輸入 BV / AV 番號
                </Text>
              </VStack>
            )
            : (
              <LazyVGrid
                columns={[
                  { size: { type: "flexible" }, spacing: 8, alignment: "leading" },
                  { size: { type: "flexible" }, spacing: 8, alignment: "leading" },
                ]}
                alignment="leading"
                spacing={8}
                padding={{ horizontal: 16, vertical: 4 }}
              >
                {history.map((keyword: string): VirtualNode => (
                  <HStack
                    key={keyword}
                    spacing={6}
                    padding={{ horizontal: 11, vertical: 8 }}
                    background="tertiarySystemFill"
                    clipShape="capsule"
                    onTapGesture={() => runSearch(keyword)}
                  >
                    <Image systemName="clock.arrow.circlepath" font={11} foregroundStyle="secondaryLabel" />
                    <Text font={12} foregroundStyle="label" lineLimit={1}>{keyword}</Text>
                  </HStack>
                ))}
              </LazyVGrid>
            )}
          <Spacer frame={{ height: 96 }} />
        </VStack>
      </ScrollView>
    )
  }

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      {searchBar}
      {directBanner
        ? (
          <HStack spacing={0} padding={{ horizontal: 14, vertical: 2 }} frame={{ maxWidth: "infinity" }}>
            {directBanner}
          </HStack>
        )
        : null}
      <HStack spacing={0} padding={{ horizontal: 14, vertical: 2 }} frame={{ maxWidth: "infinity" }}>
        {platformRow}
      </HStack>
      {sortRow}
      <HStack spacing={0} padding={{ horizontal: 14, vertical: 4 }}>
        <HStack spacing={0} frame={{ height: 1, maxWidth: "infinity" }} background="separator" />
      </HStack>
      {content}
    </VStack>
  )
}
