import type {
  ChannelDetail,
  UnifiedVideoItem,
  VideoChapter,
  VideoCollaborator,
  VideoDetail,
} from "../../types/index"
import type { JsonObject } from "./innertube"
import { extractVideoItems, parseChapters, parseRelatedVideos } from "./parseItems"
import { asArray, asObject, parseViewCountText, readText, readThumbnailUrl } from "./parsePrimitives"

interface VideoOwnerInfo {
  name: string
  avatar: string
  subscriberText: string
  collaborators: VideoCollaborator[]
}

function collaboratorSubscribers(subtitle: string): string {
  const parts: string[] = subtitle.replace(/[\u200e\u200f\u2066-\u2069]/g, "").split("•")
  return parts.length > 1 ? parts[parts.length - 1].trim() : ""
}

function parseCollaborators(owner: JsonObject): VideoCollaborator[] {
  const dialog: JsonObject | null = asObject(
    asObject(asObject(asObject(owner["navigationEndpoint"])?.["showDialogCommand"])?.["panelLoadingStrategy"])?.["inlineContent"],
  )
  const list: JsonObject | null = asObject(
    asObject(asObject(asObject(dialog?.["dialogViewModel"])?.["customContent"])?.["listViewModel"]),
  )
  const collaborators: VideoCollaborator[] = []
  for (const entry of asArray(list?.["listItems"])) {
    const item: JsonObject | null = asObject(asObject(entry)?.["listItemViewModel"])
    if (!item) continue
    const title: JsonObject | null = asObject(item["title"])
    const name: string = readText(title)
    const command: JsonObject | null = asObject(
      asObject(asObject(asArray(title?.["commandRuns"])[0])?.["onTap"])?.["innertubeCommand"],
    )
    const id: string = String(asObject(command?.["browseEndpoint"])?.["browseId"] ?? "")
    if (!name || !id) continue
    const avatar: JsonObject | null = asObject(asObject(asObject(item["leadingAccessory"])?.["avatarViewModel"])?.["image"])
    const collaborator: VideoCollaborator = { id, name }
    const avatarUrl: string = readThumbnailUrl(avatar)
    if (avatarUrl) collaborator.avatarUrl = avatarUrl
    const subscribers: string = collaboratorSubscribers(readText(item["subtitle"]))
    if (subscribers) collaborator.subscriberCountText = subscribers
    collaborators.push(collaborator)
  }
  return collaborators
}

function parseVideoOwner(next: JsonObject): VideoOwnerInfo | null {
  const results: JsonObject | null = asObject(
    asObject(asObject(asObject(next["contents"])?.["twoColumnWatchNextResults"])?.["results"])?.["results"],
  )
  for (const entry of asArray(results?.["contents"])) {
    const secondary: JsonObject | null = asObject(asObject(entry)?.["videoSecondaryInfoRenderer"])
    const owner: JsonObject | null = asObject(asObject(secondary?.["owner"])?.["videoOwnerRenderer"])
    if (!owner) continue
    const collaborators: VideoCollaborator[] = parseCollaborators(owner)
    return {
      name: readText(owner["attributedTitle"]) || readText(owner["title"]),
      avatar: readThumbnailUrl(owner["thumbnail"]) || collaborators[0]?.avatarUrl || "",
      subscriberText: readText(owner["subscriberCountText"]),
      collaborators,
    }
  }
  return null
}

export function parseLiveViewerCount(next: JsonObject | null): number | undefined {
  if (!next) return undefined
  let viewers: number | undefined

  const visit = (node: unknown, depth: number): void => {
    if (viewers !== undefined || !node || depth > 24) return
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1)
      return
    }
    const object: JsonObject | null = asObject(node)
    if (!object) return
    const renderer: JsonObject | null = asObject(object["videoViewCountRenderer"])
    if (renderer) {
      const text: string = readText(renderer["viewCount"])
      const isLive: boolean = renderer["isLive"] === true || /watching|正在觀看|正在观看/i.test(text)
      if (isLive) {
        const original: number = Number(renderer["originalViewCount"])
        viewers = Number.isFinite(original) && original > 0 ? original : parseViewCountText(text)
      }
      if (viewers !== undefined) return
    }
    for (const key of Object.keys(object)) visit(object[key], depth + 1)
  }

  visit(next, 0)
  return viewers
}

function parsePrimaryDateText(next: JsonObject): string {
  const results: JsonObject | null = asObject(
    asObject(asObject(asObject(next["contents"])?.["twoColumnWatchNextResults"])?.["results"])?.["results"],
  )
  for (const entry of asArray(results?.["contents"])) {
    const primary: JsonObject | null = asObject(asObject(entry)?.["videoPrimaryInfoRenderer"])
    if (!primary) continue
    return readText(primary["relativeDateText"]) || readText(primary["dateText"])
  }
  return ""
}

function formatPublishDate(iso: string): string {
  if (!iso) return ""
  const at: number = Date.parse(iso)
  if (!Number.isFinite(at)) return iso
  const diff: number = Math.floor((Date.now() - at) / 1000)
  if (diff < 60) return "剛剛"
  if (diff < 3600) return `${Math.floor(diff / 60)} 分鐘前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小時前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  return iso.slice(0, 10)
}

export function parseVideoDetail(videoId: string, player: JsonObject, next: JsonObject | null): VideoDetail {
  const details: JsonObject = asObject(player["videoDetails"]) ?? {}
  const microformat: JsonObject =
    asObject(asObject(player["microformat"])?.["playerMicroformatRenderer"]) ?? {}
  const title: string = String(details["title"] ?? readText(microformat["title"]) ?? "")
  const duration: number = Number(details["lengthSeconds"] ?? 0)
  const liveViewers: number | undefined = parseLiveViewerCount(next)
  const viewCount: number = liveViewers ?? Number(details["viewCount"] ?? 0)
  const author: string = String(details["author"] ?? "")
  const channelId: string = String(details["channelId"] ?? "")
  const thumbnailUrl: string = readThumbnailUrl(asObject(details["thumbnail"]) ?? microformat["thumbnail"])
  const keywords: unknown[] = asArray(details["keywords"])
  const publishDate: string = String(microformat["publishDate"] ?? "")
  const publishedText: string = (next ? parsePrimaryDateText(next) : "") || formatPublishDate(publishDate)

  const item: VideoDetail = {
    id: `yt:${videoId}`,
    provider: "yt",
    rawId: videoId,
    title,
    thumbnailUrl,
    duration,
    viewCount,
    publishedText,
    publishedAt: publishDate ? Date.parse(publishDate) || undefined : undefined,
    authorId: channelId,
    authorName: author,
    isLive: Boolean(details["isLive"]) || liveViewers !== undefined,
    description: String(details["shortDescription"] ?? microformat["description"] ?? ""),
    relatedVideos: next ? parseRelatedVideos(next) : [],
    tags: keywords.map((keyword: unknown): string => String(keyword)),
  }

  const chapters: VideoChapter[] = next ? parseChapters(next) : []
  if (chapters.length > 0) item.chapters = chapters
  const owner: VideoOwnerInfo | null = next ? parseVideoOwner(next) : null
  if (owner?.avatar) item.authorAvatar = owner.avatar
  if (owner?.subscriberText) item.subscriberCountText = owner.subscriberText
  if (owner && owner.collaborators.length > 1) {
    item.collaborators = owner.collaborators
    if (owner.name) item.authorName = owner.name
  }
  return item
}

export function parseChannelDetail(channelId: string, browse: JsonObject): ChannelDetail {
  const metadata: JsonObject = asObject(browse["metadata"]) ?? {}
  const channelMetadata: JsonObject = asObject(metadata["channelMetadataRenderer"]) ?? {}
  const microformat: JsonObject =
    asObject(asObject(browse["microformat"])?.["microformatDataRenderer"]) ?? {}
  const pageHeader: JsonObject =
    asObject(asObject(asObject(browse["header"])?.["pageHeaderRenderer"])?.["content"])?.["pageHeaderViewModel"] != null
      ? asObject(asObject(asObject(asObject(browse["header"])?.["pageHeaderRenderer"])?.["content"])?.["pageHeaderViewModel"]) ?? {}
      : {}

  const name: string =
    String(channelMetadata["title"] ?? "") ||
    readText(asObject(pageHeader["title"])?.["dynamicTextViewModel"]) ||
    String(microformat["title"] ?? "")
  const avatar: string =
    readThumbnailUrl(asObject(pageHeader["image"])?.["decoratedAvatarViewModel"]) ||
    readThumbnailUrl(asObject(asObject(asObject(pageHeader["image"])?.["decoratedAvatarViewModel"])?.["avatar"])?.["avatarViewModel"]) ||
    readThumbnailUrl(channelMetadata["avatar"]) ||
    readThumbnailUrl(asObject(microformat["thumbnail"]))
  const banner: string =
    readThumbnailUrl(asObject(channelMetadata["banner"])) ||
    readThumbnailUrl(asObject(asObject(asObject(pageHeader["banner"])?.["imageBannerViewModel"])?.["image"]))

  const videos: UnifiedVideoItem[] = extractVideoItems(browse).map((video: UnifiedVideoItem): UnifiedVideoItem => {
    if (video.authorName && video.authorId) return video
    return {
      ...video,
      authorName: video.authorName || name,
      authorId: video.authorId || channelId,
      authorAvatar: video.authorAvatar || avatar || undefined,
    }
  })

  const headerMetadata: JsonObject | null = asObject(pageHeader["metadata"])
  const metaParts: string[] = []
  for (const row of asArray(asObject(headerMetadata?.["contentMetadataViewModel"])?.["metadataRows"])) {
    for (const part of asArray(asObject(row)?.["metadataParts"])) {
      const text: string = readText(asObject(part)?.["text"]).trim()
      if (text) metaParts.push(text)
    }
  }
  const subscriberText: string =
    metaParts.find((part: string): boolean => /subscriber|訂閱|订阅|粉絲|粉丝/i.test(part)) ?? ""
  const videosText: string = metaParts.find((part: string): boolean => /videos?|影片|视频/i.test(part)) ?? ""
  const subscriberCount: string = subscriberText
    .replace(/\s*(位)?(subscribers?|訂閱(者)?|订阅(者)?|粉絲|粉丝)\s*$/i, "")
    .trim()
  const videoCountText: string = videosText.replace(/\s*(videos?|影片|视频)\s*$/i, "").trim()

  return {
    id: `yt:${channelId}`,
    provider: "yt",
    rawId: channelId,
    name,
    avatarUrl: avatar,
    bannerUrl: banner || undefined,
    description: String(channelMetadata["description"] ?? microformat["description"] ?? ""),
    subscriberCountText: subscriberCount ? `${subscriberCount} 訂閱` : readText(pageHeader["metadata"]) || undefined,
    videoCountText: videoCountText || undefined,
    videos,
  }
}
