import {
  Button,
  Form,
  HStack,
  Image,
  LabeledContent,
  Menu,
  Picker,
  Script,
  Section,
  Spacer,
  Text,
  Toggle,
  VStack,
  useEffect,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
import type {
  PlayerSettings,
  Provider,
  ProviderAuthState,
  SponsorCategory,
  YoutubeStreamPreference,
} from "../types/index"
import {
  clearAuth,
  clearSearchHistory,
  clearWatchHistory,
  exportAllData,
  getAuthState,
  getPlaylists,
  getSettings,
  getSubscriptions,
  getWatchHistory,
  getWatchLater,
  importAllData,
  loginWithWebView,
  setAuthCookies,
  subscribeStorageChanges,
  updateSettings,
} from "../services/index"
import { SPONSOR_CATEGORY_LABELS, providerBadgeLabel, providerFullName } from "../utils/format"
import { palette, providerColor } from "../ui/theme"

export interface SettingsViewProps {
  onExitApp?: () => void
}

interface Option<T> {
  label: string
  value: T
}

const STREAM_MODE_OPTIONS: Option<YoutubeStreamPreference>[] = [
  { label: "自動", value: "auto" },
  { label: "HLS 優先", value: "hls" },
  { label: "SABR 優先", value: "sabr" },
]

const QUALITY_OPTIONS: Option<number>[] = [
  { label: "4K", value: 2160 },
  { label: "1080p", value: 1080 },
  { label: "720p", value: 720 },
  { label: "480p", value: 480 },
]

const RATE_OPTIONS: Option<number>[] = [
  { label: "0.75×", value: 0.75 },
  { label: "1×", value: 1.0 },
  { label: "1.25×", value: 1.25 },
  { label: "1.5×", value: 1.5 },
  { label: "2×", value: 2.0 },
]

const AREA_OPTIONS: Option<number>[] = [
  { label: "1/4 螢幕", value: 0.25 },
  { label: "半螢幕", value: 0.5 },
  { label: "3/4 螢幕", value: 0.75 },
  { label: "全螢幕", value: 1.0 },
]

const OPACITY_OPTIONS: Option<number>[] = [
  { label: "50%", value: 0.5 },
  { label: "70%", value: 0.7 },
  { label: "90%", value: 0.9 },
  { label: "100%", value: 1.0 },
]

const SPEED_OPTIONS: Option<number>[] = [
  { label: "慢", value: 0.75 },
  { label: "標準", value: 1.0 },
  { label: "快", value: 1.25 },
  { label: "極快", value: 1.5 },
]

const ALL_SPONSOR_CATEGORIES: SponsorCategory[] = [
  "sponsor",
  "selfpromo",
  "interaction",
  "intro",
  "outro",
  "preview",
  "music_offtopic",
]

function parseCookieString(raw: string): Record<string, string> {
  const result: Record<string, string> = {}
  const parts: string[] = raw.split(/[;\n]+/)
  for (const part of parts) {
    const trimmed: string = part.trim()
    if (!trimmed) continue
    const eqIndex: number = trimmed.indexOf("=")
    if (eqIndex <= 0) continue
    const key: string = trimmed.slice(0, eqIndex).trim()
    const value: string = trimmed.slice(eqIndex + 1).trim()
    if (key && value) {
      result[key] = value
    }
  }
  return result
}

// Stored values may predate the option list; snap to the closest so the picker always shows a selection.
function nearest(options: Option<number>[], value: number): number {
  let best: number = options[0].value
  for (const option of options) {
    if (Math.abs(option.value - value) < Math.abs(best - value)) best = option.value
  }
  return best
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

function AccountRow(props: {
  provider: Provider
  state: ProviderAuthState
  onWebLogin: () => void
  onPasteCookies: () => void
  onLogout: () => void
}): VirtualNode {
  const cookieCount: number = Object.keys(props.state.cookies).length
  const statusText: string = props.state.loggedIn
    ? props.state.username ? props.state.username : "已登入"
    : cookieCount > 0 ? `已儲存 ${cookieCount} 個 Cookie` : "未登入"

  return (
    <Menu
      label={
        <HStack spacing={12} frame={{ maxWidth: "infinity" }} contentShape="rect">
          <VStack
            frame={{ width: 36, height: 36 }}
            background={{ style: providerColor(props.provider), shape: { type: "rect", cornerRadius: 18 } }}
          >
            <Text font={11} fontWeight="heavy" foregroundStyle={palette.onMedia}>
              {providerBadgeLabel(props.provider)}
            </Text>
          </VStack>
          <VStack alignment="leading" spacing={2}>
            <Text font={16} foregroundStyle="label">{providerFullName(props.provider)}</Text>
            <Text font={13} foregroundStyle={props.state.loggedIn ? palette.success : "secondaryLabel"}>
              {statusText}
            </Text>
          </VStack>
          <Spacer />
          <Image systemName="chevron.up.chevron.down" font={13} fontWeight="semibold" foregroundStyle="tertiaryLabel" />
        </HStack>
      }
    >
      <Button title="網頁登入" systemImage="globe" action={props.onWebLogin} />
      <Button title="貼上 Cookie" systemImage="doc.on.clipboard" action={props.onPasteCookies} />
      {cookieCount > 0 ? (
        <Button title="清除 Cookie" systemImage="trash" role="destructive" action={props.onLogout} />
      ) : null}
    </Menu>
  )
}

export function SettingsView(props: SettingsViewProps): VirtualNode {
  const [settings, setSettings] = useState<PlayerSettings>(() => getSettings())
  const [ytAuth, setYtAuth] = useState<ProviderAuthState>(() => getAuthState("yt"))
  const [biliAuth, setBiliAuth] = useState<ProviderAuthState>(() => getAuthState("bili"))
  const [stats, setStats] = useState<{
    subscriptions: number
    history: number
    watchLater: number
    playlists: number
  }>(() => ({
    subscriptions: getSubscriptions().length,
    history: getWatchHistory().length,
    watchLater: getWatchLater().length,
    playlists: getPlaylists().length,
  }))
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const refreshAll = (): void => {
    setSettings(getSettings())
    setYtAuth(getAuthState("yt"))
    setBiliAuth(getAuthState("bili"))
    setStats({
      subscriptions: getSubscriptions().length,
      history: getWatchHistory().length,
      watchLater: getWatchLater().length,
      playlists: getPlaylists().length,
    })
  }

  useEffect(() => {
    return subscribeStorageChanges(() => {
      refreshAll()
    })
  }, [])

  const showToast = (msg: string): void => {
    setStatusMessage(msg)
  }

  const patchSettings = (patch: Partial<PlayerSettings>): void => {
    const next: PlayerSettings = updateSettings(patch)
    setSettings(next)
  }

  const setAuth = (provider: Provider, next: ProviderAuthState): void => {
    if (provider === "bili") {
      setBiliAuth(next)
    } else {
      setYtAuth(next)
    }
  }

  const handleWebLogin = async (provider: Provider): Promise<void> => {
    try {
      const next: ProviderAuthState = await loginWithWebView(provider)
      setAuth(provider, next)
      showToast(
        next.loggedIn
          ? `${providerFullName(provider)} 登入成功`
          : `已更新 ${providerFullName(provider)} Cookie（${Object.keys(next.cookies).length} 項）`,
      )
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "網頁登入失敗")
    }
  }

  const handlePasteCookies = async (provider: Provider): Promise<void> => {
    const clipboard: string = (await Pasteboard.getString()) ?? ""
    const input: string | null = await Dialog.prompt({
      title: `貼上 ${providerFullName(provider)} Cookie`,
      message:
        provider === "bili"
          ? "輸入包含 SESSDATA 與 bili_jct 的 Cookie 字串"
          : "輸入包含 SAPISID / SID 的 Cookie 字串",
      defaultValue: clipboard.includes("=") ? clipboard : "",
      placeholder: "key1=value1; key2=value2",
      confirmLabel: "儲存",
    })
    if (input === null) return
    const parsed: Record<string, string> = parseCookieString(input)
    if (Object.keys(parsed).length === 0) {
      await Dialog.alert({
        title: "格式無效",
        message: "找不到有效的 key=value 項目。",
      })
      return
    }
    setAuth(provider, setAuthCookies(provider, parsed))
    showToast(`已儲存 ${Object.keys(parsed).length} 個 ${providerFullName(provider)} Cookie`)
  }

  const handleLogout = async (provider: Provider): Promise<void> => {
    const confirmed: boolean = await Dialog.confirm({
      title: `登出 ${providerFullName(provider)}`,
      message: "確定要清除本機儲存的登入 Cookie 嗎？",
      confirmLabel: "清除",
    })
    if (!confirmed) return
    clearAuth(provider)
    setAuth(provider, getAuthState(provider))
    showToast(`已清除 ${providerFullName(provider)} 登入狀態`)
  }

  const toggleSponsorCategory = (category: SponsorCategory, enabled: boolean): void => {
    const current: SponsorCategory[] = settings.sponsorBlockCategories
    const next: SponsorCategory[] = enabled
      ? [...current.filter((item: SponsorCategory): boolean => item !== category), category]
      : current.filter((item: SponsorCategory): boolean => item !== category)
    patchSettings({ sponsorBlockCategories: next })
  }

  const handleAddBlockedWord = async (): Promise<void> => {
    const word: string | null = await Dialog.prompt({
      title: "新增彈幕屏蔽詞",
      message: "包含此關鍵字的彈幕將自動隱藏",
      placeholder: "輸入關鍵字",
      confirmLabel: "新增",
    })
    const trimmed: string = (word ?? "").trim()
    if (!trimmed) return
    if (settings.danmakuBlockedWords.includes(trimmed)) return
    patchSettings({
      danmakuBlockedWords: [...settings.danmakuBlockedWords, trimmed],
    })
  }

  const handleRemoveBlockedWord = (word: string): void => {
    patchSettings({
      danmakuBlockedWords: settings.danmakuBlockedWords.filter((w: string): boolean => w !== word),
    })
  }

  const handleExportClipboard = async (): Promise<void> => {
    const json: string = exportAllData()
    await Pasteboard.setString(json)
    showToast("備份已複製到剪貼簿")
  }

  const handleImportClipboard = async (): Promise<void> => {
    const clip: string = (await Pasteboard.getString()) ?? ""
    const input: string | null = await Dialog.prompt({
      title: "匯入備份",
      message: "貼上先前匯出的 Yobi 備份內容",
      defaultValue: clip.trim().startsWith("{") ? clip : "",
      placeholder: "{\"version\":1,...}",
      confirmLabel: "匯入",
    })
    if (!input) return
    const ok: boolean = importAllData(input)
    if (ok) {
      refreshAll()
      showToast("備份已匯入")
    } else {
      await Dialog.alert({
        title: "匯入失敗",
        message: "JSON 格式不正確或內容損毀。",
      })
    }
  }

  const handleClearHistory = async (): Promise<void> => {
    const ok: boolean = await Dialog.confirm({
      title: "清空觀看紀錄",
      message: "確定要清除所有本機觀看紀錄嗎？",
      confirmLabel: "清空",
    })
    if (!ok) return
    clearWatchHistory()
    showToast("已清空觀看紀錄")
  }

  return (
    <Form
      formStyle="grouped"
      tint={palette.brand}
      navigationTitle="設定"
      navigationBarTitleDisplayMode="large"
      toast={{
        message: statusMessage ?? "",
        position: "bottom",
        isPresented: statusMessage !== null,
        onChanged: (presented: boolean) => {
          if (!presented) setStatusMessage(null)
        },
      }}
    >
      <Section
        header={<Text>帳號</Text>}
        footer={<Text>登入 BiliBili 可解鎖 1080P 以上畫質與完整彈幕；YouTube 不登入也能播放。</Text>}
      >
        <AccountRow
          provider="yt"
          state={ytAuth}
          onWebLogin={() => void handleWebLogin("yt")}
          onPasteCookies={() => void handlePasteCookies("yt")}
          onLogout={() => void handleLogout("yt")}
        />
        <AccountRow
          provider="bili"
          state={biliAuth}
          onWebLogin={() => void handleWebLogin("bili")}
          onPasteCookies={() => void handlePasteCookies("bili")}
          onLogout={() => void handleLogout("bili")}
        />
      </Section>

      <Section title="播放">
        <Picker
          title="YouTube 串流模式"
          value={settings.youtubeStreamMode}
          onChanged={(value: string) => patchSettings({ youtubeStreamMode: value as YoutubeStreamPreference })}
          pickerStyle="menu"
        >
          {STREAM_MODE_OPTIONS.map((option: Option<YoutubeStreamPreference>) => (
            <Text key={`stream-${option.value}`} tag={option.value}>{option.label}</Text>
          ))}
        </Picker>
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
        <Toggle
          title="背景與鎖定畫面播放"
          value={settings.backgroundAudioEnabled}
          onChanged={(value: boolean) => patchSettings({ backgroundAudioEnabled: value })}
        />
      </Section>

      <Section
        header={<Text>SponsorBlock</Text>}
        footer={<Text>只作用於 YouTube。關閉自動跳過時，片段開始會顯示跳過按鈕。</Text>}
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
        <Section title="要跳過的片段">
          {ALL_SPONSOR_CATEGORIES.map((category: SponsorCategory) => (
            <Toggle
              key={`sb-${category}`}
              title={SPONSOR_CATEGORY_LABELS[category]}
              value={settings.sponsorBlockCategories.includes(category)}
              onChanged={(value: boolean) => toggleSponsorCategory(category, value)}
            />
          ))}
        </Section>
      ) : null}

      <Section title="BiliBili 彈幕">
        <Toggle
          title="預設開啟彈幕"
          value={settings.danmakuEnabled}
          onChanged={(value: boolean) => patchSettings({ danmakuEnabled: value })}
        />
        <NumberPicker
          title="顯示區域"
          options={AREA_OPTIONS}
          value={settings.danmakuArea}
          onChange={(value: number) => patchSettings({ danmakuArea: value })}
        />
        <NumberPicker
          title="不透明度"
          options={OPACITY_OPTIONS}
          value={settings.danmakuOpacity}
          onChange={(value: number) => patchSettings({ danmakuOpacity: value })}
        />
        <NumberPicker
          title="速度"
          options={SPEED_OPTIONS}
          value={settings.danmakuSpeed}
          onChange={(value: number) => patchSettings({ danmakuSpeed: value })}
        />
      </Section>

      <Section
        header={<Text>{`屏蔽詞 ${settings.danmakuBlockedWords.length}`}</Text>}
        footer={<Text>包含這些關鍵字的彈幕會自動隱藏。</Text>}
      >
        {settings.danmakuBlockedWords.map((word: string) => (
          <Button key={`bw-${word}`} action={() => handleRemoveBlockedWord(word)}>
            <HStack frame={{ maxWidth: "infinity" }} contentShape="rect">
              <Text foregroundStyle="label">{word}</Text>
              <Spacer />
              <Image systemName="xmark.circle.fill" foregroundStyle="tertiaryLabel" />
            </HStack>
          </Button>
        ))}
        <Button title="新增屏蔽詞" systemImage="plus" action={() => void handleAddBlockedWord()} />
      </Section>

      <Section title="本機資料">
        <LabeledContent title="訂閱頻道" value={`${stats.subscriptions}`} />
        <LabeledContent title="觀看紀錄" value={`${stats.history}`} />
        <LabeledContent title="稍後觀看" value={`${stats.watchLater}`} />
        <LabeledContent title="播放清單" value={`${stats.playlists}`} />
        <Button title="匯出備份到剪貼簿" systemImage="square.and.arrow.up" action={() => void handleExportClipboard()} />
        <Button title="從剪貼簿匯入備份" systemImage="square.and.arrow.down" action={() => void handleImportClipboard()} />
      </Section>

      <Section>
        <Button
          title="清空觀看紀錄"
          role="destructive"
          foregroundStyle={palette.danger}
          action={() => void handleClearHistory()}
        />
        <Button
          title="清空搜尋紀錄"
          role="destructive"
          foregroundStyle={palette.danger}
          action={() => {
            clearSearchHistory()
            showToast("已清空搜尋紀錄")
          }}
        />
      </Section>

      {props.onExitApp ? (
        <Section footer={<Text>{`Yobi ${Script.metadata.version}`}</Text>}>
          <Button title="結束 Yobi" systemImage="power" foregroundStyle={palette.danger} action={props.onExitApp} />
        </Section>
      ) : null}
    </Form>
  )
}
