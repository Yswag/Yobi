import type { StreamManifest, YoutubeStreamPreference } from "../../types/index"
import type { InnertubeClientKey } from "./innertube"
import type { SabrPlayerInfo } from "./stream"

export { parseYoutubeInput } from "./input"
export {
  getYoutubeChannel,
  getYoutubeChannelPage,
  getYoutubeChannelVideos,
  getYoutubeCommentPage,
  getYoutubeCommentReplies,
  getYoutubeComments,
  getYoutubeLiveViewers,
  getYoutubeSearchSuggestions,
  getYoutubeTrending,
  getYoutubeVideoDetail,
  searchYoutubeChannelVideos,
  searchYoutubeVideos,
} from "./browse"

export async function loadWebSabrPlayer(
  videoId: string,
  clientKey: Extract<InnertubeClientKey, "WEB_SABR" | "MWEB"> = "WEB_SABR",
): Promise<SabrPlayerInfo> {
  const mod = await import("./stream")
  return mod.loadWebSabrPlayer(videoId, clientKey)
}

export async function resolveYoutubeStream(
  videoId: string,
  mode: YoutubeStreamPreference = "auto",
  preferredHeight: number = 0,
  isLive: boolean = false,
): Promise<StreamManifest> {
  const mod = await import("./stream")
  return mod.resolveYoutubeStream(videoId, mode, preferredHeight, isLive)
}
