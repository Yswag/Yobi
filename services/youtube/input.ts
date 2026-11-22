export function parseYoutubeInput(input: string): string | null {
  const trimmed: string = input.trim()
  if (!trimmed) return null
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed

  const patterns: RegExp[] = [
    /(?:youtube\.com|youtube-nocookie\.com)\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/live\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/v\/([A-Za-z0-9_-]{11})/,
  ]
  for (const pattern of patterns) {
    const match: RegExpMatchArray | null = trimmed.match(pattern)
    if (match) return match[1]
  }
  return null
}
