export const UMP_PART = {
  MEDIA_HEADER: 20,
  MEDIA: 21,
  MEDIA_END: 22,
  NEXT_REQUEST_POLICY: 35,
  FORMAT_INITIALIZATION_METADATA: 42,
  SABR_REDIRECT: 43,
  SABR_ERROR: 44,
  SABR_CONTEXT_UPDATE: 57,
  STREAM_PROTECTION_STATUS: 58,
  SABR_CONTEXT_SENDING_POLICY: 59,
} as const

export interface SabrByteRange {
  start: number
  end: number
}

export interface UmpPart {
  type: number
  data: Uint8Array
}

export function readVarInt(bytes: Uint8Array, offset: number): [number, number] {
  if (offset >= bytes.length) return [-1, offset]
  const first: number = bytes[offset]
  const byteLength: number =
    first < 128 ? 1 : first < 192 ? 2 : first < 224 ? 3 : first < 240 ? 4 : 5
  if (offset + byteLength > bytes.length) return [-1, offset]

  if (byteLength === 1) return [first, offset + 1]
  if (byteLength === 2) {
    return [(first & 0x3f) | (bytes[offset + 1] << 6), offset + 2]
  }
  if (byteLength === 3) {
    return [(first & 0x1f) | (bytes[offset + 1] << 5) | (bytes[offset + 2] << 13), offset + 3]
  }
  if (byteLength === 4) {
    return [
      (first & 0x0f) | (bytes[offset + 1] << 4) | (bytes[offset + 2] << 12) | (bytes[offset + 3] << 20),
      offset + 4,
    ]
  }
  const value: number =
    (bytes[offset + 1] | (bytes[offset + 2] << 8) | (bytes[offset + 3] << 16) | (bytes[offset + 4] << 24)) >>> 0
  return [value, offset + 5]
}

export function writeVarInt(value: number, out: number[]): void {
  if (value < 0) throw new Error("UMP VarInt 不可為負")
  if (value < 128) {
    out.push(value)
  } else if (value < 16384) {
    out.push((value & 0x3f) | 0x80, value >> 6)
  } else if (value < 2097152) {
    out.push((value & 0x1f) | 0xc0, (value >> 5) & 0xff, value >> 13)
  } else if (value < 268435456) {
    out.push((value & 0x0f) | 0xe0, (value >> 4) & 0xff, (value >> 12) & 0xff, value >> 20)
  } else {
    out.push(0xf0, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff)
  }
}

export function parseUmpParts(bytes: Uint8Array): UmpPart[] {
  const parts: UmpPart[] = []
  let offset: number = 0
  while (offset < bytes.length) {
    const typeResult: [number, number] = readVarInt(bytes, offset)
    if (typeResult[0] < 0) break
    offset = typeResult[1]
    const sizeResult: [number, number] = readVarInt(bytes, offset)
    if (sizeResult[0] < 0) break
    offset = sizeResult[1]
    const size: number = sizeResult[0]
    if (offset + size > bytes.length) break
    parts.push({ type: typeResult[0], data: bytes.subarray(offset, offset + size) })
    offset += size
  }
  return parts
}

export type ProtoValue = number | Uint8Array

export interface ProtoField {
  field: number
  wire: number
  value: ProtoValue
}

export class ProtoWriter {
  private buffer: number[] = []

  private varint(value: number): void {
    let remaining: number = Math.max(0, Math.floor(value))
    while (remaining > 0x7f) {
      this.buffer.push((remaining & 0x7f) | 0x80)
      remaining = Math.floor(remaining / 128)
    }
    this.buffer.push(remaining & 0x7f)
  }

  private tag(field: number, wire: number): void {
    this.varint((field << 3) | wire)
  }

  uint32(field: number, value: number): ProtoWriter {
    this.tag(field, 0)
    this.varint(value)
    return this
  }

  int64(field: number, value: number): ProtoWriter {
    this.tag(field, 0)
    this.varint(value)
    return this
  }

  float(field: number, value: number): ProtoWriter {
    this.tag(field, 5)
    const buffer: ArrayBuffer = new ArrayBuffer(4)
    new DataView(buffer).setFloat32(0, value, true)
    const view: Uint8Array = new Uint8Array(buffer)
    for (let i = 0; i < 4; i++) this.buffer.push(view[i])
    return this
  }

  string(field: number, value: string): ProtoWriter {
    const encoded: Uint8Array = new TextEncoder().encode(value)
    this.tag(field, 2)
    this.varint(encoded.length)
    for (let i = 0; i < encoded.length; i++) this.buffer.push(encoded[i])
    return this
  }

  bytes(field: number, value: Uint8Array): ProtoWriter {
    this.tag(field, 2)
    this.varint(value.length)
    for (let i = 0; i < value.length; i++) this.buffer.push(value[i])
    return this
  }

  message(field: number, builder: ProtoWriter): ProtoWriter {
    return this.bytes(field, builder.finish())
  }

  finish(): Uint8Array {
    return new Uint8Array(this.buffer)
  }
}

function readProtoVarint(bytes: Uint8Array, offset: number): [number, number] {
  let result: number = 0
  let shift: number = 0
  let cursor: number = offset
  while (cursor < bytes.length) {
    const byte: number = bytes[cursor]
    result += (byte & 0x7f) * Math.pow(2, shift)
    cursor++
    if ((byte & 0x80) === 0) return [result, cursor]
    shift += 7
    if (shift > 49) break
  }
  return [0, offset]
}

export function decodeProto(bytes: Uint8Array): Map<number, ProtoField[]> {
  const fields: Map<number, ProtoField[]> = new Map()
  let offset: number = 0
  while (offset < bytes.length) {
    const tagResult: [number, number] = readProtoVarint(bytes, offset)
    const tag: number = tagResult[0]
    if (tagResult[1] === offset) break
    offset = tagResult[1]
    if (tag === 0) break
    const field: number = tag >>> 3
    const wire: number = tag & 7
    let value: ProtoValue = 0

    if (wire === 0) {
      const varintResult: [number, number] = readProtoVarint(bytes, offset)
      value = varintResult[0]
      offset = varintResult[1]
    } else if (wire === 2) {
      const lengthResult: [number, number] = readProtoVarint(bytes, offset)
      const length: number = lengthResult[0]
      offset = lengthResult[1]
      const end: number = Math.min(offset + length, bytes.length)
      value = bytes.subarray(offset, end)
      offset = end
    } else if (wire === 1) {
      offset += 8
      continue
    } else if (wire === 5) {
      if (offset + 4 <= bytes.length) {
        const view: DataView = new DataView(bytes.buffer, bytes.byteOffset + offset, 4)
        value = view.getFloat32(0, true)
      }
      offset += 4
    } else {
      break
    }

    const list: ProtoField[] = fields.get(field) ?? []
    list.push({ field, wire, value })
    fields.set(field, list)
  }
  return fields
}

export function protoNumber(fields: Map<number, ProtoField[]>, field: number): number | undefined {
  const entry: ProtoField | undefined = fields.get(field)?.[0]
  if (!entry) return undefined
  return typeof entry.value === "number" ? entry.value : undefined
}

export function protoBytes(fields: Map<number, ProtoField[]>, field: number): Uint8Array | undefined {
  const entry: ProtoField | undefined = fields.get(field)?.[0]
  if (!entry || typeof entry.value === "number") return undefined
  return entry.value
}

export function protoInts(fields: Map<number, ProtoField[]>, field: number): number[] {
  const out: number[] = []
  for (const entry of fields.get(field) ?? []) {
    if (typeof entry.value === "number") {
      out.push(entry.value)
      continue
    }
    let offset: number = 0
    while (offset < entry.value.length) {
      const [value, next] = readProtoVarint(entry.value, offset)
      if (next === offset) break
      out.push(value)
      offset = next
    }
  }
  return out
}

export function protoString(fields: Map<number, ProtoField[]>, field: number): string | undefined {
  const value: Uint8Array | undefined = protoBytes(fields, field)
  return value ? new TextDecoder().decode(value) : undefined
}

export interface SabrMediaHeader {
  headerId: number
  itag?: number
  segmentNum?: number
  isInitializationSegment?: boolean
  startMs?: number
  durationMs?: number
  byteRangeStart?: number
}

export function decodeMediaHeader(bytes: Uint8Array): SabrMediaHeader {
  const fields: Map<number, ProtoField[]> = decodeProto(bytes)
  const header: SabrMediaHeader = { headerId: protoNumber(fields, 1) ?? 0 }
  const itag: number | undefined = protoNumber(fields, 3)
  if (itag !== undefined) header.itag = itag
  const segmentNum: number | undefined = protoNumber(fields, 9)
  if (segmentNum !== undefined) header.segmentNum = segmentNum
  const isInit: number | undefined = protoNumber(fields, 8)
  if (isInit !== undefined) header.isInitializationSegment = isInit === 1
  const startMs: number | undefined = protoNumber(fields, 11)
  if (startMs !== undefined) header.startMs = startMs
  const durationMs: number | undefined = protoNumber(fields, 12)
  if (durationMs !== undefined) header.durationMs = durationMs
  const byteRangeStart: number | undefined = protoNumber(fields, 6)
  if (byteRangeStart !== undefined) header.byteRangeStart = byteRangeStart
  return header
}

export interface SabrFormatInitMetadata {
  itag: number
  lastModified: string
  endSegmentNumber?: number
  indexRange?: SabrByteRange
}

function decodeRange(bytes: Uint8Array | undefined): SabrByteRange | undefined {
  if (!bytes) return undefined
  const fields: Map<number, ProtoField[]> = decodeProto(bytes)
  const start: number | undefined = protoNumber(fields, 1)
  const end: number | undefined = protoNumber(fields, 2)
  return start !== undefined && end !== undefined ? { start, end } : undefined
}

export function decodeFormatInitMetadata(bytes: Uint8Array): SabrFormatInitMetadata | null {
  const fields: Map<number, ProtoField[]> = decodeProto(bytes)
  const formatId: Uint8Array | undefined = protoBytes(fields, 2)
  if (!formatId) return null
  const idFields: Map<number, ProtoField[]> = decodeProto(formatId)
  const itag: number | undefined = protoNumber(idFields, 1)
  if (itag === undefined) return null
  const metadata: SabrFormatInitMetadata = { itag, lastModified: String(protoNumber(idFields, 2) ?? 0) }
  const endSegmentNumber: number | undefined = protoNumber(fields, 4)
  if (endSegmentNumber !== undefined) metadata.endSegmentNumber = endSegmentNumber
  const indexRange: SabrByteRange | undefined = decodeRange(protoBytes(fields, 7))
  if (indexRange) metadata.indexRange = indexRange
  return metadata
}

export interface SabrNextRequestPolicy {
  playbackCookie?: Uint8Array
  targetVideoReadaheadMs?: number
  targetAudioReadaheadMs?: number
  backoffTimeMs?: number
}

export function decodeNextRequestPolicy(bytes: Uint8Array): SabrNextRequestPolicy {
  const fields: Map<number, ProtoField[]> = decodeProto(bytes)
  const policy: SabrNextRequestPolicy = {}
  const cookie: Uint8Array | undefined = protoBytes(fields, 7)
  if (cookie) policy.playbackCookie = cookie
  const video: number | undefined = protoNumber(fields, 2)
  if (video !== undefined) policy.targetVideoReadaheadMs = video
  const audio: number | undefined = protoNumber(fields, 1)
  if (audio !== undefined) policy.targetAudioReadaheadMs = audio
  const backoff: number | undefined = protoNumber(fields, 4)
  if (backoff !== undefined) policy.backoffTimeMs = backoff
  return policy
}

export function decodeSabrError(bytes: Uint8Array): string {
  const fields: Map<number, ProtoField[]> = decodeProto(bytes)
  return protoString(fields, 2) ?? protoString(fields, 1) ?? "SABR error"
}

export function decodeSabrRedirect(bytes: Uint8Array): string | undefined {
  const fields: Map<number, ProtoField[]> = decodeProto(bytes)
  return protoString(fields, 1)
}

export function base64ToBytes(value: string): Uint8Array | null {
  if (!value) return null
  let normalized: string = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\./g, "=")
  while (normalized.length % 4 !== 0) normalized += "="
  const data: Data | null = Data.fromBase64String(normalized)
  return data ? data.toUint8Array() : null
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total: number = 0
  for (const chunk of chunks) total += chunk.length
  const out: Uint8Array = new Uint8Array(total)
  let offset: number = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export function makeClientPlaybackNonce(): string {
  const alphabet: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
  let nonce: string = ""
  for (let i = 0; i < 16; i++) nonce += alphabet[Math.floor(Math.random() * alphabet.length)]
  return nonce
}
