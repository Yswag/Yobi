
const EWMA_ALPHA: number = 0.3
const BAN_MS: number = 2 * 60 * 1000
const PROMOTE_GAIN: number = 1.5
const MIN_SAMPLES: number = 3
const RETRY_SLOWER_FACTOR: number = 3
const STALE_MS: number = 5 * 60 * 1000

interface LineRecord {
  msPerMb: number | null
  samples: number
  lastAt: number
  bannedUntil: number
}

const records: Map<string, LineRecord> = new Map()

function recordOf(host: string): LineRecord {
  let record: LineRecord | undefined = records.get(host)
  if (!record) {
    record = { msPerMb: null, samples: 0, lastAt: 0, bannedUntil: 0 }
    records.set(host, record)
  }
  return record
}

export function hostOf(value: string): string {
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return ""
  }
}

export function noteLineSample(host: string, ms: number, bytes: number, fullBytes: number): void {
  if (!host || !(ms > 0) || bytes < fullBytes / 2) return
  const record: LineRecord = recordOf(host)
  const sample: number = (ms * fullBytes) / bytes
  record.msPerMb = record.msPerMb === null ? sample : record.msPerMb * (1 - EWMA_ALPHA) + sample * EWMA_ALPHA
  record.samples++
  record.lastAt = Date.now()
}

export function noteLineFailure(host: string): void {
  if (!host) return
  const record: LineRecord = recordOf(host)
  record.bannedUntil = Date.now() + BAN_MS
  record.lastAt = Date.now()
}

export function isLineBanned(host: string): boolean {
  return (records.get(host)?.bannedUntil ?? 0) > Date.now()
}

export function lineScore(host: string): number | null {
  return records.get(host)?.msPerMb ?? null
}

export function rankLines(hosts: string[]): string[] {
  const usable: string[] = hosts.filter((host: string): boolean => !isLineBanned(host))
  const known: string[] = usable
    .filter((host: string): boolean => lineScore(host) !== null)
    .sort((a: string, b: string): number => (lineScore(a) ?? 0) - (lineScore(b) ?? 0))
  const unknown: string[] = usable.filter((host: string): boolean => lineScore(host) === null)
  return [...known, ...unknown]
}

export function pickLineToExplore(hosts: string[], primary: string, busy: string[]): string | null {
  const candidates: string[] = hosts.filter(
    (host: string): boolean => host !== primary && !isLineBanned(host) && !busy.includes(host),
  )
  const untried: string | undefined = candidates.find((host: string): boolean => lineScore(host) === null)
  if (untried) return untried
  const now: number = Date.now()
  const best: number = Math.min(...hosts.map((host: string): number => lineScore(host) ?? Number.POSITIVE_INFINITY))
  const retry: string[] = candidates
    .filter((host: string): boolean => {
      const score: number = lineScore(host) ?? Number.POSITIVE_INFINITY
      return score <= best * RETRY_SLOWER_FACTOR || now - (records.get(host)?.lastAt ?? 0) > STALE_MS
    })
    .sort((a: string, b: string): number => (records.get(a)?.lastAt ?? 0) - (records.get(b)?.lastAt ?? 0))
  return retry[0] ?? null
}

export function shouldPromote(candidate: string, primary: string): boolean {
  if (candidate === primary || isLineBanned(candidate)) return false
  if (isLineBanned(primary)) return true
  const next: number | null = lineScore(candidate)
  const current: number | null = lineScore(primary)
  if (next === null || current === null) return false
  if ((records.get(candidate)?.samples ?? 0) < MIN_SAMPLES) return false
  return next * PROMOTE_GAIN < current
}
