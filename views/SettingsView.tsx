import {
  Button,
  Form,
  Image,
  LabeledContent,
  Section,
  Script,
  Text,
  useEffect,
  useState,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { PlayerSettings, Provider, ProviderAuthState } from "../types/index"
import {
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
  subscribeStorageChanges,
  updateSettings,
} from "../services/index"
import type { AccountActionResult } from "../actions/index"
import { runLogoutFlow, runPasteCookiesFlow, runWebLoginFlow } from "../actions/index"
import {
  BACKEND_OPTIONS,
  QUALITY_OPTIONS,
  RATE_OPTIONS,
  nearestOption,
  optionLabelOf,
} from "../utils/playbackOptions"
import { AccountRow, LinkRow } from "../components/settings/SettingsRows"
import {
  DanmakuBlockedWordsSection,
  DanmakuSettingsSection,
} from "../components/settings/DanmakuSettingsSection"
import { palette } from "../ui/theme"
import { useToast } from "../ui/useToast"

export interface SettingsViewProps {
  onExitApp?: () => void
  onOpenPlayback?: () => void
  onOpenSponsorBlock?: () => void
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
  const toast = useToast()

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
    }, ["settings", "subscriptions", "history", "watchLater", "playlists"])
  }, [])

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
    const result: AccountActionResult = await runWebLoginFlow(provider)
    if (result.auth) setAuth(provider, result.auth)
    if (result.message) toast.showToast(result.message)
  }

  const handlePasteCookies = async (provider: Provider): Promise<void> => {
    const result: AccountActionResult = await runPasteCookiesFlow(provider)
    if (result.auth) setAuth(provider, result.auth)
    if (result.message) toast.showToast(result.message)
  }

  const handleLogout = async (provider: Provider): Promise<void> => {
    const result: AccountActionResult = await runLogoutFlow(provider)
    if (result.auth) setAuth(provider, result.auth)
    if (result.message) toast.showToast(result.message)
  }

  const handleExportClipboard = async (): Promise<void> => {
    const json: string = exportAllData()
    await Pasteboard.setString(json)
    toast.showToast("備份已複製到剪貼簿")
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
      toast.showToast("備份已匯入")
    } else {
      await Dialog.alert({
        title: "匯入失敗",
        message: "JSON 格式不正確或內容毀損。",
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
    toast.showToast("已清空觀看紀錄")
  }

  const handleExit = async (): Promise<void> => {
    if (!props.onExitApp) return
    const index: number | null = await Dialog.actionSheet({
      title: "結束 Yobi",
      actions: [{ label: "結束", destructive: true }],
    })
    if (typeof index !== "number") return
    props.onExitApp()
  }

  return (
    <Form
      formStyle="grouped"
      tint={palette.brand}
      navigationTitle="設定"
      navigationBarTitleDisplayMode="large"
      scrollEdgeEffectStyle="soft"
      toolbar={{
        topBarTrailing: props.onExitApp ? (
          <Button role="destructive" buttonStyle="plain" action={() => void handleExit()}>
            <Image systemName="power" font={17} fontWeight="semibold" foregroundStyle={palette.danger} />
          </Button>
        ) : undefined,
      }}
      toast={{ ...toast.toastProps, position: "bottom" }}
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

      <Section>
        <LinkRow
          icon="play.rectangle.fill"
          color="#FF9500"
          title="播放"
          summary={[
            optionLabelOf(BACKEND_OPTIONS, settings.videoBackend),
            optionLabelOf(QUALITY_OPTIONS, nearestOption(QUALITY_OPTIONS, settings.preferredQualityHeight)),
            optionLabelOf(RATE_OPTIONS, nearestOption(RATE_OPTIONS, settings.defaultPlaybackRate)),
          ].join("・")}
          onTap={props.onOpenPlayback}
        />
        <LinkRow
          icon="shield.lefthalf.filled"
          color="#2ECC71"
          title="SponsorBlock / 空降助手"
          summary={settings.sponsorBlockEnabled
            ? `已啟用・${settings.sponsorBlockAutoSkip ? "自動" : "手動"}跳過（${settings.sponsorBlockCategories.length} 個分類）`
            : "已停用"}
          onTap={props.onOpenSponsorBlock}
        />
      </Section>

      <DanmakuSettingsSection settings={settings} onPatch={patchSettings} />

      <DanmakuBlockedWordsSection settings={settings} onPatch={patchSettings} />

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
            toast.showToast("已清空搜尋紀錄")
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
