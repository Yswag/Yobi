import type { Provider, ProviderAuthState } from "../types/index"
import {
  clearAuth,
  getAuthState,
  invalidateYoutubeAuthCache,
  isAuthPersistenceAvailable,
  loginWithWebView,
  setAuthCookies,
} from "../services/index"
import { providerFullName } from "../utils/format"

export interface AccountActionResult {
  auth?: ProviderAuthState
  message?: string
}

export function parseCookieString(raw: string): Record<string, string> {
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

export async function runWebLoginFlow(provider: Provider): Promise<AccountActionResult> {
  try {
    const next: ProviderAuthState = await loginWithWebView(provider)
    if (provider === "yt") invalidateYoutubeAuthCache()
    const count: number = Object.keys(next.cookies).length
    if (!isAuthPersistenceAvailable()) {
      return { auth: next, message: "登入只在本次有效：無法寫入 Keychain" }
    }
    const message: string = next.loggedIn
      ? `${providerFullName(provider)} 登入成功${next.username ? `：${next.username}` : ""}`
      : count > 0
        ? `已更新 ${providerFullName(provider)} Cookie（${count} 項）`
        : "登入未完成"
    return { auth: next, message }
  } catch (err: unknown) {
    return { message: err instanceof Error ? err.message : "網頁登入失敗" }
  }
}

export async function runPasteCookiesFlow(provider: Provider): Promise<AccountActionResult> {
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
  if (input === null) return {}
  const parsed: Record<string, string> = parseCookieString(input)
  if (Object.keys(parsed).length === 0) {
    await Dialog.alert({
      title: "格式無效",
      message: "找不到有效的 key=value 項目。",
    })
    return {}
  }
  const state: ProviderAuthState = setAuthCookies(provider, parsed)
  if (!isAuthPersistenceAvailable()) {
    return { auth: state, message: "Cookie 只在本次有效：無法寫入 Keychain" }
  }
  return {
    auth: state,
    message: `已儲存 ${Object.keys(parsed).length} 個 ${providerFullName(provider)} Cookie`,
  }
}

export async function runLogoutFlow(provider: Provider): Promise<AccountActionResult> {
  const confirmed: boolean = await Dialog.confirm({
    title: `登出 ${providerFullName(provider)}`,
    message: "確定要清除本機儲存的登入 Cookie 嗎？",
    confirmLabel: "清除",
  })
  if (!confirmed) return {}
  clearAuth(provider)
  if (provider === "yt") invalidateYoutubeAuthCache()
  return {
    auth: getAuthState(provider),
    message: `已清除 ${providerFullName(provider)} 登入狀態`,
  }
}
