import {
  Form,
  HStack,
  LabeledContent,
  Section,
  Text,
  Toggle,
  VStack,
  useEffect,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { PlayerSettings, SponsorCategory } from "../types/index"
import { getSettings, subscribeStorageChanges, updateSettings } from "../services/index"
import { SPONSOR_CATEGORY_COLORS, SPONSOR_CATEGORY_LABELS } from "../utils/format"
import { palette } from "../ui/theme"

const ALL_SPONSOR_CATEGORIES: SponsorCategory[] = [
  "sponsor",
  "selfpromo",
  "interaction",
  "intro",
  "outro",
  "preview",
  "music_offtopic",
]

export function SponsorBlockSettingsView(): VirtualNode {
  const [settings, setSettings] = useState<PlayerSettings>(() => getSettings())

  useEffect(() => {
    return subscribeStorageChanges(() => {
      setSettings(getSettings())
    }, ["settings"])
  }, [])

  const patchSettings = (patch: Partial<PlayerSettings>): void => {
    const next: PlayerSettings = updateSettings(patch)
    setSettings(next)
  }

  const toggleCategory = (category: SponsorCategory, enabled: boolean): void => {
    const current: SponsorCategory[] = settings.sponsorBlockCategories
    const next: SponsorCategory[] = enabled
      ? [...current.filter((item: SponsorCategory): boolean => item !== category), category]
      : current.filter((item: SponsorCategory): boolean => item !== category)
    patchSettings({ sponsorBlockCategories: next })
  }

  return (
    <Form
      formStyle="grouped"
      tint={palette.brand}
      navigationTitle="SponsorBlock"
      navigationBarTitleDisplayMode="inline"
      scrollEdgeEffectStyle="soft"
    >
      <Section
        footer={
          <Text>支援 YouTube（SponsorBlock）與 BiliBili（空降助手）。關閉自動跳過時，播放中遇到片段會顯示跳過按鈕。</Text>
        }
      >
        <Toggle
          title="啟用"
          value={settings.sponsorBlockEnabled}
          onChanged={(value: boolean) => patchSettings({ sponsorBlockEnabled: value })}
        />
        {settings.sponsorBlockEnabled ? (
          <Toggle
            title="自動跳過"
            value={settings.sponsorBlockAutoSkip}
            onChanged={(value: boolean) => patchSettings({ sponsorBlockAutoSkip: value })}
          />
        ) : null}
      </Section>

      {settings.sponsorBlockEnabled ? (
        <Section
          header={<Text>要跳過的片段</Text>}
          footer={<Text>播放器進度條將以對應顏色標記這些片段。</Text>}
        >
          {ALL_SPONSOR_CATEGORIES.map((category: SponsorCategory) => (
            <Toggle
              key={`sb-${category}`}
              value={settings.sponsorBlockCategories.includes(category)}
              onChanged={(value: boolean) => toggleCategory(category, value)}
            >
              <HStack spacing={10}>
                <VStack
                  frame={{ width: 10, height: 10 }}
                  background={{ style: SPONSOR_CATEGORY_COLORS[category], shape: { type: "rect", cornerRadius: 5 } }}
                />
                <Text>{SPONSOR_CATEGORY_LABELS[category]}</Text>
              </HStack>
            </Toggle>
          ))}
        </Section>
      ) : null}

      <Section header={<Text>服務端點</Text>}>
        <LabeledContent title="YouTube" value="sponsor.ajay.app" />
        <LabeledContent title="BiliBili" value="bsbsb.top（空降助手）" />
      </Section>
    </Form>
  )
}
