import { reportError } from "./errors"

export interface SabrProxyUrls {
  hlsUrl: string
  dashUrl: string
}

export interface SabrProxySessionHandler {
  hlsMasterPlaylist(): string
  mediaPlaylist(itag: number): string | Promise<string>
  dashManifest(): string | Promise<string>
  initializationSegment(itag: number): Promise<Uint8Array | null>
  mediaSegment(itag: number, sequence: number): Promise<Uint8Array | null>
  contentType?(itag: number): string | undefined
}

export interface HlsRelayHandler {
  playlist(segmentUrl: (index: number) => string, initUrl: string): Promise<string>
  initialization(): Promise<Uint8Array | null>
  segment(index: number): Promise<Uint8Array | null>
}

export type RangeReadResult =
  | { status: "ok"; bytes: Uint8Array; total: number | null }
  | { status: "range_not_satisfiable"; total: number }
  | { status: "error"; message: string }

export interface RangeFileHandler {
  readonly contentType: string
  readRange(start: number, end: number | null): Promise<RangeReadResult>
  dispose?(): void
}

interface VirtualManifest {
  content: string
  contentType: string
  file: string
}

const TRY_PORTS: number[] = [18920, 18921, 18922, 18923, 0]
const MAX_VIRTUAL_MANIFESTS: number = 32

let server: HttpServer | null = null
let serverPort: number = 0
let starting: boolean = false

const virtualManifests: Map<string, VirtualManifest> = new Map()
const sabrSessions: Map<string, SabrProxySessionHandler> = new Map()
const hlsRelays: Map<string, HlsRelayHandler> = new Map()
const rangeFiles: Map<string, RangeFileHandler> = new Map()

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

  target.registerAsyncHandler("/file/:id/file.m4s", async (req: HttpRequest): Promise<HttpResponse> => {
    const handler: RangeFileHandler | undefined = rangeFiles.get(req.params["id"])
    if (!handler) return notFound("unknown stream")

    if (req.method === "HEAD") {
      return HttpResponse.raw(200, "OK", {
        headers: {
          ...BASE_HEADERS,
          "Content-Type": handler.contentType,
          "Accept-Ranges": "bytes",
        },
      })
    }

    const requested: { start: number; end: number | null } = parseByteRange(
      req.headers["range"] ?? req.headers["Range"],
    )
    const result: RangeReadResult = await handler.readRange(requested.start, requested.end)
    if (result.status === "range_not_satisfiable") {
      return HttpResponse.raw(416, "Range Not Satisfiable", {
        headers: { ...BASE_HEADERS, "Content-Range": `bytes */${result.total}` },
      })
    }
    if (result.status === "error") {
      return badGateway(result.message)
    }
    return HttpResponse.raw(206, "Partial Content", {
      headers: {
        ...BASE_HEADERS,
        "Content-Type": handler.contentType,
        "Accept-Ranges": "bytes",
        "Content-Length": String(result.bytes.byteLength),
        "Content-Range": `bytes ${requested.start}-${requested.start + result.bytes.byteLength - 1}/${result.total ?? "*"}`,
      },
      body: Data.fromUint8Array(result.bytes) ?? undefined,
    })
  })

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

export function registerRangeFileHandler(id: string, handler: RangeFileHandler): string {
  const port: number = ensureLocalProxyStarted()
  rangeFiles.set(id, handler)
  return `http://127.0.0.1:${port}/file/${id}/file.m4s`
}

export function unregisterRangeFileHandler(id: string): void {
  rangeFiles.delete(id)
}

export function registerVirtualManifest(id: string, content: string, contentType: string): string {
  const port: number = ensureLocalProxyStarted()
  const file: string = ensureManifestFile(contentType)
  virtualManifests.delete(id)
  while (virtualManifests.size >= MAX_VIRTUAL_MANIFESTS) {
    const oldestId: string | undefined = virtualManifests.keys().next().value
    if (oldestId === undefined) break
    virtualManifests.delete(oldestId)
  }
  virtualManifests.set(id, { content, contentType, file })
  return `http://127.0.0.1:${port}/manifest/${id}/${file}`
}

export function unregisterVirtualManifest(id: string): void {
  virtualManifests.delete(id)
}

export function updateVirtualManifest(id: string, content: string): void {
  const existing: VirtualManifest | undefined = virtualManifests.get(id)
  if (existing) {
    existing.content = content
  }
}

export function registerSabrSessionHandler(sessionId: string, handler: SabrProxySessionHandler): SabrProxyUrls {
  const port: number = ensureLocalProxyStarted()
  sabrSessions.set(sessionId, handler)
  return {
    hlsUrl: `http://127.0.0.1:${port}/sabr/${sessionId}/master.m3u8`,
    dashUrl: `http://127.0.0.1:${port}/sabr/${sessionId}/manifest.mpd`,
  }
}

export function getSabrProxyUrls(sessionId: string): SabrProxyUrls | null {
  if (!sabrSessions.has(sessionId) || !serverPort) return null
  return {
    hlsUrl: `http://127.0.0.1:${serverPort}/sabr/${sessionId}/master.m3u8`,
    dashUrl: `http://127.0.0.1:${serverPort}/sabr/${sessionId}/manifest.mpd`,
  }
}

export function registerHlsRelayHandler(id: string, handler: HlsRelayHandler): string {
  const port: number = ensureLocalProxyStarted()
  hlsRelays.set(id, handler)
  return `http://127.0.0.1:${port}/relay/${id}/playlist.m3u8`
}

export function unregisterHlsRelayHandler(id: string): void {
  hlsRelays.delete(id)
}

export function unregisterSabrSessionHandler(sessionId: string): void {
  sabrSessions.delete(sessionId)
}

export function isLocalProxyRunning(): boolean {
  return server !== null && server.state === "running"
}

export function getLocalProxyPort(): number {
  return serverPort
}

export function stopLocalProxy(): void {
  virtualManifests.clear()
  sabrSessions.clear()
  hlsRelays.clear()
  const handlers: RangeFileHandler[] = [...rangeFiles.values()]
  rangeFiles.clear()
  for (const handler of handlers) {
    try {
      handler.dispose?.()
    } catch (error) {
      reportError("proxy", "rangeFile.dispose", error)
    }
  }
  if (server) {
    try {
      server.stop()
    } catch (error) {
      reportError("proxy", "server.stop", error)
    }
  }
  server = null
  serverPort = 0
}
