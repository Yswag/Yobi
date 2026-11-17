import { AbortController } from "scripting"
import type { AbortSignal } from "scripting"

/**
 * 片段預抓：播放器要第 N 塊時，背景先抓後面幾塊。
 * Scripting 播放器自己抓片段時 4K 會轉圈，先抓好就能直接從記憶體回。
 * 所有預抓器共用一個記憶體上限；同時只會播一支影片。
 */

const MAX_CACHED_BYTES: number = 96 * 1024 * 1024
/** 這麼久沒被要資料的預抓器（換畫質、換影片後）會被清掉快取。 */
const IDLE_MS: number = 10_000

export interface ChunkSource {
  /** 總塊數；還不知道時回 null。 */
  count(): number | null
  /** 總數未知時，回 null 代表超過結尾；網路錯誤要丟例外，才不會被當成結尾。 */
  fetch(index: number, signal: AbortSignal): Promise<Uint8Array | null>
}

export interface PrefetcherOptions {
  ahead: number
  /** 同時抓幾塊；有狀態的來源（SABR）要設 1。 */
  concurrency: number
}

interface InFlight {
  promise: Promise<Uint8Array | null>
  /** 正在等這塊的播放器請求數；有人在等就不取消。 */
  waiters: number
  /** 取消後立刻釋放名額並回 null；被 abort 的 fetch 不一定會結束，不能等它。 */
  cancel: () => void
}

interface Queued {
  index: number
  resolve: (go: boolean) => void
}

const prefetchers: Set<Prefetcher> = new Set()

function totalCachedBytes(): number {
  let total: number = 0
  for (const prefetcher of prefetchers) total += prefetcher.cachedBytes
  return total
}

function dropIdle(current: Prefetcher): void {
  const now: number = Date.now()
  for (const prefetcher of prefetchers) {
    if (prefetcher !== current && prefetcher.cachedBytes > 0 && prefetcher.isIdle(now)) prefetcher.release()
  }
}

export class Prefetcher {
  private readonly source: ChunkSource
  private readonly options: PrefetcherOptions
  private readonly cache: Map<number, Uint8Array> = new Map()
  private readonly inFlight: Map<number, InFlight> = new Map()
  /** warm() 先抓的塊：不受 trimOutside 影響，播放器第一次要到時才轉進一般快取。 */
  private readonly pinned: Map<number, { promise: Promise<Uint8Array | null>; controller: AbortController }> = new Map()
  private queue: Queued[] = []
  private running: number = 0
  /** 抓到 null 的最小塊號，之後不再往後預抓。 */
  private endIndex: number = Number.POSITIVE_INFINITY
  private lastRequestAt: number = 0
  /** 播放器最近要的塊號。 */
  private lastIndex: number = -1
  cachedBytes: number = 0

  constructor(source: ChunkSource, options: PrefetcherOptions) {
    this.source = source
    this.options = options
    prefetchers.add(this)
  }

  async get(index: number): Promise<Uint8Array | null> {
    this.lastRequestAt = Date.now()
    this.lastIndex = index
    dropIdle(this)
    this.trimOutside(index)

    const cached: Uint8Array | undefined = this.cache.get(index)
    const pinned = this.pinned.get(index)
    if (pinned) this.pinned.delete(index)
    const result: Promise<Uint8Array | null> = cached
      ? Promise.resolve(cached)
      : pinned
        ? pinned.promise.then((bytes: Uint8Array | null) => (bytes ? this.keep(index, bytes) : this.wait(index)))
        : this.wait(index)
    const count: number = Math.min(this.source.count() ?? Number.POSITIVE_INFINITY, this.endIndex)
    for (let ahead = 1; ahead <= this.options.ahead; ahead++) {
      const next: number = index + ahead
      if (next >= count) break
      if (this.cache.has(next) || this.inFlight.has(next)) continue
      if (totalCachedBytes() >= MAX_CACHED_BYTES) break
      void this.start(next, false)
    }

    const bytes: Uint8Array | null = await result
    if (bytes || index >= this.endIndex) return bytes
    // 第一次失敗通常是暫時性的，直接再抓一次。
    return this.cache.get(index) ?? this.wait(index)
  }

  /**
   * 先把這塊抓好放著，給「開片後馬上要跳過去」的位置用（續播、換畫質）。
   * 開片時播放器先讀檔頭，一般快取會以檔頭為中心清掉遠處的塊，所以另外放。
   */
  warm(index: number): void {
    if (this.cache.has(index) || this.inFlight.has(index) || this.pinned.has(index)) return
    if (index >= this.endIndex) return
    this.lastRequestAt = Date.now()
    const controller: AbortController = new AbortController()
    const promise: Promise<Uint8Array | null> = this.source.fetch(index, controller.signal).catch(() => null)
    this.pinned.set(index, { promise, controller })
  }

  private keep(index: number, bytes: Uint8Array): Uint8Array {
    if (!this.cache.has(index)) {
      this.cache.set(index, bytes)
      this.cachedBytes += bytes.byteLength
    }
    return bytes
  }

  private async wait(index: number): Promise<Uint8Array | null> {
    const promise: Promise<Uint8Array | null> = this.start(index, true)
    const flight: InFlight | undefined = this.inFlight.get(index)
    if (flight) flight.waiters++
    try {
      return await promise
    } finally {
      if (flight) flight.waiters--
    }
  }

  private start(index: number, urgent: boolean): Promise<Uint8Array | null> {
    const existing: InFlight | undefined = this.inFlight.get(index)
    if (existing) {
      if (urgent) this.promote(index)
      return existing.promise
    }

    const controller: AbortController = new AbortController()
    let cancelled: boolean = false
    let holdsSlot: boolean = false
    let settleCancel: (value: null) => void = () => {}
    const cancellation: Promise<null> = new Promise((resolve: (value: null) => void) => {
      settleCancel = resolve
    })
    const releaseSlot = (): void => {
      if (!holdsSlot) return
      holdsSlot = false
      this.finishOne()
    }

    const work: Promise<Uint8Array | null> = this.schedule(index, urgent).then(async (go: boolean) => {
      if (!go) return null
      holdsSlot = true
      if (cancelled) {
        releaseSlot()
        return null
      }
      try {
        const bytes: Uint8Array | null = await this.source.fetch(index, controller.signal)
        if (!bytes && !cancelled && this.source.count() === null) this.endIndex = Math.min(this.endIndex, index)
        return bytes
      } catch {
        return null
      } finally {
        releaseSlot()
      }
    })

    const flight: InFlight = {
      waiters: 0,
      cancel: (): void => {
        if (cancelled) return
        cancelled = true
        this.dequeue(index)
        controller.abort()
        releaseSlot()
        settleCancel(null)
      },
      promise: Promise.race([work, cancellation]).then((bytes: Uint8Array | null): Uint8Array | null => {
        if (this.inFlight.get(index) === flight) this.inFlight.delete(index)
        if (cancelled || !bytes) return null
        this.cache.set(index, bytes)
        this.cachedBytes += bytes.byteLength
        return bytes
      }),
    }
    this.inFlight.set(index, flight)
    return flight.promise
  }

  /** 依同時上限排隊；回傳 true 代表輪到了，false 代表排隊中被取消。 */
  private schedule(index: number, urgent: boolean): Promise<boolean> {
    if (this.running < this.options.concurrency) {
      this.running++
      return Promise.resolve(true)
    }
    return new Promise((resolve: (go: boolean) => void) => {
      const entry: Queued = { index, resolve }
      if (urgent) this.queue.unshift(entry)
      else this.queue.push(entry)
    })
  }

  private dequeue(index: number): void {
    this.queue = this.queue.filter((entry: Queued): boolean => {
      if (entry.index !== index) return true
      entry.resolve(false)
      return false
    })
  }

  private promote(index: number): void {
    const position: number = this.queue.findIndex((entry: Queued): boolean => entry.index === index)
    if (position > 0) this.queue.unshift(...this.queue.splice(position, 1))
  }

  /** 名額交給下一個排隊者；沒人排隊才真的減少。 */
  private finishOne(): void {
    const next: Queued | undefined = this.queue.shift()
    if (next) next.resolve(true)
    else this.running = Math.max(0, this.running - 1)
  }

  /**
   * 保留前一塊（播放器偶爾重抓）與後面的預抓範圍，其餘釋放。
   * 拖動後舊範圍的預抓直接取消，但播放器還在等的那塊不動，否則新舊請求會互相取消。
   */
  private trimOutside(index: number): void {
    const keep = (chunk: number): boolean => chunk >= index - 1 && chunk <= index + this.options.ahead
    for (const [chunk, bytes] of this.cache) {
      if (keep(chunk)) continue
      this.cache.delete(chunk)
      this.cachedBytes -= bytes.byteLength
    }
    for (const [chunk, flight] of this.inFlight) {
      if (keep(chunk) || flight.waiters > 0) continue
      flight.cancel()
    }
  }

  /** 播放位置之後連續已抓好的位元組；中間缺一塊就停，缺塊之後的對播放還沒用。 */
  aheadBytes(): number {
    let total: number = 0
    for (let index = this.lastIndex + 1; ; index++) {
      const bytes: Uint8Array | undefined = this.cache.get(index)
      if (!bytes) return total
      total += bytes.byteLength
    }
  }

  isIdle(now: number): boolean {
    return now - this.lastRequestAt > IDLE_MS
  }

  release(): void {
    for (const entry of this.pinned.values()) entry.controller.abort()
    this.pinned.clear()
    for (const flight of [...this.inFlight.values()]) flight.cancel()
    this.inFlight.clear()
    for (const entry of this.queue) entry.resolve(false)
    this.queue = []
    this.cache.clear()
    this.cachedBytes = 0
  }

  dispose(): void {
    this.release()
    prefetchers.delete(this)
  }
}

/**
 * 正在用的預抓器裡，播放位置之後最多的連續位元組；沒有就回 null。
 * 取最多的那個是影片軌：音軌位元組少，換算秒數會失真。
 */
export function prefetchedAheadBytes(): number | null {
  const now: number = Date.now()
  let best: number | null = null
  for (const prefetcher of prefetchers) {
    if (prefetcher.isIdle(now)) continue
    best = Math.max(best ?? 0, prefetcher.aheadBytes())
  }
  return best
}

/** 停止播放時釋放所有預抓的資料。 */
export function releaseAllPrefetchers(): void {
  for (const prefetcher of prefetchers) prefetcher.release()
}
