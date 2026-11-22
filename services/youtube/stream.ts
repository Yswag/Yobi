import type {
  AudioStreamTrack,
  StreamManifest,
  VideoQualityTrack,
  YoutubeStreamPreference,
} from "../../types/index"
import { effectiveResolution } from "../../utils/format"
import {
  fetchPlayerResponse,
  getAnonymousVisitorData,
  getYoutubeAuth,
  INNERTUBE_CLIENTS,
  innertubePost,
  type InnertubeClientKey,
  type JsonObject,
} from "./innertube"
import { parseSubtitleTracks } from "./parseItems"
import { asArray, asObject } from "./parsePrimitives"
import { playabilityFailure } from "./browse"
import type { YoutubePoTokens } from "./potoken"
import type { SabrFormat, SabrQualitySession, SabrSessionConfig } from "./sabr"

export interface SabrPlayerInfo {
  clientKey: InnertubeClientKey
  serverAbrStreamingUrl: string
  ustreamerConfig: string
  formats: SabrFormat[]
  player: JsonObject
  poToken?: string
  clientVersion?: string
  visitorData?: string
  userAgent?: string
  cpn?: string
}

export async function loadWebSabrPlayer(
  videoId: string,
  clientKey: Extract<InnertubeClientKey, "WEB_SABR" | "MWEB"> = "WEB_SABR",
): Promise<SabrPlayerInfo> {
  const [tokens, sabrFormatsMod, sabrProtoMod] = await Promise.all([
    clientKey === "MWEB"
      ? import("./pageMinter").then((m) => m.getYoutubePageTokens(videoId))
      : import("./potoken").then((m) => m.getYoutubePoTokens(videoId, "WEB")),
    import("./sabrFormats"),
    import("./sabrProto"),
  ])
  const resolvedTokens: YoutubePoTokens = tokens
  const base: JsonObject = INNERTUBE_CLIENTS[clientKey].context
  const context: JsonObject = {
    ...base,
    client: {
      ...base["client"],
      clientVersion: resolvedTokens.clientVersion,
      visitorData: resolvedTokens.visitorData,
    },
  }
  const cpn: string = sabrProtoMod.makeClientPlaybackNonce()
  const player: JsonObject = await innertubePost(
    "player",
    {
      context,
      videoId,
      cpn,
      playbackContext: {
        adPlaybackContext: { pyv: true },
        contentPlaybackContext: {
          vis: 0,
          splay: false,
          lactMilliseconds: "-1",
          signatureTimestamp: resolvedTokens.signatureTimestamp,
        },
      },
      contentCheckOk: true,
      racyCheckOk: true,
      serviceIntegrityDimensions: { poToken: resolvedTokens.videoBoundPoToken },
    },
    {
      client: clientKey,
      visitorData: resolvedTokens.visitorData,
      headers: {
        "X-YouTube-Client-Version": resolvedTokens.clientVersion,
        "User-Agent": resolvedTokens.userAgent,
      },
    },
  )
  const failure: string | null = playabilityFailure(player)
  if (failure) throw new Error(`YouTube 無法播放：${failure}`)
  const streamingData: JsonObject | null = asObject(player["streamingData"])
  const rawUrl: string = String(streamingData?.["serverAbrStreamingUrl"] ?? "")
  const playerConfig: JsonObject | null = asObject(player["playerConfig"])
  const ustreamerConfig: string = String(
    asObject(asObject(playerConfig?.["mediaCommonConfig"])?.["mediaUstreamerRequestConfig"])?.[
      "videoPlaybackUstreamerConfig"
    ] ?? "",
  )
  if (!rawUrl || !ustreamerConfig) throw new Error("WEB player 沒有 SABR 串流設定")
  const formats: SabrFormat[] = sabrFormatsMod.parseAdaptiveFormats(asArray(streamingData?.["adaptiveFormats"]))
  if (formats.length === 0) throw new Error("WEB player 沒有可用格式")
  const nsigMod = await import("./nsig")
  return {
    clientKey,
    serverAbrStreamingUrl: await nsigMod.decipherStreamingUrl(rawUrl, resolvedTokens.jsUrl),
    ustreamerConfig,
    formats,
    player,
    poToken: resolvedTokens.visitorBoundPoToken,
    clientVersion: resolvedTokens.clientVersion,
    visitorData: resolvedTokens.visitorData,
    userAgent: resolvedTokens.userAgent,
    cpn,
  }
}

const SABR_CLIENT_ORDER: InnertubeClientKey[] = ["WEB_SABR", "MWEB"]

async function loadSabrPlayer(videoId: string): Promise<SabrPlayerInfo | null> {
  const sabrFormatsMod = await import("./sabrFormats")
  for (const clientKey of SABR_CLIENT_ORDER) {
    try {
      const player: JsonObject = await fetchPlayerResponse(videoId, clientKey)
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

      const formats: SabrFormat[] = sabrFormatsMod.parseAdaptiveFormats(asArray(streamingData["adaptiveFormats"]))
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
    }
  }
  return null
}

function closestQuality(qualities: VideoQualityTrack[], preferredHeight: number): VideoQualityTrack | undefined {
  let best: VideoQualityTrack | undefined
  let bestDelta: number = Number.MAX_SAFE_INTEGER
  for (const quality of qualities) {
    const resolution: number = effectiveResolution(quality.width, quality.height)
    if (quality.delivery === "sabr" && resolution === 0) continue
    const delta: number = Math.abs((resolution || preferredHeight) - preferredHeight)
    if (delta < bestDelta) {
      bestDelta = delta
      best = quality
    }
  }
  return best
}

interface ResolvedRoute {
  delivery: "hls" | "sabr"
  primaryUrl: string
  qualities: VideoQualityTrack[]
  audioTracks: AudioStreamTrack[]
  player: JsonObject
  prepareQuality?: (qualityId: string) => Promise<string | null>
  dispose?: () => void
}

async function resolveHlsRoute(videoId: string): Promise<ResolvedRoute> {
  const visitorData: string | undefined = getYoutubeAuth().visitorData ?? (await getAnonymousVisitorData())
  const player: JsonObject = await fetchPlayerResponse(videoId, "VISIONOS", { visitorData })
  const failure: string | null = playabilityFailure(player)
  if (failure) throw new Error(`YouTube 無法播放：${failure}`)
  const manifestUrl: string = String(asObject(player["streamingData"])?.["hlsManifestUrl"] ?? "")
  if (!manifestUrl) throw new Error("YouTube 沒有 HLS 串流")
  const hlsMod = await import("./hls")
  const resolved = await hlsMod.resolveHlsManifest(manifestUrl)
  return {
    delivery: "hls",
    primaryUrl: resolved.primaryUrl,
    qualities: resolved.qualities,
    audioTracks: [],
    player,
    dispose: resolved.dispose,
  }
}

async function resolveSabrRoute(videoId: string): Promise<ResolvedRoute> {
  const web: SabrPlayerInfo | null = await loadWebSabrPlayer(videoId, "MWEB").catch(() => null)
  const info: SabrPlayerInfo | null = web ?? (await loadSabrPlayer(videoId))
  if (!info) throw new Error("YouTube 沒有 SABR 串流")
  const sabrMod = await import("./sabr")
  const audio: SabrFormat | undefined = sabrMod.pickBestAudioFormat(info.formats)
  if (!audio) throw new Error("YouTube SABR 沒有音訊軌")
  const pageMinterMod = web ? await import("./pageMinter") : null
  const config: SabrSessionConfig = {
    videoId,
    serverAbrStreamingUrl: info.serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: info.ustreamerConfig,
    formats: info.formats,
    clientKey: info.clientKey,
    poToken: info.poToken,
    clientVersion: info.clientVersion,
    visitorData: info.visitorData,
    userAgent: info.userAgent,
    cpn: info.cpn,
    refreshPoToken: pageMinterMod
      ? (staleToken: string): Promise<string> => pageMinterMod.refreshYoutubePageToken(videoId, staleToken)
      : undefined,
  }
  const videos: SabrFormat[] = sabrMod.pickVideoFormats(info.formats, true)
  if (videos.length === 0) throw new Error("YouTube SABR 沒有影片軌")
  const qualities: VideoQualityTrack[] = videos.map(
    (video: SabrFormat): VideoQualityTrack => sabrMod.sabrQualityTrackOf(video),
  )
  const formatsById: Map<string, SabrFormat> = new Map()
  for (let i = 0; i < videos.length; i++) formatsById.set(qualities[i].id, videos[i])
  const activeSessions: Map<string, SabrQualitySession> = new Map()
  let lastPreparedId: string | null = null

  const prepareQuality = async (qualityId: string): Promise<string | null> => {
    const video: SabrFormat | undefined = formatsById.get(qualityId)
    if (!video) return null
    let entry: SabrQualitySession | undefined = activeSessions.get(qualityId)
    if (!entry) {
      for (const [id, existing] of activeSessions.entries()) {
        if (id !== lastPreparedId) {
          existing.dispose()
          activeSessions.delete(id)
        }
      }
      entry = sabrMod.createSabrQualitySession(config, video, audio)
      activeSessions.set(qualityId, entry)
    }
    const ready: boolean = await entry.prepare()
    if (!ready) {
      entry.dispose()
      activeSessions.delete(qualityId)
      return null
    }
    const track: VideoQualityTrack | undefined = qualities.find(
      (item: VideoQualityTrack): boolean => item.id === qualityId,
    )
    if (track) track.url = entry.urls.hlsUrl
    lastPreparedId = qualityId
    return entry.urls.hlsUrl
  }

  const dispose = (): void => {
    for (const entry of activeSessions.values()) entry.dispose()
    activeSessions.clear()
    lastPreparedId = null
  }

  const audioTracks: AudioStreamTrack[] = info.formats
    .filter((format: SabrFormat): boolean => format.isAudio && format.mimeType.startsWith("audio/mp4"))
    .map((format: SabrFormat): AudioStreamTrack => sabrMod.audioTrackOf(format))
  return {
    delivery: "sabr",
    primaryUrl: "",
    qualities,
    audioTracks,
    player: info.player,
    prepareQuality,
    dispose,
  }
}

export async function resolveYoutubeStream(
  videoId: string,
  mode: YoutubeStreamPreference = "auto",
  preferredHeight: number = 0,
  isLive: boolean = false,
): Promise<StreamManifest> {
  if (isLive) {
    const liveMod = await import("./live")
    return liveMod.resolveYoutubeLiveStream(videoId)
  }

  const routes: Array<(id: string) => Promise<ResolvedRoute>> =
    mode === "sabr" ? [resolveSabrRoute, resolveHlsRoute] : [resolveHlsRoute, resolveSabrRoute]
  let route: ResolvedRoute | null = null
  let chosenUrl: string | null = null
  let firstError: unknown = null
  for (const resolve of routes) {
    let candidate: ResolvedRoute | null = null
    try {
      candidate = await resolve(videoId)
      const pick: VideoQualityTrack | undefined =
        preferredHeight > 0 ? closestQuality(candidate.qualities, preferredHeight) : undefined
      if (candidate.prepareQuality) {
        const preparedUrl: string | null = await candidate.prepareQuality(pick?.id ?? candidate.qualities[0].id)
        if (!preparedUrl) throw new Error("YouTube SABR 讀不到分段索引")
        chosenUrl = preparedUrl
      } else {
        chosenUrl = pick?.url ?? candidate.primaryUrl
      }
      route = candidate
      break
    } catch (error) {
      candidate?.dispose?.()
      if (firstError === null) firstError = error
    }
  }
  if (!route) {
    try {
      const liveMod = await import("./live")
      return await liveMod.resolveYoutubeLiveStream(videoId)
    } catch {
      throw firstError instanceof Error ? firstError : new Error("找不到可播放的 YouTube 串流")
    }
  }

  const { primaryUrl, qualities, prepareQuality, dispose } = route
  const details: JsonObject = asObject(route.player["videoDetails"]) ?? {}
  const resolvedPrimaryUrl: string = chosenUrl || primaryUrl

  return {
    provider: "yt",
    rawId: videoId,
    delivery: route.delivery,
    primaryUrl: resolvedPrimaryUrl,
    backend: "native",
    qualities,
    audioTracks: route.audioTracks,
    subtitles: parseSubtitleTracks(route.player),
    isLive: Boolean(details["isLive"]),
    duration: Number(details["lengthSeconds"] ?? 0),
    resolveQuality: async (
      qualityId: string,
    ): Promise<{ url: string; backend: "auto" | "native" | "system" | "remux" }> => {
      const quality: VideoQualityTrack | undefined = qualities.find(
        (entry: VideoQualityTrack): boolean => entry.id === qualityId,
      )
      if (quality && prepareQuality) {
        const preparedUrl: string | null = await prepareQuality(quality.id)
        if (!preparedUrl) throw new Error("這個畫質暫時無法播放")
        return { url: preparedUrl, backend: "native" }
      }
      return { url: quality?.url || resolvedPrimaryUrl, backend: "native" }
    },
    dispose,
  }
}
