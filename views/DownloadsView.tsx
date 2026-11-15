import {
  HStack,
  Image,
  ScrollView,
  Spacer,
  Text,
  VStack,
  ZStack,
  useEffect,
  useState,
} from "scripting"
import type { Color, VirtualNode } from "scripting"
import type { DownloadTaskState, OfflineDownload, Provider } from "../types"
import {
  clearAllDownloads,
  formatBytes,
  getActiveDownload,
  getDownloads,
  removeDownload,
  subscribeDownloadChanges,
  totalDownloadBytes,
} from "../services"
import { formatDuration, providerAccentColor, providerBadgeLabel } from "../utils/format"
import { openVideo } from "../state/playerStore"

export interface DownloadsViewProps {
  onOpenSettings?: () => void
}

type DownloadFilter = "all" | Provider

const LINK_BLUE: Color = "rgba(10,132,255,1)"
const DANGER_RED: Color = "rgba(255,59,48,1)"
const OFFLINE_GREEN: Color = "rgba(48,209,88,1)"
const THUMB_WIDTH: number = 132
const THUMB_HEIGHT: number = 74
const EMPTY_BOTTOM: number = 96

export function DownloadsView(props: DownloadsViewProps): VirtualNode {
  const [entries, setEntries] = useState<OfflineDownload[]>(() => getDownloads())
  const [active, setActive] = useState<DownloadTaskState | null>(() => getActiveDownload())
  const [filter, setFilter] = useState<DownloadFilter>("all")

  useEffect(() => {
    const refresh = (): void => {
      setEntries(getDownloads())
      setActive(getActiveDownload())
    }
    refresh()
    return subscribeDownloadChanges(refresh)
  }, [])

  const visible: OfflineDownload[] = entries.filter((entry: OfflineDownload): boolean => {
    if (filter === "all") return true
    return entry.item.provider === filter
  })

  const usedBytes: number = totalDownloadBytes()

  const handlePlay = (entry: OfflineDownload): void => {
    void openVideo(entry.item, {
      cid: entry.cid,
      page: entry.page,
      queue: visible.map((item: OfflineDownload) => item.item),
    })
  }

  const handleRemove = (entry: OfflineDownload): void => {
    void Dialog.confirm({
      title: "刪除離線檔案",
      message: `確定要刪除「${entry.item.title}」的本機檔案嗎？`,
      confirmLabel: "刪除",
    }).then((confirmed: boolean) => {
      if (!confirmed) return
      void removeDownload(entry.id).then(() => setEntries(getDownloads()))
    })
  }

  const handleClearAll = (): void => {
    void Dialog.confirm({
      title: "清除所有下載",
      message: "這會刪除全部離線檔案與相關暫存。",
      confirmLabel: "全部清除",
    }).then((confirmed: boolean) => {
      if (!confirmed) return
      void clearAllDownloads().then(() => setEntries(getDownloads()))
    })
  }

  const renderChip = (label: string, value: DownloadFilter): VirtualNode => {
    const isActive: boolean = filter === value
    const accent: Color = value === "all" ? LINK_BLUE : providerAccentColor(value)
    return (
      <HStack
        spacing={0}
        padding={{ horizontal: 10, vertical: 5 }}
        background={isActive ? accent : "tertiarySystemFill"}
        clipShape="capsule"
        onTapGesture={() => setFilter(value)}
      >
        <Text
          font={11}
          fontWeight={isActive ? "semibold" : "medium"}
          foregroundStyle={isActive ? "white" : "secondaryLabel"}
          lineLimit={1}
        >
          {label}
        </Text>
      </HStack>
    )
  }

  const renderEntry = (entry: OfflineDownload): VirtualNode => (
    <VStack
      key={`dl-${entry.id}`}
      spacing={0}
      padding={10}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background="secondarySystemGroupedBackground"
      clipShape={{ type: "rect", cornerRadius: 12 }}
    >
      <HStack alignment="top" spacing={10} frame={{ maxWidth: "infinity" }}>
        <ZStack
          alignment="bottomTrailing"
          frame={{ width: THUMB_WIDTH, height: THUMB_HEIGHT }}
          background="rgba(120,120,128,0.18)"
          clipShape={{ type: "rect", cornerRadius: 8 }}
          onTapGesture={() => handlePlay(entry)}
        >
          {entry.item.thumbnailUrl ? (
            <Image
              imageUrl={entry.item.thumbnailUrl}
              resizable
              scaleToFill
              frame={{ width: THUMB_WIDTH, height: THUMB_HEIGHT }}
            />
          ) : (
            <Image systemName="play.rectangle.fill" font={22} foregroundStyle="secondaryLabel" />
          )}
          <Text
            font={9}
            fontWeight="bold"
            foregroundStyle="white"
            padding={{ horizontal: 4, vertical: 1.5 }}
            background={providerAccentColor(entry.item.provider)}
            clipShape={{ type: "rect", cornerRadius: 3 }}
            offset={{ x: -4, y: -4 }}
          >
            {providerBadgeLabel(entry.item.provider)}
          </Text>
        </ZStack>

        <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text
            font={13}
            fontWeight="semibold"
            foregroundStyle="label"
            lineLimit={2}
            multilineTextAlignment="leading"
            onTapGesture={() => handlePlay(entry)}
          >
            {entry.item.title}
          </Text>
          <Text font={11} foregroundStyle="secondaryLabel" lineLimit={1}>
            {entry.item.authorName || "未知作者"}
          </Text>
          <HStack spacing={5}>
            <Text
              font={10}
              fontWeight="semibold"
              foregroundStyle="white"
              padding={{ horizontal: 5, vertical: 1.5 }}
              background="rgba(120,120,128,0.85)"
              clipShape="capsule"
            >
              {entry.qualityLabel}
            </Text>
            <Text
              font={10}
              fontWeight="semibold"
              foregroundStyle={OFFLINE_GREEN}
              padding={{ horizontal: 5, vertical: 1.5 }}
              background="rgba(48,209,88,0.16)"
              clipShape="capsule"
            >
              {entry.cacheMode === "http" ? "已下載" : entry.cacheMode === "dash" ? "DASH" : "HLS"}
            </Text>
            <Text font={10} foregroundStyle="tertiaryLabel" lineLimit={1}>
              {`${entry.bytes > 0 ? formatBytes(entry.bytes) : "—"} · ${formatDuration(entry.duration)}`}
            </Text>
          </HStack>
        </VStack>

        <VStack
          spacing={0}
          frame={{ width: 30, height: 30 }}
          background="tertiarySystemFill"
          clipShape="circle"
          onTapGesture={() => handleRemove(entry)}
        >
          <Image systemName="trash" font={12} foregroundStyle={DANGER_RED} />
        </VStack>
      </HStack>
    </VStack>
  )

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background="systemGroupedBackground">
      <VStack spacing={10} padding={{ horizontal: 14, vertical: 10 }} frame={{ maxWidth: "infinity" }}>
        <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
          <Text font={22} fontWeight="bold" foregroundStyle="label">
            離線下載
          </Text>
          <Spacer />
          {props.onOpenSettings ? (
            <VStack
              spacing={0}
              frame={{ width: 30, height: 30 }}
              background="tertiarySystemFill"
              clipShape="circle"
              onTapGesture={props.onOpenSettings}
            >
              <Image systemName="gearshape.fill" font={13} foregroundStyle="secondaryLabel" />
            </VStack>
          ) : null}
        </HStack>

        <HStack spacing={6} frame={{ maxWidth: "infinity" }}>
          {renderChip("全部", "all")}
          {renderChip(providerBadgeLabel("yt"), "yt")}
          {renderChip(providerBadgeLabel("bili"), "bili")}
          <Spacer />
          <Text font={11} monospacedDigit foregroundStyle="tertiaryLabel">
            {`${visible.length} 部 · ${formatBytes(usedBytes)}`}
          </Text>
        </HStack>
      </VStack>

      <ScrollView axes="vertical" scrollIndicator="automatic" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <VStack alignment="leading" spacing={10} padding={{ horizontal: 14 }} frame={{ maxWidth: "infinity" }}>
          {active ? (
            <VStack
              alignment="leading"
              spacing={8}
              padding={12}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
              background="secondarySystemGroupedBackground"
              clipShape={{ type: "rect", cornerRadius: 12 }}
            >
              <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
                <Image systemName="arrow.down.circle.fill" font={14} foregroundStyle={LINK_BLUE} />
                <Text font={12} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>
                  {active.title}
                </Text>
                <Spacer />
                <Text font={11} monospacedDigit foregroundStyle="secondaryLabel">
                  {active.error ? "失敗" : `${Math.round(active.progress * 100)}%`}
                </Text>
              </HStack>

              <ZStack
                alignment="leading"
                frame={{ maxWidth: "infinity", height: 4 }}
                background="rgba(120,120,128,0.24)"
                clipShape="capsule"
              >
                <HStack
                  spacing={0}
                  frame={{ width: Math.max(2, Math.round((Device.screen.width - 76) * active.progress)), height: 4 }}
                  background={active.error ? DANGER_RED : LINK_BLUE}
                  clipShape="capsule"
                />
              </ZStack>

              <Text font={10} foregroundStyle={active.error ? DANGER_RED : "tertiaryLabel"} lineLimit={2}>
                {active.error
                  ? active.error
                  : `${active.qualityLabel} · ${active.totalSegments > 0 ? `${active.downloadedSegments}/${active.totalSegments} 片段` : "準備中…"}`}
              </Text>
            </VStack>
          ) : null}

          {visible.length === 0 && !active ? (
            <VStack
              spacing={10}
              padding={{ vertical: 56 }}
              frame={{ maxWidth: "infinity" }}
            >
              <Image systemName="arrow.down.circle" font={40} foregroundStyle="tertiaryLabel" />
              <Text font={15} fontWeight="semibold" foregroundStyle="label">
                尚無離線下載
              </Text>
              <Text font={12} foregroundStyle="secondaryLabel" multilineTextAlignment="center">
                {"在播放頁點「下載」即可把影片存到本機，\n之後沒有網路也能播放。"}
              </Text>
            </VStack>
          ) : (
            visible.map((entry: OfflineDownload) => renderEntry(entry))
          )}

          {visible.length > 0 ? (
            <HStack
              spacing={6}
              padding={{ horizontal: 12, vertical: 9 }}
              frame={{ maxWidth: "infinity" }}
              background="rgba(255,59,48,0.12)"
              clipShape="capsule"
              onTapGesture={handleClearAll}
            >
              <Image systemName="trash.fill" font={12} foregroundStyle={DANGER_RED} />
              <Text font={12} fontWeight="semibold" foregroundStyle={DANGER_RED}>
                清除全部離線檔案
              </Text>
              <Spacer />
            </HStack>
          ) : null}

          <Spacer frame={{ height: EMPTY_BOTTOM }} />
        </VStack>
      </ScrollView>
    </VStack>
  )
}
