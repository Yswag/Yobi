import type { Provider, UnifiedVideoItem } from "../types/index"
import {
  addSearchHistory,
  detectInputLink,
  getVideoDetail,
  resolveBiliShortUrl,
  type DetectedInputLink,
} from "../services/index"
import { openVideo } from "../state/playerStore"
import { providerFullName } from "../utils/format"

export interface DirectLinkTarget {
  provider: Provider
  rawId: string
  label: string
}

export function detectDirectLink(input: string): DirectLinkTarget | null {
  const trimmed: string = input.trim()
  if (!trimmed) return null

  if (/b23\.tv\/[0-9A-Za-z]+/i.test(trimmed)) {
    return { provider: "bili", rawId: trimmed, label: "BiliBili 短連結" }
  }

  const detected: DetectedInputLink | null = detectInputLink(trimmed)
  if (!detected) return null
  return {
    provider: detected.provider,
    rawId: detected.rawId,
    label: `${providerFullName(detected.provider)} · ${detected.rawId}`,
  }
}

export async function resolveAnyVideoInput(input: string): Promise<DetectedInputLink | null> {
  const trimmed: string = (input ?? "").trim()
  if (!trimmed) return null

  const direct: DetectedInputLink | null = detectInputLink(trimmed)
  if (direct) return direct

  if (trimmed.includes("b23.tv")) {
    const resolved: { bvid?: string; aid?: number } | null = await resolveBiliShortUrl(trimmed)
    if (resolved?.bvid) return detectInputLink(resolved.bvid)
    if (resolved?.aid) return detectInputLink(`av${resolved.aid}`)
  }
  return null
}

export function buildStubVideoItem(provider: Provider, rawId: string): UnifiedVideoItem {
  return {
    id: `${provider}:${rawId}`,
    provider,
    rawId,
    title: rawId,
    thumbnailUrl: "",
    duration: 0,
    authorId: "",
    authorName: providerFullName(provider),
  }
}

export async function openDirectLinkTarget(
  target: DirectLinkTarget,
  options?: { recordHistory?: boolean },
): Promise<void> {
  let rawId: string = target.rawId
  if (/b23\.tv/i.test(rawId)) {
    const ids: { bvid?: string; aid?: number } | null = await resolveBiliShortUrl(rawId)
    if (!ids) throw new Error("無法展開短連結")
    rawId = ids.bvid ? ids.bvid : `av${ids.aid}`
  }
  const detail: UnifiedVideoItem = await getVideoDetail(target.provider, rawId)
  if (options?.recordHistory) addSearchHistory(detail.rawId)
  void openVideo(detail, { queue: [detail] })
}

export async function openLinkFromClipboardOrPrompt(): Promise<void> {
  const clipboard: string = (await Pasteboard.getString()) ?? ""
  let detected: DetectedInputLink | null = await resolveAnyVideoInput(clipboard)

  if (!detected) {
    const input: string | null = await Dialog.prompt({
      title: "開啟連結",
      message: "貼上 YouTube 連結或 BiliBili BV / AV 番號",
      defaultValue: clipboard,
      placeholder: "https://... 或 BV1xx411c7mD",
      confirmLabel: "開啟",
    })
    if (typeof input !== "string" || !input.trim()) return
    detected = await resolveAnyVideoInput(input)
  }

  if (!detected) {
    await Dialog.alert({
      title: "無法辨識連結",
      message: "請輸入 YouTube 影片連結或 BiliBili BV / AV 番號。",
    })
    return
  }

  void openVideo(buildStubVideoItem(detected.provider, detected.rawId))
}
