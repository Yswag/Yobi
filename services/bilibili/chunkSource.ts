import { AbortController, fetch } from "scripting"
import type { AbortSignal } from "scripting"
import { Prefetcher } from "../prefetch"
import { recordDownload } from "../netMeter"
import { getSettings } from "../storage"
import { reportError } from "../errors"
import {
  ensureLocalProxyStarted,
  registerRangeFileHandler,
  unregisterRangeFileHandler,
  type RangeFileHandler,
  type RangeReadResult,
} from "../localProxy"
import type { MediaStreamAccess } from "../mediaServer"
import {
  hostOf,
  isLineBanned,
  lineScore,
  noteLineFailure,
  noteLineSample,
  pickLineToExplore,
  rankLines,
  shouldPromote,
} from "./lines"
import { BILI_REFERER, BILI_USER_AGENT } from "./wbi"

interface BiliFileSource {
  id: string
  urls: string[]
  primary: string
  primarySince: number
  playhead: number
  exploring: Map<number, { host: string; controller: AbortController }>
  head: Uint8Array | null
  contentType: string
  total: number | null
  prefetcher: Prefetcher
  handler: RangeFileHandler
}

const biliFileSources: Map<string, BiliFileSource> = new Map()
const BILI_WINDOW_BYTES: number = 1024 * 1024
const BILI_PREFETCH_AHEAD_DEFAULT: number = 32
const BILI_PREFETCH_SECONDS: number = 15
const BILI_PREFETCH_MIN_AHEAD: number = 16
const BILI_PREFETCH_MAX_AHEAD: number = 64
const BILI_PREFETCH_CONCURRENCY: number = 4
const BILI_PREFETCH_CONCURRENCY_HEAVY: number = 6
const BILI_HEAVY_BITRATE: number = 12_000_000
const BILI_MAX_RESPONSE_BYTES: number = 16 * 1024 * 1024
const BILI_CHUNK_TIMEOUT_MS: number = 12000
const BILI_EXPLORE_EVERY: number = 8
const BILI_EXPLORE_MIN_AHEAD: number = 6
const BILI_EXPLORE_TIMEOUT_MS: number = 4000
const BILI_HEDGE_MIN_MS: number = 800
const BILI_HEDGE_MAX_MS: number = 4000
const BILI_HEDGE_DEFAULT_MS: number = 1500
const BILI_HEDGE_POLL_MS: number = 250
const BILI_HEDGE_WAITING_MIN_MS: number = 350
const BILI_HEDGE_WAITING_FACTOR: number = 1.5
const BILI_PRIMARY_DWELL_MS: number = 60_000
const BILI_MAX_TRIES: number = 3
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
  Referer: BILI_REFERER,
  "User-Agent": BILI_USER_AGENT,
}

function prefetchAheadFor(bitrate: number): number {
  if (!(bitrate > 0)) return BILI_PREFETCH_AHEAD_DEFAULT
  const bytesPerSecond: number = bitrate / 8
  const grids: number = Math.ceil((bytesPerSecond * BILI_PREFETCH_SECONDS) / BILI_WINDOW_BYTES)
  return Math.min(BILI_PREFETCH_MAX_AHEAD, Math.max(BILI_PREFETCH_MIN_AHEAD, grids))
}

function isUposHost(host: string): boolean {
  return /^upos-[a-z0-9-]+\.bilivideo\.com$/.test(host)
}

function swappedUrl(url: string, host: string): string | null {
  try {
    const next: URL = new URL(url)
    next.host = host
    return next.toString()
  } catch {
    return null
  }
}

function buildBiliCandidates(issued: string[]): string[] {
  if (!getSettings().biliLineSwitch) return issued.length ? [issued[0]] : []
  const out: string[] = []
  for (const url of issued) {
    if (url && !out.includes(url)) out.push(url)
  }
  const uposUrl: string | undefined = issued.find((url: string): boolean => isUposHost(hostOf(url)))
  if (uposUrl) {
    for (const host of BILI_CANDIDATE_POOL) {
      const url: string | null = swappedUrl(uposUrl, host)
      if (url && !out.includes(url)) out.push(url)
    }
  }
  return out
}

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
  } catch (error) {
    reportError("proxy", "timer.disarm", error)
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
    const contentType: string = (response.headers.get("content-type") ?? "").toLowerCase()
    if (contentType.includes("text/") || contentType.includes("json") || contentType.includes("xml")) {
      return { ok: false, ms: Date.now() - startedAt, reason: `content-type ${contentType}` }
    }
    const total: number = Number(response.headers.get("content-range")?.split("/")[1])
    const bytes: Uint8Array = new Uint8Array(await response.arrayBuffer())
    const known: boolean = Number.isFinite(total) && total > 0
    const atEof: boolean = known && start + bytes.byteLength >= total
    if (response.status === 206 && bytes.byteLength < BILI_WINDOW_BYTES && !atEof) {
      return { ok: false, ms: Date.now() - startedAt, reason: `short ${bytes.byteLength}/${BILI_WINDOW_BYTES}` }
    }
    recordDownload(bytes.byteLength, trackHost ? url : "")
    const sliced: Uint8Array =
      response.status === 200 && start > 0
        ? bytes.slice(start, start + BILI_WINDOW_BYTES)
        : bytes.byteLength > BILI_WINDOW_BYTES
          ? bytes.slice(0, BILI_WINDOW_BYTES)
          : bytes
    return { ok: true, bytes: sliced, ms: Date.now() - startedAt, total: known ? total : null }
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
    } catch (error) {
      reportError("proxy", "abort.detach", error)
    }
  }
}

let biliLineSwitchListener: ((host: string) => void) | null = null

export function setBiliLineSwitchListener(listener: ((host: string) => void) | null): void {
  biliLineSwitchListener = listener
}

function markWaiting(source: BiliFileSource, index: number): void {
  source.playhead = index
  for (const [chunk, entry] of source.exploring) {
    if (chunk <= index + 1) entry.controller.abort()
  }
}

function hostsOf(source: BiliFileSource): string[] {
  return source.urls.map(hostOf)
}

function urlOfHost(source: BiliFileSource, host: string): string {
  return source.urls.find((url: string): boolean => hostOf(url) === host) ?? source.urls[0]
}

function refreshPrimary(source: BiliFileSource, announce: boolean): void {
  const best: string | undefined = rankLines(hostsOf(source))[0]
  if (!best || !shouldPromote(best, source.primary)) return
  const forced: boolean = isLineBanned(source.primary)
  if (!forced && Date.now() - source.primarySince < BILI_PRIMARY_DWELL_MS) return
  source.primary = best
  source.primarySince = Date.now()
  if (!announce || !biliLineSwitchListener) return
  try {
    biliLineSwitchListener(best)
  } catch (error) {
    reportError("proxy", "lineSwitch.listener", error)
  }
}

interface BiliOutcome {
  host: string
  result: BiliAttemptResult
}

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
  }
  return { host, result }
}

async function fetchBiliHedged(
  source: BiliFileSource,
  index: number,
  primary: string,
  backup: string,
  start: number,
  signal: AbortSignal,
): Promise<BiliOutcome[]> {
  const waiting: boolean = index - source.playhead <= 1
  const expected: number = lineScore(primary) ?? BILI_HEDGE_DEFAULT_MS
  const delay: number = waiting
    ? Math.min(BILI_HEDGE_MAX_MS, Math.max(BILI_HEDGE_WAITING_MIN_MS, expected * BILI_HEDGE_WAITING_FACTOR))
    : Math.min(BILI_HEDGE_MAX_MS, Math.max(BILI_HEDGE_MIN_MS, expected * 2))
  const first: AbortController = new AbortController()
  const second: AbortController = new AbortController()
  const relayAbort = (): void => {
    first.abort()
    second.abort()
  }
  signal.addEventListener("abort", relayAbort)
  const startedAt: number = Date.now()
  const outcomes: BiliOutcome[] = []
  const fromBackup: Set<BiliOutcome> = new Set()
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
        void attemptBiliLine(source, backup, start, BILI_CHUNK_TIMEOUT_MS, second.signal, true).then(
          (outcome: BiliOutcome): void => {
            fromBackup.add(outcome)
            settle(outcome)
          },
        )
      }
      timer = armTimeout(check, delay)
    })
    if (winner.result.ok && fromBackup.has(winner)) {
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
    } catch (error) {
      reportError("proxy", "abort.detach", error)
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

  if (hosts.length > 1 && distance >= BILI_EXPLORE_MIN_AHEAD && index % BILI_EXPLORE_EVERY === 0) {
    const busy: string[] = [...source.exploring.values()].map((entry): string => entry.host)
    const host: string | null = pickLineToExplore(hosts, source.primary, busy)
    if (host) {
      const controller: AbortController = new AbortController()
      const relayAbort = (): void => controller.abort()
      signal.addEventListener("abort", relayAbort)
      source.exploring.set(index, { host, controller })
      let outcome: BiliOutcome
      try {
        outcome = await attemptBiliLine(source, host, start, BILI_EXPLORE_TIMEOUT_MS, controller.signal, false)
      } finally {
        source.exploring.delete(index)
        try {
          signal.removeEventListener("abort", relayAbort)
        } catch (error) {
          reportError("proxy", "abort.detach", error)
        }
      }
      if (outcome.result.ok) {
        refreshPrimary(source, true)
        return outcome.result.bytes
      }
      if (signal.aborted || outcome.result.reason === "416") return null
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
    const waiting: boolean = index - source.playhead <= 1
    const scored: string | undefined = order
      .slice(i + 1)
      .find((next: string): boolean => !tried.has(next) && lineScore(next) !== null)
    const untouched: string | undefined = waiting
      ? order.slice(i + 1).find((next: string): boolean => !tried.has(next))
      : undefined
    const backup: string = scored ?? untouched ?? host
    const outcomes: BiliOutcome[] = await fetchBiliHedged(source, index, host, backup, start, signal)
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
  throw new Error(`bili chunk ${index}: ${lastReason}`)
}

async function readBiliRange(
  source: BiliFileSource,
  start: number,
  requestedEnd: number | null,
): Promise<RangeReadResult> {
  if (
    source.head &&
    requestedEnd !== null &&
    requestedEnd >= start &&
    requestedEnd < source.head.byteLength
  ) {
    return {
      status: "ok",
      bytes: source.head.slice(start, requestedEnd + 1),
      total: source.total,
    }
  }
  const first: number = Math.floor(start / BILI_WINDOW_BYTES)
  markWaiting(source, first)
  const head: Uint8Array | null = await source.prefetcher.get(first)
  const offset: number = start - first * BILI_WINDOW_BYTES
  if (!head || offset >= head.byteLength) {
    if (source.total !== null && start >= source.total) {
      return { status: "range_not_satisfiable", total: source.total }
    }
    return { status: "error", message: "upstream failed" }
  }

  const limit: number = requestedEnd !== null ? BILI_MAX_RESPONSE_BYTES : BILI_WINDOW_BYTES
  let end: number = Math.min(requestedEnd ?? Number.POSITIVE_INFINITY, start + limit - 1)
  if (source.total !== null) end = Math.min(end, source.total - 1)
  const parts: Uint8Array[] = [head.subarray(offset)]
  let have: number = head.byteLength - offset
  for (let index = first + 1; start + have - 1 < end; index++) {
    markWaiting(source, index)
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
  return { status: "ok", bytes, total: source.total }
}

function disposeBiliSource(source: BiliFileSource): void {
  for (const entry of source.exploring.values()) entry.controller.abort()
  source.exploring.clear()
  source.prefetcher.dispose()
  if (biliFileSources.get(source.id) === source) {
    biliFileSources.delete(source.id)
  }
}

export function registerBiliFileSource(
  id: string,
  urls: string | string[],
  contentType: string,
  bitrate?: number,
): string {
  ensureLocalProxyStarted()
  const issued: string[] = (Array.isArray(urls) ? urls : [urls]).filter((value: string): boolean => !!value)
  const candidates: string[] = buildBiliCandidates(issued)
  const existing: BiliFileSource | undefined = biliFileSources.get(id)
  if (existing && existing.urls.join(" ") === candidates.join(" ")) {
    return registerRangeFileHandler(id, existing.handler)
  }
  if (existing) {
    unregisterRangeFileHandler(id)
    disposeBiliSource(existing)
  } else if (biliFileSources.size >= BILI_MAX_SOURCES) {
    const oldest: string | undefined = biliFileSources.keys().next().value
    if (oldest) {
      unregisterRangeFileHandler(oldest)
      const stale: BiliFileSource | undefined = biliFileSources.get(oldest)
      if (stale) disposeBiliSource(stale)
    }
  }
  const heavy: boolean = (bitrate ?? 0) >= BILI_HEAVY_BITRATE
  const source: BiliFileSource = {
    id,
    urls: candidates,
    primary: hostOf(candidates[0] ?? ""),
    primarySince: 0,
    playhead: 0,
    exploring: new Map(),
    head: null,
    contentType,
    total: null,
    prefetcher: new Prefetcher(
      {
        count: (): number | null => (source.total === null ? null : Math.ceil(source.total / BILI_WINDOW_BYTES)),
        fetch: (index: number, signal: AbortSignal): Promise<Uint8Array | null> => fetchBiliChunk(source, index, signal),
      },
      {
        ahead: prefetchAheadFor(bitrate ?? 0),
        concurrency: heavy ? BILI_PREFETCH_CONCURRENCY_HEAVY : BILI_PREFETCH_CONCURRENCY,
        chunkBytes: BILI_WINDOW_BYTES,
      },
    ),
    handler: {
      contentType,
      readRange: (start: number, end: number | null): Promise<RangeReadResult> => readBiliRange(source, start, end),
      dispose: (): void => disposeBiliSource(source),
    },
  }
  refreshPrimary(source, false)
  biliFileSources.set(id, source)
  try {
    return registerRangeFileHandler(id, source.handler)
  } catch (error) {
    disposeBiliSource(source)
    throw error
  }
}

export function getBiliStreamAccess(id: string): MediaStreamAccess | null {
  const source: BiliFileSource | undefined = biliFileSources.get(id)
  if (!source) return null
  return {
    id,
    contentType: source.contentType,
    windowBytes: BILI_WINDOW_BYTES,
    prefetcher: source.prefetcher,
    total: (): number | null => source.total,
    markWaiting: (index: number): void => markWaiting(source, index),
  }
}

export function seedBiliHead(id: string, bytes: Uint8Array, total: number | null): void {
  const source: BiliFileSource | undefined = biliFileSources.get(id)
  if (!source) return
  source.head = bytes
  if (total !== null && total > 0) source.total = total
}

export function warmBiliRange(id: string, start: number, end: number): void {
  const source: BiliFileSource | undefined = biliFileSources.get(id)
  if (!source || end < start) return
  const first: number = Math.floor(start / BILI_WINDOW_BYTES)
  const last: number = Math.floor(end / BILI_WINDOW_BYTES)
  source.playhead = last
  for (let index = first; index <= last; index++) source.prefetcher.warm(index)
}

export function clearBiliChunkSources(): void {
  const sources: BiliFileSource[] = [...biliFileSources.values()]
  for (const source of sources) {
    unregisterRangeFileHandler(source.id)
    disposeBiliSource(source)
  }
}
