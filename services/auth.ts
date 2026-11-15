import { fetch } from "scripting"
import type { Provider, ProviderAuthState } from "../types"

const AUTH_KEY = "yobi.auth.v1"
const BILI_REFERER = "https://www.bilibili.com/"
const BILI_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

type AuthStore = Partial<Record<Provider, ProviderAuthState>>

interface CookieLike {
  name: string
  value: string
  domain?: string
}

// ─── Pure TS helpers ────────────────────────────────────────────────────────

/** UTF-8 encode a string into bytes without relying on TextEncoder. */
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

/** Zero-dependency SHA-1, returns a lowercase hex digest. */
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

// ─── Store ──────────────────────────────────────────────────────────────────

function readStore(): AuthStore {
  const stored = Storage.get<AuthStore>(AUTH_KEY)
  return stored && typeof stored === "object" ? stored : {}
}

function writeStore(store: AuthStore): void {
  Storage.set(AUTH_KEY, store)
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

export function setAuthCookies(
  provider: Provider,
  cookies: Record<string, string>,
  profile?: { username?: string; userId?: string; avatarUrl?: string },
): ProviderAuthState {
  const store = readStore()
  const previous = store[provider] ?? emptyState(provider)
  const merged: Record<string, string> = { ...previous.cookies }
  for (const name of Object.keys(cookies ?? {})) {
    const value = cookies[name]
    if (typeof value === "string") merged[name] = value
  }

  const state: ProviderAuthState = {
    provider,
    loggedIn: hasLoginCookie(provider, merged),
    username: profile?.username ?? previous.username,
    userId: profile?.userId ?? previous.userId,
    avatarUrl: profile?.avatarUrl ?? previous.avatarUrl,
    cookieHeader: buildCookieHeader(merged),
    cookies: merged,
    updatedAt: Date.now(),
  }

  if (!state.loggedIn && !profile) {
    // Nothing logged in and no profile info: keep the record cheap but consistent.
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

// ─── YouTube SAPISIDHASH ────────────────────────────────────────────────────

export function buildYoutubeSapisidHashHeader(
  origin = "https://www.youtube.com",
): Promise<string | null> {
  const cookies = getAuthState("yt").cookies
  const sapisid = cookies["SAPISID"] || cookies["__Secure-3PAPISID"]
  if (!sapisid) return Promise.resolve(null)
  const timestamp = Math.floor(Date.now() / 1000)
  const digest = sha1Hex(`${timestamp} ${sapisid} ${origin}`)
  return Promise.resolve(`SAPISIDHASH ${timestamp}_${digest}`)
}

// ─── WebView login ──────────────────────────────────────────────────────────

function domainMatches(domain: string | undefined, provider: Provider): boolean {
  const host = (domain ?? "").toLowerCase()
  if (provider === "bili") return host.includes("bilibili.com")
  return host.includes("youtube.com") || host.includes("google.com")
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

export async function loginWithWebView(provider: Provider): Promise<ProviderAuthState> {
  const controller = new WebViewController()
  const homeUrl = provider === "bili" ? "https://m.bilibili.com" : "https://m.youtube.com"
  const navigationTitle = provider === "bili" ? "登入 BiliBili" : "登入 YouTube"

  try {
    await controller.loadURL(homeUrl)
    await controller.present({ navigationTitle })

    let webCookies: CookieLike[] = []
    try {
      webCookies = await controller.getAllCookies()
    } catch {
      webCookies = []
    }

    if (!webCookies.length) {
      try {
        webCookies = await controller.getCookies(homeUrl)
      } catch {
        webCookies = []
      }
    }

    const collected: Record<string, string> = {}
    for (const cookie of webCookies) {
      if (!cookie || !cookie.name) continue
      if (!domainMatches(cookie.domain, provider)) continue
      collected[cookie.name] = cookie.value
    }

    if (!Object.keys(collected).length) {
      // User dismissed the sheet without logging in.
      return getAuthState(provider)
    }

    const merged = { ...getAuthState(provider).cookies, ...collected }
    const profile = provider === "bili" ? await fetchBiliProfile(merged) : undefined
    return setAuthCookies(provider, merged, profile)
  } finally {
    try {
      controller.dispose()
    } catch {
      // ignore disposal errors
    }
  }
}
