/**
 * YouTube 介面語言／地區。
 *
 * Innertube 回應不會告訴你 hl/gl（`responseContext` 根本沒有這兩個欄位，它只是把你送進去的值回音），
 * 所以只能從 YouTube 自己的頁面讀 `ytcfg`。login 與 pageMinter 都會開 m.youtube.com，順手把值存下來；
 * 讀不到就沿用上次的，再沒有才退回 en／US。
 */

const LOCALE_KEY: string = "youtube_locale"

export interface YoutubeLocale {
  /** e.g. "zh-TW" */
  hl: string
  /** e.g. "TW" */
  gl: string
}

const DEFAULT_LOCALE: YoutubeLocale = { hl: "en", gl: "US" }

function isValid(hl: string, gl: string): boolean {
  return /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(hl) && /^[A-Z]{2}$/.test(gl)
}

let current: YoutubeLocale | null = null

export function getYoutubeLocale(): YoutubeLocale {
  if (current) return current
  try {
    const stored = Storage.get<YoutubeLocale>(LOCALE_KEY)
    if (stored && isValid(String(stored.hl ?? ""), String(stored.gl ?? ""))) {
      current = { hl: String(stored.hl), gl: String(stored.gl) }
      return current
    }
  } catch {
    // fall through
  }
  current = DEFAULT_LOCALE
  return current
}

/** Stores what the YouTube page reports; invalid or empty values keep the previous locale. */
export function setYoutubeLocale(hl: unknown, gl: unknown): void {
  const language: string = typeof hl === "string" ? hl.trim() : ""
  const region: string = typeof gl === "string" ? gl.trim().toUpperCase() : ""
  if (!isValid(language, region)) return
  if (current && current.hl === language && current.gl === region) return
  current = { hl: language, gl: region }
  try {
    Storage.set(LOCALE_KEY, current)
  } catch {
    // keep the in-memory value even if persistence fails
  }
}

/** JS snippet that reads hl/gl off any YouTube page that defines `ytcfg`. */
export const READ_LOCALE_SCRIPT: string = `
  var get = function (key) { return window.ytcfg && ytcfg.get ? ytcfg.get(key) : undefined; };
  return JSON.stringify({ hl: get("HL") || "", gl: get("GL") || "" });
`
