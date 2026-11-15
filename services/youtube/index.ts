/**
 * YouTube 服務入口：搜尋、熱門、詳情、頻道、留言、字幕、HLS / SABR 串流。
 */

import { fetch } from "scripting"
import type {
  AudioStreamTrack,
  ChannelDetail,
  CommentItem,
  StreamManifest,
  UnifiedVideoItem,
  VideoDetail,
  VideoQualityTrack,
  YoutubeStreamPreference,
} from "../../types"
import {
  fetchBrowseResponse,
  fetchNextResponse,
  fetchPlayerResponse,
  fetchSearchResponse,
  type InnertubeClientKey,
  type JsonObject,
} from "./innertube"
import {
  extractVideoItems,
  parseChannelDetail,
  parseComments,
  parseRelatedVideos,
  parseSubtitleTracks,
  parseVideoDetail,
} from "./parsers"
import { resolveHlsManifest } from "./hls"
import {
  audioTrackOf,
  createSabrQualitySession,
  parseAdaptiveFormats,
  pickBestAudioFormat,
  pickVideoFormats,
  type SabrFormat,
  type SabrSessionConfig,
} from "./sabr"

const SUGGEST_ENDPOINT: string = "https://suggestqueries-clients6.youtube.com/complete/search"

/** 支援 youtu.be / watch?v= / shorts / live / embed 與 11 碼 ID。 */
export function parseYoutubeInput(input: string): string | null {
  const trimmed: string = input.trim()
  if (!trimmed) return null
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed

  const patterns: RegExp[] = [
    /(?:youtube\.com|youtube-nocookie\.com)\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/live\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/v\/([A-Za-z0-9_-]{11})/,
  ]
  for (const pattern of patterns) {
    const match: RegExpMatchArray | null = trimmed.match(pattern)
    if (match) return match[1]
  }
  return null
}

function asObject(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject
  return null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function dedupeItems(items: UnifiedVideoItem[]): UnifiedVideoItem[] {
  const seen: Set<string> = new Set()
  const result: UnifiedVideoItem[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    result.push(item)
  }
  return result
}

function playabilityFailure(player: JsonObject): string | null {
  const status: JsonObject | null = asObject(player["playabilityStatus"])
  if (!status) return null
  const value: string = String(status["status"] ?? "")
  if (!value || value === "OK") return null
  return String(status["reason"] ?? value)
}

export async function searchYoutubeVideos(query: string): Promise<UnifiedVideoItem[]> {
  const response: JsonObject = await fetchSearchResponse(query)
  return extractVideoItems(response)
}

/** 首頁熱門：先試 FEwhat_to_watch，空的話退回熱門關鍵字搜尋。 */
export async function getYoutubeTrending(): Promise<UnifiedVideoItem[]> {
  try {
    const response: JsonObject = await fetchBrowseResponse("FEwhat_to_watch")
    const items: UnifiedVideoItem[] = extractVideoItems(response)
    if (items.length > 0) return items
  } catch (_error) {
    // 未登入或個人化失敗時直接進 fallback
  }

  const fallbackQueries: string[] = ["music", "news", "gaming"]
  const batches: UnifiedVideoItem[][] = await Promise.all(
    fallbackQueries.map(async (query: string): Promise<UnifiedVideoItem[]> => {
      try {
        return await searchYoutubeVideos(query)
      } catch (_error) {
        return []
      }
    }),
  )

  const merged: UnifiedVideoItem[] = []
  const longest: number = batches.reduce((max: number, batch: UnifiedVideoItem[]): number => Math.max(max, batch.length), 0)
  for (let i = 0; i < longest; i++) {
    for (const batch of batches) {
      const item: UnifiedVideoItem | undefined = batch[i]
      if (item) merged.push(item)
    }
  }
  return dedupeItems(merged)
}

/** 搜尋建議。 */
export async function getYoutubeSearchSuggestions(query: string): Promise<string[]> {
  const trimmed: string = query.trim()
  if (!trimmed) return []
  const url: string = `${SUGGEST_ENDPOINT}?client=youtube&ds=yt&q=${encodeURIComponent(trimmed)}`
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_1 like Mac OS X)" },
      timeout: 12,
      debugLabel: "Yobi YouTube suggest",
    })
    if (!response.ok) return []
    const text: string = await response.text()
    const start: number = text.indexOf("(")
    const end: number = text.lastIndexOf(")")
    if (start < 0 || end <= start) return []
    const payload: unknown = JSON.parse(text.slice(start + 1, end))
    const entries: unknown[] = asArray(asArray(payload)[1])
    const suggestions: string[] = []
    for (const entry of entries) {
      const value: unknown = asArray(entry)[0]
      if (typeof value === "string" && value.length > 0) suggestions.push(value)
    }
    return suggestions
  } catch (_error) {
    return []
  }
}

/** 影片詳情（player + next）。 */
export async function getYoutubeVideoDetail(videoId: string): Promise<VideoDetail> {
  const player: JsonObject = await fetchPlayerResponse(videoId, "IOS")
  const failure: string | null = playabilityFailure(player)
  if (failure) throw new Error(`YouTube 無法播放：${failure}`)

  let next: JsonObject | null = null
  try {
    next = await fetchNextResponse(videoId)
  } catch (_error) {
    next = null
  }

  const detail: VideoDetail = parseVideoDetail(videoId, player, next)
  if (!detail.relatedVideos || detail.relatedVideos.length === 0) {
    detail.relatedVideos = next ? parseRelatedVideos(next) : []
  }
  return detail
}

function findCommentsContinuation(next: JsonObject): string | null {
  const tokens: string[] = []

  const visit = (node: unknown, depth: number): void => {
    if (!node || depth > 26) return
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1)
      return
    }
    const object: JsonObject | null = asObject(node)
    if (!object) return

    const section: JsonObject | null = asObject(object["itemSectionRenderer"])
    if (section) {
      const header: string = JSON.stringify(section["header"] ?? "")
      const contents: unknown[] = asArray(section["contents"])
      const endpoint: JsonObject | null = asObject(
        asObject(contents[0])?.["continuationItemRenderer"],
      )?.["continuationEndpoint"] as JsonObject | null
      const command: JsonObject | null = asObject(endpoint?.["continuationCommand"])
      if (command && typeof command["token"] === "string" && /comment/i.test(header)) {
        tokens.push(String(command["token"]))
      }
    }

    for (const key of Object.keys(object)) visit(object[key], depth + 1)
  }

  visit(next, 0)
  if (tokens.length > 0) return tokens[0]

  // 退而求其次：任何 targetId 指向 watch 的 continuation
  let fallback: string | null = null
  const scan = (node: unknown, depth: number): void => {
    if (!node || depth > 26 || fallback) return
    if (Array.isArray(node)) {
      for (const entry of node) scan(entry, depth + 1)
      return
    }
    const object: JsonObject | null = asObject(node)
    if (!object) return
    const command: JsonObject | null = asObject(asObject(object["continuationEndpoint"])?.["continuationCommand"])
    if (command && typeof command["token"] === "string" && String(command["request"] ?? "").includes("comments")) {
      fallback = String(command["token"])
      return
    }
    for (const key of Object.keys(object)) scan(object[key], depth + 1)
  }
  scan(next, 0)
  return fallback
}

/** 留言（取第一頁）。 */
export async function getYoutubeComments(videoId: string): Promise<CommentItem[]> {
  const next: JsonObject = await fetchNextResponse(videoId)
  const initial: CommentItem[] = parseComments(next)
  if (initial.length > 0) return initial

  const token: string | null = findCommentsContinuation(next)
  if (!token) return []
  const response: JsonObject = await fetchNextResponse(videoId, token)
  return parseComments(response)
}

/** 頻道頁。 */
export async function getYoutubeChannel(channelId: string): Promise<ChannelDetail> {
  const response: JsonObject = await fetchBrowseResponse(channelId)
  return parseChannelDetail(channelId, response)
}

interface SabrPlayerInfo {
  clientKey: InnertubeClientKey
  serverAbrStreamingUrl: string
  ustreamerConfig: string
  formats: SabrFormat[]
  player: JsonObject
}

const SABR_CLIENT_ORDER: InnertubeClientKey[] = ["IOS", "ANDROID_VR", "WEB_SABR", "MWEB"]

async function loadSabrPlayer(videoId: string, existingIosPlayer?: JsonObject | null): Promise<SabrPlayerInfo | null> {
  for (const clientKey of SABR_CLIENT_ORDER) {
    try {
      const player: JsonObject =
        clientKey === "IOS" && existingIosPlayer ? existingIosPlayer : await fetchPlayerResponse(videoId, clientKey)
      if (playabilityFailure(player)) continue
      const streamingData: JsonObject | null = asObject(player["streamingData"])
      if (!streamingData) continue
      const serverAbrStreamingUrl: string = String(streamingData["serverAbrStreamingUrl"] ?? "")
      const playerConfig: JsonObject | null = asObject(player["playerConfig"])
      const ustreamerConfig: string = String(
        asObject(
          asObject(asObject(playerConfig?.["mediaCommonConfig"])?.["mediaUstreamerRequestConfig"]),
        )?.["videoPlaybackUstreamerConfig"] ?? "",
      )

      const formats: SabrFormat[] = parseAdaptiveFormats(asArray(streamingData["adaptiveFormats"]))
      if (formats.length === 0) continue
      const hasDirectUrls: boolean = formats.some((f: SabrFormat): boolean => Boolean(f.url))
      if (!hasDirectUrls && (!serverAbrStreamingUrl || !ustreamerConfig)) continue
      return {
        clientKey,
        serverAbrStreamingUrl: hasDirectUrls ? "" : serverAbrStreamingUrl,
        ustreamerConfig,
        formats,
        player,
      }
    } catch (_error) {
      // 換下一個 client
    }
  }
  return null
}

function closestQuality(qualities: VideoQualityTrack[], preferredHeight: number): VideoQualityTrack | undefined {
  let best: VideoQualityTrack | undefined
  let bestDelta: number = Number.MAX_SAFE_INTEGER
  for (const quality of qualities) {
    if (quality.delivery === "sabr" && quality.height === 0) continue
    const delta: number = Math.abs((quality.height || preferredHeight) - preferredHeight)
    if (delta < bestDelta) {
      bestDelta = delta
      best = quality
    }
  }
  return best
}

/**
 * 解析可播放串流。
 *
 * mode:
 * - auto：HLS 優先，同時附上 SABR 高畫質軌（可切換）
 * - hls：只走 HLS
 * - sabr：只走 SABR（失敗才退回 HLS）
 */
export async function resolveYoutubeStream(
  videoId: string,
  mode: YoutubeStreamPreference = "auto",
  preferredHeight: number = 0,
): Promise<StreamManifest> {
  const wantHls: boolean = mode !== "sabr"
  const wantSabr: boolean = mode !== "hls"

  let hlsPlayer: JsonObject | null = null
  let hlsManifestUrl: string | null = null

  if (wantHls || mode === "sabr") {
    try {
      hlsPlayer = await fetchPlayerResponse(videoId, "IOS")
      const failure: string | null = playabilityFailure(hlsPlayer)
      if (failure && mode === "hls") throw new Error(`YouTube 無法播放：${failure}`)
      if (!failure) {
        const streamingData: JsonObject | null = asObject(hlsPlayer["streamingData"])
        const value: string = String(streamingData?.["hlsManifestUrl"] ?? "")
        if (value) hlsManifestUrl = value
      }
    } catch (error) {
      if (mode === "hls") throw error
    }
  }

  const hlsQualities: VideoQualityTrack[] = []
  let hlsPrimary: string | null = null
  if (hlsManifestUrl) {
    try {
      const resolved = await resolveHlsManifest(hlsManifestUrl)
      hlsPrimary = resolved.primaryUrl
      hlsQualities.push(...resolved.qualities)
    } catch (_error) {
      hlsPrimary = null
    }
  }

  const sabrQualities: VideoQualityTrack[] = []
  const sabrAudioTracks: AudioStreamTrack[] = []
  let sabrPrimary: string | null = null
  let sabrFormatsForAudio: SabrFormat[] = []

  if (wantSabr) {
    try {
      const info: SabrPlayerInfo | null = await loadSabrPlayer(videoId, hlsPlayer)
      if (info) {
        const videoFormats: SabrFormat[] = pickVideoFormats(info.formats, true)
        const audio: SabrFormat | undefined = pickBestAudioFormat(info.formats)
        if (audio) {
          sabrFormatsForAudio = info.formats.filter((format: SabrFormat): boolean => format.isAudio)
          const config: SabrSessionConfig = {
            videoId,
            serverAbrStreamingUrl: info.serverAbrStreamingUrl,
            videoPlaybackUstreamerConfig: info.ustreamerConfig,
            formats: info.formats,
            clientKey: info.clientKey,
          }
          const poToken: string | undefined = undefined
          void poToken

          for (const video of videoFormats) {
            const session = createSabrQualitySession(config, video, audio)
            sabrQualities.push(session.quality)
            if (!sabrPrimary) sabrPrimary = session.urls.hlsUrl
          }
          for (const audioFormat of sabrFormatsForAudio) {
            sabrAudioTracks.push(audioTrackOf(audioFormat))
          }
        }
      }
    } catch (_error) {
      // SABR 失敗時退回 HLS
    }
  }

  const primaryUrl: string | null = sabrPrimary ?? hlsPrimary
  if (!primaryUrl) {
    throw new Error("找不到可播放的 YouTube 串流")
  }

  // 合併畫質：SABR 優先，HLS 補上 SABR 沒有的高度。
  const merged: VideoQualityTrack[] = []
  const coveredHeights: Set<number> = new Set()
  for (const quality of sabrQualities) {
    merged.push(quality)
    if (quality.height > 0) coveredHeights.add(quality.height)
  }
  for (const quality of hlsQualities) {
    if (quality.height > 0 && coveredHeights.has(quality.height)) continue
    merged.push(quality)
  }
  const qualities: VideoQualityTrack[] = merged.sort(
    (a: VideoQualityTrack, b: VideoQualityTrack): number => b.height - a.height || (b.bitrate ?? 0) - (a.bitrate ?? 0),
  )

  const details: JsonObject = asObject((hlsPlayer ?? {})["videoDetails"]) ?? {}
  const duration: number = Number(details["lengthSeconds"] ?? 0)
  const isLive: boolean = Boolean(details["isLive"])
  const subtitles = hlsPlayer ? parseSubtitleTracks(hlsPlayer) : []

  const chosen: VideoQualityTrack | undefined = preferredHeight > 0 ? closestQuality(qualities, preferredHeight) : undefined
  const startUrl: string = chosen?.url ?? primaryUrl
  const delivery: "hls" | "sabr" = sabrPrimary && !hlsPrimary ? "sabr" : "hls"

  const manifest: StreamManifest = {
    provider: "yt",
    rawId: videoId,
    delivery,
    primaryUrl: startUrl,
    backend: "auto",
    qualities,
    audioTracks: sabrAudioTracks,
    subtitles,
    isLive,
    duration,
    resolveQuality: async (
      qualityId: string,
    ): Promise<{ url: string; backend: "auto" | "native" | "system" | "remux" }> => {
      if (qualityId === "auto" || qualityId === "hls-auto") {
        return { url: primaryUrl, backend: "auto" }
      }
      const quality: VideoQualityTrack | undefined = qualities.find(
        (entry: VideoQualityTrack): boolean => entry.id === qualityId,
      )
      if (!quality) {
        return { url: primaryUrl, backend: "auto" }
      }
      return { url: quality.url, backend: "auto" }
    },
  }
  return manifest
}
