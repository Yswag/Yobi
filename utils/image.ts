
function targetPixels(points: number): number {
  return Math.min(720, Math.max(96, Math.round(points * 2)))
}

const YT_THUMB_SIZES: { name: string; width: number }[] = [
  { name: "default", width: 120 },
  { name: "mqdefault", width: 320 },
  { name: "hqdefault", width: 480 },
  { name: "sddefault", width: 640 },
  { name: "maxresdefault", width: 1280 },
]

function youtubeThumbnail(url: string, pixels: number): string {
  const match: RegExpMatchArray | null = url.match(/^(.*\/)(default|mqdefault|hqdefault|sddefault|maxresdefault)\.(jpg|webp|png)(\?.*)?$/)
  if (!match) return url
  const current: number = YT_THUMB_SIZES.findIndex((size): boolean => size.name === match[2])
  const wanted: number = YT_THUMB_SIZES.findIndex((size): boolean => size.width >= pixels)
  const index: number = Math.min(wanted < 0 ? YT_THUMB_SIZES.length - 1 : wanted, current)
  if (index === current) return url
  return `${match[1]}${YT_THUMB_SIZES[index].name}.${match[3]}`
}

function youtubeAvatar(url: string, pixels: number): string {
  if (!/^https?:\/\/yt[34]\./.test(url)) return url
  return url.replace(/=s\d+/, `=s${pixels}`)
}

function biliImage(url: string, pixels: number, aspect: number): string {
  if (!/^https?:\/\/[^/]*(hdslb|bilivideo)\.com\//.test(url)) return url
  const base: string = url.split("@")[0]
  const height: number = Math.round(pixels * aspect)
  return `${base}@${pixels}w_${height}h_1c.webp`
}

export function thumbnailUrl(url: string | undefined, widthPoints: number): string | undefined {
  if (!url) return url
  const pixels: number = targetPixels(widthPoints)
  const sized: string = youtubeThumbnail(url, pixels)
  return sized === url ? biliImage(url, pixels, 9 / 16) : sized
}

export function avatarUrl(url: string | undefined, sizePoints: number): string | undefined {
  if (!url) return url
  const pixels: number = Math.min(240, targetPixels(sizePoints))
  const sized: string = youtubeAvatar(url, pixels)
  return sized === url ? biliImage(url, pixels, 1) : sized
}

function biliEmoji(url: string, pixels: number): string {
  if (!/^https?:\/\/[^/]*(hdslb|bilivideo)\.com\//.test(url)) return url
  const base: string = url.split("@")[0]
  if (/\.gif(\?|$)/i.test(base)) return url
  return `${base}@${pixels}w.webp`
}

export function emojiImageUrl(url: string | undefined, sizePoints: number): string | undefined {
  if (!url) return url
  const pixels: number = Math.min(128, Math.max(48, Math.round(sizePoints * 3)))
  const sized: string = youtubeAvatar(url, pixels)
  return sized === url ? biliEmoji(url, pixels) : sized
}
