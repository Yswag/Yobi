/**
 * YouTube Innertube API 客戶端（純 fetch）。
 *
 * 多種 client context：
 * - IOS：免簽名即可拿到 `streamingData.hlsManifestUrl` 與 adaptiveFormats。
 * - WEB：搜尋、browse、next、留言。
 * - WEB_SABR / MWEB / ANDROID_VR：取得 serverAbrStreamingUrl + ustreamerConfig。
 */

import { fetch } from "scripting"
import { getAuthState } from "../auth"

export type InnertubeClientKey = "IOS" | "WEB" | "WEB_SABR" | "MWEB" | "ANDROID_VR" | "TVHTML5"

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

  const context: JsonObject = payload["context"] ?? config.context
  const body: JsonObject = { ...payload, context }
  if (auth.visitorData) {
    body["visitorData"] = auth.visitorData
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
}

/** 取得 player response（IOS 可直接拿到 hlsManifestUrl）。 */
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
  return innertubePost("player", payload, { client: clientKey })
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

/** next（推薦、章節、留言）。 */
export async function fetchNextResponse(videoId: string, continuation?: string): Promise<JsonObject> {
  if (continuation) {
    return innertubePost("next", { continuation }, { client: "WEB" })
  }
  return innertubePost("next", { videoId }, { client: "WEB" })
}
