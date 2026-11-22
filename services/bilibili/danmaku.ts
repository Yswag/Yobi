import { fetch } from "scripting"
import { reportError } from "../errors"
import { BILI_HEADERS } from "./meta"

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return Data.fromUint8Array(bytes)?.toDecodedString("utf8") ?? ""
  } catch {
    return ""
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function looksLikeXml(text: string): boolean {
  const trimmed: string = text.trimStart()
  return trimmed.startsWith("<?xml") || trimmed.startsWith("<i")
}

async function decodeDanmakuBytes(bytes: Uint8Array): Promise<string> {
  const plain: string = decodeUtf8(bytes)
  if (looksLikeXml(plain)) return stripBom(plain).trim()
  const { inflateDanmaku } = await import("./inflate")
  const inflated: string = decodeUtf8(inflateDanmaku(bytes))
  if (looksLikeXml(inflated)) return stripBom(inflated).trim()
  throw new Error("彈幕資料格式不正確")
}

export async function fetchBiliDanmakuXml(cid: number): Promise<string> {
  const urls: string[] = [
    `https://comment.bilibili.com/${cid}.xml`,
    `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`,
  ]

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { ...BILI_HEADERS } })
      if (!res.ok) continue
      const bytes: Uint8Array = await res.bytes()
      return await decodeDanmakuBytes(bytes)
    } catch (error) {
      reportError("bili", "danmaku.endpoint", error)
    }
  }
  throw new Error("無法取得彈幕資料")
}
