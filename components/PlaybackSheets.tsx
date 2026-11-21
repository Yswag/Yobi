import {
  Button,
  Form,
  HStack,
  Image,
  NavigationStack,
  Picker,
  Section,
  Slider,
  Spacer,
  Text,
  Toggle,
  VStack,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { VideoQualityTrack } from "../types"
import {
  getPlayerController,
  selectQuality,
  setStatsVisible,
  updateDanmakuSettings,
  usePlayerStore,
} from "../state/playerStore"
import { palette, type } from "../ui/theme"

const AREA_OPTIONS: { label: string; value: number }[] = [
  { label: "1/4", value: 0.25 },
  { label: "1/2", value: 0.5 },
  { label: "3/4", value: 0.75 },
  { label: "全屏", value: 1 },
]

function nearestArea(value: number): number {
  let best: number = AREA_OPTIONS[0].value
  for (const option of AREA_OPTIONS) {
    if (Math.abs(option.value - value) < Math.abs(best - value)) best = option.value
  }
  return best
}

function formatBitrate(bitsPerSecond: number | undefined): string | null {
  if (!bitsPerSecond || bitsPerSecond <= 0) return null
  const mbps: number = bitsPerSecond / 1_000_000
  return mbps >= 10 ? `${Math.round(mbps)} Mbps` : `${mbps.toFixed(1)} Mbps`
}

function decoderSummary(selected: VideoQualityTrack | undefined): string | null {
  let info: VideoPlaybackInfo | null = null
  try {
    info = getPlayerController().mediaInfo
  } catch {
    info = null
  }
  const acceleration: string | null =
    info?.hardwareAccelerated === true ? "硬體解碼" : info?.hardwareAccelerated === false ? "軟體解碼" : null
  const parts: string[] = [info?.videoDecoder ?? null, acceleration, formatBitrate(selected?.bitrate)]
    .filter((part: string | null): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(" · ") : null
}

function SheetShell(props: { title: string; onDone: () => void; children: (VirtualNode | null)[] | VirtualNode }): VirtualNode {
  return (
    <NavigationStack presentationDetents={["medium", "large"]} presentationDragIndicator="visible">
      <Form
        formStyle="grouped"
        tint={palette.brand}
        navigationTitle={props.title}
        navigationBarTitleDisplayMode="inline"
        toolbar={{ confirmationAction: <Button title="完成" action={props.onDone} /> }}
      >
        {props.children}
      </Form>
    </NavigationStack>
  )
}

export function QualitySheet(props: { onDone: () => void }): VirtualNode {
  const store = usePlayerStore()
  const qualities: VideoQualityTrack[] = store.manifest?.qualities ?? []
  const summary: string | null = decoderSummary(
    qualities.find((quality: VideoQualityTrack): boolean => quality.id === store.selectedQualityId),
  )

  return (
    <SheetShell title="畫質" onDone={props.onDone}>
      <Section header={<Text>畫質</Text>} footer={summary ? <Text>{summary}</Text> : undefined}>
        {qualities.length === 0 ? (
          <Text foregroundStyle="secondaryLabel">尚無可用畫質</Text>
        ) : qualities.map((quality: VideoQualityTrack) => {
          const selected: boolean = quality.id === store.selectedQualityId
          const detail: string = [quality.delivery.toUpperCase(), quality.codec, formatBitrate(quality.bitrate)]
            .filter(Boolean)
            .join(" · ")
          return (
            <Button
              key={`quality-${quality.id}`}
              action={() => {
                void selectQuality(quality.id)
                props.onDone()
              }}
            >
              <HStack frame={{ maxWidth: "infinity" }} contentShape="rect">
                <VStack alignment="leading" spacing={2}>
                  <Text font={type.cardTitle + 1} fontWeight={selected ? "semibold" : "regular"} foregroundStyle="label">
                    {quality.label}
                  </Text>
                  <Text font={type.meta} foregroundStyle="secondaryLabel">{detail}</Text>
                </VStack>
                <Spacer />
                {selected ? <Image systemName="checkmark" fontWeight="semibold" foregroundStyle={palette.brand} /> : null}
              </HStack>
            </Button>
          )
        })}
      </Section>

      <Section>
        <Toggle title="播放統計" value={store.statsVisible} onChanged={(value: boolean) => setStatsVisible(value)} />
      </Section>
    </SheetShell>
  )
}

export function DanmakuSheet(props: { onDone: () => void }): VirtualNode {
  const store = usePlayerStore()
  const settings = store.settings

  return (
    <SheetShell title="彈幕" onDone={props.onDone}>
      <Section>
        <Toggle
          title="顯示彈幕"
          value={store.danmakuEnabled}
          onChanged={(value: boolean) => updateDanmakuSettings({ danmakuEnabled: value })}
        />
      </Section>
      <Section title="顯示區域">
        <Picker
          title="顯示區域"
          value={nearestArea(settings.danmakuArea)}
          onChanged={(value: number) => updateDanmakuSettings({ danmakuArea: value })}
          pickerStyle="segmented"
        >
          {AREA_OPTIONS.map(option => (
            <Text key={`area-${option.value}`} tag={option.value}>{option.label}</Text>
          ))}
        </Picker>
      </Section>
      <Section title="外觀">
        <VStack alignment="leading" spacing={6}>
          <HStack>
            <Text>不透明度</Text>
            <Spacer />
            <Text monospacedDigit foregroundStyle="secondaryLabel">{`${Math.round(settings.danmakuOpacity * 100)}%`}</Text>
          </HStack>
          <Slider
            value={settings.danmakuOpacity}
            min={0.1}
            max={1}
            step={0.05}
            onChanged={(value: number) => updateDanmakuSettings({ danmakuOpacity: value })}
          />
        </VStack>
        <VStack alignment="leading" spacing={6}>
          <HStack>
            <Text>速度</Text>
            <Spacer />
            <Text monospacedDigit foregroundStyle="secondaryLabel">{`${settings.danmakuSpeed.toFixed(2)}×`}</Text>
          </HStack>
          <Slider
            value={settings.danmakuSpeed}
            min={0.5}
            max={2}
            step={0.25}
            onChanged={(value: number) => updateDanmakuSettings({ danmakuSpeed: value })}
          />
        </VStack>
      </Section>
    </SheetShell>
  )
}
