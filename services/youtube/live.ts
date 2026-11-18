/**
 * YouTube 直播取流，與一般影片分開。
 *
 * 直播沒有時間軸，也不吃 VISIONOS / SABR：只有 app client 會回 `hlsManifestUrl`
 * （實測 ANDROID 有，IOS 只有 adaptiveFormats，WEB／TVHTML5／VISIONOS 被風控擋）。
 * 因此依序問幾個 client，取第一個「master、媒體清單、第一段」都真的抓得到的。
 *
 * 清單與片段直接給播放器，不經本機轉手：轉手會把媒體清單快取起來，
 * 直播的滑動窗格不會更新，播完一輪就停。
 *
 * 後端用 system：native 對直播的 1 秒片段、3 秒窗格會一直轉圈（實測），system 正常。
 */

import { fetch } from "scripting"
import type { StreamManifest, VideoQualityTrack } from "../../types"
import { parseHlsMasterText, qualityLabel, resolveUrl, type HlsVariant } from "./hls"
import { fetchPlayerResponse, type InnertubeClientKey, type JsonObject } from "./innertube"

interface LiveClientProfile {
  key: InnertubeClientKey
  /** 大的先問。 */
  preference: number
}

const LIVE_CLIENTS: LiveClientProfile[] = [
  { key: "ANDROID", preference: 220 },
  { key: "IOS", preference: 160 },
  { key: "WEB", preference: 120 },
  { key: "TVHTML5", preference: 100 },
]

interface LiveCandidate {
  url: string
  source: InnertubeClientKey
  preference: number
  /** 網址帶 `/n/` 挑戰時要先改寫才能抓，排在後面。 */
  challenged: boolean
}

function asObject(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject
  return null
}

function manifestUrlOf(player: JsonObject): string {
  const streamingData: JsonObject | null = asObject(player["streamingData"])
  if (!streamingData) return ""
  const hls: unknown = streamingData["hlsManifestUrl"]
  if (typeof hls === "string" && hls) return hls
  const hlsvp: unknown = streamingData["hlsvp"]
  return typeof hlsvp === "string" ? hlsvp : ""
}

/** 各 client 的 `hlsManifestUrl`；同一個網址只留一次。 */
async function collectCandidates(videoId: string): Promise<LiveCandidate[]> {
  const seen: Set<string> = new Set()
  const candidates: LiveCandidate[] = []
  for (const profile of LIVE_CLIENTS) {
    try {
      const player: JsonObject = await fetchPlayerResponse(videoId, profile.key)
      const url: string = manifestUrlOf(player)
      if (!url || seen.has(url)) continue
      seen.add(url)
      candidates.push({
        url,
        source: profile.key,
        preference: profile.preference,
        challenged: /\/n\/[^/]+\//.test(url),
      })
    } catch {
      // 這個 client 不能用就換下一個
    }
  }
  return candidates.sort(
    (a: LiveCandidate, b: LiveCandidate): number =>
      Number(a.challenged) - Number(b.challenged) || b.preference - a.preference,
  )
}

async function fetchText(url: string, timeoutSeconds: number): Promise<{ ok: boolean; text: string }> {
  try {
    const response = await fetch(url, { timeout: timeoutSeconds, debugLabel: "Yobi YouTube live" })
    if (!response.ok) return { ok: false, text: "" }
    return { ok: true, text: await response.text() }
  } catch {
    return { ok: false, text: "" }
  }
}

/** 清單裡第一個非註解行（媒體清單的下一段或 master 的 variant）。 */
function firstUriLine(text: string, baseUrl: string): string {
  for (const rawLine of text.split(/\r?\n/)) {
    const line: string = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    return resolveUrl(baseUrl, line)
  }
  return ""
}

/** 抓到底：master、第一條媒體清單、第一段。成功才回 master 文字。 */
async function verifyCandidate(url: string): Promise<string | null> {
  const master = await fetchText(url, 8)
  if (!master.ok || !master.text.includes("#EXTM3U")) return null
  const mediaUrl: string = firstUriLine(master.text, url)
  if (!mediaUrl) return null
  const media = await fetchText(mediaUrl, 8)
  if (!media.ok || !media.text.includes("#EXTM3U")) return null
  const segmentUrl: string = firstUriLine(media.text, mediaUrl)
  if (!segmentUrl) return master.text
  try {
    const probe = await fetch(segmentUrl, {
      headers: { Range: "bytes=0-1" },
      timeout: 8,
      debugLabel: "Yobi YouTube live segment",
    })
    return probe.ok ? master.text : null
  } catch {
    return null
  }
}

function buildQualities(masterText: string, masterUrl: string): VideoQualityTrack[] {
  const parsed = parseHlsMasterText(masterText, masterUrl)
  const sorted: HlsVariant[] = parsed.variants
    .slice()
    .sort((a: HlsVariant, b: HlsVariant): number => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth)

  const qualities: VideoQualityTrack[] = []
  const usedIds: Set<string> = new Set()
  for (const variant of sorted) {
    const fps: number | undefined = variant.frameRate
    const base: string = `live-${variant.height ?? 0}p${fps && fps >= 50 ? "60" : ""}`
    const id: string = usedIds.has(base) ? `${base}-${variant.bandwidth}` : base
    usedIds.add(id)
    const quality: VideoQualityTrack = {
      id,
      label: qualityLabel(variant.height ?? 0, fps),
      width: variant.width ?? 0,
      height: variant.height ?? 0,
      delivery: "hls",
      url: variant.uri,
    }
    if (fps) quality.fps = fps
    if (variant.bandwidth) quality.bitrate = variant.bandwidth
    if (variant.codecs) quality.codec = variant.codecs.split(",")[0]
    qualities.push(quality)
  }
  return qualities
}

/** 直播串流：挑一條真的能播的 HLS，畫質清單對應 master 裡的 variant。 */
export async function resolveYoutubeLiveStream(videoId: string): Promise<StreamManifest> {
  const candidates: LiveCandidate[] = await collectCandidates(videoId)
  if (candidates.length === 0) throw new Error("YouTube 直播沒有 HLS 串流")

  let masterUrl: string = ""
  let masterText: string = ""
  for (const candidate of candidates) {
    const text: string | null = await verifyCandidate(candidate.url)
    if (text) {
      masterUrl = candidate.url
      masterText = text
      break
    }
  }
  if (!masterUrl) throw new Error("YouTube 直播清單都抓不到片段")

  const qualities: VideoQualityTrack[] = buildQualities(masterText, masterUrl)
  if (qualities.length === 0) throw new Error("YouTube 直播清單沒有畫質")

  return {
    provider: "yt",
    rawId: videoId,
    delivery: "hls",
    // 直播給 master，讓播放器跟著即時頻寬挑 variant；指定畫質再從選單換。
    primaryUrl: masterUrl,
    backend: "system",
    qualities,
    audioTracks: [],
    subtitles: [],
    isLive: true,
    duration: 0,
    resolveQuality: async (
      qualityId: string,
    ): Promise<{ url: string; backend: "auto" | "native" | "system" | "remux" }> => {
      const quality: VideoQualityTrack | undefined = qualities.find(
        (entry: VideoQualityTrack): boolean => entry.id === qualityId,
      )
      return { url: quality?.url ?? masterUrl, backend: "system" }
    },
  }
}
