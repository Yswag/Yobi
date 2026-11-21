import { fetch } from "scripting"
import { getCookieHeader, utf8Bytes } from "../auth"

export const BILI_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
export const BILI_REFERER = "https://www.bilibili.com/"

const NAV_URL = "https://api.bilibili.com/x/web-interface/nav"
const SPI_URL = "https://api.bilibili.com/x/frontend/finger/spi"
const BUVID_KEY = "yobi.bili.buvid.v1"
const WBI_TTL = 60 * 60 * 1000
const BUVID_TTL = 7 * 24 * 60 * 60 * 1000

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

const MD5_SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

const MD5_K = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0,
)

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

function littleEndianHex(value: number): string {
  let output = ""
  for (let i = 0; i < 4; i++) {
    output += ((value >>> (i * 8)) & 0xff).toString(16).padStart(2, "0")
  }
  return output
}

export function md5Hex(input: string): string {
  const bytes = utf8Bytes(input)
  const bitLength = bytes.length * 8
  const blockCount = ((bytes.length + 8) >> 6) + 1
  const buffer = new Uint8Array(blockCount * 64)
  buffer.set(bytes)
  buffer[bytes.length] = 0x80

  const view = new DataView(buffer.buffer)
  view.setUint32(buffer.length - 8, bitLength % 4294967296, true)
  view.setUint32(buffer.length - 4, Math.floor(bitLength / 4294967296), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  const m = new Uint32Array(16)
  for (let offset = 0; offset < buffer.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      m[i] = view.getUint32(offset + i * 4, true)
    }

    let a = a0
    let b = b0
    let c = c0
    let d = d0

    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      const temp = d
      d = c
      c = b
      b = (b + rotl((a + f + MD5_K[i] + m[g]) >>> 0, MD5_SHIFT[i])) >>> 0
      a = temp
    }

    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }

  return littleEndianHex(a0) + littleEndianHex(b0) + littleEndianHex(c0) + littleEndianHex(d0)
}

interface WbiKeyCache {
  imgKey: string
  subKey: string
  at: number
}

let wbiKeyCache: WbiKeyCache | null = null

interface BuvidCache {
  buvid3: string
  buvid4: string
  at: number
}

let buvidCache: BuvidCache | null = null

function extractKey(url: unknown): string {
  if (typeof url !== "string" || !url) return ""
  const file = url.split("?")[0].split("/").pop() ?? ""
  return file.replace(/\.[a-zA-Z0-9]+$/, "")
}

function parseCookieHeader(header: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of header.split(";")) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const index = trimmed.indexOf("=")
    if (index <= 0) continue
    map.set(trimmed.slice(0, index), trimmed.slice(index + 1))
  }
  return map
}

async function getBuvid(): Promise<BuvidCache | null> {
  if (buvidCache && Date.now() - buvidCache.at < BUVID_TTL) return buvidCache

  const stored = Storage.get<BuvidCache>(BUVID_KEY)
  if (
    stored &&
    typeof stored.buvid3 === "string" &&
    stored.buvid3.length > 0 &&
    Date.now() - stored.at < BUVID_TTL
  ) {
    buvidCache = stored
    return stored
  }

  try {
    const res = await fetch(SPI_URL, {
      headers: {
        "User-Agent": BILI_USER_AGENT,
        Referer: BILI_REFERER,
      },
    })
    if (!res.ok) return buvidCache
    const json: any = await res.json()
    const data = json?.data ?? {}
    if (typeof data.b_3 !== "string" || !data.b_3) return buvidCache
    const next: BuvidCache = {
      buvid3: data.b_3,
      buvid4: typeof data.b_4 === "string" ? data.b_4 : "",
      at: Date.now(),
    }
    buvidCache = next
    Storage.set(BUVID_KEY, next)
    return next
  } catch {
    return buvidCache
  }
}

export async function getBiliCookieHeader(): Promise<string> {
  const map = parseCookieHeader(getCookieHeader("bili"))
  const buvid = await getBuvid()
  if (buvid) {
    if (!map.get("buvid3")) map.set("buvid3", buvid.buvid3)
    if (buvid.buvid4 && !map.get("buvid4")) map.set("buvid4", buvid.buvid4)
  }
  return Array.from(map.entries())
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ")
}

export async function getBiliRequestHeaders(): Promise<Record<string, string>> {
  return {
    "User-Agent": BILI_USER_AGENT,
    Referer: BILI_REFERER,
    Origin: "https://www.bilibili.com",
    Accept: "application/json, text/plain, */*",
    Cookie: await getBiliCookieHeader(),
  }
}

export async function getWbiKeys(): Promise<{ imgKey: string; subKey: string }> {
  if (wbiKeyCache && Date.now() - wbiKeyCache.at < WBI_TTL) {
    return { imgKey: wbiKeyCache.imgKey, subKey: wbiKeyCache.subKey }
  }

  try {
    const res = await fetch(NAV_URL, { headers: await getBiliRequestHeaders() })
    if (res.ok) {
      const json: any = await res.json()
      const wbiImg = json?.data?.wbi_img
      const imgKey = extractKey(wbiImg?.img_url)
      const subKey = extractKey(wbiImg?.sub_url)
      if (imgKey && subKey) {
        wbiKeyCache = { imgKey, subKey, at: Date.now() }
        return { imgKey, subKey }
      }
    }
  } catch {
  }

  if (wbiKeyCache) {
    return { imgKey: wbiKeyCache.imgKey, subKey: wbiKeyCache.subKey }
  }

  return { imgKey: "", subKey: "" }
}

function mixinKeyFor(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey
  let mixed = ""
  for (let i = 0; i < MIXIN_KEY_ENC_TAB.length; i++) {
    const index = MIXIN_KEY_ENC_TAB[i]
    mixed += raw[index] ?? ""
  }
  return mixed.slice(0, 32)
}

function cleanValue(value: string): string {
  return value.replace(/[!'()*]/g, "")
}

export async function signWbiParams(
  params: Record<string, string | number>,
): Promise<string> {
  const { imgKey, subKey } = await getWbiKeys()
  return signWbiParamsWithKeys(params, imgKey, subKey)
}

function signWbiParamsWithKeys(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
): string {
  const mixinKey = mixinKeyFor(imgKey, subKey)
  const merged: Record<string, string> = {}
  for (const name of Object.keys(params ?? {})) {
    const value = params[name]
    if (value === undefined || value === null) continue
    merged[name] = cleanValue(String(value))
  }
  merged.wts = String(Math.floor(Date.now() / 1000))

  const query = Object.keys(merged)
    .sort()
    .map(name => `${encodeURIComponent(name)}=${encodeURIComponent(merged[name])}`)
    .join("&")

  const wRid = md5Hex(query + mixinKey)
  return `${query}&w_rid=${wRid}`
}

function buildQuery(params: Record<string, string | number>): string {
  return Object.keys(params)
    .filter(name => params[name] !== undefined && params[name] !== null)
    .map(name => `${encodeURIComponent(name)}=${encodeURIComponent(String(params[name]))}`)
    .join("&")
}

export type BiliFailureKind = "banned" | "retryable" | "deprecated" | "unknown"

export class BiliApiError extends Error {
  readonly kind: BiliFailureKind
  readonly code: number | null
  readonly status: number | null

  constructor(message: string, kind: BiliFailureKind, code: number | null, status: number | null) {
    super(message)
    this.name = "BiliApiError"
    this.kind = kind
    this.code = code
    this.status = status
  }
}

export function classifyBiliCode(code: number | null | undefined): BiliFailureKind {
  if (typeof code !== "number") return "unknown"
  if (code === 0) return "unknown"
  if (code === -412 || code === -352 || code === -509 || code === -799) return "banned"
  if (code === -404 || code === -400 || code === 62002 || code === 62004) return "deprecated"
  if (code <= -500 && code >= -504) return "retryable"
  return "unknown"
}

function classifyStatus(status: number): BiliFailureKind {
  if (status === 412 || status === 403) return "banned"
  if (status === 429 || status >= 500) return "retryable"
  if (status === 404) return "deprecated"
  return "unknown"
}

export function biliErrorKind(error: unknown): BiliFailureKind {
  return error instanceof BiliApiError ? error.kind : "unknown"
}

export function biliCodeError(code: number, message: string): BiliApiError {
  return new BiliApiError(message || `BiliBili 回應 ${code}`, classifyBiliCode(code), code, null)
}

export async function biliFetchJson<T>(
  url: string,
  params?: Record<string, string | number>,
  useWbi = false,
): Promise<T> {
  const query = params
    ? useWbi
      ? await signWbiParams(params)
      : buildQuery(params)
    : ""
  const fullUrl = query ? `${url}${url.includes("?") ? "&" : "?"}${query}` : url

  const res = await fetch(fullUrl, { headers: await getBiliRequestHeaders() })
  if (!res.ok) {
    throw new BiliApiError(`BiliBili 請求失敗 (${res.status})`, classifyStatus(res.status), null, res.status)
  }
  return (await res.json()) as T
}
