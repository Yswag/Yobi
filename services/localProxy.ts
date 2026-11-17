import { AbortController, fetch } from "scripting"
import type { AbortSignal } from "scripting"
import { Prefetcher } from "./prefetch"
import { recordDownload } from "./netMeter"
import { getSettings } from "./storage"
import {
  isLineBanned,
  lineScore,
  noteLineFailure,
  noteLineSample,
  pickLineToExplore,
  rankLines,
  shouldPromote,
} from "./bilibili/lines"

/**
 * 本機 HttpServer 代理。
 *
 * `HttpRequest.path` 不含 query string，因此所有參數都編進路徑：
 *   /manifest/:id/:file
 *   /bili-file/:id/:itag/file.m4s
 *   /hls-master/:sessionId/master.m3u8
 *   /hls-media/:sessionId/:itag/playlist.m3u8
 *   /sabr-init/:sessionId/:itag/init.mp4
 *   /sabr-seg/:sessionId/:itag/:seq/seg.mp4
 *   /sabr/:sessionId/master.m3u8
 *   /sabr/:sessionId/manifest.mpd
 *   /relay/:id/playlist.m3u8
 *   /relay/:id/:index/seg.ts（index 為 init 時回初始化片段）
 */

export interface SabrProxyUrls {
  /** 本地 HLS Master 位址 */
  hlsUrl: string
  /** 本地 DASH MPD 位址 */
  dashUrl: string
}

export interface SabrProxySessionHandler {
  /** 產生 HLS Master `.m3u8` 內容（可含單一畫質 + 音訊群組） */
  hlsMasterPlaylist(): string
  /** 產生指定 itag 的 media playlist `.m3u8` 內容 */
  mediaPlaylist(itag: number): string | Promise<string>
  /** 產生 DASH `.mpd` 內容 */
  dashManifest(): string | Promise<string>
  /** 取得初始化切片（fMP4 init segment） */
  initializationSegment(itag: number): Promise<Uint8Array | null>
  /** 取得第 seq 個媒體切片（seq 從 1 開始） */
  mediaSegment(itag: number, sequence: number): Promise<Uint8Array | null>
  /** 該 itag 的 MIME，用於回應 Content-Type */
  contentType?(itag: number): string | undefined
}

/**
 * 轉手外部 HLS 媒體清單：片段由這裡代抓。
 * 片段網址照 YouTube 以 `seg.ts` 結尾、類型給 octet-stream（影片片段其實是 fMP4，音訊是 ADTS AAC）：
 * 帶 `.mp4` 時播放器回 Invalid data，不帶副檔名時回 no playable track。
 */
export interface HlsRelayHandler {
  playlist(segmentUrl: (index: number) => string, initUrl: string): Promise<string>
  initialization(): Promise<Uint8Array | null>
  segment(index: number): Promise<Uint8Array | null>
}

interface VirtualManifest {
  content: string
  contentType: string
  file: string
}

const TRY_PORTS: number[] = [18920, 18921, 18922, 18923, 0]

let server: HttpServer | null = null
let serverPort: number = 0
let starting: boolean = false

const virtualManifests: Map<string, VirtualManifest> = new Map()
const sabrSessions: Map<string, SabrProxySessionHandler> = new Map()
const hlsRelays: Map<string, HlsRelayHandler> = new Map()

/**
 * bilibili 的 m4s 需要 Referer，只能由本機代理代抓。
 * 整個檔按固定 1 MB 切格子預抓；回應仍是「從起點最多一格、不超過要求的結尾」，跨格就拼兩格。
 * DASH 的子片段是明確範圍，只回到格子邊界會截斷樣本，播放器回 Invalid data。
 */
interface BiliFileSource {
  /** [0] 是 bili 發的線路，後面是它自己的備援與可以互換的鏡像。 */
  urls: string[]
  /** 大部分格子走的主線路 host。 */
  primary: string
  /** 上次換主線路的時間；主線路沒被停用就至少待滿 BILI_PRIMARY_DWELL_MS。 */
  primarySince: number
  /** 播放器最近要的格子；離它夠遠的預抓才拿去試別條線。 */
  playhead: number
  /** 正在試線的格子；播放器追上來就取消，改走主線路。 */
  exploring: Map<number, { host: string; controller: AbortController }>
  contentType: string
  /** 檔案總長，第一次拿到 Content-Range 後才知道。 */
  total: number | null
  prefetcher: Prefetcher
}

const biliFileSources: Map<string, BiliFileSource> = new Map()
/** 一格 1 MB：播放器要等整格抓完才拿得到第一個位元組，格子越大起播越慢。 */
const BILI_WINDOW_BYTES: number = 1024 * 1024
/** 32 格約 32 MB，4K 約 20 秒；影音兩軌合計仍在共用的 96 MB 上限內。 */
const BILI_PREFETCH_AHEAD: number = 32
/** 帶明確結尾的請求最多拼這麼多；4K 13 Mbps 的 5 秒子片段約 8 MB。 */
const BILI_MAX_RESPONSE_BYTES: number = 16 * 1024 * 1024
/** 單筆抓這麼久還沒回來就放棄，換下一條線。 */
const BILI_CHUNK_TIMEOUT_MS: number = 12000
/** 每幾格撥一格去試別條線，而且要離播放位置至少這麼多格。 */
const BILI_EXPLORE_EVERY: number = 8
const BILI_EXPLORE_MIN_AHEAD: number = 6
/** 試線的格子可以放棄得早：實測正常線路 1 MB 不到 1.3 秒。 */
const BILI_EXPLORE_TIMEOUT_MS: number = 4000
/** 一格超過預期的 2 倍（夹在這區間）、而且播放器在等，就同時向下一條要。 */
const BILI_HEDGE_MIN_MS: number = 800
const BILI_HEDGE_MAX_MS: number = 4000
const BILI_HEDGE_DEFAULT_MS: number = 1500
const BILI_HEDGE_POLL_MS: number = 250
/** 換主線路後至少待這麼久，除非它失敗被停用。 */
const BILI_PRIMARY_DWELL_MS: number = 60_000
/** 一格最多換幾條線重抓。 */
const BILI_MAX_TRIES: number = 3
/** 上游是 UPOS 時彼此可以互換 host；Akamai 只吃自己發的網址。各線路快慢會隨時間變，交給實際下載的分數決定。 */
const BILI_CANDIDATE_POOL: string[] = [
  "upos-sz-mirrorcosov.bilivideo.com",
  "upos-sz-mirroraliov.bilivideo.com",
  "upos-sz-mirrorhwov.bilivideo.com",
  "upos-sz-mirrorali.bilivideo.com",
  "upos-tf-all-hw.bilivideo.com",
  "upos-sz-mirrorhw.bilivideo.com",
  "upos-sz-mirrorcos.bilivideo.com",
  "upos-tf-all-tx.bilivideo.com",
]
const BILI_MAX_SOURCES: number = 48

const BILI_REQUEST_HEADERS: Record<string, string> = {
  Referer: "https://www.bilibili.com/",
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
}

const BASE_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Cache-Control": "no-store",
}

function ensureManifestFile(contentType: string): string {
  const lower: string = contentType.toLowerCase()
  if (lower.includes("mpegurl") || lower.includes("m3u8")) return "stream.m3u8"
  if (lower.includes("dash") || lower.includes("mpd")) return "stream.mpd"
  return "stream.m3u8"
}

function textResponse(content: string, contentType: string): HttpResponse {
  const body: Data | null = Data.fromRawString(content, "utf-8")
  const headers: Record<string, string> = { ...BASE_HEADERS, "Content-Type": contentType }
  // DASH 解析器需要 Content-Length 才能讀 manifest（HLS 則不需要）。
  if (body) headers["Content-Length"] = String(body.toArrayBuffer().byteLength)
  return HttpResponse.raw(200, "OK", {
    headers,
    body: body ?? undefined,
  })
}

function binaryResponse(bytes: Uint8Array, contentType: string): HttpResponse {
  const body: Data | null = Data.fromUint8Array(bytes)
  return HttpResponse.raw(200, "OK", {
    headers: {
      ...BASE_HEADERS,
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
    },
    body: body ?? undefined,
  })
}

function notFound(message: string): HttpResponse {
  const body: Data | null = Data.fromRawString(message, "utf-8")
  return HttpResponse.raw(404, "Not Found", {
    headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    body: body ?? undefined,
  })
}

function badGateway(message: string): HttpResponse {
  const body: Data | null = Data.fromRawString(message, "utf-8")
  return HttpResponse.raw(502, "Bad Gateway", {
    headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    body: body ?? undefined,
  })
}

function parseByteRange(header: string | undefined): { start: number; end: number | null } {
  const match: RegExpMatchArray | null =
    typeof header === "string" ? header.match(/bytes=(\d+)-(\d*)/) : null
  if (!match) return { start: 0, end: null }
  const start: number = Number(match[1])
  const endText: string = match[2]
  const end: number | null = endText ? Number(endText) : null
  return {
    start: Number.isFinite(start) ? start : 0,
    end: end !== null && Number.isFinite(end) ? end : null,
  }
}

function registerRoutes(target: HttpServer): void {
  target.registerAsyncHandler("/manifest/:id/:file", async (req: HttpRequest): Promise<HttpResponse> => {
    const manifest: VirtualManifest | undefined = virtualManifests.get(req.params["id"])
    if (!manifest) return notFound("unknown manifest")
    return textResponse(manifest.content, manifest.contentType)
  })

  // 播放器抓 MPD 片段時不會帶 Referer（來源是本機檔），由這裡補上；一次最多回一格。
  target.registerAsyncHandler(
    "/bili-file/:id/file.m4s",
    async (req: HttpRequest): Promise<HttpResponse> => {
      const source: BiliFileSource | undefined = biliFileSources.get(req.params["id"])
      if (!source) return notFound("unknown stream")

      if (req.method === "HEAD") {
        return HttpResponse.raw(200, "OK", {
          headers: {
            ...BASE_HEADERS,
            "Content-Type": source.contentType,
            "Accept-Ranges": "bytes",
          },
        })
      }

      const requested = parseByteRange(req.headers["range"] ?? req.headers["Range"])
      const start: number = requested.start
      const first: number = Math.floor(start / BILI_WINDOW_BYTES)
      const servedAt: number = Date.now()
      source.playhead = first
      for (const [index, entry] of source.exploring) {
        if (index <= first + 1) entry.controller.abort()
      }
      const head: Uint8Array | null = await source.prefetcher.get(first)
      const offset: number = start - first * BILI_WINDOW_BYTES
      if (!head || offset >= head.byteLength) {
        if (source.total !== null && start >= source.total) {
          return HttpResponse.raw(416, "Range Not Satisfiable", {
            headers: { ...BASE_HEADERS, "Content-Range": `bytes */${source.total}` },
          })
        }
        logPlaybackEvent(`serve 502 ${req.params["id"]} #${first} ${Date.now() - servedAt}ms`)
        return badGateway("upstream failed")
      }

      // SegmentList 的子片段帶明確結尾，要拼滿整段：截短會讓播放器回 Invalid data。
      // 沒有結尾的開放請求最多回一格，播放器會自己接著要。
      const limit: number = requested.end !== undefined ? BILI_MAX_RESPONSE_BYTES : BILI_WINDOW_BYTES
      let end: number = Math.min(requested.end ?? Number.POSITIVE_INFINITY, start + limit - 1)
      if (source.total !== null) end = Math.min(end, source.total - 1)
      const parts: Uint8Array[] = [head.subarray(offset)]
      let have: number = head.byteLength - offset
      for (let index = first + 1; start + have - 1 < end; index++) {
        const next: Uint8Array | null = await source.prefetcher.get(index)
        if (!next || next.byteLength === 0) break
        parts.push(next)
        have += next.byteLength
      }
      const length: number = Math.min(have, end - start + 1)
      let bytes: Uint8Array
      if (parts.length === 1 && offset === 0 && length === head.byteLength) {
        bytes = head
      } else {
        bytes = new Uint8Array(length)
        let written: number = 0
        for (const part of parts) {
          if (written >= length) break
          const take: number = Math.min(part.byteLength, length - written)
          bytes.set(part.subarray(0, take), written)
          written += take
        }
      }
      const serveMs: number = Date.now() - servedAt
      if (traceBiliRequests) {
        logPlaybackEvent(
          `serve ${req.params["id"].slice(-12)} req=${start}-${requested.end ?? ""} -> ${bytes.byteLength} total=${source.total} ${serveMs}ms`,
        )
      } else if (serveMs > 2000) {
        logPlaybackEvent(`serve slow ${req.params["id"]} #${first} ${serveMs}ms`)
      }
      return HttpResponse.raw(206, "Partial Content", {
        headers: {
          ...BASE_HEADERS,
          "Content-Type": source.contentType,
          "Accept-Ranges": "bytes",
          "Content-Length": String(bytes.byteLength),
          "Content-Range": `bytes ${start}-${start + bytes.byteLength - 1}/${source.total ?? "*"}`,
        },
        body: Data.fromUint8Array(bytes) ?? undefined,
      })
    },
  )

  target.registerAsyncHandler("/hls-master/:sessionId/master.m3u8", async (req: HttpRequest): Promise<HttpResponse> => {
    const handler: SabrProxySessionHandler | undefined = sabrSessions.get(req.params["sessionId"])
    if (!handler) return notFound("unknown session")
    return textResponse(handler.hlsMasterPlaylist(), "application/vnd.apple.mpegurl")
  })

  target.registerAsyncHandler("/sabr/:sessionId/master.m3u8", async (req: HttpRequest): Promise<HttpResponse> => {
    const handler: SabrProxySessionHandler | undefined = sabrSessions.get(req.params["sessionId"])
    if (!handler) return notFound("unknown session")
    return textResponse(handler.hlsMasterPlaylist(), "application/vnd.apple.mpegurl")
  })

  target.registerAsyncHandler("/sabr/:sessionId/manifest.mpd", async (req: HttpRequest): Promise<HttpResponse> => {
    const handler: SabrProxySessionHandler | undefined = sabrSessions.get(req.params["sessionId"])
    if (!handler) return notFound("unknown session")
    return textResponse(await handler.dashManifest(), "application/dash+xml")
  })

  target.registerAsyncHandler(
    "/hls-media/:sessionId/:itag/playlist.m3u8",
    async (req: HttpRequest): Promise<HttpResponse> => {
      const handler: SabrProxySessionHandler | undefined = sabrSessions.get(req.params["sessionId"])
      const itag: number = Number(req.params["itag"])
      if (!handler || !Number.isFinite(itag)) return notFound("unknown session")
      return textResponse(await handler.mediaPlaylist(itag), "application/vnd.apple.mpegurl")
    },
  )

  target.registerAsyncHandler(
    "/sabr-init/:sessionId/:itag/init.mp4",
    async (req: HttpRequest): Promise<HttpResponse> => {
      const handler: SabrProxySessionHandler | undefined = sabrSessions.get(req.params["sessionId"])
      const itag: number = Number(req.params["itag"])
      if (!handler || !Number.isFinite(itag)) return notFound("unknown session")
      const bytes: Uint8Array | null = await handler.initializationSegment(itag)
      if (!bytes) return notFound("initialization segment unavailable")
      return binaryResponse(bytes, handler.contentType?.(itag) ?? "video/mp4")
    },
  )

  target.registerAsyncHandler("/relay/:id/playlist.m3u8", async (req: HttpRequest): Promise<HttpResponse> => {
    const id: string = req.params["id"]
    const handler: HlsRelayHandler | undefined = hlsRelays.get(id)
    if (!handler) return notFound("unknown relay")
    try {
      const text: string = await handler.playlist(
        (index: number): string => `http://127.0.0.1:${serverPort}/relay/${id}/${index}/seg.ts`,
        `http://127.0.0.1:${serverPort}/relay/${id}/init/seg.ts`,
      )
      return textResponse(text, "application/vnd.apple.mpegurl")
    } catch (error) {
      return badGateway(error instanceof Error ? error.message : "playlist failed")
    }
  })

  target.registerAsyncHandler("/relay/:id/:index/seg.ts", async (req: HttpRequest): Promise<HttpResponse> => {
    const handler: HlsRelayHandler | undefined = hlsRelays.get(req.params["id"])
    if (!handler) return notFound("unknown relay")
    const isInit: boolean = req.params["index"] === "init"
    const index: number = Number(req.params["index"])
    if (!isInit && !Number.isInteger(index)) return notFound("unknown segment")
    const bytes: Uint8Array | null = await (isInit ? handler.initialization() : handler.segment(index)).catch(() => null)
    return bytes ? binaryResponse(bytes, "application/octet-stream") : badGateway("segment unavailable")
  })

  target.registerAsyncHandler(
    "/sabr-seg/:sessionId/:itag/:seq/seg.mp4",
    async (req: HttpRequest): Promise<HttpResponse> => {
      const handler: SabrProxySessionHandler | undefined = sabrSessions.get(req.params["sessionId"])
      const itag: number = Number(req.params["itag"])
      const sequence: number = Number(req.params["seq"])
      if (!handler || !Number.isFinite(itag) || !Number.isFinite(sequence)) {
        return notFound("unknown session")
      }
      const bytes: Uint8Array | null = await handler.mediaSegment(itag, sequence)
      if (!bytes) return notFound("segment unavailable")
      return binaryResponse(bytes, handler.contentType?.(itag) ?? "video/mp4")
    },
  )
}

/** 啟動本機代理（單例），回傳實際使用的 port。 */
export function ensureLocalProxyStarted(): number {
  if (server && server.state === "running" && server.port) {
    return server.port
  }
  if (starting && serverPort > 0) {
    return serverPort
  }

  starting = true
  try {
    const instance: HttpServer = new HttpServer()
    registerRoutes(instance)

    let lastError: string | null = null
    for (let i = 0; i < TRY_PORTS.length; i++) {
      const port: number = TRY_PORTS[i]
      const error: string | null = instance.start({ port, forceIPv4: true })
      if (!error) {
        server = instance
        serverPort = instance.port ?? port
        return serverPort
      }
      lastError = error
      if (port === 0) break
    }
    throw new Error(`本機代理啟動失敗：${lastError ?? "unknown error"}`)
  } finally {
    starting = false
  }
}

function hostOfUrl(value: string): string {
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return ""
  }
}

function isUposHost(host: string): boolean {
  return /^upos-[a-z0-9-]+\.bilivideo\.com$/.test(host)
}

function swappedUrl(url: string, host: string): string | null {
  try {
    const next = new URL(url)
    next.host = host
    return next.toString()
  } catch {
    return null
  }
}

/** 開關關掉時只留 bili 發的第一條線路。 */
function buildBiliCandidates(issued: string[]): string[] {
  if (!getSettings().biliLineSwitch) return issued.length ? [issued[0]] : []
  const out: string[] = []
  for (const url of issued) {
    if (url && !out.includes(url)) out.push(url)
  }
  const uposUrl: string | undefined = issued.find((url: string): boolean => isUposHost(hostOfUrl(url)))
  if (uposUrl) {
    for (const host of BILI_CANDIDATE_POOL) {
      const url: string | null = swappedUrl(uposUrl, host)
      if (url && !out.includes(url)) out.push(url)
    }
  }
  return out
}

/** 註冊虛擬 manifest 內容（m3u8 / mpd），回傳可播放的本地 URL。 */
export function registerBiliFileSource(id: string, urls: string | string[], contentType: string): string {
  const port: number = ensureLocalProxyStarted()
  const issued: string[] = (Array.isArray(urls) ? urls : [urls]).filter((value: string): boolean => !!value)
  const candidates: string[] = buildBiliCandidates(issued)
  const existing: BiliFileSource | undefined = biliFileSources.get(id)
  if (existing && existing.urls.join(" ") === candidates.join(" ")) {
    return `http://127.0.0.1:${port}/bili-file/${id}/file.m4s`
  }
  existing?.prefetcher.dispose()
  if (!existing && biliFileSources.size >= BILI_MAX_SOURCES) {
    const oldest: string | undefined = biliFileSources.keys().next().value
    if (oldest) {
      biliFileSources.get(oldest)?.prefetcher.dispose()
      biliFileSources.delete(oldest)
    }
  }
  const source: BiliFileSource = {
    urls: candidates,
    primary: hostOfUrl(candidates[0] ?? ""),
    primarySince: 0,
    playhead: 0,
    exploring: new Map(),
    contentType,
    total: null,
    prefetcher: new Prefetcher(
      {
        count: (): number | null => (source.total === null ? null : Math.ceil(source.total / BILI_WINDOW_BYTES)),
        fetch: (index: number, signal: AbortSignal): Promise<Uint8Array | null> => fetchBiliChunk(source, index, signal),
      },
      { ahead: BILI_PREFETCH_AHEAD, concurrency: 4 },
    ),
  }
  // 之前的影片已經量過哪條線快，開播就直接用。
  refreshPrimary(source, false)
  biliFileSources.set(id, source)
  return `http://127.0.0.1:${port}/bili-file/${id}/file.m4s`
}

/** 換線路的實驗紀錄；只記決策，不記每一格，寫入用 append 避免同步重寫整個檔。 */
const BILI_LINE_LOG: string = "yobi-bili-lines.log"

function logBiliLine(line: string): void {
  if (!getSettings().biliLineSwitch) return
  logPlaybackEvent(line)
}

let traceBiliRequests: boolean = false

/** 除錯用：每個 bili 片段請求都寫進紀錄。 */
export function setBiliRequestTrace(enabled: boolean): void {
  traceBiliRequests = enabled
}

/** 開片、seek、關閉與慢請求寫進同一份紀錄，卡住時才對得上時間線。 */
export function logPlaybackEvent(line: string): void {
  try {
    FileManager.appendTextSync(
      FileManager.appGroupDocumentsDirectory + "/" + BILI_LINE_LOG,
      `${new Date().toISOString()} ${line}\n`,
    )
  } catch {
    // 紀錄失敗不影響播放
  }
}

/** setTimeout 在非主 JS 隊列會直接丟錯，這裡吞掉；沒計時器只是少了客戶端逾時。 */
function armTimeout(callback: () => void, ms: number): number {
  try {
    return setTimeout(callback, ms)
  } catch {
    return -1
  }
}

function disarmTimeout(id: number): void {
  if (id < 0) return
  try {
    clearTimeout(id)
  } catch {
    // 已經沒了
  }
}

type BiliAttemptResult =
  | { ok: true; bytes: Uint8Array; ms: number; total: number | null }
  | { ok: false; ms: number; reason: string }

async function fetchBiliAttempt(
  url: string,
  start: number,
  budgetMs: number,
  signal: AbortSignal,
  trackHost: boolean,
): Promise<BiliAttemptResult> {
  const controller: AbortController = new AbortController()
  const relayAbort = (): void => controller.abort()
  signal.addEventListener("abort", relayAbort)
  let timedOut: boolean = false
  const timer: number = armTimeout((): void => {
    timedOut = true
    controller.abort()
  }, budgetMs)
  const startedAt: number = Date.now()

  try {
    const response: Awaited<ReturnType<typeof fetch>> = await fetch(url, {
      headers: { ...BILI_REQUEST_HEADERS, Range: `bytes=${start}-${start + BILI_WINDOW_BYTES - 1}` },
      signal: controller.signal,
      debugLabel: "Yobi bili chunk",
    })
    if (response.status === 416) return { ok: false, ms: Date.now() - startedAt, reason: "416" }
    if (!response.ok) return { ok: false, ms: Date.now() - startedAt, reason: `HTTP ${response.status}` }
    const total: number = Number(response.headers.get("content-range")?.split("/")[1])
    const bytes: Uint8Array = new Uint8Array(await response.arrayBuffer())
    // 試線的格子算進網速，但不是主線路，不更新面板上的「線路」。
    recordDownload(bytes.byteLength, trackHost ? url : "")
    // 伺服器忽略 Range 回整個檔時，自己切出這一格。
    const sliced: Uint8Array =
      response.status === 200 && start > 0
        ? bytes.slice(start, start + BILI_WINDOW_BYTES)
        : bytes.byteLength > BILI_WINDOW_BYTES
          ? bytes.slice(0, BILI_WINDOW_BYTES)
          : bytes
    return { ok: true, bytes: sliced, ms: Date.now() - startedAt, total: Number.isFinite(total) && total > 0 ? total : null }
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - startedAt,
      reason: signal.aborted ? "aborted" : timedOut ? `timeout ${budgetMs}ms` : String(error),
    }
  } finally {
    disarmTimeout(timer)
    try {
      signal.removeEventListener("abort", relayAbort)
    } catch {
      // 移除失敗不影響資料
    }
  }
}

let biliLineSwitchListener: ((host: string) => void) | null = null

/** 播放器想在第一行顯示「已切換線路」時掛上來。 */
export function setBiliLineSwitchListener(listener: ((host: string) => void) | null): void {
  biliLineSwitchListener = listener
}

function hostsOf(source: BiliFileSource): string[] {
  return source.urls.map(hostOfUrl)
}

function urlOfHost(source: BiliFileSource, host: string): string {
  return source.urls.find((url: string): boolean => hostOfUrl(url) === host) ?? source.urls[0]
}

/** 換到目前最快的可用線路；開播前依舊紀錄選線時不提示。 */
function refreshPrimary(source: BiliFileSource, announce: boolean): void {
  const best: string | undefined = rankLines(hostsOf(source))[0]
  if (!best || !shouldPromote(best, source.primary)) return
  const forced: boolean = isLineBanned(source.primary)
  if (!forced && Date.now() - source.primarySince < BILI_PRIMARY_DWELL_MS) return
  const from: string = source.primary
  source.primary = best
  source.primarySince = Date.now()
  logBiliLine(
    `primary ${from} ${Math.round(lineScore(from) ?? 0)} -> ${best} ${Math.round(lineScore(best) ?? 0)}ms/MB${forced ? " (banned)" : ""}`,
  )
  if (!announce || !biliLineSwitchListener) return
  try {
    biliLineSwitchListener(best)
  } catch {
    // 提示失敗不影響播放
  }
}

interface BiliOutcome {
  host: string
  result: BiliAttemptResult
}

/** 抓一格並記分；取消與 416 不算線路的錯。 */
async function attemptBiliLine(
  source: BiliFileSource,
  host: string,
  start: number,
  budgetMs: number,
  signal: AbortSignal,
  trackHost: boolean,
): Promise<BiliOutcome> {
  const result: BiliAttemptResult = await fetchBiliAttempt(urlOfHost(source, host), start, budgetMs, signal, trackHost)
  if (result.ok) {
    if (result.total !== null) source.total = result.total
    noteLineSample(host, result.ms, result.bytes.byteLength, BILI_WINDOW_BYTES)
  } else if (result.reason !== "aborted" && result.reason !== "416") {
    noteLineFailure(host)
    logBiliLine(`fail ${host} ${result.reason}`)
  }
  return { host, result }
}

/**
 * 主線路超過預期還沒回來、而且播放器已經在等這格，就同時向下一條要，先到先用。
 * 預抓發出的格子也適用：發出時還很遠，卡住後播放器可能已經追上來。
 */
async function fetchBiliHedged(
  source: BiliFileSource,
  index: number,
  primary: string,
  backup: string,
  start: number,
  signal: AbortSignal,
): Promise<BiliOutcome[]> {
  const expected: number = lineScore(primary) ?? BILI_HEDGE_DEFAULT_MS
  const delay: number = Math.min(BILI_HEDGE_MAX_MS, Math.max(BILI_HEDGE_MIN_MS, expected * 2))
  const first: AbortController = new AbortController()
  const second: AbortController = new AbortController()
  const relayAbort = (): void => {
    first.abort()
    second.abort()
  }
  signal.addEventListener("abort", relayAbort)
  const startedAt: number = Date.now()
  const outcomes: BiliOutcome[] = []
  let timer: number = -1

  try {
    const winner: BiliOutcome = await new Promise<BiliOutcome>((resolve: (outcome: BiliOutcome) => void): void => {
      let launched: number = 1
      let failures: number = 0
      let done: boolean = false
      const settle = (outcome: BiliOutcome): void => {
        outcomes.push(outcome)
        if (done) return
        if (outcome.result.ok) {
          done = true
          resolve(outcome)
          return
        }
        failures++
        if (failures >= launched) {
          done = true
          resolve(outcome)
        }
      }
      void attemptBiliLine(source, primary, start, BILI_CHUNK_TIMEOUT_MS, first.signal, true).then(settle)
      const check = (): void => {
        if (done) return
        if (index - source.playhead > 1) {
          timer = armTimeout(check, BILI_HEDGE_POLL_MS)
          return
        }
        launched++
        logBiliLine(`hedge #${index} ${primary} +${Date.now() - startedAt}ms -> ${backup}`)
        void attemptBiliLine(source, backup, start, BILI_CHUNK_TIMEOUT_MS, second.signal, true).then(settle)
      }
      timer = armTimeout(check, delay)
    })
    if (winner.result.ok && winner.host === backup) {
      // 主線路沒抓完就被取消，用它已經花掉的時間記一筆，分數才會反映它變慢了。
      noteLineSample(primary, Date.now() - startedAt, BILI_WINDOW_BYTES, BILI_WINDOW_BYTES)
      first.abort()
    } else {
      second.abort()
    }
    return [winner, ...outcomes.filter((outcome: BiliOutcome): boolean => outcome !== winner)]
  } finally {
    disarmTimeout(timer)
    try {
      signal.removeEventListener("abort", relayAbort)
    } catch {
      // 移除失敗不影響資料
    }
  }
}

async function fetchBiliChunk(source: BiliFileSource, index: number, signal: AbortSignal): Promise<Uint8Array | null> {
  const start: number = index * BILI_WINDOW_BYTES
  if (source.total !== null && start >= source.total) return null
  if (!source.urls.length) return null
  const hosts: string[] = hostsOf(source)
  const distance: number = index - source.playhead
  const tried: Set<string> = new Set()

  // 離播放位置夠遠的格子才拿去試別條線；試輸了也還來得及用主線路補。
  if (hosts.length > 1 && distance >= BILI_EXPLORE_MIN_AHEAD && index % BILI_EXPLORE_EVERY === 0) {
    const busy: string[] = [...source.exploring.values()].map((entry): string => entry.host)
    const host: string | null = pickLineToExplore(hosts, source.primary, busy)
    if (host) {
      const controller: AbortController = new AbortController()
      const relayAbort = (): void => controller.abort()
      signal.addEventListener("abort", relayAbort)
      source.exploring.set(index, { host, controller })
      const startedAt: number = Date.now()
      let outcome: BiliOutcome
      try {
        outcome = await attemptBiliLine(source, host, start, BILI_EXPLORE_TIMEOUT_MS, controller.signal, false)
      } finally {
        source.exploring.delete(index)
        try {
          signal.removeEventListener("abort", relayAbort)
        } catch {
          // 移除失敗不影響資料
        }
      }
      if (outcome.result.ok) {
        refreshPrimary(source, true)
        return outcome.result.bytes
      }
      if (signal.aborted || outcome.result.reason === "416") return null
      if (outcome.result.reason === "aborted") {
        // 沒抓完就被搬回來：至少這麼慢，記一筆，明顯慢的線就不會马上又被拿去試。
        // 只知道「至少這麼慢」，當整格記分會冤枉剛好被打斷的快線，不記。
        logBiliLine(`preempt ${host} ${Date.now() - startedAt}ms`)
      }
      tried.add(host)
    }
  }

  refreshPrimary(source, true)
  const order: string[] = [source.primary, ...rankLines(hosts).filter((host: string): boolean => host !== source.primary)]
    .filter((host: string): boolean => !tried.has(host))
    .slice(0, BILI_MAX_TRIES)
  let lastReason: string = "no line"
  for (let i = 0; i < order.length; i++) {
    const host: string = order[i]
    if (tried.has(host)) continue
    const backup: string | undefined = order.slice(i + 1).find((next: string): boolean => !tried.has(next))
    const outcomes: BiliOutcome[] = backup
      ? await fetchBiliHedged(source, index, host, backup, start, signal)
      : [await attemptBiliLine(source, host, start, BILI_CHUNK_TIMEOUT_MS, signal, true)]
    const winner: BiliOutcome = outcomes[0]
    if (winner.result.ok) {
      refreshPrimary(source, true)
      return winner.result.bytes
    }
    if (signal.aborted || winner.result.reason === "416") return null
    for (const outcome of outcomes) tried.add(outcome.host)
    tried.add(host)
    lastReason = winner.result.reason
  }
  // 丟例外而不是回 null：回 null 會被預抓器當成檔案結尾。
  throw new Error(`bili chunk ${index}: ${lastReason}`)
}

export function registerVirtualManifest(id: string, content: string, contentType: string): string {
  const port: number = ensureLocalProxyStarted()
  const file: string = ensureManifestFile(contentType)
  virtualManifests.set(id, { content, contentType, file })
  return `http://127.0.0.1:${port}/manifest/${id}/${file}`
}

/** 更新已註冊虛擬 manifest 的內容（保持同一 URL）。 */
export function updateVirtualManifest(id: string, content: string): void {
  const existing: VirtualManifest | undefined = virtualManifests.get(id)
  if (existing) {
    existing.content = content
  }
}

/** 註冊 SABR session 的切片處理器，回傳本地 HLS Master 與 DASH MPD URL。 */
export function registerSabrSessionHandler(sessionId: string, handler: SabrProxySessionHandler): SabrProxyUrls {
  const port: number = ensureLocalProxyStarted()
  sabrSessions.set(sessionId, handler)
  return {
    hlsUrl: `http://127.0.0.1:${port}/sabr/${sessionId}/master.m3u8`,
    dashUrl: `http://127.0.0.1:${port}/sabr/${sessionId}/manifest.mpd`,
  }
}

/** 取得已註冊 session 的 URL（未註冊時為 null）。 */
export function getSabrProxyUrls(sessionId: string): SabrProxyUrls | null {
  if (!sabrSessions.has(sessionId) || !serverPort) return null
  return {
    hlsUrl: `http://127.0.0.1:${serverPort}/sabr/${sessionId}/master.m3u8`,
    dashUrl: `http://127.0.0.1:${serverPort}/sabr/${sessionId}/manifest.mpd`,
  }
}

/** 註冊 HLS 轉手，回傳本機媒體清單網址。 */
export function registerHlsRelayHandler(id: string, handler: HlsRelayHandler): string {
  const port: number = ensureLocalProxyStarted()
  hlsRelays.set(id, handler)
  return `http://127.0.0.1:${port}/relay/${id}/playlist.m3u8`
}

export function unregisterHlsRelayHandler(id: string): void {
  hlsRelays.delete(id)
}

/** 移除 SABR session。 */
export function unregisterSabrSessionHandler(sessionId: string): void {
  sabrSessions.delete(sessionId)
}

/** 目前代理是否已啟動。 */
export function isLocalProxyRunning(): boolean {
  return server !== null && server.state === "running"
}

/** 目前代理 port（未啟動為 0）。 */
export function getLocalProxyPort(): number {
  return serverPort
}

/** 停止本機代理並清空所有註冊資源。 */
export function stopLocalProxy(): void {
  virtualManifests.clear()
  sabrSessions.clear()
  hlsRelays.clear()
  for (const source of biliFileSources.values()) source.prefetcher.dispose()
  biliFileSources.clear()
  if (server) {
    try {
      server.stop()
    } catch (_error) {
      // 忽略停止時的錯誤
    }
  }
  server = null
  serverPort = 0
}
