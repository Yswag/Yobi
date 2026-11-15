import {
  HStack,
  Image,
  LazyVStack,
  ScrollView,
  Text,
  VStack,
  useEffect,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
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
import { openVideo } from "../state/playerStore"
import { VideoCard } from "../components/VideoCard"
import {
  ChipBar,
  EmptyState,
  GlassIconButton,
  PageHeader,
  ProgressTrack,
  PROVIDER_FILTERS,
} from "../ui/primitives"
import { palette, radius, space, type } from "../ui/theme"

export interface DownloadsViewProps {
  onOpenSettings?: () => void
}

type DownloadFilter = "all" | Provider

function cacheLabel(entry: OfflineDownload): string {
  if (entry.cacheMode === "http") return "MP4"
  return entry.cacheMode === "dash" ? "DASH" : "HLS"
}

function entryMeta(entry: OfflineDownload): string {
  const parts: string[] = [entry.qualityLabel, cacheLabel(entry)]
  if (entry.bytes > 0) parts.push(formatBytes(entry.bytes))
  return parts.join(" · ")
}

function ActiveDownloadCard(props: { task: DownloadTaskState }): VirtualNode {
  const task: DownloadTaskState = props.task
  const failed: boolean = Boolean(task.error)
  const detail: string = failed
    ? task.error ?? ""
    : `${task.qualityLabel} · ${task.totalSegments > 0 ? `${task.downloadedSegments}/${task.totalSegments} 片段` : "準備中"}`

  return (
    <VStack
      alignment="leading"
      spacing={10}
      padding={14}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={{ style: "secondarySystemFill", shape: { type: "rect", cornerRadius: radius.lg, style: "continuous" } }}
    >
      <HStack spacing={10} frame={{ maxWidth: "infinity" }}>
        <Image
          systemName={failed ? "exclamationmark.triangle.fill" : "arrow.down.circle.fill"}
          font={18}
          foregroundStyle={failed ? palette.danger : palette.brand}
        />
        <Text font={type.body} fontWeight="semibold" foregroundStyle="label" lineLimit={1} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          {task.title}
        </Text>
        <Text font={type.meta + 1} fontWeight="semibold" monospacedDigit foregroundStyle={failed ? palette.danger : "secondaryLabel"}>
          {failed ? "失敗" : `${Math.round(task.progress * 100)}%`}
        </Text>
      </HStack>
      <ProgressTrack ratio={task.progress} color={failed ? palette.danger : palette.brand} height={4} onMedia={false} />
      <Text font={type.caption} foregroundStyle={failed ? palette.danger : "tertiaryLabel"} lineLimit={2}>
        {detail}
      </Text>
    </VStack>
  )
}

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

  const hasAny: boolean = entries.length > 0 || active !== null

  return (
    <ScrollView axes="vertical" scrollIndicator="hidden" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <VStack spacing={14} frame={{ maxWidth: "infinity" }} padding={{ bottom: 16 }}>
        <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <PageHeader
            title="下載"
            trailing={props.onOpenSettings ? <GlassIconButton icon="gearshape" onTap={props.onOpenSettings} /> : undefined}
          />
          {entries.length > 0 ? (
            <Text
              font={type.meta + 1}
              monospacedDigit
              foregroundStyle="secondaryLabel"
              padding={{ horizontal: space.page }}
              offset={{ x: 0, y: -8 }}
            >
              {`${entries.length} 部影片 · 共 ${formatBytes(usedBytes)}`}
            </Text>
          ) : null}
        </VStack>

        {active ? (
          <VStack padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity" }}>
            <ActiveDownloadCard task={active} />
          </VStack>
        ) : null}

        {!hasAny ? (
          <EmptyState
            icon="arrow.down.circle"
            title="沒有離線影片"
            message="在播放頁點「下載」，沒有網路也能看"
          />
        ) : (
          <VStack spacing={12} frame={{ maxWidth: "infinity" }}>
            {entries.length > 0 ? <ChipBar options={PROVIDER_FILTERS} value={filter} onChange={setFilter} /> : null}
            {entries.length > 0 && visible.length === 0 ? (
              <EmptyState icon="tray" title="這個平台沒有下載" />
            ) : (
              <LazyVStack spacing={4} frame={{ maxWidth: "infinity" }}>
                {visible.map((entry: OfflineDownload) => (
                  <VideoCard
                    key={`dl-${entry.id}`}
                    item={{ ...entry.item, duration: entry.duration || entry.item.duration }}
                    layout="row"
                    meta={entryMeta(entry)}
                    actions={[{ label: "刪除離線檔案", icon: "trash", destructive: true, onTap: () => handleRemove(entry) }]}
                    onSelect={() => handlePlay(entry)}
                  />
                ))}
              </LazyVStack>
            )}
            {entries.length > 0 ? (
              <Text
                font={type.body}
                fontWeight="semibold"
                foregroundStyle={palette.danger}
                padding={{ vertical: 12 }}
                frame={{ maxWidth: "infinity" }}
                contentShape="rect"
                onTapGesture={handleClearAll}
              >
                清除全部離線檔案
              </Text>
            ) : null}
          </VStack>
        )}
      </VStack>
    </ScrollView>
  )
}
