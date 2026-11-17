import { AbortController, fetch } from "scripting"
import type { AbortSignal } from "scripting"
import { Prefetcher } from "./prefetch"

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
  url: string
  contentType: string
  /** 檔案總長，第一次拿到 Content-Range 後才知道。 */
  total: number | null
  prefetcher: Prefetcher
}

const biliFileSources: Map<string, BiliFileSource> = new Map()
/** 一格 1 MB：4K 時單筆要的回應更短，卡住的尾巴也短。 */
const BILI_WINDOW_BYTES: number = 1024 * 1024
/** 一格變小，預抓就要拉長，不然可緩衝的秒數反而變少。 */
const BILI_PREFETCH_AHEAD: number = 16
/** 單筆抓這麼久還沒回來就放棄，交給預抓器重試。 */
const BILI_CHUNK_TIMEOUT_MS: number = 12000
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
      const head: Uint8Array | null = await source.prefetcher.get(first)
      const offset: number = start - first * BILI_WINDOW_BYTES
      if (!head || offset >= head.byteLength) {
        if (source.total !== null && start >= source.total) {
          return HttpResponse.raw(416, "Range Not Satisfiable", {
            headers: { ...BASE_HEADERS, "Content-Range": `bytes */${source.total}` },
          })
        }
        return badGateway("upstream failed")
      }

      let end: number = Math.min(requested.end ?? Number.POSITIVE_INFINITY, start + BILI_WINDOW_BYTES - 1)
      if (source.total !== null) end = Math.min(end, source.total - 1)
      const headEnd: number = first * BILI_WINDOW_BYTES + head.byteLength - 1
      let bytes: Uint8Array
      if (end <= headEnd) {
        bytes = offset === 0 && end === headEnd ? head : head.slice(offset, end - first * BILI_WINDOW_BYTES + 1)
      } else {
        // 跨格：接上下一格（已在預抓範圍內）。
        const tail: Uint8Array | null = await source.prefetcher.get(first + 1)
        const tailLength: number = tail ? Math.min(tail.byteLength, end - headEnd) : 0
        bytes = new Uint8Array(head.byteLength - offset + tailLength)
        bytes.set(head.subarray(offset), 0)
        if (tail && tailLength > 0) bytes.set(tail.subarray(0, tailLength), head.byteLength - offset)
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

/** 註冊虛擬 manifest 內容（m3u8 / mpd），回傳可播放的本地 URL。 */
export function registerBiliFileSource(id: string, url: string, contentType: string): string {
  const port: number = ensureLocalProxyStarted()
  const existing: BiliFileSource | undefined = biliFileSources.get(id)
  if (existing && existing.url === url) return `http://127.0.0.1:${port}/bili-file/${id}/file.m4s`
  existing?.prefetcher.dispose()
  if (!existing && biliFileSources.size >= BILI_MAX_SOURCES) {
    const oldest: string | undefined = biliFileSources.keys().next().value
    if (oldest) {
      biliFileSources.get(oldest)?.prefetcher.dispose()
      biliFileSources.delete(oldest)
    }
  }
  const source: BiliFileSource = {
    url,
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
  biliFileSources.set(id, source)
  return `http://127.0.0.1:${port}/bili-file/${id}/file.m4s`
}

async function fetchBiliChunk(source: BiliFileSource, index: number, signal: AbortSignal): Promise<Uint8Array | null> {
  const start: number = index * BILI_WINDOW_BYTES
  if (source.total !== null && start >= source.total) return null

  const controller: AbortController = new AbortController()
  const relayAbort = (): void => controller.abort()
  signal.addEventListener("abort", relayAbort)
  const timer: number = setTimeout((): void => controller.abort(), BILI_CHUNK_TIMEOUT_MS)

  try {
    const response: Awaited<ReturnType<typeof fetch>> = await fetch(source.url, {
      headers: { ...BILI_REQUEST_HEADERS, Range: `bytes=${start}-${start + BILI_WINDOW_BYTES - 1}` },
      signal: controller.signal,
      debugLabel: "Yobi bili chunk",
    })
    if (response.status === 416) return null
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const total: number = Number(response.headers.get("content-range")?.split("/")[1])
    if (Number.isFinite(total) && total > 0) source.total = total
    const bytes: Uint8Array = new Uint8Array(await response.arrayBuffer())
    // 伺服器忽略 Range 回整個檔時，自己切出這一格。
    if (response.status === 200 && start > 0) return bytes.slice(start, start + BILI_WINDOW_BYTES)
    return bytes.byteLength > BILI_WINDOW_BYTES ? bytes.slice(0, BILI_WINDOW_BYTES) : bytes
  } catch (error) {
    if (signal.aborted) return null
    throw error
  } finally {
    clearTimeout(timer)
    try {
      signal.removeEventListener("abort", relayAbort)
    } catch {
      // 移除失敗不影響資料
    }
  }
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
