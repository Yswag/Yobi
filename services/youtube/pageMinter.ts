import { warmThrottlingDecoder } from "./nsig"
import { setYoutubeLocale } from "./locale"
import type { YoutubePoTokens, YoutubeWebConfig } from "./potoken"

/**
 * PO tokens minted by the m.youtube.com player itself, in a hidden watch page.
 *
 * The player's poToken plugin mints a video-bound token synchronously when video data loads
 * (`Av(videoData)` → minter with `videoData.videoId`), and it does so for any video id. Its constructor
 * assigns `this.useLivingRoomPoToken`, so a setter on Object.prototype installed at document start
 * captures the instance; the minting method is then found by behavior, not by its minified name.
 * The page needs neither playback nor being on screen. Media requests are blocked.
 */

const PAGE_ORIGIN: string = "https://m.youtube.com"
const USER_AGENT: string =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1"
const MINT_TIMEOUT_MS: number = 15000
const LOAD_TIMEOUT_MS: number = 15000
const POLL_MS: number = 250
const MAX_VIDEO_TOKENS: number = 64

const HOOK: string = `
(function () {
  if (window.__yobiMint) return;
  const plugins = [];
  Object.defineProperty(Object.prototype, "useLivingRoomPoToken", {
    configurable: true,
    get() { return undefined; },
    set(value) {
      Object.defineProperty(this, "useLivingRoomPoToken", { value, writable: true, configurable: true, enumerable: true });
      plugins.push(this);
    },
  });
  let method = null;
  const call = (plugin, name, videoId) => {
    const videoData = { videoId };
    try { plugin[name].call(plugin, videoData); } catch (error) { return ""; }
    for (const key of Object.keys(videoData)) {
      const value = videoData[key];
      if (key !== "videoId" && typeof value === "string" && value.length > 40) return value;
    }
    return "";
  };
  window.__yobiMint = function (videoId) {
    for (const plugin of plugins) {
      if (method) {
        const token = call(plugin, method, videoId);
        if (token) return token;
        continue;
      }
      for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(plugin))) {
        if (name === "constructor" || typeof plugin[name] !== "function" || plugin[name].length !== 1) continue;
        const token = call(plugin, name, videoId);
        if (token) { method = name; return token; }
      }
    }
    return "";
  };
})();
`

const BLOCK_MEDIA: Array<Record<string, any>> = [
  { trigger: { "url-filter": "googlevideo\\.com/videoplayback" }, action: { type: "block" } },
]

interface MintPage {
  web: WebViewController
  config: YoutubeWebConfig
  tokens: Map<string, string>
}

let current: MintPage | null = null
let opening: Promise<MintPage> | null = null

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** WebKit kills the app when a WebView is driven off the main thread; the SABR proxy calls in from a background one. */
function onMain<T>(run: () => Promise<T>): Promise<T> {
  if (Thread.isMainThread) return run()
  return new Promise<T>((resolve, reject) => {
    Thread.runInMain(() => {
      run().then(resolve, reject)
    })
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ])
}

function mintIn(web: WebViewController, videoId: string): Promise<string> {
  return onMain(() =>
    web.evaluateJavaScript<string>(`return window.__yobiMint ? window.__yobiMint(${JSON.stringify(videoId)}) : ""`),
  )
}

async function readConfig(web: WebViewController): Promise<YoutubeWebConfig> {
  const raw: string = await onMain(() => web.evaluateJavaScript<string>(`
    var get = function (key) { return window.ytcfg && ytcfg.get ? ytcfg.get(key) : undefined; };
    return JSON.stringify({
      visitorData: get("VISITOR_DATA") || "",
      signatureTimestamp: Number(get("STS") || 0),
      clientVersion: get("INNERTUBE_CLIENT_VERSION") || "",
      jsUrl: get("PLAYER_JS_URL") || "",
      hl: get("HL") || "",
      gl: get("GL") || "",
    });
  `))
  const config: YoutubeWebConfig & { hl?: string; gl?: string } = JSON.parse(raw)
  if (!config.visitorData || !config.clientVersion || !config.jsUrl) throw new Error("YouTube 頁面缺少 ytcfg")
  // The watch page is the cheapest place to learn the account's hl/gl.
  setYoutubeLocale(config.hl, config.gl)
  return config
}

function disposeWeb(web: WebViewController): void {
  if (Thread.isMainThread) web.dispose()
  else Thread.runInMain(() => web.dispose())
}

async function openPage(seedVideoId: string): Promise<MintPage> {
  const web: WebViewController = await onMain(async () => new WebViewController({ ephemeral: true }))
  try {
    await onMain(async () => {
      await web.setSettings({ customUserAgent: USER_AGENT })
      await web.addContentRuleList({ id: "yobi-block-media", rules: BLOCK_MEDIA })
      await web.addUserScript({ source: HOOK, injectionTime: "documentStart", forMainFrameOnly: true })
    })
    await withTimeout(
      onMain(() => web.loadURL(`${PAGE_ORIGIN}/watch?v=${encodeURIComponent(seedVideoId)}`)),
      LOAD_TIMEOUT_MS,
      "YouTube 頁面載入逾時",
    )
    const tokens: Map<string, string> = new Map()
    const deadline: number = Date.now() + MINT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const token: string = await mintIn(web, seedVideoId)
      if (token) {
        tokens.set(seedVideoId, token)
        const config: YoutubeWebConfig = await readConfig(web)
        warmThrottlingDecoder(config.jsUrl)
        return { web, config, tokens }
      }
      await sleep(POLL_MS)
    }
    throw new Error("YouTube 頁面的 PO token 產生器沒有就緒")
  } catch (error) {
    disposeWeb(web)
    throw error
  }
}

/** Drops a page that stopped minting, e.g. after its web content process was reclaimed. */
function retire(page: MintPage): void {
  if (current === page) current = null
  disposeWeb(page.web)
}

function pageFor(seedVideoId: string): Promise<MintPage> {
  if (current) return Promise.resolve(current)
  if (!opening) {
    opening = openPage(seedVideoId)
      .then((page: MintPage): MintPage => {
        current = page
        return page
      })
      .finally(() => {
        opening = null
      })
  }
  return opening
}

/** Loads the page ahead of the first playback so the first token is ready without waiting. */
export function warmYoutubePageMinter(seedVideoId: string = "jNQXAC9IVRw"): void {
  void pageFor(seedVideoId).catch(() => undefined)
}

/** Video-bound token from the page player, with the page's web config (visitor, STS, client version). */
export async function getYoutubePageTokens(videoId: string): Promise<YoutubePoTokens> {
  const page: MintPage = await pageFor(videoId)
  try {
    return await tokensFrom(page, videoId)
  } catch (_error) {
    retire(page)
    return tokensFrom(await pageFor(videoId), videoId)
  }
}

async function tokensFrom(page: MintPage, videoId: string): Promise<YoutubePoTokens> {
  let token: string | undefined = page.tokens.get(videoId)
  if (!token) {
    token = await mintIn(page.web, videoId)
    if (!token) throw new Error("YouTube 頁面沒有產生 PO token")
    if (page.tokens.size >= MAX_VIDEO_TOKENS) {
      const oldest: string | undefined = page.tokens.keys().next().value
      if (oldest !== undefined) page.tokens.delete(oldest)
    }
    page.tokens.set(videoId, token)
  }
  return {
    ...page.config,
    visitorBoundPoToken: token,
    videoBoundPoToken: token,
    userAgent: USER_AGENT,
  }
}

export function disposeYoutubePageMinter(): void {
  if (current) retire(current)
}

/**
 * Called when the server keeps refusing `staleToken`: reloads the page unless another caller
 * already did, then mints again.
 */
export async function refreshYoutubePageToken(videoId: string, staleToken: string): Promise<string> {
  if (current && current.tokens.get(videoId) === staleToken) retire(current)
  return (await getYoutubePageTokens(videoId)).visitorBoundPoToken
}
