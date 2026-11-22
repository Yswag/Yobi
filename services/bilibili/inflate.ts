interface HuffmanTable {
  counts: number[]
  symbols: number[]
}

const LEN_BASE: number[] = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
  131, 163, 195, 227, 258,
]
const LEN_EXTRA: number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]
const DIST_BASE: number[] = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
  2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
const DIST_EXTRA: number[] = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
  13, 13,
]
const CODE_LENGTH_ORDER: number[] = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
]

class BitReader {
  private readonly data: Uint8Array
  private position: number = 0
  private bitOffset: number = 0

  constructor(data: Uint8Array) {
    this.data = data
  }

  read(count: number): number {
    let value: number = 0
    for (let i = 0; i < count; i++) {
      const byte: number | undefined = this.data[this.position]
      if (byte === undefined) throw new Error("deflate stream ended early")
      value |= ((byte >> this.bitOffset) & 1) << i
      this.bitOffset++
      if (this.bitOffset === 8) {
        this.bitOffset = 0
        this.position++
      }
    }
    return value
  }

  align(): void {
    if (this.bitOffset !== 0) {
      this.bitOffset = 0
      this.position++
    }
  }

  readBytes(count: number): Uint8Array {
    const start: number = this.position
    if (start + count > this.data.length) throw new Error("deflate stream ended early")
    this.position += count
    return this.data.subarray(start, start + count)
  }
}

function buildHuffman(lengths: number[]): HuffmanTable {
  let maxLength: number = 0
  for (const length of lengths) {
    if (length > maxLength) maxLength = length
  }
  const counts: number[] = new Array<number>(maxLength + 1).fill(0)
  for (const length of lengths) {
    if (length > 0) counts[length]++
  }
  const offsets: number[] = new Array<number>(maxLength + 1).fill(0)
  for (let length = 1; length < maxLength; length++) {
    offsets[length + 1] = offsets[length] + counts[length]
  }
  const symbols: number[] = new Array<number>(lengths.length).fill(0)
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length: number = lengths[symbol]
    if (length > 0) symbols[offsets[length]++] = symbol
  }
  return { counts, symbols }
}

function decodeSymbol(reader: BitReader, table: HuffmanTable): number {
  let code: number = 0
  let first: number = 0
  let index: number = 0
  for (let length = 1; length < table.counts.length; length++) {
    code |= reader.read(1)
    const count: number = table.counts[length] ?? 0
    if (code - first < count) return table.symbols[index + (code - first)]
    index += count
    first = (first + count) << 1
    code <<= 1
  }
  throw new Error("invalid huffman code")
}

let fixedLiteralTable: HuffmanTable | null = null
let fixedDistanceTable: HuffmanTable | null = null

function fixedTables(): { literal: HuffmanTable; distance: HuffmanTable } {
  if (!fixedLiteralTable) {
    const lengths: number[] = []
    for (let symbol = 0; symbol < 288; symbol++) {
      if (symbol < 144) lengths.push(8)
      else if (symbol < 256) lengths.push(9)
      else if (symbol < 280) lengths.push(7)
      else lengths.push(8)
    }
    fixedLiteralTable = buildHuffman(lengths)
  }
  if (!fixedDistanceTable) {
    fixedDistanceTable = buildHuffman(new Array<number>(32).fill(5))
  }
  return { literal: fixedLiteralTable, distance: fixedDistanceTable }
}

function inflateRaw(input: Uint8Array): Uint8Array {
  const reader: BitReader = new BitReader(input)
  let output: Uint8Array = new Uint8Array(Math.max(1024, input.length * 4))
  let outputLength: number = 0

  const ensure = (extra: number): void => {
    if (outputLength + extra <= output.length) return
    let size: number = output.length * 2
    while (size < outputLength + extra) size *= 2
    const next: Uint8Array = new Uint8Array(size)
    next.set(output.subarray(0, outputLength))
    output = next
  }

  const push = (byte: number): void => {
    ensure(1)
    output[outputLength++] = byte
  }

  const decodeBlock = (literal: HuffmanTable, distance: HuffmanTable): void => {
    while (true) {
      const symbol: number = decodeSymbol(reader, literal)
      if (symbol < 256) {
        push(symbol)
        continue
      }
      if (symbol === 256) return

      const lengthIndex: number = symbol - 257
      if (lengthIndex < 0 || lengthIndex >= LEN_BASE.length) throw new Error("invalid length")
      const length: number = LEN_BASE[lengthIndex] + reader.read(LEN_EXTRA[lengthIndex])

      const distanceSymbol: number = decodeSymbol(reader, distance)
      if (distanceSymbol >= DIST_BASE.length) throw new Error("invalid distance")
      const back: number = DIST_BASE[distanceSymbol] + reader.read(DIST_EXTRA[distanceSymbol])
      if (back > outputLength) throw new Error("invalid distance reference")

      ensure(length)
      let source: number = outputLength - back
      for (let i = 0; i < length; i++) {
        output[outputLength++] = output[source++]
      }
    }
  }

  let final: number = 0
  while (!final) {
    final = reader.read(1)
    const type: number = reader.read(2)

    if (type === 0) {
      reader.align()
      const length: number = reader.read(16)
      reader.read(16)
      const bytes: Uint8Array = reader.readBytes(length)
      ensure(length)
      output.set(bytes, outputLength)
      outputLength += length
      continue
    }

    if (type === 1) {
      const tables = fixedTables()
      decodeBlock(tables.literal, tables.distance)
      continue
    }

    if (type === 2) {
      const literalCount: number = reader.read(5) + 257
      const distanceCount: number = reader.read(5) + 1
      const codeLengthCount: number = reader.read(4) + 4

      const codeLengths: number[] = new Array<number>(19).fill(0)
      for (let i = 0; i < codeLengthCount; i++) {
        codeLengths[CODE_LENGTH_ORDER[i]] = reader.read(3)
      }
      const codeLengthTable: HuffmanTable = buildHuffman(codeLengths)

      const lengths: number[] = []
      while (lengths.length < literalCount + distanceCount) {
        const symbol: number = decodeSymbol(reader, codeLengthTable)
        if (symbol < 16) {
          lengths.push(symbol)
        } else if (symbol === 16) {
          if (!lengths.length) throw new Error("invalid code length repeat")
          const repeat: number = reader.read(2) + 3
          const previous: number = lengths[lengths.length - 1]
          for (let i = 0; i < repeat; i++) lengths.push(previous)
        } else if (symbol === 17) {
          const repeat: number = reader.read(3) + 3
          for (let i = 0; i < repeat; i++) lengths.push(0)
        } else if (symbol === 18) {
          const repeat: number = reader.read(7) + 11
          for (let i = 0; i < repeat; i++) lengths.push(0)
        } else {
          throw new Error("invalid code length symbol")
        }
      }

      const literal: HuffmanTable = buildHuffman(lengths.slice(0, literalCount))
      const distance: HuffmanTable = buildHuffman(
        lengths.slice(literalCount, literalCount + distanceCount),
      )
      decodeBlock(literal, distance)
      continue
    }

    throw new Error("invalid deflate block type")
  }

  return output.subarray(0, outputLength)
}

export function inflateDanmaku(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 3) throw new Error("too small to decompress")

  const candidates: Uint8Array[] = []
  const isGzip: boolean = bytes[0] === 0x1f && bytes[1] === 0x8b
  if (isGzip) {
    const flags: number = bytes[3]
    let offset: number = 10
    if (flags & 0x04) offset = 12 + (bytes[10] | (bytes[11] << 8))
    if (flags & 0x08) {
      while (offset < bytes.length && bytes[offset] !== 0) offset++
      offset++
    }
    if (flags & 0x10) {
      while (offset < bytes.length && bytes[offset] !== 0) offset++
      offset++
    }
    if (flags & 0x02) offset += 2
    candidates.push(bytes.subarray(offset))
  } else if ((bytes[0] & 0x0f) === 0x08 && ((bytes[0] << 8) | bytes[1]) % 31 === 0) {
    let offset: number = 2
    if (bytes[1] & 0x20) offset += 4
    candidates.push(bytes.subarray(offset))
    candidates.push(bytes)
  } else {
    candidates.push(bytes)
  }

  let lastError: unknown = null
  for (const candidate of candidates) {
    try {
      return inflateRaw(candidate)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error("無法解壓彈幕資料")
}
