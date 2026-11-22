import { fetch } from "scripting"

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
let solverLoading: Promise<Solver> | null = null
const MAX_PLAYERS: number = 4
const preprocessed: Map<string, Promise<string>> = new Map()

function loadUmd(source: string): unknown {
  const module: { exports: Record<string, unknown> } = { exports: {} }
  new Function("exports", "module", "define", source)(module.exports, module, undefined)
  return module.exports
}

function getSolver(): Promise<Solver> {
  if (solver) return Promise.resolve(solver)
  if (!solverLoading) {
    solverLoading = Promise.all([
      import("./vendor/meriyah"),
      import("./vendor/astring"),
      import("./vendor/ytSolver"),
    ])
      .then(([meriyahMod, astringMod, ytSolverMod]): Solver => {
        const meriyah: unknown = loadUmd(meriyahMod.MERIYAH_SOURCE)
        const astring: unknown = loadUmd(astringMod.ASTRING_SOURCE)
        solver = new Function("meriyah", "astring", `${ytSolverMod.YT_SOLVER_SOURCE}; return jsc;`)(
          meriyah,
          astring,
        ) as Solver
        return solver
      })
      .finally((): void => {
        solverLoading = null
      })
  }
  return solverLoading
}

async function loadPlayer(jsUrl: string): Promise<string> {
  const url: string = jsUrl.startsWith("http") ? jsUrl : `https://www.youtube.com${jsUrl}`
  const [response, runSolver] = await Promise.all([
    fetch(url, { timeout: 25, debugLabel: "Yobi player js" }),
    getSolver(),
  ])
  if (!response.ok) throw new Error(`播放器腳本下載失敗：HTTP ${response.status}`)
  const player: string = await response.text()
  const result: SolverResult = runSolver({
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

export function warmThrottlingDecoder(jsUrl: string): void {
  void preprocessedPlayer(jsUrl).catch(() => undefined)
}

async function solve(jsUrl: string, values: string[]): Promise<Record<string, string>> {
  const [runSolver, preprocessedPlayerText] = await Promise.all([
    getSolver(),
    preprocessedPlayer(jsUrl),
  ])
  const result: SolverResult = runSolver({
    type: "preprocessed",
    preprocessed_player: preprocessedPlayerText,
    requests: [{ type: "n", challenges: values }],
  })
  const response: SolverResponse | undefined = result.responses?.[0]
  if (response?.type !== "result" || !response.data) {
    throw new Error(response?.error ?? "n 參數解碼失敗")
  }
  return response.data
}

export async function decodeThrottlingParameters(jsUrl: string, values: string[]): Promise<Record<string, string>> {
  if (values.length === 0) return {}
  try {
    return await solve(jsUrl, values)
  } catch (_error) {
    preprocessed.delete(jsUrl)
    return solve(jsUrl, values)
  }
}

export async function decipherStreamingUrl(url: string, jsUrl: string): Promise<string> {
  const match: RegExpMatchArray | null = url.match(/[?&]n=([^&]+)/)
  if (!match) return url
  const original: string = decodeURIComponent(match[1])
  const decoded: string | undefined = (await decodeThrottlingParameters(jsUrl, [original]))[original]
  if (!decoded) return url
  return url.replace(/([?&]n=)[^&]+/, `$1${encodeURIComponent(decoded)}`)
}
