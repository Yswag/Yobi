import { fetch } from "scripting"

/**
 * PO tokens minted on device with the WAA flow of xptv-extensions `script/yt-pot.js` (from SmartTube):
 * jnn Create challenge -> BotGuard in an ephemeral WKWebView -> GenerateIT -> minter.
 * The visitor-bound token goes into SABR requests, the video-bound one into the player request.
 */

const INNERTUBE_API_KEY: string = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"
const WAA_API_KEY: string = "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw"
const WAA_REQUEST_KEY: string = "O43z0dpjhgX20SCx4KAo"
const JNN_CREATE: string = "https://www.youtube.com/api/jnn/v1/Create"
const JNN_GENERATE_IT: string = "https://www.youtube.com/api/jnn/v1/GenerateIT"
const BOTGUARD_USER_AGENT: string =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
const BOTGUARD_HEADERS: Record<string, string> = {
  "User-Agent": BOTGUARD_USER_AGENT,
  Accept: "application/json",
  "Content-Type": "application/json+protobuf",
  Cookie: "SOCS=CAISAiAD",
  "x-goog-api-key": WAA_API_KEY,
  "x-user-agent": "grpc-web-javascript/0.1",
}
const FALLBACK_WEB_CLIENT_VERSION: string = "2.20261112.10.00"
export const WEB_USER_AGENT: string =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const BOTGUARD_ORIGIN: string = "https://www.youtube.com/__bgp__"
const EXPIRY_MARGIN_MS: number = 10 * 60 * 1000
const MAX_VIDEO_TOKENS: number = 64

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

let session: BotGuardSession | null = null
let building: Promise<BotGuardSession> | null = null

async function fetchVisitorData(): Promise<string> {
  const response = await fetch(`https://www.youtube.com/youtubei/v1/config?key=${INNERTUBE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      context: { client: { hl: "en", gl: "US", clientName: "WEB", clientVersion: FALLBACK_WEB_CLIENT_VERSION } },
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
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64: string = value.replace(/-/g, "+").replace(/_/g, "/") + "==".slice((value.length + 3) % 4)
  const bytes: Uint8Array | null = Data.fromBase64String(base64)?.toUint8Array() ?? null
  if (!bytes) throw new Error("base64 解碼失敗")
  return bytes
}

/** jnn Create returns the challenge as `[_, scrambled]`; each byte is offset by 97. */
async function fetchChallenge(): Promise<BotGuardChallenge> {
  const response = await fetch(JNN_CREATE, {
    method: "POST",
    headers: BOTGUARD_HEADERS,
    body: JSON.stringify([WAA_REQUEST_KEY]),
    timeout: 20,
    debugLabel: "Yobi jnn Create",
  })
  if (!response.ok) throw new Error(`BotGuard challenge 取得失敗：HTTP ${response.status}`)
  const raw = (await response.json()) as unknown[]
  if (typeof raw[1] !== "string") throw new Error("BotGuard challenge 格式不符")
  const bytes: Uint8Array = base64UrlToBytes(raw[1])
  for (let i = 0; i < bytes.length; i++) bytes[i] = (bytes[i] + 97) & 0xff
  const fields = JSON.parse(new TextDecoder().decode(bytes)) as unknown[]
  const wrapped: unknown = Array.isArray(fields[1])
    ? fields[1].find((entry: unknown): boolean => typeof entry === "string" && entry.length > 0)
    : fields[1]
  if (typeof wrapped !== "string" || typeof fields[4] !== "string" || typeof fields[5] !== "string") {
    throw new Error("BotGuard challenge 缺少直譯器或程式")
  }
  return { interpreterScript: wrapped, program: fields[4], globalName: fields[5] }
}

async function fetchWebConfig(visitorData: string): Promise<YoutubeWebConfig> {
  const response = await fetch("https://www.youtube.com/", {
    headers: {
      "User-Agent": WEB_USER_AGENT,
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
    visitorData,
    signatureTimestamp: Number(/"STS"\s*:\s*(\d+)/.exec(html)?.[1] ?? 0),
    clientVersion: /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/.exec(html)?.[1] ?? FALLBACK_WEB_CLIENT_VERSION,
    jsUrl,
  }
}

async function fetchIntegrityToken(botguardResponse: string): Promise<{ token: string; ttlSecs: number }> {
  const response = await fetch(JNN_GENERATE_IT, {
    method: "POST",
    headers: BOTGUARD_HEADERS,
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

async function buildSession(): Promise<BotGuardSession> {
  const visitorData: string = await fetchVisitorData()
  const [config, challenge] = await Promise.all([fetchWebConfig(visitorData), fetchChallenge()])
  const web: WebViewController = new WebViewController({ ephemeral: true })
  try {
    await web.setSettings({ customUserAgent: BOTGUARD_USER_AGENT })
    await web.loadHTML("<!DOCTYPE html><html><body></body></html>", BOTGUARD_ORIGIN)
    const botguardResponse: string = await web.callAsyncJavaScript<string>(RUN_BOTGUARD, {
      script: challenge.interpreterScript,
      prog: challenge.program,
      name: challenge.globalName,
    })
    const integrity = await fetchIntegrityToken(botguardResponse)
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

async function currentSession(): Promise<BotGuardSession> {
  if (session && Date.now() < session.expiresAt) return session
  if (!building) {
    building = buildSession()
      .then((fresh: BotGuardSession): BotGuardSession => {
        if (session) retire(session)
        session = fresh
        return fresh
      })
      .finally(() => {
        building = null
      })
  }
  return building
}

/** Visitor and video bound tokens plus the web config they were minted against. */
export async function getYoutubePoTokens(videoId: string): Promise<YoutubePoTokens> {
  const current: BotGuardSession = await currentSession()
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
  }
}

/** Drops the current session so the next call mints from scratch (e.g. after a 403). */
export function invalidateYoutubePoTokens(): void {
  if (session) retire(session)
  session = null
}
