
const LOCALE_KEY: string = "youtube_locale"

export interface YoutubeLocale {
  hl: string
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
  }
  current = DEFAULT_LOCALE
  return current
}

export function setYoutubeLocale(hl: unknown, gl: unknown): void {
  const language: string = typeof hl === "string" ? hl.trim() : ""
  const region: string = typeof gl === "string" ? gl.trim().toUpperCase() : ""
  if (!isValid(language, region)) return
  if (current && current.hl === language && current.gl === region) return
  current = { hl: language, gl: region }
  try {
    Storage.set(LOCALE_KEY, current)
  } catch {
  }
}

export const READ_LOCALE_SCRIPT: string = `
  var get = function (key) { return window.ytcfg && ytcfg.get ? ytcfg.get(key) : undefined; };
  return JSON.stringify({ hl: get("HL") || "", gl: get("GL") || "" });
`
