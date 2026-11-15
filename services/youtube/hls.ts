/**
 * YouTube HLS Master `.m3u8` 解析。
 *
 * 為每個 `#EXT-X-STREAM-INF` 建立單一畫質子 Master：
 * 保留原本的絕對 variant URL，並把對應的 `#EXT-X-MEDIA:TYPE=AUDIO`
 * 轉成絕對 URL 一起放進子 Master，切畫質時才不會失去音訊。
 */

import { fetch } from "scripting"
import type { VideoQualityTrack } from "../../types"
import { registerVirtualManifest } from "../localProxy"

export interface HlsAudioGroup {
  groupId: string
  name: string
  language?: string
  uri: string
  isDefault: boolean
}

export interface HlsVariant {
  uri: string
  bandwidth: number
  averageBandwidth?: number
  width?: number
  height?: number
  frameRate?: number
  codecs?: string
  audioGroup?: string
}

export interface ParsedHlsMaster {
  variants: HlsVariant[]
  audioGroups: HlsAudioGroup[]
}

export interface ResolvedHlsManifest {
  primaryUrl: string
  qualities: VideoQualityTrack[]
  masterText: string
  variants: HlsVariant[]
  audioGroups: HlsAudioGroup[]
}

function splitAttributes(input: string): Record<string, string> {
  const result: Record<string, string> = {}
  let current: string = ""
  let inQuotes: boolean = false
  const parts: string[] = []
  for (let i = 0; i < input.length; i++) {
    const char: string = input[i]
    if (char === "\"") {
      inQuotes = !inQuotes
      current += char
    } else if (char === "," && !inQuotes) {
      parts.push(current)
      current = ""
    } else {
      current += char
    }
  }
  if (current) parts.push(current)
  for (const part of parts) {
    const index: number = part.indexOf("=")
    if (index < 0) continue
    const key: string = part.slice(0, index).trim().toUpperCase()
    let value: string = part.slice(index + 1).trim()
    if (value.startsWith("\"") && value.endsWith("\"")) value = value.slice(1, -1)
    result[key] = value
  }
  return result
}

/** 以 base URL 解析相對路徑。 */
export function resolveUrl(baseUrl: string, relative: string): string {
  if (!relative) return baseUrl
  if (/^https?:\/\//i.test(relative)) return relative
  if (relative.startsWith("//")) return `https:${relative}`
  const baseMatch: RegExpMatchArray | null = baseUrl.match(/^(https?:\/\/[^/]+)(.*)$/i)
  if (!baseMatch) return relative
  const origin: string = baseMatch[1]
  const basePath: string = baseMatch[2].split("?")[0]
  if (relative.startsWith("/")) return `${origin}${relative}`
  const baseDir: string = basePath.slice(0, basePath.lastIndexOf("/") + 1)
  return `${origin}${baseDir}${relative}`
}

/** 解析 Master playlist 文字。 */
export function parseHlsMasterText(text: string, masterUrl: string): ParsedHlsMaster {
  const lines: string[] = text
    .split(/\r?\n/)
    .map((line: string): string => line.trim())
    .filter((line: string): boolean => line.length > 0)

  const variants: HlsVariant[] = []
  const audioGroups: HlsAudioGroup[] = []

  for (let i = 0; i < lines.length; i++) {
    const line: string = lines[i]
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attributes: Record<string, string> = splitAttributes(line.slice("#EXT-X-MEDIA:".length))
      if ((attributes["TYPE"] ?? "").toUpperCase() !== "AUDIO") continue
      const uri: string = resolveUrl(masterUrl, attributes["URI"] ?? "")
      audioGroups.push({
        groupId: attributes["GROUP-ID"] ?? "",
        name: attributes["NAME"] ?? "audio",
        language: attributes["LANGUAGE"],
        uri,
        isDefault: (attributes["DEFAULT"] ?? "").toUpperCase() === "YES",
      })
      continue
    }

    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue
    const attributes: Record<string, string> = splitAttributes(line.slice("#EXT-X-STREAM-INF:".length))
    let uri: string = ""
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith("#")) continue
      uri = resolveUrl(masterUrl, lines[j])
      i = j
      break
    }
    if (!uri) continue

    const resolution: string = attributes["RESOLUTION"] ?? ""
    const resolutionMatch: RegExpMatchArray | null = resolution.match(/^(\d+)x(\d+)$/)
    const variant: HlsVariant = {
      uri,
      bandwidth: Number(attributes["BANDWIDTH"] ?? 0),
      codecs: attributes["CODECS"],
      audioGroup: attributes["AUDIO"],
    }
    const average: string | undefined = attributes["AVERAGE-BANDWIDTH"]
    if (average) variant.averageBandwidth = Number(average)
    if (resolutionMatch) {
      variant.width = Number(resolutionMatch[1])
      variant.height = Number(resolutionMatch[2])
    }
    const frameRate: string | undefined = attributes["FRAME-RATE"]
    if (frameRate) variant.frameRate = Number(frameRate)
    variants.push(variant)
  }

  return { variants, audioGroups }
}

function qualityLabel(height: number, fps: number | undefined): string {
  const base: string =
    height >= 2160 ? "4K" : height >= 1440 ? "2K" : height > 0 ? `${height}p` : "Auto"
  const suffix: string = fps && fps >= 50 ? "60" : ""
  return `${base}${suffix}`
}

function simpleHash(input: string): string {
  let hash: number = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) % 2147483647
  }
  return Math.abs(hash).toString(36)
}

function buildSingleVariantMaster(variant: HlsVariant, audio: HlsAudioGroup | undefined): string {
  const lines: string[] = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS"]
  if (audio) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${audio.name}",DEFAULT=YES,AUTOSELECT=YES,URI="${audio.uri}"`,
    )
  }
  const attributes: string[] = [`BANDWIDTH=${variant.bandwidth}`]
  if (variant.averageBandwidth) attributes.push(`AVERAGE-BANDWIDTH=${variant.averageBandwidth}`)
  if (variant.width && variant.height) attributes.push(`RESOLUTION=${variant.width}x${variant.height}`)
  if (variant.frameRate) attributes.push(`FRAME-RATE=${variant.frameRate}`)
  if (variant.codecs) attributes.push(`CODECS="${variant.codecs}"`)
  if (audio) attributes.push("AUDIO=\"audio\"")
  lines.push(`#EXT-X-STREAM-INF:${attributes.join(",")}`, variant.uri)
  return `${lines.join("\n")}\n`
}

/**
 * 抓取並解析 HLS Master，回傳可切換的畫質軌。
 * 原始 master 保留為自適應 `primaryUrl`。
 */
export async function resolveHlsManifest(masterUrl: string): Promise<ResolvedHlsManifest> {
  const response = await fetch(masterUrl, {
    headers: { "User-Agent": "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_1 like Mac OS X;)" },
    timeout: 20,
    debugLabel: "Yobi HLS master",
  })
  if (!response.ok) {
    throw new Error(`HLS master 取得失敗：HTTP ${response.status}`)
  }
  const masterText: string = await response.text()
  const parsed: ParsedHlsMaster = parseHlsMasterText(masterText, masterUrl)

  const sorted: HlsVariant[] = parsed.variants
    .slice()
    .sort((a: HlsVariant, b: HlsVariant): number => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth)

  const qualities: VideoQualityTrack[] = []
  const usedIds: Set<string> = new Set()

  for (const variant of sorted) {
    const audio: HlsAudioGroup | undefined = variant.audioGroup
      ? parsed.audioGroups.find((group: HlsAudioGroup): boolean => group.groupId === variant.audioGroup)
      : parsed.audioGroups.find((group: HlsAudioGroup): boolean => group.isDefault) ?? parsed.audioGroups[0]

    const localUrl: string = registerVirtualManifest(
      `yt-hls-${simpleHash(variant.uri)}`,
      buildSingleVariantMaster(variant, audio),
      "application/vnd.apple.mpegurl",
    )

    let id: string = `hls-${variant.height ?? 0}p${variant.frameRate && variant.frameRate >= 50 ? "60" : ""}`
    if (usedIds.has(id)) id = `${id}-${simpleHash(variant.uri)}`
    usedIds.add(id)

    const quality: VideoQualityTrack = {
      id,
      label: qualityLabel(variant.height ?? 0, variant.frameRate),
      width: variant.width ?? 0,
      height: variant.height ?? 0,
      delivery: "hls",
      url: localUrl,
    }
    if (variant.frameRate) quality.fps = variant.frameRate
    if (variant.bandwidth) quality.bitrate = variant.bandwidth
    if (variant.codecs) quality.codec = variant.codecs.split(",")[0]
    qualities.push(quality)
  }

  return { primaryUrl: masterUrl, qualities, masterText, variants: parsed.variants, audioGroups: parsed.audioGroups }
}
