import type { BiliDashMedia, PreparedTrack } from "./dashMpd"
import { mediaPaths, registerMediaSession } from "../mediaServer"
import type { MediaSession, MediaTrack } from "../mediaServer"

/**
 * 直接從 dash payload 生 HLS，不經過 MPD：
 * 每段一個帶副檔名的本機網址（native 後端沒副檔名會回 no playable track），
 * 時長取 sidx 的精確值，位元組由 mediaServer 邊抓邊送。
 */

const VIDEO_ITAG: number = 1
const AUDIO_ITAG: number = 2

function trimNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")
}

function frameRateOf(media: BiliDashMedia): string {
  const raw: string | number | undefined = media.frameRate ?? media.frame_rate
  if (raw === undefined || raw === null || raw === "") return ""
  const text: string = typeof raw === "number" ? String(raw) : raw.trim()
  const direct: number = Number(text)
  if (Number.isFinite(direct) && direct > 0) return trimNumber(direct)
  // bili 有些片給 "2997/100" 這種分數；HLS 的 FRAME-RATE 只吃十進位。
  const fraction: RegExpExecArray | null = /^(\d+)\s*\/\s*(\d+)$/.exec(text)
  if (fraction) {
    const value: number = Number(fraction[1]) / Number(fraction[2])
    if (Number.isFinite(value) && value > 0) return trimNumber(value)
  }
  return text.replace(/[^0-9/.]/g, "")
}

function toMediaTrack(track: PreparedTrack, itag: number): MediaTrack {
  const index = track.index
  if (!index) throw new Error("缺少 sidx，無法產生 HLS")
  const [start, end] = index.initRange.split("-").map(Number)
  return {
    itag,
    sourceId: track.sourceId,
    mimeType: track.mimeType,
    initStart: start,
    initEnd: end,
    entries: index.sidx.entries,
  }
}

function mediaPlaylist(sessionId: string, track: MediaTrack): string {
  const durations: number[] = track.entries.map(
    (entry): number => entry.durationUs / 1_000_000,
  )
  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(Math.max(...durations)))}`,
    "#EXT-X-MEDIA-SEQUENCE:1",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MAP:URI="${mediaPaths(sessionId, track.itag, 1).init}"`,
  ]
  for (let sequence = 1; sequence <= durations.length; sequence++) {
    lines.push(
      `#EXTINF:${durations[sequence - 1].toFixed(3)},`,
      mediaPaths(sessionId, track.itag, sequence).segment,
    )
  }
  lines.push("#EXT-X-ENDLIST", "")
  return lines.join("\n")
}

function masterPlaylist(
  sessionId: string,
  video: PreparedTrack,
  audio: PreparedTrack | null,
): string {
  const media = video.media
  const qn: number = Number(media.id)
  // 125 = HDR10、126 = 杜比視界；與 ATV-Bilibili-demo 的分法一致。
  const isDolby: boolean = qn === 126
  const isHDR10: boolean = qn === 125
  const isHDR: boolean = isDolby || isHDR10
  let videoRange: string = isHDR ? "HLG" : "SDR"
  let videoCodec: string = media.codecs ?? ""
  let supplemental: string = ""
  let frameRate: string = frameRateOf(media) || "25"
  if (isHDR10) {
    videoRange = "PQ"
    if (Number(frameRate) > 30) frameRate = "30"
  }
  // DoVi 不能直接宣告 dvh1；要改回 hvc1 並用 SUPPLEMENTAL-CODECS 描述。
  if (videoCodec === "dvh1.08.07" || videoCodec === "dvh1.08.03") {
    supplemental = `${videoCodec}/db4h`
    videoCodec = "hvc1.2.4.L153.b0"
    videoRange = "HLG"
  } else if (videoCodec === "dvh1.08.06") {
    supplemental = `${videoCodec}/db1p`
    videoCodec = "hvc1.2.4.L150"
    videoRange = "PQ"
  } else if (videoCodec.startsWith("dvh1.05")) {
    videoRange = "PQ"
  }
  if (Number(frameRate) >= 60) frameRate = "60"

  const average: number = (Number(media.bandwidth) || 0) + (Number(audio?.media.bandwidth) || 0)
  const codecs: string = [videoCodec, audio?.media.codecs ?? ""]
    .filter((codec: string): boolean => codec.length > 0)
    .join(",")
  const attributes: string[] = [
    // DASH 的 bandwidth 是均值，HLS 要的是峰值；宣告太低會被 CoreMedia 判 -12318。
    `BANDWIDTH=${Math.round(average * 1.5)}`,
    `AVERAGE-BANDWIDTH=${average}`,
  ]
  if (media.width && media.height) {
    attributes.push(`RESOLUTION=${Math.round(media.width)}x${Math.round(media.height)}`)
  }
  if (frameRate) attributes.push(`FRAME-RATE=${frameRate}`)
  if (codecs) attributes.push(`CODECS="${codecs}"`)
  if (supplemental) attributes.push(`SUPPLEMENTAL-CODECS="${supplemental}"`)
  attributes.push(`VIDEO-RANGE=${videoRange}`)
  if (audio) attributes.push(`AUDIO="audio"`)

  const lines: string[] = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"]
  if (audio) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="zh",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="${
        mediaPaths(sessionId, AUDIO_ITAG, 1).media
      }"`,
    )
  }
  lines.push(
    `#EXT-X-STREAM-INF:${attributes.join(",")}`,
    mediaPaths(sessionId, VIDEO_ITAG, 1).media,
    "",
  )
  return lines.join("\n")
}

/**
 * 用已準備好的軌道註冊一個 HLS session，回傳可直接 open() 的 master 網址。
 * 沒有 sidx 就丟錯，由呼叫端決定要不要退回 MPD（軌道已準備好，不必重做）。
 */
export async function writeBiliHlsManifest(
  bvid: string,
  cid: number,
  qn: number,
  prepared: { videos: PreparedTrack[]; audio: PreparedTrack | null },
): Promise<string> {
  const selected: PreparedTrack | undefined = prepared.videos[0]
  if (!selected?.index) throw new Error("影片軌沒有 sidx，無法產生 HLS")
  const video: MediaTrack = toMediaTrack(selected, VIDEO_ITAG)
  const audio: MediaTrack | null = prepared.audio?.index
    ? toMediaTrack(prepared.audio, AUDIO_ITAG)
    : null

  const safe: string = (bvid || "unknown").replace(/[^A-Za-z0-9_-]/g, "")
  const sessionId: string = `${safe}_${cid}_${qn}_${Date.now().toString(36)}`
  const tracks: Map<number, MediaTrack> = new Map()
  tracks.set(video.itag, video)
  if (audio) tracks.set(audio.itag, audio)

  const media: Map<number, string> = new Map()
  media.set(video.itag, mediaPlaylist(sessionId, video))
  if (audio) media.set(audio.itag, mediaPlaylist(sessionId, audio))

  const session: MediaSession = {
    master: masterPlaylist(sessionId, selected, prepared.audio),
    media,
    tracks,
  }
  return registerMediaSession(sessionId, session)
}
