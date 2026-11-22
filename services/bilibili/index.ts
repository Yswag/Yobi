import type { StreamManifest } from "../../types"

export { parseBiliInput } from "./input"
export { resolveBiliShortUrl } from "./meta"
export {
  getBiliChannel,
  getBiliSearchSuggestions,
  getBiliTrending,
  getBiliVideoDetail,
  searchBiliChannelVideos,
  searchBiliVideos,
} from "./browse"
export { getBiliCommentPage, getBiliCommentReplies } from "./comments"

export async function resolveBiliStream(
  bvid: string,
  cid?: number,
  preferredHeight?: number,
): Promise<StreamManifest> {
  const mod = await import("./stream")
  return mod.resolveBiliStream(bvid, cid, preferredHeight)
}

export async function fetchBiliDanmakuXml(cid: number): Promise<string> {
  const mod = await import("./danmaku")
  return mod.fetchBiliDanmakuXml(cid)
}
