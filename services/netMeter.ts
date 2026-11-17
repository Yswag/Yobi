/**
 * 播放用的上游下載計量：所有經過本機代理的片段下載完成時記一筆。
 * 速率是最近 WINDOW_MS 內完成的位元組數 ÷ 時間，格子一次到齊，所以窗口不能太短。
 */

const WINDOW_MS: number = 3000

interface Sample {
  at: number
  bytes: number
}

let samples: Sample[] = []
let firstAt: number = 0
let lastHost: string = ""

function prune(now: number): void {
  while (samples.length > 0 && now - samples[0].at > WINDOW_MS) samples.shift()
}

export function recordDownload(bytes: number, url: string): void {
  if (!(bytes > 0)) return
  const now: number = Date.now()
  if (samples.length === 0 && now - firstAt > WINDOW_MS) firstAt = now
  samples.push({ at: now, bytes })
  prune(now)
  const match: RegExpMatchArray | null = url.match(/^https?:\/\/([^/:]+)/)
  if (match) lastHost = match[1]
}

/** 最近幾秒的下載速率（bit/s）；閒置時是 0。 */
export function currentDownloadBps(): number {
  const now: number = Date.now()
  prune(now)
  if (samples.length === 0) return 0
  const total: number = samples.reduce((sum: number, sample: Sample): number => sum + sample.bytes, 0)
  // 剛開始下載時窗口還沒填滿，用實際經過的時間，不然會低估。
  const span: number = Math.max(500, Math.min(WINDOW_MS, now - firstAt))
  return (total * 8000) / span
}

/** 最後一筆下載來自哪台 CDN。 */
export function lastDownloadHost(): string {
  return lastHost
}
