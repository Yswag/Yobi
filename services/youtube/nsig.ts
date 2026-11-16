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
// One player build at a time; the preprocessed form makes later calls cheap.
let cachedJsUrl: string | null = null
let cachedPreprocessed: string | null = null
let pending: Promise<string> | null = null

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

async function preprocessedPlayer(jsUrl: string): Promise<string> {
  if (cachedJsUrl === jsUrl && cachedPreprocessed) return cachedPreprocessed
  if (pending && cachedJsUrl === jsUrl) return pending
  cachedJsUrl = jsUrl
  cachedPreprocessed = null
  pending = (async (): Promise<string> => {
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
  })()
  try {
    const preprocessed: string = await pending
    if (cachedJsUrl === jsUrl) cachedPreprocessed = preprocessed
    return preprocessed
  } finally {
    pending = null
  }
}

/** Returns decoded values keyed by the original `n`. */
export async function decodeThrottlingParameters(jsUrl: string, values: string[]): Promise<Record<string, string>> {
  if (values.length === 0) return {}
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

/** Rewrites the `n` query parameter of a googlevideo URL. */
export async function decipherStreamingUrl(url: string, jsUrl: string): Promise<string> {
  const match: RegExpMatchArray | null = url.match(/[?&]n=([^&]+)/)
  if (!match) return url
  const original: string = decodeURIComponent(match[1])
  const decoded: string | undefined = (await decodeThrottlingParameters(jsUrl, [original]))[original]
  if (!decoded) return url
  return url.replace(/([?&]n=)[^&]+/, `$1${encodeURIComponent(decoded)}`)
}
