import type {
  AudioStreamTrack,
  StreamManifest,
  SubtitleTrackInfo,
  VideoQualityTrack,
} from "../../types"
import { effectiveResolution } from "../../utils/format"
import { unregisterMediaSession } from "../mediaServer"
import type { BiliDashMedia, BiliDashPayload } from "./dashMpd"
import {
  AUDIO_LABELS,
  BILI_API,
  BILI_HEADERS,
  fetchView,
  imageUrl,
  parseFrameRate,
  QN_HEIGHTS,
  resolveIds,
} from "./meta"
import { biliFetchJson } from "./wbi"

function mediaUrlOf(media: BiliDashMedia): string {
  return imageUrl(
    media.baseUrl || media.base_url || (media.backupUrl ?? media.backup_url ?? [])[0] || "",
  )
}

function codecName(media: BiliDashMedia): string {
  const codecid: number = Number(media.codecid)
  if (codecid === 7) return "AVC"
  if (codecid === 12) return "HEVC"
  if (codecid === 13) return "AV1"
  const codecs: string = (media.codecs ?? "").toLowerCase()
  if (codecs.startsWith("avc") || codecs.startsWith("h264")) return "AVC"
  if (codecs.startsWith("hev") || codecs.startsWith("hvc")) return "HEVC"
  if (codecs.startsWith("av01")) return "AV1"
  return media.codecs || "unknown"
}

function isUhd(media: BiliDashMedia): boolean {
  const height: number = Number(media.height) || QN_HEIGHTS[Number(media.id)] || 0
  return height >= 2160
}

function codecScore(media: BiliDashMedia): number {
  const name: string = codecName(media)
  const height: number = Number(media.height) || QN_HEIGHTS[Number(media.id)] || 0
  if (height >= 4320) {
    if (name === "AV1") return 3
    if (name === "HEVC") return 2
    return 0
  }
  if (name === "AVC") return height >= 2160 ? 0 : 3
  if (name === "HEVC") return 2
  if (name === "AV1") return 1
  return 0
}

function qualityLabel(media: BiliDashMedia): string {
  const height: number = Number(media.height) || QN_HEIGHTS[Number(media.id)] || 0
  const fps: number = parseFrameRate(media.frameRate ?? media.frame_rate)
  const fpsSuffix: string = fps >= 50 ? "60" : ""
  if (height >= 4320) return `8K${fpsSuffix}`
  if (height >= 2160) return `4K${fpsSuffix}`
  if (height >= 1440) return `2K${fpsSuffix}`
  if (height > 0) return `${height}p${fpsSuffix}`
  return `${Number(media.id) || 0}p`
}

function buildAudioTracks(dash: BiliDashPayload): AudioStreamTrack[] {
  const tracks: AudioStreamTrack[] = []
  const seen: Set<string> = new Set()
  const push = (media: BiliDashMedia | null | undefined, labelOverride?: string): void => {
    if (!media) return
    const url: string = mediaUrlOf(media)
    if (!url) return
    const id: string = String(media.id)
    if (seen.has(id)) return
    seen.add(id)
    const bitrate: number = Number(media.bandwidth) || 0
    tracks.push({
      id,
      label:
        labelOverride ??
        AUDIO_LABELS[Number(media.id)] ??
        `${Math.max(1, Math.round(bitrate / 1000))}kbps`,
      bitrate,
      codec: media.codecs ?? (media.mimeType ?? media.mime_type) ?? "mp4a.40.2",
      mimeType: media.mimeType ?? media.mime_type ?? "audio/mp4",
      url,
    })
  }

  for (const media of dash.audio ?? []) push(media)
  for (const media of dash.dolby?.audio ?? []) push(media, "Dolby Atmos")
  push(dash.flac?.audio ?? null, "Hi-Res")
  return tracks
}

function buildQualityTracks(dash: BiliDashPayload): VideoQualityTrack[] {
  const grouped: Map<number, BiliDashMedia[]> = new Map()
  for (const media of dash.video ?? []) {
    const qn: number = Number(media.id)
    if (!Number.isFinite(qn)) continue
    if (!mediaUrlOf(media)) continue
    const list: BiliDashMedia[] = grouped.get(qn) ?? []
    list.push(media)
    grouped.set(qn, list)
  }

  const tracks: VideoQualityTrack[] = []
  for (const [qn, list] of grouped) {
    const pool: BiliDashMedia[] = isUhd(list[0])
      ? list.filter((media: BiliDashMedia): boolean => codecName(media) !== "AVC")
      : list
    if (!pool.length) continue
    const best: BiliDashMedia = pool
      .slice()
      .sort(
        (a: BiliDashMedia, b: BiliDashMedia): number =>
          codecScore(b) - codecScore(a) || (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0),
      )[0]
    tracks.push({
      id: String(qn),
      label: qualityLabel(best),
      width: Number(best.width) || 0,
      height: Number(best.height) || QN_HEIGHTS[qn] || 0,
      fps: parseFrameRate(best.frameRate ?? best.frame_rate) || undefined,
      bitrate: Number(best.bandwidth) || undefined,
      codec: codecName(best),
      delivery: "dash",
      url: mediaUrlOf(best),
      headers: { ...BILI_HEADERS },
      qn,
    })
  }

  tracks.sort(
    (a: VideoQualityTrack, b: VideoQualityTrack): number =>
      b.height - a.height || (b.fps ?? 0) - (a.fps ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0),
  )
  return tracks
}

function pickDefaultQuality(
  qualities: VideoQualityTrack[],
  preferredHeight?: number,
): VideoQualityTrack | null {
  if (!qualities.length) return null
  const preferred: number = preferredHeight && preferredHeight > 0 ? preferredHeight : 1080
  const resolutionOf = (track: VideoQualityTrack): number =>
    effectiveResolution(track.width, track.height)
  const ascending: VideoQualityTrack[] = qualities
    .slice()
    .sort(
      (a: VideoQualityTrack, b: VideoQualityTrack): number =>
        resolutionOf(a) - resolutionOf(b) || (a.fps ?? 0) - (b.fps ?? 0),
    )

  const withinLimit: VideoQualityTrack[] = ascending.filter((track: VideoQualityTrack): boolean => {
    const res: number = resolutionOf(track)
    return res > 0 && res <= preferred
  })
  if (withinLimit.length) return withinLimit[withinLimit.length - 1]

  const known: VideoQualityTrack[] = ascending.filter(
    (track: VideoQualityTrack): boolean => resolutionOf(track) > 0,
  )
  if (known.length) return known[0]
  return ascending[0]
}

async function buildBiliPlayable(
  bvid: string,
  cid: number,
  dash: BiliDashPayload,
  qn: number,
): Promise<{ url: string; delivery: "hls" | "dash"; proxyFailed: boolean; sessionId?: string }> {
  const dashMod = await import("./dashMpd")
  const prepared = await dashMod.prepareBiliPlayback(bvid, cid, dash, qn)
  if (prepared.videos[0]?.index) {
    try {
      const hlsMod = await import("./hls")
      const hls = await hlsMod.writeBiliHlsSession(bvid, cid, qn, prepared)
      return {
        url: hls.url,
        delivery: "hls",
        proxyFailed: prepared.proxyFailed,
        sessionId: hls.sessionId,
      }
    } catch {
    }
  }
  return {
    url: await dashMod.writeBiliDashMpdFromPrepared(bvid, cid, dash, qn, prepared),
    delivery: "dash",
    proxyFailed: prepared.proxyFailed,
  }
}

export async function resolveBiliStream(
  bvid: string,
  cid?: number,
  preferredHeight?: number,
): Promise<StreamManifest> {
  const ids = await resolveIds(bvid)
  const resolvedBvid: string | undefined = ids.bvid
  if (!resolvedBvid) throw new Error("缺少 BV 號")

  let resolvedCid: number | undefined = cid
  let fallbackDuration: number = 0
  let fallbackAid: number | undefined = ids.aid

  if (!resolvedCid) {
    const view: any = await fetchView(resolvedBvid)
    if (view?.code !== 0 || !view.data?.cid) {
      throw new Error(view?.message || "無法取得影片資訊")
    }
    resolvedCid = Number(view.data.cid)
    fallbackDuration = Number(view.data.duration) || 0
    fallbackAid = Number(view.data.aid) || fallbackAid
  }

  const playParams: Record<string, string | number> = {
    bvid: resolvedBvid,
    cid: resolvedCid,
    fnval: 4048,
    fnver: 0,
    fourk: 1,
    qn: 120,
  }
  if (fallbackAid) playParams.aid = fallbackAid

  const play: any = await biliFetchJson<any>(
    `${BILI_API}/x/player/wbi/playurl`,
    playParams,
    true,
  )
  if (play?.code !== 0 || !play.data) {
    throw new Error(play?.message || "無法取得播放位址")
  }

  const data = play.data
  const streamCid: number = Number(resolvedCid)
  const danmakuXmlUrl: string = `https://comment.bilibili.com/${streamCid}.xml`
  const dash: BiliDashPayload | undefined = data.dash
  const resolveSubtitles = async (): Promise<SubtitleTrackInfo[]> => {
    const subMod = await import("./subtitles")
    return subMod.fetchBiliSubtitleTracks(resolvedBvid, streamCid)
  }
  const subtitles: SubtitleTrackInfo[] = []

  if (dash && Array.isArray(dash.video) && dash.video.length) {
    const duration: number =
      Number(dash.duration) ||
      (Number(data.timelength) ? Number(data.timelength) / 1000 : 0) ||
      fallbackDuration
    const qualities: VideoQualityTrack[] = buildQualityTracks(dash)
    const selected: VideoQualityTrack | null = pickDefaultQuality(qualities, preferredHeight)
    const defaultQn: number = selected?.qn ?? Number(selected?.id) ?? 0
    const sessionIds: Set<string> = new Set()
    const primary = await buildBiliPlayable(resolvedBvid, streamCid, dash, defaultQn)
    if (primary.sessionId) sessionIds.add(primary.sessionId)
    const audioTracks: AudioStreamTrack[] = buildAudioTracks(dash)

    const manifest: StreamManifest = {
      provider: "bili",
      rawId: resolvedBvid,
      delivery: primary.delivery,
      primaryUrl: primary.url,
      backend: "native",
      headers: { ...BILI_HEADERS },
      qualities,
      audioTracks,
      subtitles,
      resolveSubtitles,
      danmakuXmlUrl,
      cid: streamCid,
      isLive: false,
      duration,
      warnings: primary.proxyFailed
        ? ["本機代理未啟動；片段直連 CDN 會被拒（實測 403），播放可能起不來"]
        : undefined,
      resolveQuality: async (qualityId: string) => {
        const parsed: number = Number.parseInt(qualityId, 10)
        const qn: number =
          Number.isFinite(parsed) && qualities.some((track: VideoQualityTrack): boolean => track.qn === parsed)
            ? parsed
            : defaultQn
        const next = await buildBiliPlayable(resolvedBvid, streamCid, dash, qn)
        if (next.sessionId) sessionIds.add(next.sessionId)
        return {
          url: next.url,
          backend: "native",
          headers: { ...BILI_HEADERS },
        }
      },
      dispose: (): void => {
        for (const id of sessionIds) unregisterMediaSession(id)
        sessionIds.clear()
      },
    }
    return manifest
  }

  const durl: any[] | undefined = Array.isArray(data.durl) ? data.durl : undefined
  if (durl && durl.length && typeof durl[0]?.url === "string") {
    const duration: number =
      (Number(data.timelength) ? Number(data.timelength) / 1000 : 0) || fallbackDuration
    const qn: number = Number(data.quality) || Number((data.accept_quality ?? [])[0]) || 0
    const height: number = QN_HEIGHTS[qn] || 0
    const quality: VideoQualityTrack = {
      id: String(qn),
      label: height ? `${height}p` : `${qn || "Auto"}`,
      width: 0,
      height,
      delivery: "progressive",
      url: durl[0].url,
      headers: { ...BILI_HEADERS },
      qn,
    }
    return {
      provider: "bili",
      rawId: resolvedBvid,
      delivery: "progressive",
      primaryUrl: durl[0].url,
      backend: "native",
      headers: { ...BILI_HEADERS },
      qualities: [quality],
      audioTracks: [],
      subtitles,
      resolveSubtitles,
      danmakuXmlUrl,
      cid: streamCid,
      isLive: false,
      duration,
    }
  }

  throw new Error("找不到可用的串流格式")
}
