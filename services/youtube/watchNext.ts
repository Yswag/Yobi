import { fetchNextResponse, type JsonObject } from "./innertube"

const DEFAULT_WATCH_NEXT_TTL_MS: number = 5 * 60 * 1000
const MAX_WATCH_NEXT_ENTRIES: number = 8

interface WatchNextEntry {
  at: number
  data: JsonObject
}

const watchNextCache: Map<string, WatchNextEntry> = new Map()
const watchNextPending: Map<string, Promise<JsonObject>> = new Map()

export interface WatchNextOptions {
  maxAgeMs?: number
}

export async function fetchWatchNext(
  videoId: string,
  options: WatchNextOptions = {},
): Promise<JsonObject> {
  const maxAgeMs: number = options.maxAgeMs ?? DEFAULT_WATCH_NEXT_TTL_MS
  const now: number = Date.now()
  const cached: WatchNextEntry | undefined = watchNextCache.get(videoId)
  if (cached && now - cached.at < maxAgeMs) {
    return cached.data
  }

  const inflight: Promise<JsonObject> | undefined = watchNextPending.get(videoId)
  if (inflight) return inflight

  const request: Promise<JsonObject> = fetchNextResponse(videoId)
    .then((data: JsonObject): JsonObject => {
      if (!watchNextCache.has(videoId) && watchNextCache.size >= MAX_WATCH_NEXT_ENTRIES) {
        const oldest: string | undefined = watchNextCache.keys().next().value
        if (oldest !== undefined) watchNextCache.delete(oldest)
      }
      watchNextCache.set(videoId, { at: Date.now(), data })
      return data
    })
    .finally((): void => {
      if (watchNextPending.get(videoId) === request) {
        watchNextPending.delete(videoId)
      }
    })

  watchNextPending.set(videoId, request)
  return request
}
