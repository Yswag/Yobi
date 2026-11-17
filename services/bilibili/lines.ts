/**
 * bilibili CDN 線路評分：只用播放本來就要抓的 1 MB 格子計分，不另外測速。
 * 分數是每 MB 耗時的指數平均（含握手與等第一個位元組），越低越好。
 * 紀錄跨影片共用，只在這次執行內有效。
 */

const EWMA_ALPHA: number = 0.3
/** 失敗或逾時一次就停用這麼久；實測爛線路是持續爛（TLS 失敗、10 秒不回），不是偶發。 */
const BAN_MS: number = 2 * 60 * 1000
/**
 * 換主線路要快這麼多倍。實測正常線路 300–430 ms/MB 互有高低，總量又卡在手機端，
 * 差不到 1.5 倍換了也不會變快，只會來回切。
 */
const PROMOTE_GAIN: number = 1.5
/** 候選線路至少要有這麼多筆樣本才算數，一兩格的運氣不夠。 */
const MIN_SAMPLES: number = 3
/** 已知比最快的慢這麼多倍的線路不再試，除非紀錄已經舊了。 */
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
  // 檔尾的小格攤不掉固定開銷，會讓線路看起來比實際慢。
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

/** 可用的線路：有分數的由快到慢，沒試過的照原順序排在後面，停用中的不列。 */
export function rankLines(hosts: string[]): string[] {
  const usable: string[] = hosts.filter((host: string): boolean => !isLineBanned(host))
  const known: string[] = usable
    .filter((host: string): boolean => lineScore(host) !== null)
    .sort((a: string, b: string): number => (lineScore(a) ?? 0) - (lineScore(b) ?? 0))
  const unknown: string[] = usable.filter((host: string): boolean => lineScore(host) === null)
  return [...known, ...unknown]
}

/** 下一條值得試的線路：先試沒試過的，再重試最久沒量過、而且不會慢到離譜的。busy 是正在試的線。 */
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

/** 主線路被停用、或候選明顯比較快時才換。 */
export function shouldPromote(candidate: string, primary: string): boolean {
  if (candidate === primary || isLineBanned(candidate)) return false
  if (isLineBanned(primary)) return true
  const next: number | null = lineScore(candidate)
  const current: number | null = lineScore(primary)
  if (next === null || current === null) return false
  if ((records.get(candidate)?.samples ?? 0) < MIN_SAMPLES) return false
  return next * PROMOTE_GAIN < current
}
