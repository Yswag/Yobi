
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

export function currentDownloadBps(): number {
  const now: number = Date.now()
  prune(now)
  if (samples.length === 0) return 0
  const total: number = samples.reduce((sum: number, sample: Sample): number => sum + sample.bytes, 0)
  const span: number = Math.max(500, Math.min(WINDOW_MS, now - firstAt))
  return (total * 8000) / span
}

export function lastDownloadHost(): string {
  return lastHost
}
