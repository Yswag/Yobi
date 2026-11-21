import {
  Form,
  Picker,
  Section,
  Text,
  Toggle,
  useEffect,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { PlaybackBackend, PlayerSettings, YoutubeStreamPreference } from "../types/index"
import { getSettings, subscribeStorageChanges, updateSettings } from "../services/index"
import { palette } from "../ui/theme"

interface Option<T> {
  label: string
  value: T
}

export const BACKEND_OPTIONS: Option<PlaybackBackend>[] = [
  { label: "Native", value: "native" },
  { label: "System", value: "system" },
  { label: "Remux", value: "remux" },
  { label: "自動", value: "auto" },
]

export const QUALITY_OPTIONS: Option<number>[] = [
  { label: "4K", value: 2160 },
  { label: "1080p", value: 1080 },
  { label: "720p", value: 720 },
  { label: "480p", value: 480 },
]

export const RATE_OPTIONS: Option<number>[] = [
  { label: "0.75×", value: 0.75 },
  { label: "1×", value: 1.0 },
  { label: "1.25×", value: 1.25 },
  { label: "1.5×", value: 1.5 },
  { label: "2×", value: 2.0 },
]

const STREAM_MODE_OPTIONS: Option<YoutubeStreamPreference>[] = [
  { label: "自動", value: "auto" },
  { label: "HLS 優先", value: "hls" },
  { label: "SABR 優先", value: "sabr" },
]

export function nearest(options: Option<number>[], value: number): number {
  let best: number = options[0].value
  for (const option of options) {
    if (Math.abs(option.value - value) < Math.abs(best - value)) best = option.value
  }
  return best
}

export function labelOf<T>(options: Option<T>[], value: T): string {
  return options.find((option: Option<T>): boolean => option.value === value)?.label ?? String(value)
}

function OptionPicker<T extends string>(props: {
  title: string
  options: Option<T>[]
  value: T
  onChange: (value: T) => void
}): VirtualNode {
  return (
    <Picker
      title={props.title}
      value={props.value}
      onChanged={(value: string) => props.onChange(value as T)}
      pickerStyle="menu"
    >
      {props.options.map((option: Option<T>) => (
        <Text key={`${props.title}-${option.value}`} tag={option.value}>{option.label}</Text>
      ))}
    </Picker>
  )
}

function NumberPicker(props: {
  title: string
  options: Option<number>[]
  value: number
  onChange: (value: number) => void
}): VirtualNode {
  return (
    <Picker
      title={props.title}
      value={nearest(props.options, props.value)}
      onChanged={props.onChange}
      pickerStyle="menu"
    >
      {props.options.map((option: Option<number>) => (
        <Text key={`${props.title}-${option.value}`} tag={option.value}>{option.label}</Text>
      ))}
    </Picker>
  )
}

export function PlaybackSettingsView(): VirtualNode {
  const [settings, setSettings] = useState<PlayerSettings>(() => getSettings())

  useEffect(() => {
    return subscribeStorageChanges(() => {
      setSettings(getSettings())
    })
  }, [])

  const patchSettings = (patch: Partial<PlayerSettings>): void => {
    setSettings(updateSettings(patch))
  }

  return (
    <Form
      formStyle="grouped"
      tint={palette.brand}
      navigationTitle="播放"
      navigationBarTitleDisplayMode="inline"
      scrollEdgeEffectStyle="soft"
    >
      <Section footer={<Text>只有 Native 支援子母畫面；直播固定用 System。下次開啟影片時生效。</Text>}>
        <OptionPicker
          title="播放器後端"
          options={BACKEND_OPTIONS}
          value={settings.videoBackend}
          onChange={(value: PlaybackBackend) => patchSettings({ videoBackend: value })}
        />
        <NumberPicker
          title="偏好畫質"
          options={QUALITY_OPTIONS}
          value={settings.preferredQualityHeight}
          onChange={(value: number) => patchSettings({ preferredQualityHeight: value })}
        />
        <NumberPicker
          title="播放速度"
          options={RATE_OPTIONS}
          value={settings.defaultPlaybackRate}
          onChange={(value: number) => patchSettings({ defaultPlaybackRate: value })}
        />
      </Section>

      <Section
        header={<Text>YouTube 串流</Text>}
        footer={<Text>播放卡頓或畫質選項太少時，可以換一種引擎。</Text>}
      >
        <OptionPicker
          title="串流引擎"
          options={STREAM_MODE_OPTIONS}
          value={settings.youtubeStreamMode}
          onChange={(value: YoutubeStreamPreference) => patchSettings({ youtubeStreamMode: value })}
        />
      </Section>

      <Section
        header={<Text>BiliBili 線路</Text>}
        footer={<Text>依實際下載速度挑最快的伺服器，失敗或卡住時立刻換一條。</Text>}
      >
        <Toggle
          title="自動切換線路"
          value={settings.biliLineSwitch}
          onChanged={(value: boolean) => patchSettings({ biliLineSwitch: value })}
        />
      </Section>
    </Form>
  )
}
