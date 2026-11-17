import { createServer } from "node:net"
import type { Server, Socket } from "node:net"
import { getBiliStreamAccess } from "./localProxy"
import type { BiliStreamAccess } from "./localProxy"
import type { SidxEntry } from "./sidx"

/**
 * 串流用的本機 HTTP 伺服器（node:net 自寫 HTTP/1.1）。
 * 只在回應「媒體位元組」時使用：先送 header、每抓一格就寫一段、socket 關閉就停手。
 * 清單只有幾 KB，順便同源供檔，讓播放器不必跨 port 解析相對網址。
 */

/** 一條軌在 HLS 裡需要的東西；位元組仍由 localProxy 的預抓器提供。 */
export interface MediaTrack {
  itag: number
  /** localProxy 的來源 id（registerBiliFileSource 回傳的那個）。 */
  sourceId: string
  mimeType: string
  initStart: number
  initEnd: number
  entries: readonly SidxEntry[]
}

export interface MediaSession {
  master: string
  /** itag → media playlist 內容。 */
  media: Map<number, string>
  tracks: Map<number, MediaTrack>
}

interface Session {
  session: MediaSession
  /** 追蹤每條軌的預抓器，順便讓同一個 sourceId 不必重查。 */
  access: Map<number, BiliStreamAccess>
}

const PIPELINE: number = 6
// 等格子時沒東西可寫，socket 閒置時間不能比單格逾時短，不然會被自己砍掉。
const IDLE_TIMEOUT_MS: number = 60000
/** 同一格最多要幾次（預抓器內部已經會重試一次）。 */
const GRID_TRIES: number = 3

const sessions: Map<string, Session> = new Map()
let server: Server | null = null
let serverPort: number = 0
let starting: Promise<number> | null = null

function headerBlock(status: string, headers: Record<string, string>): string {
  const lines: string[] = [`HTTP/1.1 ${status}`]
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
  lines.push("Connection: close", "", "")
  return lines.join("\r\n")
}

/** HTTP 要求標頭都是 ASCII；逐位元組組字串比 Buffer 型別可靠。 */
function latin1(bytes: Uint8Array): string {
  let out: string = ""
  for (let index = 0; index < bytes.length; index++) out += String.fromCharCode(bytes[index])
  return out
}

async function writeChunk(socket: Socket, bytes: Uint8Array): Promise<boolean> {
  if (socket.destroyed) return false
  if (socket.write(bytes)) return true
  return new Promise<boolean>((resolve): void => {
    const finish = (ok: boolean): void => {
      clearTimeout(timer)
      socket.off("drain", onDrain)
      socket.off("close", onClose)
      resolve(ok)
    }
    const onDrain = (): void => finish(true)
    const onClose = (): void => finish(false)
    const timer = setTimeout((): void => finish(false), IDLE_TIMEOUT_MS)
    socket.once("drain", onDrain)
    socket.once("close", onClose)
  })
}

/** 最近一次抓不到片段的說明，給播放統計面板看。 */
let lastFailure: string | null = null

function noteFailure(text: string): void {
  lastFailure = text
}

export function lastMediaFailure(): string | null {
  return lastFailure
}

/** 要一格；失敗就再要一次，換線路由 localProxy 自己處理。 */
async function fetchGrid(access: BiliStreamAccess, index: number): Promise<Uint8Array | null> {
  for (let attempt = 0; attempt < GRID_TRIES; attempt++) {
    access.markWaiting(index)
    const bytes: Uint8Array | null = await access.prefetcher.get(index).catch((): null => null)
    if (bytes && bytes.byteLength > 0) return bytes
  }
  noteFailure(`第 ${index} 格（${index * access.windowBytes} 起）抓不到`)
  return null
}

/**
 * 回答 [start, end] 這段：第一格到就先送 header，之後每格到就寫一段；
 * 播放器斷線（seek 很常發生）就停手，不再往後抓。
 * 中途拿不到格子時只能斷線（長度已經宣告了），所以抓格子本身先重試。
 */
async function streamRange(
  socket: Socket,
  track: MediaTrack,
  access: BiliStreamAccess,
  start: number,
  end: number,
  head: boolean,
  rangeHeader: string | undefined,
): Promise<void> {
  const requested: RegExpMatchArray | null = /bytes=(\d*)-(\d*)/.exec(rangeHeader ?? "")
  const from: number = requested && requested[1] ? Math.max(start, Number(requested[1])) : start
  const total: number | null = access.total()
  // 檔尾沒那麼多位元組就先修正結尾，不要宣告了長度又寫不滿。
  const rawTo: number = requested && requested[2] ? Math.min(end, Number(requested[2])) : end
  const to: number = total !== null ? Math.min(rawTo, total - 1) : rawTo
  if (to < from) {
    socket.write(headerBlock("416 Range Not Satisfiable", { "Content-Length": "0" }))
    socket.end()
    return
  }
  const partial: boolean = from !== start || to !== end
  let closed: boolean = false
  socket.on("close", (): void => {
    closed = true
  })
  socket.on("error", (): void => {
    closed = true
  })
  const aborted: () => boolean = (): boolean => closed || socket.destroyed
  const headers: Record<string, string> = {
    "Content-Type": track.mimeType || "video/mp4",
    "Content-Length": String(to - from + 1),
    "Accept-Ranges": "bytes",
    // Content-Range 只能出現在 206；跟 200 一起送 ffmpeg 會回 Invalid data。
    ...(partial ? { "Content-Range": `bytes ${from}-${to}/${total ?? "*"}` } : {}),
  }

  if (head) {
    socket.write(headerBlock(partial ? "206 Partial Content" : "200 OK", headers))
    socket.end()
    return
  }

  const window: number = Math.max(64 * 1024, access.windowBytes)
  const firstIndex: number = Math.floor(from / window)
  const lastIndex: number = Math.floor(to / window)
  const pending: Map<number, Promise<Uint8Array | null>> = new Map()
  const launch = (index: number): void => {
    if (index < firstIndex || index > lastIndex || pending.has(index)) return
    pending.set(index, fetchGrid(access, index))
  }
  for (let index = firstIndex; index < firstIndex + PIPELINE; index++) launch(index)

  const first: Uint8Array | null = await pending.get(firstIndex)!
  if (!first || aborted()) {
    // header 還沒送，來得及回一個乾淨的錯誤。
    if (!socket.destroyed) {
      socket.write(headerBlock("503 Service Unavailable", { "Content-Type": "text/plain", "Content-Length": "0" }))
      socket.end()
    }
    return
  }

  socket.write(headerBlock(partial ? "206 Partial Content" : "200 OK", headers))

  for (let index = firstIndex; index <= lastIndex; index++) {
    if (aborted()) return
    const bytes: Uint8Array | null = index === firstIndex ? first : await pending.get(index)!
    if (!bytes) {
      // 已經宣告長度了，與其送半截讓播放器判 Invalid data，不如把連線切掉。
      noteFailure(`片段 ${from}-${to} 第 ${index} 格拿不到`)
      socket.destroy()
      return
    }
    const gridStart: number = index * window
    const sliceFrom: number = Math.max(0, from - gridStart)
    const sliceTo: number = Math.min(bytes.byteLength, to - gridStart + 1)
    launch(index + PIPELINE)
    if (sliceTo > sliceFrom && !(await writeChunk(socket, bytes.subarray(sliceFrom, sliceTo)))) return
  }
  socket.end()
}

function sendText(socket: Socket, body: string, contentType: string): void {
  const length: number = body.length
  socket.write(
    headerBlock("200 OK", {
      "Content-Type": contentType,
      "Content-Length": String(length),
    }),
  )
  socket.write(body)
  socket.end()
}

function route(socket: Socket, method: string, path: string, rangeHeader: string | undefined): void {
  const master = /^\/media-hls\/([A-Za-z0-9_-]+)\/master\.m3u8$/.exec(path)
  if (master) {
    const session: Session | undefined = sessions.get(master[1])
    if (!session) {
      socket.write(headerBlock("404 Not Found", { "Content-Length": "0" }))
      socket.end()
      return
    }
    sendText(socket, session.session.master, "application/vnd.apple.mpegurl")
    return
  }

  const playlist = /^\/media-hls\/([A-Za-z0-9_-]+)\/(\d+)\.m3u8$/.exec(path)
  if (playlist) {
    const body: string | undefined = sessions.get(playlist[1])?.session.media.get(Number(playlist[2]))
    if (body === undefined) {
      socket.write(headerBlock("404 Not Found", { "Content-Length": "0" }))
      socket.end()
      return
    }
    sendText(socket, body, "application/vnd.apple.mpegurl")
    return
  }

  const init = /^\/media-init\/([A-Za-z0-9_-]+)\/(\d+)\/init\.mp4$/.exec(path)
  const segment = /^\/media-seg\/([A-Za-z0-9_-]+)\/(\d+)\/(\d+)\/seg\.mp4$/.exec(path)
  const audio = /^\/media-audio\/([A-Za-z0-9_-]+)\/(\d+)\/audio\.mp4$/.exec(path)
  const match: RegExpExecArray | null = init ?? segment ?? audio
  if (!match) {
    socket.write(headerBlock("404 Not Found", { "Content-Length": "0" }))
    socket.end()
    return
  }
  const session: Session | undefined = sessions.get(match[1])
  const itag: number = Number(match[2])
  const track: MediaTrack | undefined = session?.session.tracks.get(itag)
  if (!session || !track) {
    socket.write(headerBlock("404 Not Found", { "Content-Length": "0" }))
    socket.end()
    return
  }
  const access: BiliStreamAccess | undefined =
    session.access.get(itag) ?? getBiliStreamAccess(track.sourceId) ?? undefined
  if (!access) {
    socket.write(headerBlock("404 Not Found", { "Content-Length": "0" }))
    socket.end()
    return
  }
  session.access.set(itag, access)

  if (init) {
    void streamRange(socket, track, access, track.initStart, track.initEnd, method === "HEAD", rangeHeader)
    return
  }
  if (audio) {
    // 音軌不切段：整條當一片送，避免每個接縫的 AAC priming 造成雜音。
    const head: SidxEntry | undefined = track.entries[0]
    const tail: SidxEntry | undefined = track.entries[track.entries.length - 1]
    if (!head || !tail) {
      socket.write(headerBlock("404 Not Found", { "Content-Length": "0" }))
      socket.end()
      return
    }
    void streamRange(
      socket,
      track,
      access,
      head.offset,
      tail.offset + tail.size - 1,
      method === "HEAD",
      rangeHeader,
    )
    return
  }
  const entry: SidxEntry | undefined = track.entries[Number(match[3]) - 1]
  if (!entry) {
    socket.write(headerBlock("404 Not Found", { "Content-Length": "0" }))
    socket.end()
    return
  }
  void streamRange(
    socket,
    track,
    access,
    entry.offset,
    entry.offset + entry.size - 1,
    method === "HEAD",
    rangeHeader,
  )
}

function handle(socket: Socket): void {
  let buffer: string = ""
  socket.on("data", (chunk: Uint8Array): void => {
    buffer += latin1(chunk)
    const end: number = buffer.indexOf("\r\n\r\n")
    if (end < 0) return
    const lines: string[] = buffer.slice(0, end).split("\r\n")
    buffer = buffer.slice(end + 4)
    const [method, target] = lines[0].split(" ")
    let range: string | undefined
    for (const line of lines.slice(1)) {
      const separator: number = line.indexOf(":")
      if (separator <= 0) continue
      if (line.slice(0, separator).trim().toLowerCase() === "range") {
        range = line.slice(separator + 1).trim()
        break
      }
    }
    route(socket, method ?? "GET", (target ?? "").split("?")[0], range)
  })
  socket.on("error", (): void => {})
  socket.setTimeout(IDLE_TIMEOUT_MS, (): void => {
    socket.destroy()
  })
}

async function start(): Promise<number> {
  if (server && serverPort) return serverPort
  if (starting) return starting
  starting = new Promise<number>((resolve, reject): void => {
    const instance: Server = createServer(handle)
    instance.once("error", (error: Error): void => {
      starting = null
      reject(error)
    })
    instance.listen(0, "127.0.0.1", (): void => {
      server = instance
      serverPort = Number((instance.address() as { port: number }).port)
      resolve(serverPort)
    })
  })
  return starting
}

/** 註冊一個 HLS session，回傳 master playlist 的本地網址。 */
export async function registerMediaSession(id: string, session: MediaSession): Promise<string> {
  const port: number = await start()
  lastFailure = null
  sessions.set(id, { session, access: new Map() })
  return `http://127.0.0.1:${port}/media-hls/${id}/master.m3u8`
}

export function unregisterMediaSession(id: string): void {
  sessions.delete(id)
}

/** 產生 HLS 通路用的相對網址；播放清單與片段同源。 */
export function mediaPaths(id: string, itag: number, sequence: number): {
  media: string
  init: string
  segment: string
  audio: string
} {
  return {
    media: `/media-hls/${id}/${itag}.m3u8`,
    init: `/media-init/${id}/${itag}/init.mp4`,
    segment: `/media-seg/${id}/${itag}/${sequence}/seg.mp4`,
    audio: `/media-audio/${id}/${itag}/audio.mp4`,
  }
}

export function isMediaServerRunning(): boolean {
  return serverPort > 0 && server !== null
}
