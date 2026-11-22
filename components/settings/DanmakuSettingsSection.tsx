import {
  Button,
  HStack,
  Image,
  Section,
  Spacer,
  Text,
  Toggle,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { PlayerSettings } from "../../types/index"
import {
  DANMAKU_AREA_OPTIONS,
  DANMAKU_OPACITY_OPTIONS,
  DANMAKU_SPEED_OPTIONS,
} from "../../utils/playbackOptions"
import { NumberPicker } from "./SettingsRows"

export interface DanmakuSettingsProps {
  settings: PlayerSettings
  onPatch: (patch: Partial<PlayerSettings>) => void
}

export function DanmakuSettingsSection(props: DanmakuSettingsProps): VirtualNode {
  const settings: PlayerSettings = props.settings
  return (
    <Section title="BiliBili 彈幕">
      <Toggle
        title="預設開啟彈幕"
        value={settings.danmakuEnabled}
        onChanged={(value: boolean) => props.onPatch({ danmakuEnabled: value })}
      />
      <NumberPicker
        title="顯示區域"
        options={DANMAKU_AREA_OPTIONS}
        value={settings.danmakuArea}
        onChange={(value: number) => props.onPatch({ danmakuArea: value })}
      />
      <NumberPicker
        title="不透明度"
        options={DANMAKU_OPACITY_OPTIONS}
        value={settings.danmakuOpacity}
        onChange={(value: number) => props.onPatch({ danmakuOpacity: value })}
      />
      <NumberPicker
        title="速度"
        options={DANMAKU_SPEED_OPTIONS}
        value={settings.danmakuSpeed}
        onChange={(value: number) => props.onPatch({ danmakuSpeed: value })}
      />
    </Section>
  )
}

export function DanmakuBlockedWordsSection(props: DanmakuSettingsProps): VirtualNode {
  const settings: PlayerSettings = props.settings

  const handleAdd = async (): Promise<void> => {
    const word: string | null = await Dialog.prompt({
      title: "新增彈幕屏蔽詞",
      message: "包含此關鍵字的彈幕將自動隱藏",
      placeholder: "輸入關鍵字",
      confirmLabel: "新增",
    })
    const trimmed: string = (word ?? "").trim()
    if (!trimmed) return
    if (settings.danmakuBlockedWords.includes(trimmed)) return
    props.onPatch({
      danmakuBlockedWords: [...settings.danmakuBlockedWords, trimmed],
    })
  }

  const handleRemove = (word: string): void => {
    props.onPatch({
      danmakuBlockedWords: settings.danmakuBlockedWords.filter((item: string): boolean => item !== word),
    })
  }

  return (
    <Section
      header={<Text>{`屏蔽詞 ${settings.danmakuBlockedWords.length}`}</Text>}
      footer={<Text>包含這些關鍵字的彈幕會自動隱藏。</Text>}
    >
      {settings.danmakuBlockedWords.map((word: string) => (
        <Button key={`bw-${word}`} action={() => handleRemove(word)}>
          <HStack frame={{ maxWidth: "infinity" }} contentShape="rect">
            <Text foregroundStyle="label">{word}</Text>
            <Spacer />
            <Image systemName="xmark.circle.fill" foregroundStyle="tertiaryLabel" />
          </HStack>
        </Button>
      ))}
      <Button title="新增屏蔽詞" systemImage="plus" action={() => void handleAdd()} />
    </Section>
  )
}
