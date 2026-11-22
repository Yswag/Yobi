import { FlowLayout, HStack, Image, Text, VStack } from "scripting"
import type { VirtualNode } from "scripting"
import type { CommentItem, CommentRun } from "../../types/index"
import { emojiImageUrl } from "../../utils/image"
import { type } from "../../ui/theme"

const EMOJI_SIZE: number = 18
const EMOJI_LARGE: number = 28
const EMOJI_GAP: number = 3
const WIDE_CHAR: RegExp = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/
const WIDE_BREAK: RegExp = /[，。！？、；：）」』】》—…]/
const WIDE_CHUNK_SIZE: number = 3

export function textChunks(text: string): string[] {
  const chunks: string[] = []
  let buffer: string = ""
  let wideCount: number = 0
  const flush = (): void => {
    if (!buffer) return
    chunks.push(buffer)
    buffer = ""
    wideCount = 0
  }
  for (const char of text) {
    if (WIDE_BREAK.test(char)) {
      if (buffer) {
        buffer += char
        flush()
      } else if (chunks.length > 0) {
        chunks[chunks.length - 1] += char
      } else {
        chunks.push(char)
      }
      continue
    }
    if (WIDE_CHAR.test(char)) {
      if (buffer && wideCount === 0) flush()
      buffer += char
      wideCount++
      if (wideCount >= WIDE_CHUNK_SIZE) flush()
      continue
    }
    if (wideCount > 0) flush()
    buffer += char
    if (char === " ") flush()
  }
  flush()
  return chunks
}

export function splitLines(runs: CommentRun[]): CommentRun[][] {
  const lines: CommentRun[][] = [[]]
  for (const run of runs) {
    if (run.imageUrl) {
      lines[lines.length - 1].push(run)
      continue
    }
    const parts: string[] = (run.text ?? "").split("\n")
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) lines.push([])
      if (parts[index]) lines[lines.length - 1].push({ text: parts[index] })
    }
  }
  return lines.filter((line: CommentRun[]): boolean => line.length > 0)
}

export function gapNode(key: string): VirtualNode {
  return <HStack key={key} frame={{ width: EMOJI_GAP, height: 1 }} />
}

export interface LineItem {
  key: string
  imageUrl?: string
  text?: string
  scale?: number
}

export function lineNodes(line: CommentRun[]): VirtualNode[] {
  const items: LineItem[] = []
  line.forEach((run: CommentRun, runIndex: number): void => {
    if (run.imageUrl) {
      items.push({ key: `img-${runIndex}`, imageUrl: run.imageUrl, scale: run.scale })
      return
    }
    textChunks(run.text ?? "").forEach((chunk: string, chunkIndex: number): void => {
      items.push({ key: `txt-${runIndex}-${chunkIndex}`, text: chunk })
    })
  })

  const hasLarge: boolean = items.some((item: LineItem): boolean => (item.scale ?? 1) > 1)
  const rowHeight: number = hasLarge ? EMOJI_LARGE : EMOJI_SIZE

  const nodes: VirtualNode[] = []
  items.forEach((item: LineItem, index: number): void => {
    const previous: LineItem | undefined = items[index - 1]
    if (previous && (previous.imageUrl || item.imageUrl)) nodes.push(gapNode(`gap-${index}`))
    if (item.imageUrl) {
      const size: number = (item.scale ?? 1) > 1 ? EMOJI_LARGE : EMOJI_SIZE
      const sizedUrl: string = emojiImageUrl(item.imageUrl, size) ?? item.imageUrl
      nodes.push(
        <Image
          key={item.key}
          imageUrl={sizedUrl}
          resizable
          scaleToFit
          frame={{ width: size, height: size }}
        />,
      )
      return
    }
    nodes.push(
      <Text
        key={item.key}
        font={type.cardTitle}
        foregroundStyle="label"
        frame={hasLarge ? { height: rowHeight, alignment: "bottom" } : undefined}
      >
        {item.text ?? ""}
      </Text>,
    )
  })
  return nodes
}

export function CommentText(props: { comment: CommentItem }): VirtualNode {
  const runs: CommentRun[] | undefined = props.comment.runs
  const hasImage: boolean = runs?.some((run: CommentRun): boolean => Boolean(run.imageUrl)) === true
  if (!runs || !hasImage) {
    return (
      <Text
        font={type.cardTitle}
        foregroundStyle="label"
        lineSpacing={3}
        multilineTextAlignment="leading"
        frame={{ maxWidth: "infinity", alignment: "leading" }}
      >
        {props.comment.content}
      </Text>
    )
  }

  const lines: CommentRun[][] = splitLines(runs)
  return (
    <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      {lines.map((line: CommentRun[], lineIndex: number) => {
        const lineHasImage: boolean = line.some((run: CommentRun): boolean => Boolean(run.imageUrl))
        if (!lineHasImage) {
          const text: string = line.map((run: CommentRun): string => run.text ?? "").join("")
          return (
            <Text
              key={`line-${lineIndex}`}
              font={type.cardTitle}
              foregroundStyle="label"
              lineSpacing={3}
              multilineTextAlignment="leading"
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            >
              {text}
            </Text>
          )
        }
        return (
          <FlowLayout
            key={`line-${lineIndex}`}
            spacing={0}
            horizontalSpacing={0}
            verticalSpacing={3}
            frame={{ maxWidth: "infinity", alignment: "leading" }}
          >
            {lineNodes(line)}
          </FlowLayout>
        )
      })}
    </VStack>
  )
}
