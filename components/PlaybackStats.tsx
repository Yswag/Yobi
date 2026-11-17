import { HStack, Text, VStack, useEffect, useState } from "scripting"
import type { VirtualNode } from "scripting"
import type { VideoQualityTrack } from "../types"
import { currentDownloadBps, lastDownloadHost, lastMediaFailure, prefetchedAheadBytes, prefetchWindow } from "../services"
import { getPlayerController, usePlayerProgress, usePlayerStore } from "../state/playerStore"
import { palette, type } from "../ui/theme"

const TICK_MS: number = 1000

/** 網速不是事件，自己每秒重讀一次。 */
function useTicker(): void {
  const [, setTick] = useState<number>(0)
  useEffect(() => {
    const id: number = setInterval(() => setTick(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])
}

function formatSpeed(bitsPerSecond: number): string {
  const bytes: number = bitsPerSecond / 8
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`
  return `${Math.round(bytes / 1024)} KB/s`
}

function formatMbps(bitsPerSecond: number | undefined): string | null {
  if (!bitsPerSecond || bitsPerSecond <= 0) return null
  const mbps: number = bitsPerSecond / 1_000_000
  return mbps >= 10 ? `${Math.round(mbps)} Mbps` : `${mbps.toFixed(1)} Mbps`
}

function join(parts: (string | null | undefined)[]): string {
  return parts.filter((part: string | null | undefined): part is string => Boolean(part)).join(" · ")
}

/** 轉圈時放在圈圈下方的即時網速。 */
export function NetSpeedLabel(props: { offsetY: number }): VirtualNode {
  useTicker()
  return (
    <Text
      font={type.meta}
      fontWeight="semibold"
      monospacedDigit
      foregroundStyle={palette.onMedia}
      fixedSize
      shadow={{ color: "rgba(0,0,0,0.5)", radius: 3 }}
      offset={{ x: 0, y: props.offsetY }}
      allowsHitTesting={false}
    >
      {formatSpeed(currentDownloadBps())}
    </Text>
  )
}

function readInfo(): VideoPlaybackInfo | null {
  try {
    return getPlayerController().mediaInfo ?? null
  } catch {
    return null
  }
}

function StatRow(props: { label: string; value: string }): VirtualNode {
  return (
    <HStack spacing={8} alignment="top">
      <Text font={type.caption} foregroundStyle={palette.onMediaDim} frame={{ width: 30, alignment: "leading" }}>
        {props.label}
      </Text>
      <Text font={type.caption} monospacedDigit foregroundStyle={palette.onMedia} lineLimit={1}>
        {props.value}
      </Text>
    </HStack>
  )
}

/** 網速、緩衝與目前播放檔案的實際規格。 */
export function PlaybackStatsPanel(): VirtualNode {
  useTicker()
  const store = usePlayerStore()
  const progress = usePlayerProgress()
  const info: VideoPlaybackInfo | null = readInfo()
  const tracks: readonly VideoPlaybackTrack[] = info?.tracks ?? []
  const pick = (kind: "video" | "audio"): VideoPlaybackTrack | undefined =>
    tracks.find((track: VideoPlaybackTrack): boolean => track.kind === kind && track.selected === true) ??
    tracks.find((track: VideoPlaybackTrack): boolean => track.kind === kind)
  const video: VideoPlaybackTrack | undefined = pick("video")
  const audio: VideoPlaybackTrack | undefined = pick("audio")
  const quality: VideoQualityTrack | undefined = store.manifest?.qualities.find(
    (item: VideoQualityTrack): boolean => item.id === store.selectedQualityId,
  )

  const width: number = video?.width || quality?.width || 0
  const height: number = video?.height || quality?.height || 0
  const fps: number = video?.frameRate || quality?.fps || 0
  const acceleration: string | null =
    info?.hardwareAccelerated === true ? "硬體" : info?.hardwareAccelerated === false ? "軟體" : null
  // 播放器讀本機代理隨要隨到，自己只往前讀一點；真正的緩衝是預抓器裡的資料。
  const aheadBytes: number | null = prefetchedAheadBytes()
  const window = prefetchWindow()
  const bitrate: number = quality?.bitrate ?? video?.bitRate ?? 0
  const buffered: string =
    aheadBytes !== null
      ? join([
          `${(aheadBytes / 1024 / 1024).toFixed(0)} MB`,
          window ? `${window.grids} 格` : null,
          bitrate > 0 ? `≈ ${Math.round((aheadBytes * 8) / bitrate)} 秒` : null,
        ])
      : `${Math.max(0, progress.bufferedUntil - progress.position).toFixed(1)} 秒`

  const rows: { label: string; value: string }[] = [
    { label: "網速", value: formatSpeed(currentDownloadBps()) },
    { label: "緩衝", value: buffered },
    { label: "畫面", value: join([width && height ? `${width}×${height}` : null, fps ? `${Math.round(fps)} fps` : null]) },
    { label: "視訊", value: join([video?.codec ?? quality?.codec, info?.videoDecoder, acceleration]) },
    {
      label: "音訊",
      value: join([
        audio?.codec,
        audio?.sampleRate ? `${(audio.sampleRate / 1000).toFixed(1)} kHz` : null,
        audio?.channels ? `${audio.channels} ch` : null,
      ]),
    },
    { label: "碼率", value: join([formatMbps(quality?.bitrate ?? video?.bitRate)]) },
    { label: "來源", value: join([store.manifest?.delivery.toUpperCase(), info?.backend, info?.container]) },
    { label: "線路", value: lastDownloadHost() },
    { label: "代理", value: lastMediaFailure() ?? "" },
  ].filter((row: { label: string; value: string }): boolean => row.value.length > 0)

  return (
    <VStack
      alignment="leading"
      spacing={2}
      padding={{ horizontal: 10, vertical: 8 }}
      background={{ style: "rgba(0,0,0,0.62)", shape: { type: "rect", cornerRadius: 8 } }}
      allowsHitTesting={false}
    >
      {rows.map((row: { label: string; value: string }) => (
        <StatRow key={row.label} label={row.label} value={row.value} />
      ))}
    </VStack>
  )
}
