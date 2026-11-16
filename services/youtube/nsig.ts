import { fetch } from "scripting"
import { ASTRING_SOURCE } from "./vendor/astring"
import { MERIYAH_SOURCE } from "./vendor/meriyah"
import { YT_SOLVER_SOURCE } from "./vendor/ytSolver"

/**
 * Decodes the `n` throttling parameter of googlevideo URLs with yt-dlp's ejs solver,
 * the same solver upstream TypeType-Token vendors. Without it SABR requests return 403.
 */

interface SolverResponse {
  type: "result" | "error"
  data?: Record<string, string>
  error?: string
}

interface SolverResult {
  type: "result" | "error"
  responses?: SolverResponse[]
  preprocessed_player?: string
  error?: string
}

type Solver = (request: Record<string, unknown>) => SolverResult

let solver: Solver | null = null
// Preprocessed players by URL; the page alternates between a few player builds.
const MAX_PLAYERS: number = 4
const preprocessed: Map<string, Promise<string>> = new Map()

function loadUmd(source: string): unknown {
  const module: { exports: Record<string, unknown> } = { exports: {} }
  new Function("exports", "module", "define", source)(module.exports, module, undefined)
  return module.exports
}

function getSolver(): Solver {
  if (solver) return solver
  const meriyah: unknown = loadUmd(MERIYAH_SOURCE)
  const astring: unknown = loadUmd(ASTRING_SOURCE)
  solver = new Function("meriyah", "astring", `${YT_SOLVER_SOURCE}; return jsc;`)(meriyah, astring) as Solver
  return solver
}

async function loadPlayer(jsUrl: string): Promise<string> {
  const url: string = jsUrl.startsWith("http") ? jsUrl : `https://www.youtube.com${jsUrl}`
  const response = await fetch(url, { timeout: 25, debugLabel: "Yobi player js" })
  if (!response.ok) throw new Error(`播放器腳本下載失敗：HTTP ${response.status}`)
  const player: string = await response.text()
  const result: SolverResult = getSolver()({
    type: "player",
    player,
    requests: [],
    output_preprocessed: true,
  })
  if (!result.preprocessed_player) throw new Error(result.error ?? "播放器腳本解析失敗")
  return result.preprocessed_player
}

function preprocessedPlayer(jsUrl: string): Promise<string> {
  const cached: Promise<string> | undefined = preprocessed.get(jsUrl)
  if (cached) return cached
  if (preprocessed.size >= MAX_PLAYERS) {
    const oldest: string | undefined = preprocessed.keys().next().value
    if (oldest !== undefined) preprocessed.delete(oldest)
  }
  const loading: Promise<string> = loadPlayer(jsUrl)
  preprocessed.set(jsUrl, loading)
  loading.catch(() => {
    if (preprocessed.get(jsUrl) === loading) preprocessed.delete(jsUrl)
  })
  return loading
}

/** Downloads and preprocesses a player ahead of its first `n` challenge. */
export function warmThrottlingDecoder(jsUrl: string): void {
  void preprocessedPlayer(jsUrl).catch(() => undefined)
}

async function solve(jsUrl: string, values: string[]): Promise<Record<string, string>> {
  const result: SolverResult = getSolver()({
    type: "preprocessed",
    preprocessed_player: await preprocessedPlayer(jsUrl),
    requests: [{ type: "n", challenges: values }],
  })
  const response: SolverResponse | undefined = result.responses?.[0]
  if (response?.type !== "result" || !response.data) {
    throw new Error(response?.error ?? "n 參數解碼失敗")
  }
  return response.data
}

/** Returns decoded values keyed by the original `n`. The solver occasionally answers `no solutions`; one retry from a fresh player clears it. */
export async function decodeThrottlingParameters(jsUrl: string, values: string[]): Promise<Record<string, string>> {
  if (values.length === 0) return {}
  try {
    return await solve(jsUrl, values)
  } catch (_error) {
    preprocessed.delete(jsUrl)
    return solve(jsUrl, values)
  }
}

/** Rewrites the `n` query parameter of a googlevideo URL. */
export async function decipherStreamingUrl(url: string, jsUrl: string): Promise<string> {
  const match: RegExpMatchArray | null = url.match(/[?&]n=([^&]+)/)
  if (!match) return url
  const original: string = decodeURIComponent(match[1])
  const decoded: string | undefined = (await decodeThrottlingParameters(jsUrl, [original]))[original]
  if (!decoded) return url
  return url.replace(/([?&]n=)[^&]+/, `$1${encodeURIComponent(decoded)}`)
}
