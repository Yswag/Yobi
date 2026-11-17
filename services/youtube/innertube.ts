/**
 * YouTube Innertube API 客戶端（純 fetch）。
 *
 * 多種 client context：
 * - VISIONOS：免 PoToken 的 `hlsManifestUrl`（影音合併、可任意 seek，最高 4K），需要 visitorData。
 * - IOS：影片詳情，以及 SABR 備援的直連 adaptiveFormats。
 * - WEB：搜尋、browse、next、留言。
 * - WEB_SABR / MWEB / ANDROID_VR：取得 serverAbrStreamingUrl + ustreamerConfig。
 */

import { fetch } from "scripting"
import { getAuthState } from "../auth"

export type InnertubeClientKey = "IOS" | "VISIONOS" | "WEB" | "WEB_SABR" | "MWEB" | "ANDROID_VR" | "TVHTML5"

/** 鬆散 JSON 型別，對應 Innertube 的巢狀回應。 */
export type JsonObject = Record<string, any>

export interface InnertubeClientConfig {
  clientName: number
  clientVersion: string
  userAgent: string
  context: JsonObject
}

export interface YoutubeAuthSnapshot {
  cookie?: string
  sapisid?: string
  authorization?: string
  visitorData?: string
}

const IOS_UA: string = "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_1 like Mac OS X;)"
const WEB_UA: string =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
const VISIONOS_UA: string =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
const ANDROID_VR_UA: string =
  "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; en_US; Quest 3 Build/SQ3A.220605.009.A1) gzip"

export const INNERTUBE_CLIENTS: Record<InnertubeClientKey, InnertubeClientConfig> = {
  IOS: {
    clientName: 5,
    clientVersion: "20.10.4",
    userAgent: IOS_UA,
    context: {
      client: {
        clientName: "IOS",
        clientVersion: "20.10.4",
        deviceMake: "Apple",
        deviceModel: "iPhone16,2",
        osName: "iPhone",
        osVersion: "18.3.1.22D72",
        hl: "en",
        gl: "US",
        utcOffsetMinutes: 0,
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true, internalExperimentFlags: [] },
    },
  },
  WEB: {
    clientName: 1,
    clientVersion: "2.20250219.01.00",
    userAgent: WEB_UA,
    context: {
      client: { clientName: "WEB", clientVersion: "2.20250219.01.00", hl: "en", gl: "US" },
      user: { lockedSafetyMode: false },
      request: { useSsl: true, internalExperimentFlags: [] },
    },
  },
  WEB_SABR: {
    clientName: 1,
    clientVersion: "2.20250219.01.00",
    userAgent: WEB_UA,
    context: {
      client: { clientName: "WEB", clientVersion: "2.20250219.01.00", hl: "en", gl: "US" },
      user: { lockedSafetyMode: false },
      request: { useSsl: true, internalExperimentFlags: [] },
    },
  },
  MWEB: {
    clientName: 2,
    clientVersion: "2.20250219.01.00",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
    context: {
      client: { clientName: "MWEB", clientVersion: "2.20250219.01.00", hl: "en", gl: "US" },
      user: { lockedSafetyMode: false },
      request: { useSsl: true, internalExperimentFlags: [] },
    },
  },
  ANDROID_VR: {
    clientName: 28,
    clientVersion: "1.62.27",
    userAgent: ANDROID_VR_UA,
    context: {
      client: {
        clientName: "ANDROID_VR",
        clientVersion: "1.62.27",
        deviceMake: "Oculus",
        deviceModel: "Quest 3",
        osName: "Android",
        osVersion: "12",
        androidSdkVersion: 32,
        hl: "en",
        gl: "US",
        utcOffsetMinutes: 0,
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true, internalExperimentFlags: [] },
    },
  },
  VISIONOS: {
    clientName: 101,
    clientVersion: "1.02",
    userAgent: VISIONOS_UA,
    context: {
      client: {
        clientName: "VISIONOS",
        clientVersion: "1.02",
        hl: "en",
        gl: "US",
        userAgent: VISIONOS_UA,
        deviceMake: "Apple",
        deviceModel: "RealityDevice17,1",
        osName: "visionOS",
        osVersion: "26.5.23O471",
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true, internalExperimentFlags: [] },
    },
  },
  TVHTML5: {
    clientName: 7,
    clientVersion: "7.20250205.10.00",
    userAgent:
      "Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15",
    context: {
      client: {
        clientName: "TVHTML5",
        clientVersion: "7.20250205.10.00",
        hl: "en",
        gl: "US",
        utcOffsetMinutes: 0,
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    },
  },
}

let anonymousVisitorData: string | null = null

/** visitorData for requests without a stored one; fetched once per run. */
export async function getAnonymousVisitorData(): Promise<string | undefined> {
  if (anonymousVisitorData) return anonymousVisitorData
  try {
    const response = await fetch("https://www.youtube.com/youtubei/v1/visitor_id?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": WEB_UA },
      body: JSON.stringify({ context: INNERTUBE_CLIENTS.WEB.context }),
      timeout: 15,
      debugLabel: "Yobi visitor_id",
    })
    const data = (await response.json()) as JsonObject
    const value: unknown = data?.["responseContext"]?.["visitorData"]
    if (typeof value === "string" && value) anonymousVisitorData = value
  } catch (_error) {
    return undefined
  }
  return anonymousVisitorData ?? undefined
}

let cachedAuth: YoutubeAuthSnapshot | null = null
let cachedAuthAt: number = 0
const AUTH_CACHE_MS: number = 30_000

/** 讀取使用者設定的 YouTube 憑證（Cookie + SAPISIDHASH）。 */
export function getYoutubeAuth(): YoutubeAuthSnapshot {
  const now: number = Date.now()
  if (cachedAuth && now - cachedAuthAt < AUTH_CACHE_MS) {
    return cachedAuth
  }

  let cookie: string | undefined
  let sapisid: string | undefined
  let visitorData: string | undefined

  try {
    const state = getAuthState("yt")
    cookie = state.cookieHeader || undefined
    sapisid = state.cookies["SAPISID"] || state.cookies["__Secure-3PAPISID"] || undefined
  } catch (_error) {
    cookie = undefined
  }

  try {
    const stored: unknown = Storage.get<unknown>("yobi.auth.v1")
    if (stored && typeof stored === "object") {
      const yt: JsonObject | null = (stored as JsonObject)["yt"] ?? null
      if (yt && typeof yt["visitorData"] === "string") {
        visitorData = String(yt["visitorData"])
      }
    }
  } catch (_error) {
    visitorData = undefined
  }

  let authorization: string | undefined
  if (sapisid) {
    const timestamp: string = Math.floor(now / 1000).toString()
    const input: Data | null = Data.fromRawString(`${timestamp} ${sapisid} https://www.youtube.com`, "utf-8")
    if (input) {
      authorization = `SAPISIDHASH ${timestamp}_${Crypto.sha1(input).toHexString()}`
    }
  }

  cachedAuth = { cookie, sapisid, authorization, visitorData }
  cachedAuthAt = now
  return cachedAuth
}

/** 讓外部（登入流程）清掉快取。 */
export function invalidateYoutubeAuthCache(): void {
  cachedAuth = null
  cachedAuthAt = 0
}

function buildHeaders(clientKey: InnertubeClientKey, auth: YoutubeAuthSnapshot): Record<string, string> {
  const config: InnertubeClientConfig = INNERTUBE_CLIENTS[clientKey]
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-YouTube-Client-Name": String(config.clientName),
    "X-YouTube-Client-Version": config.clientVersion,
    "User-Agent": config.userAgent,
    Origin: "https://www.youtube.com",
    Referer: "https://www.youtube.com/",
  }
  if (auth.visitorData) {
    headers["X-Goog-Visitor-Id"] = auth.visitorData
  }
  if (auth.cookie) {
    headers["Cookie"] = auth.cookie
  }
  if (auth.authorization) {
    headers["Authorization"] = auth.authorization
    headers["X-Origin"] = "https://www.youtube.com"
  }
  if (clientKey === "ANDROID_VR" || clientKey === "IOS") {
    headers["X-Goog-Api-Format-Version"] = "2"
  }
  return headers
}

export interface InnertubeRequestOptions {
  client?: InnertubeClientKey
  headers?: Record<string, string>
  timeoutSeconds?: number
  /** Overrides the stored visitorData, e.g. to match the one a PO token was minted for. */
  visitorData?: string
}

/** 呼叫 Innertube API。`endpoint` 例如 "player"、"search"、"browse"、"next"。 */
export async function innertubePost(
  endpoint: string,
  payload: JsonObject,
  options: InnertubeRequestOptions = {},
): Promise<JsonObject> {
  const clientKey: InnertubeClientKey = options.client ?? "WEB"
  const config: InnertubeClientConfig = INNERTUBE_CLIENTS[clientKey]
  const auth: YoutubeAuthSnapshot = getYoutubeAuth()
  const headers: Record<string, string> = { ...buildHeaders(clientKey, auth), ...(options.headers ?? {}) }
  const visitorData: string | undefined = options.visitorData ?? auth.visitorData
  if (options.visitorData) headers["X-Goog-Visitor-Id"] = options.visitorData

  const context: JsonObject = payload["context"] ?? config.context
  const body: JsonObject = { ...payload, context }
  if (visitorData) {
    body["visitorData"] = visitorData
  }

  const url: string = `https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeout: options.timeoutSeconds ?? 25,
    debugLabel: `Yobi Innertube ${endpoint}`,
  })
  const text: string = await response.text()
  if (!response.ok) {
    throw new Error(`Innertube ${endpoint} 失敗：HTTP ${response.status} ${text.slice(0, 200)}`)
  }
  try {
    return JSON.parse(text) as JsonObject
  } catch (_error) {
    throw new Error(`Innertube ${endpoint} 回應不是 JSON`)
  }
}

export interface PlayerRequestOptions {
  poToken?: string
  signatureTimestamp?: number
  reloadPlaybackParamsToken?: string
  visitorData?: string
}

/** 取得 player response。 */
export async function fetchPlayerResponse(
  videoId: string,
  clientKey: InnertubeClientKey,
  options: PlayerRequestOptions = {},
): Promise<JsonObject> {
  const contentPlaybackContext: JsonObject = {
    vis: 0,
    splay: false,
    lactMilliseconds: "-1",
    signatureTimestamp: options.signatureTimestamp ?? 0,
  }
  const playback: JsonObject = { contentPlaybackContext }
  if (options.reloadPlaybackParamsToken) {
    playback["reloadPlaybackContext"] = { reloadPlaybackParams: { token: options.reloadPlaybackParamsToken } }
  }

  const payload: JsonObject = {
    videoId,
    playbackContext: playback,
    contentCheckOk: true,
    racyCheckOk: true,
    attestationRequest: { omitBotguardData: true },
  }
  if (options.poToken) {
    payload["serviceIntegrityDimensions"] = { poToken: options.poToken }
  }
  if (options.visitorData) {
    const context: JsonObject = INNERTUBE_CLIENTS[clientKey].context
    payload["context"] = { ...context, client: { ...context["client"], visitorData: options.visitorData } }
  }
  return innertubePost("player", payload, { client: clientKey, visitorData: options.visitorData })
}

/** 搜尋。 */
export async function fetchSearchResponse(query: string, params?: string): Promise<JsonObject> {
  const payload: JsonObject = { query }
  if (params) payload["params"] = params
  return innertubePost("search", payload, { client: "WEB" })
}

/** browse（首頁、頻道）。 */
export async function fetchBrowseResponse(browseId: string, params?: string): Promise<JsonObject> {
  const payload: JsonObject = { browseId }
  if (params) payload["params"] = params
  return innertubePost("browse", payload, { client: "WEB" })
}

/** browse 的續頁（頻道影片、播放清單）。 */
export async function fetchBrowseContinuation(continuation: string): Promise<JsonObject> {
  return innertubePost("browse", { continuation }, { client: "WEB" })
}

/** next（推薦、章節、留言）。 */
export async function fetchNextResponse(videoId: string, continuation?: string): Promise<JsonObject> {
  if (continuation) {
    return innertubePost("next", { continuation }, { client: "WEB" })
  }
  return innertubePost("next", { videoId }, { client: "WEB" })
}
