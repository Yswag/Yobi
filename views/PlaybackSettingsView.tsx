import {
  Form,
  Section,
  Text,
  Toggle,
  useEffect,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { PlaybackBackend, PlayerSettings, YoutubeStreamPreference } from "../types/index"
import { getSettings, subscribeStorageChanges, updateSettings } from "../services/index"
import {
  BACKEND_OPTIONS,
  QUALITY_OPTIONS,
  RATE_OPTIONS,
  STREAM_MODE_OPTIONS,
} from "../utils/playbackOptions"
import { NumberPicker, OptionPicker } from "../components/settings/SettingsRows"
import { palette } from "../ui/theme"

export function PlaybackSettingsView(): VirtualNode {
  const [settings, setSettings] = useState<PlayerSettings>(() => getSettings())

  useEffect(() => {
    return subscribeStorageChanges(() => {
      setSettings(getSettings())
    }, ["settings"])
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
