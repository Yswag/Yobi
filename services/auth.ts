import { fetch } from "scripting"
import type { Provider, ProviderAuthState } from "../types"
import { setYoutubeLocale } from "./youtube/locale"
import { reportError } from "./errors"

const AUTH_KEY = "yobi.auth.v1"
const BILI_REFERER = "https://www.bilibili.com/"
const BILI_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

const YT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
const YT_CLIENT_VERSION = "2.20250219.01.00"
const YOUTUBE_LOGIN_URL =
  "https://accounts.google.com/ServiceLogin?service=youtube&uilel=3&passive=true&continue=" +
  encodeURIComponent("https://m.youtube.com/")

type AuthStore = Partial<Record<Provider, ProviderAuthState>>

interface CookieLike {
  name: string
  value: string
  domain?: string
}

export function utf8Bytes(input: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const low = input.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        i++
      }
    }
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return Uint8Array.from(out)
}

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0")
}

export function sha1Hex(input: string): string {
  const bytes = utf8Bytes(input)
  const bitLength = bytes.length * 8
  const blockCount = ((bytes.length + 8) >> 6) + 1
  const buffer = new Uint8Array(blockCount * 64)
  buffer.set(bytes)
  buffer[bytes.length] = 0x80

  const view = new DataView(buffer.buffer)
  view.setUint32(buffer.length - 8, Math.floor(bitLength / 4294967296), false)
  view.setUint32(buffer.length - 4, bitLength % 4294967296, false)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0

  const w = new Uint32Array(80)
  for (let offset = 0; offset < buffer.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false)
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1)
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4

    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0
      e = d
      d = c
      c = rotl(b, 30)
      b = a
      a = temp
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  return hex32(h0) + hex32(h1) + hex32(h2) + hex32(h3) + hex32(h4)
}

function parseStore(raw: unknown): AuthStore {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw)
      return parsed && typeof parsed === "object" ? (parsed as AuthStore) : {}
    } catch {
      return {}
    }
  }
  return raw && typeof raw === "object" ? (raw as AuthStore) : {}
}

let sessionStore: AuthStore | null = null
let persistFailed: boolean = false

export function isAuthPersistenceAvailable(): boolean {
  return !persistFailed
}

function readStore(): AuthStore {
  let stored: string | null = null
  try {
    stored = Keychain.get(AUTH_KEY)
  } catch (error) {
    reportError("auth", "keychain.read", error)
    stored = null
  }
  if (stored) return parseStore(stored)
  if (sessionStore) return sessionStore

  const legacy: unknown = Storage.get<unknown>(AUTH_KEY)
  if (!legacy) return {}
  const migrated: AuthStore = parseStore(legacy)
  if (Object.keys(migrated).length === 0) {
    Storage.remove(AUTH_KEY)
    return {}
  }
  if (!writeStore(migrated)) Storage.remove(AUTH_KEY)
  return migrated
}

function writeStore(store: AuthStore): boolean {
  sessionStore = store
  try {
    if (Keychain.set(AUTH_KEY, JSON.stringify(store))) {
      Storage.remove(AUTH_KEY)
      persistFailed = false
      return true
    }
  } catch (error) {
    reportError("auth", "keychain.write", error)
  }
  if (!persistFailed) {
    reportError(
      "auth",
      "store.persist",
      new Error("Keychain 寫入失敗，登入狀態只保留到本次執行結束"),
    )
  }
  persistFailed = true
  Storage.remove(AUTH_KEY)
  return false
}

function emptyState(provider: Provider): ProviderAuthState {
  return {
    provider,
    loggedIn: false,
    cookieHeader: "",
    cookies: {},
    updatedAt: 0,
  }
}

function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.keys(cookies)
    .filter(name => typeof cookies[name] === "string" && cookies[name].length > 0)
    .map(name => `${name}=${cookies[name]}`)
    .join("; ")
}

function hasLoginCookie(provider: Provider, cookies: Record<string, string>): boolean {
  const keys =
    provider === "bili"
      ? ["SESSDATA", "bili_jct", "DedeUserID"]
      : ["SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID", "SID", "__Secure-1PSID", "SIDCC"]
  return keys.some(key => {
    const value = cookies[key]
    return typeof value === "string" && value.length > 0
  })
}

export function getAuthState(provider: Provider): ProviderAuthState {
  const state = readStore()[provider]
  return state ? { ...state, cookies: { ...state.cookies } } : emptyState(provider)
}

export function getYoutubeVisitorData(): string | undefined {
  const visitor: unknown = readStore()["yt"]?.visitorData
  return typeof visitor === "string" && visitor.length > 0 ? visitor : undefined
}

export function setAuthCookies(
  provider: Provider,
  cookies: Record<string, string>,
  profile?: { username?: string; userId?: string; avatarUrl?: string },
  visitorData?: string,
): ProviderAuthState {
  const store = readStore()
  const previous = store[provider] ?? emptyState(provider)
  const merged: Record<string, string> = { ...previous.cookies }
  for (const name of Object.keys(cookies ?? {})) {
    const value = cookies[name]
    if (typeof value === "string") merged[name] = value
  }

  const sapisidChanged: boolean =
    provider === "yt" &&
    typeof cookies["SAPISID"] === "string" &&
    cookies["SAPISID"].length > 0 &&
    cookies["SAPISID"] !== previous.cookies["SAPISID"]
  const nextVisitorData: string | undefined = sapisidChanged ? undefined : visitorData ?? previous.visitorData

  const state: ProviderAuthState = {
    provider,
    loggedIn: hasLoginCookie(provider, merged),
    username: profile?.username ?? previous.username,
    userId: profile?.userId ?? previous.userId,
    avatarUrl: profile?.avatarUrl ?? previous.avatarUrl,
    visitorData: nextVisitorData,
    cookieHeader: buildCookieHeader(merged),
    cookies: merged,
    updatedAt: Date.now(),
  }

  if (!state.loggedIn && !profile) {
    state.username = undefined
    state.userId = undefined
    state.avatarUrl = undefined
  }

  store[provider] = state
  writeStore(store)
  return { ...state, cookies: { ...state.cookies } }
}

export function clearAuth(provider: Provider): void {
  const store = readStore()
  delete store[provider]
  writeStore(store)
}

export function getCookieHeader(provider: Provider): string {
  return getAuthState(provider).cookieHeader
}

function sapisidHash(
  cookies: Record<string, string>,
  origin = "https://www.youtube.com",
): string | null {
  const sapisid: string | undefined = cookies["SAPISID"] || cookies["__Secure-3PAPISID"]
  if (!sapisid) return null
  const timestamp: number = Math.floor(Date.now() / 1000)
  return `SAPISIDHASH ${timestamp}_${sha1Hex(`${timestamp} ${sapisid} ${origin}`)}`
}

export function buildYoutubeSapisidHashHeader(
  origin = "https://www.youtube.com",
): Promise<string | null> {
  return Promise.resolve(sapisidHash(getAuthState("yt").cookies, origin))
}

function isYoutubeHost(domain: string | undefined): boolean {
  const host: string = (domain ?? "").toLowerCase().replace(/^\./, "")
  return host === "youtube.com" || host.endsWith(".youtube.com")
}

function domainMatches(domain: string | undefined, provider: Provider): boolean {
  if (provider === "bili") return (domain ?? "").toLowerCase().includes("bilibili.com")
  return isYoutubeHost(domain)
}

async function fetchBiliProfile(
  cookies: Record<string, string>,
): Promise<{ username?: string; userId?: string; avatarUrl?: string } | undefined> {
  try {
    const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
      headers: {
        "User-Agent": BILI_USER_AGENT,
        Referer: BILI_REFERER,
        Cookie: buildCookieHeader(cookies),
      },
    })
    if (!res.ok) return undefined
    const json: any = await res.json()
    if (json?.code !== 0 || !json?.data?.isLogin) return undefined
    const data = json.data
    return {
      username: typeof data.uname === "string" ? data.uname : undefined,
      userId: data.mid != null ? String(data.mid) : undefined,
      avatarUrl: typeof data.face === "string" ? data.face : undefined,
    }
  } catch {
    return undefined
  }
}

const BILI_APP_PROMPT_CSS = `
.m-open-app, .fixed-openapp, .m-fixed-openapp, .m-navbar-openapp, .launch-app-btn {
  display: none !important;
}
`

const BILI_LOGIN_URL =
  "https://passport.bilibili.com/h5-app/passport/login?gourl=" +
  encodeURIComponent("https://m.bilibili.com/")

type JsonNode = Record<string, any>

function findKey(node: unknown, key: string, depth: number = 0): JsonNode | null {
  if (!node || typeof node !== "object" || depth > 12) return null
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found: JsonNode | null = findKey(entry, key, depth + 1)
      if (found) return found
    }
    return null
  }
  const object = node as JsonNode
  if (object[key] && typeof object[key] === "object") return object[key] as JsonNode
  for (const value of Object.values(object)) {
    const found: JsonNode | null = findKey(value, key, depth + 1)
    if (found) return found
  }
  return null
}

function textOf(node: unknown): string | undefined {
  if (typeof node === "string") return node || undefined
  if (!node || typeof node !== "object") return undefined
  const object = node as JsonNode
  if (typeof object["simpleText"] === "string") return object["simpleText"] || undefined
  const runs: unknown = object["runs"]
  if (!Array.isArray(runs)) return undefined
  const text: string = runs
    .map((run: unknown) => (run && typeof (run as JsonNode)["text"] === "string" ? (run as JsonNode)["text"] : ""))
    .join("")
  return text || undefined
}

function largestThumbnailUrl(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined
  const list: unknown = (node as JsonNode)["thumbnails"]
  if (!Array.isArray(list) || list.length === 0) return undefined
  const last = list[list.length - 1] as JsonNode | null
  return last && typeof last["url"] === "string" ? last["url"] : undefined
}

async function fetchYoutubeProfile(
  cookies: Record<string, string>,
  visitorData?: string,
): Promise<{ username?: string; userId?: string; avatarUrl?: string } | undefined> {
  const authorization: string | null = sapisidHash(cookies)
  if (!authorization) return undefined

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": YT_USER_AGENT,
    Origin: "https://www.youtube.com",
    "X-Origin": "https://www.youtube.com",
    "X-YouTube-Client-Name": "1",
    "X-YouTube-Client-Version": YT_CLIENT_VERSION,
    "X-Goog-AuthUser": "0",
    Cookie: buildCookieHeader(cookies),
    Authorization: authorization,
  }
  if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData

  const client: Record<string, string> = {
    clientName: "WEB",
    clientVersion: YT_CLIENT_VERSION,
    hl: "en",
    gl: "US",
  }
  if (visitorData) client["visitorData"] = visitorData

  try {
    const response = await fetch("https://www.youtube.com/youtubei/v1/account/account_menu?prettyPrint=false", {
      method: "POST",
      headers,
      body: JSON.stringify({
        context: { client, user: { lockedSafetyMode: false }, request: { useSsl: true } },
      }),
      timeout: 20,
      debugLabel: "Yobi account menu",
    })
    if (!response.ok) return undefined
    const header = findKey(await response.json(), "activeAccountHeaderRenderer")
    if (!header) return undefined
    return {
      username: textOf(header["accountName"]),
      userId: typeof header["channelId"] === "string" ? header["channelId"] : undefined,
      avatarUrl: largestThumbnailUrl(header["accountPhoto"]),
    }
  } catch (error) {
    reportError("auth", "profile.fetch", error)
    return undefined
  }
}

async function collectCookies(
  controller: WebViewController,
  provider: Provider,
): Promise<Record<string, string>> {
  let webCookies: CookieLike[] = []
  try {
    webCookies = await controller.getAllCookies()
  } catch (error) {
    reportError("auth", "cookies.read", error)
    webCookies = []
  }
  const collected: Record<string, string> = {}
  for (const cookie of webCookies) {
    if (!cookie || !cookie.name) continue
    if (!domainMatches(cookie.domain, provider)) continue
    collected[cookie.name] = cookie.value
  }
  return collected
}

async function readYoutubeVisitorData(controller: WebViewController): Promise<string | undefined> {
  try {
    const raw: unknown = await controller.evaluateJavaScript(
      `return (window.ytcfg && window.ytcfg.get) ? JSON.stringify({ visitor: ytcfg.get("VISITOR_DATA") || "", hl: ytcfg.get("HL") || "", gl: ytcfg.get("GL") || "" }) : ""`,
    )
    if (typeof raw !== "string" || raw.length === 0) return undefined
    const parsed = JSON.parse(raw) as { visitor?: string; hl?: string; gl?: string }
    setYoutubeLocale(parsed.hl, parsed.gl)
    return parsed.visitor && parsed.visitor.length > 0 ? parsed.visitor : undefined
  } catch (error) {
    reportError("auth", "visitor.read", error)
    return undefined
  }
}

async function loginBili(): Promise<ProviderAuthState> {
  const controller = new WebViewController()
  try {
    try {
      await controller.addUserScript({
        source: `const s = document.createElement("style"); s.textContent = ${JSON.stringify(
          BILI_APP_PROMPT_CSS,
        )}; document.documentElement.appendChild(s);`,
        injectionTime: "documentEnd",
        forMainFrameOnly: true,
      })
    } catch (error) {
      reportError("auth", "userScript.inject", error)
    }

    await controller.loadURL(BILI_LOGIN_URL)
    await controller.present({ navigationTitle: "登入 BiliBili" })

    const collected: Record<string, string> = await collectCookies(controller, "bili")
    if (!Object.keys(collected).length) {
      return getAuthState("bili")
    }

    const merged: Record<string, string> = { ...getAuthState("bili").cookies, ...collected }
    return setAuthCookies("bili", merged, await fetchBiliProfile(merged))
  } finally {
    try {
      controller.dispose()
    } catch (error) {
      reportError("auth", "controller.dispose", error)
    }
  }
}

async function loginYoutube(): Promise<ProviderAuthState> {
  const controller = new WebViewController()
  let harvested: Record<string, string> | null = null
  let visitorData: string | undefined

  const harvest = async (): Promise<boolean> => {
    const url: string = controller.url ?? ""
    if (!/^https:\/\/(m|www)\.youtube\.com\//.test(url)) return false
    const cookies: Record<string, string> = await collectCookies(controller, "yt")
    if (!hasLoginCookie("yt", cookies)) return false
    harvested = cookies
    visitorData = await readYoutubeVisitorData(controller)
    return true
  }

  try {
    await controller.addEventListener("loadFinish", () => {
      void harvest().then((done: boolean) => {
        if (done) controller.dismiss()
      })
    })
    await controller.loadURL(YOUTUBE_LOGIN_URL)
    await controller.present({ navigationTitle: "登入 YouTube" })

    if (!harvested) await harvest()
    const cookies: Record<string, string> | null = harvested
    if (!cookies) return getAuthState("yt")
    return setAuthCookies("yt", cookies, await fetchYoutubeProfile(cookies, visitorData), visitorData)
  } finally {
    try {
      controller.dispose()
    } catch (error) {
      reportError("auth", "controller.dispose", error)
    }
  }
}

export async function loginWithWebView(provider: Provider): Promise<ProviderAuthState> {
  return provider === "yt" ? loginYoutube() : loginBili()
}
