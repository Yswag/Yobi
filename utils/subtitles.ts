
interface Cue {
  start: number
  end: number
  text: string
}

const TIMING: RegExp = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})/
const MIN_CUE_SECONDS: number = 0.05

const CUE_STYLE: string = "STYLE\n::cue {\n  background-color: #000000B3;\n  color: #FFFFFF;\n  font-family: PingFang SC;\n  font-weight: bold;\n  font-size: 70%;\n}"
const CUE_SETTINGS: string = "line:-2"

function parseTime(text: string): number {
  const parts: string[] = text.replace(",", ".").split(":")
  let seconds: number = 0
  for (const part of parts) seconds = seconds * 60 + Number(part)
  return seconds
}

function vttTime(seconds: number): string {
  const totalMs: number = Math.max(0, Math.round(seconds * 1000))
  const ms: number = totalMs % 1000
  const totalSeconds: number = Math.floor(totalMs / 1000)
  const pad = (value: number, width: number = 2): string => String(value).padStart(width, "0")
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}.${pad(ms, 3)}`
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_: string, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
}

function parseCues(source: string): Cue[] {
  const cues: Cue[] = []
  for (const block of source.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines: string[] = block.split("\n")
    const timingIndex: number = lines.findIndex((line: string): boolean => TIMING.test(line))
    if (timingIndex < 0) continue
    const match: RegExpExecArray | null = TIMING.exec(lines[timingIndex])
    if (!match) continue
    const start: number = parseTime(match[1])
    const end: number = parseTime(match[2])
    if (end - start < MIN_CUE_SECONDS) continue
    const text: string = lines
      .slice(timingIndex + 1)
      .map((line: string): string => decodeEntities(line.replace(/<[^>]*>/g, "")).trim())
      .filter((line: string): boolean => line.length > 0)
      .join("\n")
    if (text) cues.push({ start, end, text })
  }
  return cues
}

export function toCleanVtt(source: string): string {
  return cuesToVtt(parseCues(source))
}

export function cuesToVtt(cues: Cue[]): string {
  if (cues.length === 0) return ""
  const blocks: string[] = cues.map(
    (cue: Cue): string => `${vttTime(cue.start)} --> ${vttTime(cue.end)} ${CUE_SETTINGS}\n${cue.text.replace(/-->/g, "→")}`,
  )
  return `WEBVTT\n\n${CUE_STYLE}\n\n${blocks.join("\n\n")}\n`
}

export function biliSubtitleToVtt(source: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return ""
  }
  const body: unknown = (parsed as { body?: unknown } | null)?.body
  if (!Array.isArray(body)) return ""
  const cues: Cue[] = []
  for (const entry of body) {
    const item = entry as { from?: unknown; to?: unknown; content?: unknown } | null
    const start: number = Number(item?.from)
    const end: number = Number(item?.to)
    const text: string = decodeEntities(String(item?.content ?? "")).trim()
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (end - start < MIN_CUE_SECONDS || !text) continue
    cues.push({ start, end, text })
  }
  return cuesToVtt(cues)
}
