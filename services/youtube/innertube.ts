
import { fetch } from "scripting"
import { getAuthState } from "../auth"
import { getYoutubeLocale } from "./locale"

export type InnertubeClientKey = "VISIONOS" | "WEB" | "WEB_SABR" | "MWEB" | "TVHTML5" | "ANDROID" | "IOS"

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

const WEB_UA: string =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
const VISIONOS_UA: string =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"

export const INNERTUBE_CLIENTS: Record<InnertubeClientKey, InnertubeClientConfig> = {
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
  ANDROID: {
    clientName: 3,
    clientVersion: "21.26.364",
    userAgent: "com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip",
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "21.26.364",
        androidSdkVersion: 30,
        osName: "Android",
        osVersion: "11",
        hl: "en",
        gl: "US",
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true, internalExperimentFlags: [] },
    },
  },
  IOS: {
    clientName: 5,
    clientVersion: "21.02.3",
    userAgent: "com.google.ios.youtube/21.02.3 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    context: {
      client: {
        clientName: "IOS",
        clientVersion: "21.02.3",
        deviceMake: "Apple",
        deviceModel: "iPhone16,2",
        osName: "iPhone",
        osVersion: "18.3.2.22D82",
        hl: "en",
        gl: "US",
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
    visitorData = state.visitorData
  } catch (_error) {
    cookie = undefined
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

export function invalidateYoutubeAuthCache(): void {
  cachedAuth = null
  cachedAuthAt = 0
}

const HASH_AUTH_CLIENTS: InnertubeClientKey[] = ["WEB", "WEB_SABR", "MWEB"]

const COOKIE_CLIENTS: InnertubeClientKey[] = ["WEB", "WEB_SABR", "MWEB"]

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
  if (auth.cookie && COOKIE_CLIENTS.includes(clientKey)) {
    headers["Cookie"] = auth.cookie
    headers["X-Goog-AuthUser"] = "0"
  }
  if (auth.authorization && HASH_AUTH_CLIENTS.includes(clientKey)) {
    headers["Authorization"] = auth.authorization
    headers["X-Origin"] = "https://www.youtube.com"
  }
  if (clientKey === "TVHTML5") {
    headers["X-Goog-Api-Format-Version"] = "2"
  }
  return headers
}

export interface InnertubeRequestOptions {
  client?: InnertubeClientKey
  headers?: Record<string, string>
  timeoutSeconds?: number
  visitorData?: string
}

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

  const baseContext: JsonObject = payload["context"] ?? config.context
  const locale = getYoutubeLocale()
  const clientContext: JsonObject = {
    ...(baseContext["client"] as JsonObject | undefined),
    hl: locale.hl,
    gl: locale.gl,
  }
  const context: JsonObject = {
    ...baseContext,
    client: visitorData ? { ...clientContext, visitorData } : clientContext,
  }
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

export async function fetchSearchResponse(query: string, params?: string): Promise<JsonObject> {
  const payload: JsonObject = { query }
  if (params) payload["params"] = params
  return innertubePost("search", payload, { client: "WEB" })
}

export async function fetchBrowseResponse(browseId: string, params?: string, query?: string): Promise<JsonObject> {
  const payload: JsonObject = { browseId }
  if (params) payload["params"] = params
  if (query) payload["query"] = query
  return innertubePost("browse", payload, { client: "WEB" })
}

export async function fetchBrowseContinuation(continuation: string): Promise<JsonObject> {
  return innertubePost("browse", { continuation }, { client: "WEB" })
}

export async function fetchNextResponse(videoId: string, continuation?: string): Promise<JsonObject> {
  if (continuation) {
    return innertubePost("next", { continuation }, { client: "WEB" })
  }
  return innertubePost("next", { videoId }, { client: "WEB" })
}
