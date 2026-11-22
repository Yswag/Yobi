export function parseBiliInput(input: string): { bvid?: string; aid?: number } | null {
  const text: string = (input ?? "").trim()
  if (!text) return null

  const bvMatch: RegExpMatchArray | null = text.match(/BV[0-9A-Za-z]{10}/)
  if (bvMatch) return { bvid: bvMatch[0] }

  const avMatch: RegExpMatchArray | null = text.match(/(?:^|[^0-9A-Za-z])av(\d+)/i)
  if (avMatch) {
    const aid: number = Number(avMatch[1])
    if (Number.isFinite(aid) && aid > 0) return { aid }
  }

  return null
}
