/**
 * 清單裡的圖片只要顯示大小那麼多點，但上游給的是原始尺寸（bili 封面常是 1920×1080）。
 * 在這裡統一把網址換成對應大小的版本，捲動時就不必為每張縮圖解碼一張大圖。
 * 認不得的網址原樣回傳。
 */

/** 實際請求的像素：2 倍圖，遇到超大顯示尺寸也封頂。 */
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
  const best: { name: string; width: number } =
    YT_THUMB_SIZES.find((size): boolean => size.width >= pixels) ?? YT_THUMB_SIZES[YT_THUMB_SIZES.length - 1]
  return `${match[1]}${best.name}.${match[3]}`
}

/** yt3 的頻道頭像用 `=s176-c-k-...` 這種後綴控制大小。 */
function youtubeAvatar(url: string, pixels: number): string {
  if (!/^https?:\/\/yt3\./.test(url)) return url
  return url.replace(/=s\d+/, `=s${pixels}`)
}

function biliImage(url: string, pixels: number, aspect: number): string {
  if (!/^https?:\/\/[^/]*(hdslb|bilivideo)\.com\//.test(url)) return url
  const base: string = url.split("@")[0]
  const height: number = Math.round(pixels * aspect)
  return `${base}@${pixels}w_${height}h_1c.webp`
}

/** 封面：給顯示寬度（pt），自動挑對應大小。 */
export function thumbnailUrl(url: string | undefined, widthPoints: number): string | undefined {
  if (!url) return url
  const pixels: number = targetPixels(widthPoints)
  const sized: string = youtubeThumbnail(url, pixels)
  return sized === url ? biliImage(url, pixels, 9 / 16) : sized
}

/** 頭像：方形。 */
export function avatarUrl(url: string | undefined, sizePoints: number): string | undefined {
  if (!url) return url
  const pixels: number = Math.min(240, targetPixels(sizePoints))
  const sized: string = youtubeAvatar(url, pixels)
  return sized === url ? biliImage(url, pixels, 1) : sized
}
