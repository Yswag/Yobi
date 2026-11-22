import type { PlaybackBackend, YoutubeStreamPreference } from "../types/index"

export interface SettingOption<T> {
  label: string
  value: T
}

export const BACKEND_OPTIONS: SettingOption<PlaybackBackend>[] = [
  { label: "Native", value: "native" },
  { label: "System", value: "system" },
  { label: "Remux", value: "remux" },
  { label: "自動", value: "auto" },
]

export const QUALITY_OPTIONS: SettingOption<number>[] = [
  { label: "4K", value: 2160 },
  { label: "1080p", value: 1080 },
  { label: "720p", value: 720 },
  { label: "480p", value: 480 },
]

export const RATE_OPTIONS: SettingOption<number>[] = [
  { label: "0.75×", value: 0.75 },
  { label: "1×", value: 1.0 },
  { label: "1.25×", value: 1.25 },
  { label: "1.5×", value: 1.5 },
  { label: "2×", value: 2.0 },
]

export const STREAM_MODE_OPTIONS: SettingOption<YoutubeStreamPreference>[] = [
  { label: "自動", value: "auto" },
  { label: "HLS 優先", value: "hls" },
  { label: "SABR 優先", value: "sabr" },
]

export const DANMAKU_AREA_OPTIONS: SettingOption<number>[] = [
  { label: "1/4 螢幕", value: 0.25 },
  { label: "半螢幕", value: 0.5 },
  { label: "3/4 螢幕", value: 0.75 },
  { label: "全螢幕", value: 1.0 },
]

export const DANMAKU_OPACITY_OPTIONS: SettingOption<number>[] = [
  { label: "50%", value: 0.5 },
  { label: "70%", value: 0.7 },
  { label: "90%", value: 0.9 },
  { label: "100%", value: 1.0 },
]

export const DANMAKU_SPEED_OPTIONS: SettingOption<number>[] = [
  { label: "慢", value: 0.75 },
  { label: "標準", value: 1.0 },
  { label: "快", value: 1.25 },
  { label: "極快", value: 1.5 },
]

export function nearestOption(options: SettingOption<number>[], value: number): number {
  let best: number = options[0].value
  for (const option of options) {
    if (Math.abs(option.value - value) < Math.abs(best - value)) best = option.value
  }
  return best
}

export function optionLabelOf<T>(options: SettingOption<T>[], value: T): string {
  return options.find((option: SettingOption<T>): boolean => option.value === value)?.label ?? String(value)
}
