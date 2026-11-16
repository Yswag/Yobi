// YouTube 的自動字幕 VTT 帶逐字時間標記、空白 cue 與 10ms 的銜接 cue，播放器的解析器整份拒收。
// 這裡只取時間與純文字，重新輸出成帶 CC 底框樣式的 WebVTT。

interface Cue {
  start: number
  end: number
  text: string
}

const TIMING: RegExp = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})/
const MIN_CUE_SECONDS: number = 0.05

// 照 YouTube 的 CC：無襯線粗體、清晰字級、約 70% 不透明的深黑底（播放器只吃 hex）。
const CUE_STYLE: string = "STYLE\n::cue {\n  background-color: #000000B3;\n  color: #FFFFFF;\n  font-family: PingFang SC;\n  font-weight: bold;\n  font-size: 70%;\n}"
// 最後一行放在倒數第二行的位置，離底邊留一行；多行往上長。
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

// SRT 與 VTT 都是「時間行＋文字行」的區塊，同一套解析。
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

/** SRT／WebVTT → 只有時間、純文字與 CC 樣式的 WebVTT；沒有任何可用的 cue 時回傳空字串。 */
export function toCleanVtt(source: string): string {
  const cues: Cue[] = parseCues(source)
  if (cues.length === 0) return ""
  const blocks: string[] = cues.map(
    (cue: Cue): string => `${vttTime(cue.start)} --> ${vttTime(cue.end)} ${CUE_SETTINGS}\n${cue.text.replace(/-->/g, "→")}`,
  )
  return `WEBVTT\n\n${CUE_STYLE}\n\n${blocks.join("\n\n")}\n`
}
