/** ISO BMFF `sidx` box 解析：YouTube 直連與 bilibili DASH 都靠它算出每個子片段的位元組範圍。 */

export interface SidxEntry {
  offset: number
  size: number
  durationUs: number
}

export interface SidxIndex {
  timescale: number
  entries: SidxEntry[]
}

/** 解析 indexRange 開頭的位元組；baseOffset 是這段位元組在檔案裡的起點。 */
export function parseSidx(bytes: Uint8Array, baseOffset: number): SidxIndex | null {
  if (bytes.length < 16) return null
  const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let cursor: number = 0
  let sidxStart: number = -1
  while (cursor + 8 <= bytes.length) {
    const size: number = view.getUint32(cursor)
    const type: string = String.fromCharCode(
      bytes[cursor + 4],
      bytes[cursor + 5],
      bytes[cursor + 6],
      bytes[cursor + 7],
    )
    if (type === "sidx") {
      sidxStart = cursor
      break
    }
    if (size <= 0) break
    cursor += size
  }
  if (sidxStart < 0) return null

  let offset: number = sidxStart + 8
  const version: number = bytes[offset]
  offset += 4 // version + flags
  offset += 4 // reference_ID
  const timescale: number = view.getUint32(offset)
  offset += 4
  if (version === 0) {
    offset += 8 // earliest_presentation_time + first_offset
  } else {
    offset += 16
  }
  offset += 2 // reserved
  const referenceCount: number = view.getUint16(offset)
  offset += 2

  const boxSize: number = view.getUint32(sidxStart)
  const firstOffset: number = version === 0 ? view.getUint32(sidxStart + 8 + 4 + 4 + 4 + 4) : 0
  let mediaOffset: number = baseOffset + sidxStart + boxSize + firstOffset

  const entries: SidxEntry[] = []
  for (let i = 0; i < referenceCount; i++) {
    if (offset + 12 > bytes.length) break
    const reference: number = view.getUint32(offset)
    const duration: number = view.getUint32(offset + 4)
    offset += 12
    const referenceType: number = reference >>> 31
    const size: number = reference & 0x7fffffff
    if (referenceType === 0) {
      entries.push({ offset: mediaOffset, size, durationUs: Math.round((duration / timescale) * 1_000_000) })
      mediaOffset += size
    }
  }
  return { timescale, entries }
}
