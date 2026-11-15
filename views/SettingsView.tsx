import {
  Button,
  HStack,
  Image,
  ScrollView,
  Spacer,
  Text,
  Toggle,
  VStack,
  ZStack,
  useEffect,
  useState,
} from "scripting"
import type { Color, VirtualNode } from "scripting"
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
import {
  SPONSOR_CATEGORY_LABELS,
  providerAccentColor,
  providerFullName,
} from "../utils/format"

export interface SettingsViewProps {
  onClose?: () => void
  onExitApp?: () => void
}

const LINK_BLUE: Color = "rgba(10,132,255,1)"
const YT_RED: Color = "rgba(255,46,77,1)"
const BILI_PINK: Color = "rgba(251,114,153,1)"

const STREAM_MODE_OPTIONS: { label: string; value: YoutubeStreamPreference }[] = [
  { label: "Auto (HLS+SABR)", value: "auto" },
  { label: "HLS 優先", value: "hls" },
  { label: "SABR 優先", value: "sabr" },
]

const QUALITY_OPTIONS: { label: string; value: number }[] = [
  { label: "4K (2160p)", value: 2160 },
  { label: "1080p", value: 1080 },
  { label: "720p", value: 720 },
  { label: "480p", value: 480 },
]

const RATE_OPTIONS: { label: string; value: number }[] = [
  { label: "0.75x", value: 0.75 },
  { label: "1.0x", value: 1.0 },
  { label: "1.25x", value: 1.25 },
  { label: "1.5x", value: 1.5 },
  { label: "2.0x", value: 2.0 },
]

const AREA_OPTIONS: { label: string; value: number }[] = [
  { label: "1/4 螢幕", value: 0.25 },
  { label: "半螢幕", value: 0.5 },
  { label: "3/4 螢幕", value: 0.75 },
  { label: "全螢幕", value: 1.0 },
]

const OPACITY_OPTIONS: { label: string; value: number }[] = [
  { label: "50%", value: 0.5 },
  { label: "70%", value: 0.7 },
  { label: "90%", value: 0.9 },
  { label: "100%", value: 1.0 },
]

const SPEED_OPTIONS: { label: string; value: number }[] = [
  { label: "慢 (0.75x)", value: 0.75 },
  { label: "標準 (1.0x)", value: 1.0 },
  { label: "快 (1.25x)", value: 1.25 },
  { label: "極快 (1.5x)", value: 1.5 },
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

function SectionCard(props: { title: string; icon: string; children?: VirtualNode | VirtualNode[] }): VirtualNode {
  return (
    <VStack
      alignment="leading"
      spacing={12}
      padding={14}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background="secondarySystemGroupedBackground"
      clipShape={{ type: "rect", cornerRadius: 14 }}
    >
      <HStack spacing={8}>
        <Image systemName={props.icon} font={14} foregroundStyle={LINK_BLUE} />
        <Text font={14} fontWeight="bold" foregroundStyle="label">
          {props.title}
        </Text>
      </HStack>
      {props.children}
    </VStack>
  )
}

function OptionPill(props: {
  label: string
  active: boolean
  activeColor?: Color
  onTap: () => void
}): VirtualNode {
  const color: Color = props.activeColor ?? LINK_BLUE
  return (
    <HStack
      spacing={0}
      padding={{ horizontal: 11, vertical: 6 }}
      background={props.active ? color : "tertiarySystemFill"}
      clipShape="capsule"
      onTapGesture={props.onTap}
    >
      <Text
        font={12}
        fontWeight={props.active ? "semibold" : "regular"}
        foregroundStyle={props.active ? "white" : "label"}
      >
        {props.label}
      </Text>
    </HStack>
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
    setTimeout(() => {
      setStatusMessage(null)
    }, 2400)
  }

  const patchSettings = (patch: Partial<PlayerSettings>): void => {
    const next: PlayerSettings = updateSettings(patch)
    setSettings(next)
  }

  const handleWebLogin = async (provider: Provider): Promise<void> => {
    try {
      const next: ProviderAuthState = await loginWithWebView(provider)
      if (provider === "bili") {
        setBiliAuth(next)
      } else {
        setYtAuth(next)
      }
      showToast(
        next.loggedIn
          ? `${providerFullName(provider)} 登入成功`
          : `已更新 ${providerFullName(provider)} Cookie (${Object.keys(next.cookies).length} 項)`,
      )
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "WebView 登入失敗")
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
    const next: ProviderAuthState = setAuthCookies(provider, parsed)
    if (provider === "bili") {
      setBiliAuth(next)
    } else {
      setYtAuth(next)
    }
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
    if (provider === "bili") {
      setBiliAuth(getAuthState("bili"))
    } else {
      setYtAuth(getAuthState("yt"))
    }
    showToast(`已清除 ${providerFullName(provider)} 登入狀態`)
  }

  const toggleSponsorCategory = (category: SponsorCategory): void => {
    const current: SponsorCategory[] = settings.sponsorBlockCategories
    const exists: boolean = current.includes(category)
    const next: SponsorCategory[] = exists
      ? current.filter((item: SponsorCategory): boolean => item !== category)
      : [...current, category]
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
    showToast("已將完整備份 JSON 複製到剪貼簿")
  }

  const handleImportClipboard = async (): Promise<void> => {
    const clip: string = (await Pasteboard.getString()) ?? ""
    const input: string | null = await Dialog.prompt({
      title: "匯入備份 JSON",
      message: "貼上先前匯出的 Yobi JSON 備份內容",
      defaultValue: clip.trim().startsWith("{") ? clip : "",
      placeholder: "{\"version\":1,...}",
      confirmLabel: "匯入",
    })
    if (!input) return
    const ok: boolean = importAllData(input)
    if (ok) {
      refreshAll()
      showToast("備份資料匯入成功")
    } else {
      await Dialog.alert({
        title: "匯入失敗",
        message: "JSON 格式不正確或內容損毀。",
      })
    }
  }

  const renderAccountRow = (provider: Provider, state: ProviderAuthState): VirtualNode => {
    const accent: Color = provider === "bili" ? BILI_PINK : YT_RED
    const cookieCount: number = Object.keys(state.cookies).length
    const statusText: string = state.loggedIn
      ? state.username
        ? `已登入：${state.username}`
        : `已登入 (${cookieCount} Cookies)`
      : cookieCount > 0
        ? `已儲存 ${cookieCount} 個 Cookie`
        : "未登入"

    return (
      <VStack
        alignment="leading"
        spacing={10}
        padding={12}
        frame={{ maxWidth: "infinity", alignment: "leading" }}
        background="tertiarySystemFill"
        clipShape={{ type: "rect", cornerRadius: 12 }}
      >
        <HStack spacing={10} frame={{ maxWidth: "infinity" }}>
          <ZStack
            frame={{ width: 36, height: 36 }}
            background={accent}
            clipShape="circle"
          >
            <Text font={12} fontWeight="bold" foregroundStyle="white">
              {provider === "bili" ? "BILI" : "YT"}
            </Text>
          </ZStack>

          <VStack alignment="leading" spacing={2}>
            <Text font={14} fontWeight="semibold" foregroundStyle="label">
              {providerFullName(provider)}
            </Text>
            <Text
              font={12}
              foregroundStyle={state.loggedIn ? "rgba(48,209,88,1)" : "secondaryLabel"}
            >
              {statusText}
            </Text>
          </VStack>

          <Spacer />

          <HStack
            spacing={4}
            padding={{ horizontal: 12, vertical: 6 }}
            background={accent}
            clipShape="capsule"
            onTapGesture={() => {
              void handleWebLogin(provider)
            }}
          >
            <Image systemName="globe" font={12} foregroundStyle="white" />
            <Text font={12} fontWeight="semibold" foregroundStyle="white">
              網頁登入
            </Text>
          </HStack>
        </HStack>

        <HStack spacing={8}>
          <HStack
            spacing={4}
            padding={{ horizontal: 10, vertical: 5 }}
            background="quaternarySystemFill"
            clipShape="capsule"
            onTapGesture={() => {
              void handlePasteCookies(provider)
            }}
          >
            <Image systemName="doc.on.clipboard" font={11} foregroundStyle="secondaryLabel" />
            <Text font={11} foregroundStyle="label">
              貼上 Cookie
            </Text>
          </HStack>

          {cookieCount > 0 ? (
            <HStack
              spacing={4}
              padding={{ horizontal: 10, vertical: 5 }}
              background="quaternarySystemFill"
              clipShape="capsule"
              onTapGesture={() => {
                void handleLogout(provider)
              }}
            >
              <Image systemName="trash" font={11} foregroundStyle="rgba(255,59,48,1)" />
              <Text font={11} foregroundStyle="rgba(255,59,48,1)">
                清除 Cookie
              </Text>
            </HStack>
          ) : null}
        </HStack>
      </VStack>
    )
  }

  return (
    <VStack
      spacing={0}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      background="systemGroupedBackground"
    >
      <HStack
        spacing={10}
        padding={{ horizontal: 16, vertical: 12 }}
        frame={{ maxWidth: "infinity" }}
        background="secondarySystemGroupedBackground"
      >
        {props.onClose ? (
          <HStack
            spacing={4}
            padding={{ horizontal: 10, vertical: 6 }}
            background="tertiarySystemFill"
            clipShape="capsule"
            onTapGesture={props.onClose}
          >
            <Image systemName="chevron.left" font={12} foregroundStyle="label" />
            <Text font={13} fontWeight="medium" foregroundStyle="label">
              返回
            </Text>
          </HStack>
        ) : null}

        <Text font={20} fontWeight="bold" foregroundStyle="label">
          設定與帳號
        </Text>

        <Spacer />

        {props.onExitApp ? (
          <HStack
            spacing={5}
            padding={{ horizontal: 12, vertical: 6 }}
            background="rgba(255,59,48,0.14)"
            clipShape="capsule"
            onTapGesture={props.onExitApp}
          >
            <Image systemName="power" font={12} foregroundStyle="rgba(255,59,48,1)" />
            <Text font={12} fontWeight="semibold" foregroundStyle="rgba(255,59,48,1)">
              關閉腳本
            </Text>
          </HStack>
        ) : null}
      </HStack>

      {statusMessage ? (
        <HStack
          spacing={6}
          padding={{ horizontal: 14, vertical: 8 }}
          frame={{ maxWidth: "infinity" }}
          background="rgba(10,132,255,0.15)"
        >
          <Image systemName="checkmark.circle.fill" font={13} foregroundStyle={LINK_BLUE} />
          <Text font={12} fontWeight="medium" foregroundStyle={LINK_BLUE}>
            {statusMessage}
          </Text>
          <Spacer />
        </HStack>
      ) : null}

      <ScrollView axes="vertical" scrollIndicator="automatic">
        <VStack spacing={14} padding={14} frame={{ maxWidth: "infinity" }}>
          <SectionCard title="平台帳號與 Cookie" icon="person.crop.circle.badge.checkmark">
            {renderAccountRow("yt", ytAuth)}
            {renderAccountRow("bili", biliAuth)}
            <Text font={11} foregroundStyle="secondaryLabel">
              登入 BiliBili 可解鎖 1080P+ 高畫質與完整彈幕；YouTube 預設免登入即可透過雙引擎播放。
            </Text>
          </SectionCard>

          <SectionCard title="播放與串流引擎" icon="play.tv.fill">
            <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={12} foregroundStyle="secondaryLabel">
                YouTube 串流模式
              </Text>
              <ScrollView axes="horizontal" scrollIndicator="hidden">
                <HStack spacing={6}>
                  {STREAM_MODE_OPTIONS.map(opt => (
                    <OptionPill
                      key={`stream-${opt.value}`}
                      label={opt.label}
                      active={settings.youtubeStreamMode === opt.value}
                      activeColor={YT_RED}
                      onTap={() => patchSettings({ youtubeStreamMode: opt.value })}
                    />
                  ))}
                </HStack>
              </ScrollView>
            </VStack>

            <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={12} foregroundStyle="secondaryLabel">
                預設偏好畫質
              </Text>
              <ScrollView axes="horizontal" scrollIndicator="hidden">
                <HStack spacing={6}>
                  {QUALITY_OPTIONS.map(opt => (
                    <OptionPill
                      key={`q-${opt.value}`}
                      label={opt.label}
                      active={settings.preferredQualityHeight === opt.value}
                      onTap={() => patchSettings({ preferredQualityHeight: opt.value })}
                    />
                  ))}
                </HStack>
              </ScrollView>
            </VStack>

            <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={12} foregroundStyle="secondaryLabel">
                預設播放速度
              </Text>
              <ScrollView axes="horizontal" scrollIndicator="hidden">
                <HStack spacing={6}>
                  {RATE_OPTIONS.map(opt => (
                    <OptionPill
                      key={`rate-${opt.value}`}
                      label={opt.label}
                      active={settings.defaultPlaybackRate === opt.value}
                      onTap={() => patchSettings({ defaultPlaybackRate: opt.value })}
                    />
                  ))}
                </HStack>
              </ScrollView>
            </VStack>

            <Toggle
              title="允許背景與鎖屏音訊播放"
              value={settings.backgroundAudioEnabled}
              onChanged={(val: boolean) => patchSettings({ backgroundAudioEnabled: val })}
            />
          </SectionCard>

          <SectionCard title="SponsorBlock 片段跳過" icon="forward.end.alt.fill">
            <Toggle
              title="啟用 SponsorBlock (YouTube)"
              value={settings.sponsorBlockEnabled}
              onChanged={(val: boolean) => patchSettings({ sponsorBlockEnabled: val })}
            />
            <Toggle
              title="自動跳過片段（關閉則顯示跳過提示按鈕）"
              value={settings.sponsorBlockAutoSkip}
              onChanged={(val: boolean) => patchSettings({ sponsorBlockAutoSkip: val })}
            />
            <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={12} foregroundStyle="secondaryLabel">
                偵測類別
              </Text>
              <ScrollView axes="horizontal" scrollIndicator="hidden">
                <HStack spacing={6}>
                  {ALL_SPONSOR_CATEGORIES.map((cat: SponsorCategory) => (
                    <OptionPill
                      key={`sb-${cat}`}
                      label={SPONSOR_CATEGORY_LABELS[cat]}
                      active={settings.sponsorBlockCategories.includes(cat)}
                      onTap={() => toggleSponsorCategory(cat)}
                    />
                  ))}
                </HStack>
              </ScrollView>
            </VStack>
          </SectionCard>

          <SectionCard title="BiliBili 彈幕設定" icon="bubble.left.and.bubble.right.fill">
            <Toggle
              title="預設開啟彈幕"
              value={settings.danmakuEnabled}
              onChanged={(val: boolean) => patchSettings({ danmakuEnabled: val })}
            />

            <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={12} foregroundStyle="secondaryLabel">
                顯示區域
              </Text>
              <ScrollView axes="horizontal" scrollIndicator="hidden">
                <HStack spacing={6}>
                  {AREA_OPTIONS.map(opt => (
                    <OptionPill
                      key={`area-${opt.value}`}
                      label={opt.label}
                      active={settings.danmakuArea === opt.value}
                      activeColor={BILI_PINK}
                      onTap={() => patchSettings({ danmakuArea: opt.value })}
                    />
                  ))}
                </HStack>
              </ScrollView>
            </VStack>

            <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={12} foregroundStyle="secondaryLabel">
                不透明度
              </Text>
              <ScrollView axes="horizontal" scrollIndicator="hidden">
                <HStack spacing={6}>
                  {OPACITY_OPTIONS.map(opt => (
                    <OptionPill
                      key={`op-${opt.value}`}
                      label={opt.label}
                      active={Math.abs(settings.danmakuOpacity - opt.value) < 0.05}
                      activeColor={BILI_PINK}
                      onTap={() => patchSettings({ danmakuOpacity: opt.value })}
                    />
                  ))}
                </HStack>
              </ScrollView>
            </VStack>

            <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={12} foregroundStyle="secondaryLabel">
                彈幕速度
              </Text>
              <ScrollView axes="horizontal" scrollIndicator="hidden">
                <HStack spacing={6}>
                  {SPEED_OPTIONS.map(opt => (
                    <OptionPill
                      key={`spd-${opt.value}`}
                      label={opt.label}
                      active={Math.abs(settings.danmakuSpeed - opt.value) < 0.05}
                      activeColor={BILI_PINK}
                      onTap={() => patchSettings({ danmakuSpeed: opt.value })}
                    />
                  ))}
                </HStack>
              </ScrollView>
            </VStack>

            <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
                <Text font={12} foregroundStyle="secondaryLabel">
                  彈幕屏蔽詞 ({settings.danmakuBlockedWords.length})
                </Text>
                <Spacer />
                <HStack
                  spacing={4}
                  padding={{ horizontal: 10, vertical: 4 }}
                  background="tertiarySystemFill"
                  clipShape="capsule"
                  onTapGesture={() => {
                    void handleAddBlockedWord()
                  }}
                >
                  <Image systemName="plus" font={10} foregroundStyle={LINK_BLUE} />
                  <Text font={11} fontWeight="medium" foregroundStyle={LINK_BLUE}>
                    新增
                  </Text>
                </HStack>
              </HStack>

              {settings.danmakuBlockedWords.length > 0 ? (
                <ScrollView axes="horizontal" scrollIndicator="hidden">
                  <HStack spacing={6}>
                    {settings.danmakuBlockedWords.map((word: string) => (
                      <HStack
                        key={`bw-${word}`}
                        spacing={4}
                        padding={{ horizontal: 10, vertical: 5 }}
                        background="tertiarySystemFill"
                        clipShape="capsule"
                        onTapGesture={() => handleRemoveBlockedWord(word)}
                      >
                        <Text font={11} foregroundStyle="label">
                          {word}
                        </Text>
                        <Image systemName="xmark.circle.fill" font={11} foregroundStyle="secondaryLabel" />
                      </HStack>
                    ))}
                  </HStack>
                </ScrollView>
              ) : (
                <Text font={11} foregroundStyle="tertiaryLabel">
                  尚未設定屏蔽關鍵字
                </Text>
              )}
            </VStack>
          </SectionCard>

          <SectionCard title="本機資料與備份" icon="externaldrive.fill.badge.icloud">
            <Text font={12} foregroundStyle="secondaryLabel">
              {`已訂閱 ${stats.subscriptions} 頻道 · 歷史 ${stats.history} 筆 · 稍後觀看 ${stats.watchLater} 部 · 清單 ${stats.playlists} 個`}
            </Text>

            <HStack spacing={8}>
              <HStack
                spacing={6}
                padding={{ horizontal: 12, vertical: 8 }}
                background={LINK_BLUE}
                clipShape="capsule"
                onTapGesture={() => {
                  void handleExportClipboard()
                }}
              >
                <Image systemName="doc.on.doc.fill" font={12} foregroundStyle="white" />
                <Text font={12} fontWeight="semibold" foregroundStyle="white">
                  匯出備份至剪貼簿
                </Text>
              </HStack>

              <HStack
                spacing={6}
                padding={{ horizontal: 12, vertical: 8 }}
                background="tertiarySystemFill"
                clipShape="capsule"
                onTapGesture={() => {
                  void handleImportClipboard()
                }}
              >
                <Image systemName="square.and.arrow.down" font={12} foregroundStyle="label" />
                <Text font={12} fontWeight="medium" foregroundStyle="label">
                  從剪貼簿匯入
                </Text>
              </HStack>
            </HStack>

            <HStack spacing={8}>
              <Button
                title="清空觀看歷史"
                role="destructive"
                buttonStyle="bordered"
                controlSize="small"
                action={() => {
                  void Dialog.confirm({
                    title: "清空觀看歷史",
                    message: "確定要清除所有本機觀看紀錄嗎？",
                    confirmLabel: "清空",
                  }).then((ok: boolean) => {
                    if (ok) {
                      clearWatchHistory()
                      showToast("已清空觀看歷史")
                    }
                  })
                }}
              />
              <Button
                title="清空搜尋紀錄"
                role="destructive"
                buttonStyle="bordered"
                controlSize="small"
                action={() => {
                  clearSearchHistory()
                  showToast("已清空搜尋紀錄")
                }}
              />
            </HStack>
          </SectionCard>

          <Spacer frame={{ height: 96 }} />
        </VStack>
      </ScrollView>
    </VStack>
  )
}
