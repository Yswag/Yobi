import { fetch } from "scripting"

/**
 * PO tokens minted on device, following SmartTube's port of bgutil-ytdlp-pot-provider:
 * homepage ytcfg + ytAtN challenge -> BotGuard in an ephemeral WKWebView -> GenerateIT -> minter.
 * The visitor-bound token goes into SABR requests, the video-bound one into the player request.
 *
 * The challenge must come from the homepage snapshot, not /api/jnn/v1/Create: BotGuard reads
 * yt.config_.EVENT_ID from that same page, and challenges minted without it are rejected.
 *
 * `MWEB` mints against m.youtube.com with a Safari/iPhone user agent, i.e. the same engine family
 * (WebKit) the token is later used from; `WEB` mints against the desktop page.
 */

export type PoTokenClient = "WEB" | "MWEB"

const INNERTUBE_API_KEY: string = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"
const WAA_API_KEY: string = "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw"
const WAA_REQUEST_KEY: string = "O43z0dpjhgX20SCx4KAo"
const JNN_GENERATE_IT: string = "https://www.youtube.com/api/jnn/v1/GenerateIT"
const BOTGUARD_USER_AGENT: string =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
const MWEB_USER_AGENT: string =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1"
const BOTGUARD_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "Content-Type": "application/json+protobuf",
  Cookie: "SOCS=CAISAiAD",
  "x-goog-api-key": WAA_API_KEY,
  "x-user-agent": "grpc-web-javascript/0.1",
}
const FALLBACK_WEB_CLIENT_VERSION: string = "2.20261112.10.00"
const FALLBACK_MWEB_CLIENT_VERSION: string = "2.20261112.10.00"
const EXPIRY_MARGIN_MS: number = 10 * 60 * 1000
const MAX_VIDEO_TOKENS: number = 64

interface TokenProfile {
  home: string
  userAgent: string
  jnnOrigin: string
  fallbackClientVersion: string
}

const PROFILES: Record<PoTokenClient, TokenProfile> = {
  WEB: {
    home: "https://www.youtube.com",
    userAgent: BOTGUARD_USER_AGENT,
    jnnOrigin: "https://www.youtube.com",
    fallbackClientVersion: FALLBACK_WEB_CLIENT_VERSION,
  },
  MWEB: {
    home: "https://m.youtube.com",
    userAgent: MWEB_USER_AGENT,
    jnnOrigin: "https://m.youtube.com",
    fallbackClientVersion: FALLBACK_MWEB_CLIENT_VERSION,
  },
}

export interface YoutubeWebConfig {
  visitorData: string
  /** Player signature timestamp; WEB player requests without it come back UNPLAYABLE. */
  signatureTimestamp: number
  clientVersion: string
  /** Path of base.js, used to decode the `n` parameter. */
  jsUrl: string
}

export interface YoutubePoTokens extends YoutubeWebConfig {
  /** Sent in SABR requests (streamer context). */
  visitorBoundPoToken: string
  /** Sent in the player request (serviceIntegrityDimensions.poToken). */
  videoBoundPoToken: string
  /** User agent the tokens were minted under; keep it for the player and SABR requests. */
  userAgent: string
}

interface BotGuardSession {
  web: WebViewController
  config: YoutubeWebConfig
  integrityToken: string
  visitorBoundPoToken: string
  expiresAt: number
  videoTokens: Map<string, string>
}

const RUN_BOTGUARD: string = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (cfg) {
    const config = JSON.parse(cfg);
    globalThis.yt = { config_: config };
    if (globalThis.window) globalThis.window.yt = globalThis.yt;
  }
  new Function(script)();
  const vm = globalThis[name];
  if (!vm || !vm.a) throw new Error("BotGuard VM not found");
  let resolveFns;
  const fnsReady = new Promise((r) => { resolveFns = r; });
  const callback = (asyncSnapshotFunction, shutdownFunction, passEventFunction, checkCameraFunction) => {
    resolveFns({ asyncSnapshotFunction, shutdownFunction, passEventFunction, checkCameraFunction });
  };
  const syncFn = vm.a(prog, callback, true, undefined, function () {}, [[], []])[0];
  const fns = await Promise.race([fnsReady, sleep(10000).then(() => { throw new Error("asyncSnapshotFunction timeout"); })]);
  const wpo = [];
  let response = await Promise.race([
    new Promise((resolve) => fns.asyncSnapshotFunction((r) => resolve(r), [undefined, undefined, wpo, undefined])),
    sleep(20000).then(() => { throw new Error("snapshot timeout"); }),
  ]);
  if (!wpo.length && syncFn) {
    try {
      const syncResponse = syncFn([undefined, undefined, wpo, undefined]);
      if (syncResponse) response = syncResponse;
    } catch (_) {}
  }
  if (!wpo.length) throw new Error("webPoSignalOutput is empty");
  globalThis.__wpo = wpo;
  return response;
`

const MINT: string = `
  const g = globalThis;
  let mintFn = g.__poTokenMinter;
  if (!mintFn || g.__poTokenMinterIntegrityToken !== token) {
    const getMinter = g.__wpo && g.__wpo[0];
    if (!getMinter) throw new Error("PMD:Undefined");
    const b64 = token.replace(/-/g, "+").replace(/_/g, "/").replace(/\\./g, "=");
    const bytes = Uint8Array.from(atob(b64).split("").map((c) => c.charCodeAt(0)));
    const created = await getMinter(bytes);
    if (!(created instanceof Function)) throw new Error("APF:Failed");
    mintFn = created;
    g.__poTokenMinter = mintFn;
    g.__poTokenMinterIntegrityToken = token;
  }
  const result = await mintFn(new TextEncoder().encode(id));
  if (!(result instanceof Uint8Array)) throw new Error("ODM:Invalid");
  let bin = "";
  for (let i = 0; i < result.length; i++) bin += String.fromCharCode(result[i]);
  return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=/g, "");
`

const sessions: Map<PoTokenClient, BotGuardSession> = new Map()
const building: Map<PoTokenClient, Promise<BotGuardSession>> = new Map()

async function fetchVisitorData(profile: TokenProfile): Promise<string> {
  const response = await fetch(`https://www.youtube.com/youtubei/v1/config?key=${INNERTUBE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": profile.userAgent },
    body: JSON.stringify({
      context: { client: { hl: "en", gl: "US", clientName: "WEB", clientVersion: profile.fallbackClientVersion } },
    }),
    timeout: 15,
    debugLabel: "Yobi visitorData",
  })
  if (!response.ok) throw new Error(`visitorData 取得失敗：HTTP ${response.status}`)
  const data = (await response.json()) as { responseContext?: { visitorData?: string } }
  const visitorData: string | undefined = data.responseContext?.visitorData
  if (!visitorData) throw new Error("visitorData 不存在")
  return visitorData
}

interface BotGuardChallenge {
  interpreterScript: string
  program: string
  globalName: string
  /** Object literal from `ytcfg.set({...})`; BotGuard reads `config_.EVENT_ID` out of it. */
  ytcfg: string
}

/** `ytAtN({...})` and `ytcfg.set({...})` are JS object literals, not JSON. */
function parseLooseJson(text: string): Record<string, unknown> {
  const unhexed: string = text.replace(
    /\\x([0-9A-Fa-f]{2})/g,
    (_match: string, hex: string): string => String.fromCharCode(Number.parseInt(hex, 16)),
  )
  const json: string = unhexed
    .replace(/,\s*([\]}])/g, "$1")
    .replace(/'((?:[^'\\]|\\[\s\S])*)'/g, (_match: string, inner: string): string =>
      JSON.stringify(inner.replace(/\\'/g, "'")),
    )
    .replace(/([{,]\s*)([A-Za-z0-9_$]+)\s*:/g, '$1"$2":')
  return JSON.parse(json) as Record<string, unknown>
}

interface BgChallenge {
  interpreterHash: string
  program: string
  globalName: string
  clientExperimentsStateBlob: string
  interpreterUrl: { privateDoNotAccessOrElseTrustedResourceUrlWrappedValue: string }
}

/** Challenge comes from the homepage snapshot; the interpreter script is fetched from its URL. */
async function fetchChallenge(html: string, profile: TokenProfile): Promise<BotGuardChallenge> {
  const ytcfg: string | undefined = /ytcfg\.set\((\{[\s\S]+?\})\);/.exec(html)?.[1]
  if (!ytcfg) throw new Error("YouTube 首頁沒有 ytcfg")
  const att: string | undefined = /window\.ytAtN\(\s*(\{[\s\S]*?\})\s*\)/.exec(html)?.[1]
  if (!att) throw new Error("YouTube 首頁沒有 ytAtN 挑戰")
  const raw: unknown = parseLooseJson(att)["R"]
  if (typeof raw !== "string") throw new Error("ytAtN 沒有 R")
  const parsed = JSON.parse(raw) as { bgChallenge?: BgChallenge }
  const challenge: BgChallenge | undefined = parsed.bgChallenge
  if (!challenge?.interpreterUrl || !challenge.program || !challenge.globalName) {
    throw new Error("ytAtN 缺少 bgChallenge")
  }
  const interpreterUrl: string = challenge.interpreterUrl.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue
  const response = await fetch(`https:${interpreterUrl}`, {
    headers: { "User-Agent": profile.userAgent, Accept: "*/*" },
    timeout: 20,
    debugLabel: "Yobi BotGuard interpreter",
  })
  if (!response.ok) throw new Error(`BotGuard 直譯器取得失敗：HTTP ${response.status}`)
  return {
    interpreterScript: await response.text(),
    program: challenge.program,
    globalName: challenge.globalName,
    ytcfg,
  }
}

interface HomePage {
  html: string
  config: YoutubeWebConfig
}

async function fetchHome(visitorData: string, profile: TokenProfile): Promise<HomePage> {
  const response = await fetch(`${profile.home}/`, {
    headers: {
      "User-Agent": profile.userAgent,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.7",
      "X-Goog-Visitor-Id": visitorData,
    },
    timeout: 20,
    debugLabel: "Yobi YouTube home",
  })
  if (!response.ok) throw new Error(`YouTube 首頁取得失敗：HTTP ${response.status}`)
  const html: string = await response.text()
  const jsUrl: string | undefined = /"jsUrl"\s*:\s*"([^"]+)"/.exec(html)?.[1]
  if (!jsUrl) throw new Error("YouTube 首頁沒有播放器腳本網址")
  return {
    html,
    config: {
      visitorData,
      signatureTimestamp: Number(/"STS"\s*:\s*(\d+)/.exec(html)?.[1] ?? 0),
      clientVersion:
        /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/.exec(html)?.[1] ?? profile.fallbackClientVersion,
      jsUrl,
    },
  }
}

async function fetchIntegrityToken(
  botguardResponse: string,
  profile: TokenProfile,
): Promise<{ token: string; ttlSecs: number }> {
  const response = await fetch(JNN_GENERATE_IT, {
    method: "POST",
    headers: { ...BOTGUARD_HEADERS, "User-Agent": profile.userAgent },
    body: JSON.stringify([WAA_REQUEST_KEY, botguardResponse]),
    timeout: 15,
    debugLabel: "Yobi GenerateIT",
  })
  if (!response.ok) throw new Error(`GenerateIT 失敗：HTTP ${response.status}`)
  const data = (await response.json()) as unknown[]
  if (typeof data[0] !== "string") throw new Error("GenerateIT 沒有 integrity token")
  return { token: data[0], ttlSecs: typeof data[1] === "number" ? data[1] : 21600 }
}

function mint(web: WebViewController, integrityToken: string, identifier: string): Promise<string> {
  return web.callAsyncJavaScript<string>(MINT, { token: integrityToken, id: identifier })
}

function retire(old: BotGuardSession): void {
  try {
    old.web.dispose()
  } catch {
    // Already gone
  }
}

async function buildSession(client: PoTokenClient): Promise<BotGuardSession> {
  const profile: TokenProfile = PROFILES[client]
  const visitorData: string = await fetchVisitorData(profile)
  const home: HomePage = await fetchHome(visitorData, profile)
  const challenge: BotGuardChallenge = await fetchChallenge(home.html, profile)
  const config: YoutubeWebConfig = home.config
  const web: WebViewController = new WebViewController({ ephemeral: true })
  try {
    await web.setSettings({ customUserAgent: profile.userAgent })
    await web.loadHTML("<!DOCTYPE html><html><body></body></html>", profile.jnnOrigin)
    const botguardResponse: string = await web.callAsyncJavaScript<string>(RUN_BOTGUARD, {
      cfg: challenge.ytcfg,
      script: challenge.interpreterScript,
      prog: challenge.program,
      name: challenge.globalName,
    })
    const integrity = await fetchIntegrityToken(botguardResponse, profile)
    const visitorBoundPoToken: string = await mint(web, integrity.token, visitorData)
    const ttlMs: number = Math.max(1000, integrity.ttlSecs * 1000)
    return {
      web,
      config,
      integrityToken: integrity.token,
      visitorBoundPoToken,
      expiresAt: Date.now() + ttlMs - Math.min(EXPIRY_MARGIN_MS, Math.floor(ttlMs / 10)),
      videoTokens: new Map(),
    }
  } catch (error) {
    try {
      web.dispose()
    } catch {
      // Ignore
    }
    throw error
  }
}

async function currentSession(client: PoTokenClient): Promise<BotGuardSession> {
  const cached: BotGuardSession | undefined = sessions.get(client)
  if (cached && Date.now() < cached.expiresAt) return cached
  const pending: Promise<BotGuardSession> | undefined = building.get(client)
  if (pending) return pending
  const started: Promise<BotGuardSession> = buildSession(client)
    .then((fresh: BotGuardSession): BotGuardSession => {
      const previous: BotGuardSession | undefined = sessions.get(client)
      if (previous) retire(previous)
      sessions.set(client, fresh)
      return fresh
    })
    .finally(() => {
      building.delete(client)
    })
  building.set(client, started)
  return started
}

/** Visitor and video bound tokens plus the web config they were minted against. */
export async function getYoutubePoTokens(videoId: string, client: PoTokenClient = "WEB"): Promise<YoutubePoTokens> {
  const current: BotGuardSession = await currentSession(client)
  let videoBoundPoToken: string | undefined = current.videoTokens.get(videoId)
  if (!videoBoundPoToken) {
    videoBoundPoToken = await mint(current.web, current.integrityToken, videoId)
    if (current.videoTokens.size >= MAX_VIDEO_TOKENS) {
      const oldest: string | undefined = current.videoTokens.keys().next().value
      if (oldest !== undefined) current.videoTokens.delete(oldest)
    }
    current.videoTokens.set(videoId, videoBoundPoToken)
  }
  return {
    ...current.config,
    visitorBoundPoToken: current.visitorBoundPoToken,
    videoBoundPoToken,
    userAgent: PROFILES[client].userAgent,
  }
}

/** Drops cached sessions so the next call mints from scratch (e.g. after a 403). */
export function invalidateYoutubePoTokens(): void {
  for (const current of sessions.values()) retire(current)
  sessions.clear()
}
