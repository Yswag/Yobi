import { AbortController } from "scripting"
import type { AbortSignal } from "scripting"

const MAX_CACHED_BYTES: number = 96 * 1024 * 1024
const IDLE_MS: number = 10_000

export interface ChunkSource {
  count(): number | null
  fetch(index: number, signal: AbortSignal): Promise<Uint8Array | null>
}

export interface PrefetcherOptions {
  ahead: number
  concurrency: number
  chunkBytes?: number
}

interface InFlight {
  promise: Promise<Uint8Array | null>
  waiters: number
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
  private readonly chunkBytes: number
  private readonly cache: Map<number, Uint8Array> = new Map()
  private readonly inFlight: Map<number, InFlight> = new Map()
  private readonly pinned: Map<number, { promise: Promise<Uint8Array | null>; controller: AbortController }> = new Map()
  private queue: Queued[] = []
  private running: number = 0
  private endIndex: number = Number.POSITIVE_INFINITY
  private lastRequestAt: number = 0
  private lastIndex: number = -1
  cachedBytes: number = 0
  held: boolean = false

  constructor(source: ChunkSource, options: PrefetcherOptions) {
    this.source = source
    this.options = options
    this.chunkBytes = options.chunkBytes ?? 1024 * 1024
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
    return this.cache.get(index) ?? this.wait(index)
  }

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

  private finishOne(): void {
    const next: Queued | undefined = this.queue.shift()
    if (next) next.resolve(true)
    else this.running = Math.max(0, this.running - 1)
  }

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

  get windowGrids(): number {
    return this.options.ahead
  }

  get chunkSize(): number {
    return this.chunkBytes
  }

  aheadBytes(): number {
    let total: number = 0
    const limit: number = 4096
    for (let index = this.lastIndex + 1, steps = 0; steps < limit; index++, steps++) {
      const bytes: Uint8Array | undefined = this.cache.get(index)
      if (bytes) {
        total += bytes.byteLength
        continue
      }
      if (this.inFlight.has(index)) {
        total += this.chunkBytes
        continue
      }
      return total
    }
    return total
  }

  isIdle(now: number): boolean {
    return !this.held && now - this.lastRequestAt > IDLE_MS
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

export function prefetchedAheadBytes(): number | null {
  const now: number = Date.now()
  let best: number | null = null
  for (const prefetcher of prefetchers) {
    if (prefetcher.isIdle(now)) continue
    best = Math.max(best ?? 0, prefetcher.aheadBytes())
  }
  return best
}

export function prefetchWindow(): { grids: number; bytes: number } | null {
  const now: number = Date.now()
  let best: Prefetcher | null = null
  let bestAhead: number = -1
  for (const prefetcher of prefetchers) {
    if (prefetcher.isIdle(now)) continue
    const ahead: number = prefetcher.aheadBytes()
    if (ahead > bestAhead) {
      best = prefetcher
      bestAhead = ahead
    }
  }
  if (!best) return null
  return { grids: best.windowGrids, bytes: best.windowGrids * best.chunkSize }
}

export function releaseAllPrefetchers(): void {
  for (const prefetcher of prefetchers) prefetcher.release()
}
