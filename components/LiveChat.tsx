import { HStack, Image, ScrollView, Text, VStack, useEffect, useRef, useState } from "scripting"
import type { Color, VirtualNode } from "scripting"
import type {
  LiveChatCursor,
  LiveChatMessage,
  LiveChatRun,
} from "../services/youtube/liveChat"
import { Avatar, EmptyState } from "../ui/primitives"
import { palette, space, type } from "../ui/theme"

const MAX_MESSAGES: number = 300
const RETRY_MS: number = 4000
const MAX_RETRIES: number = 3
const MIN_POLL_MS: number = 150
const AFTER_MESSAGES_MS: number = 250
const IDLE_POLL_MS: number = 300
const LONG_POLL_MS: number = 1500
const AVATAR_SIZE: number = 24
const EMOJI_SIZE: number = 22

type ChatStatus = "loading" | "ready" | "ended" | "unavailable" | "error"

const NAME_COLORS: Color[] = [
  "#ff6b6b",
  "#ffa94d",
  "#ffd43b",
  "#69db7c",
  "#38d9a9",
  "#4dabf7",
  "#9775fa",
  "#da77f2",
  "#f783ac",
  "#c9a227",
] as Color[]

function colorFor(message: LiveChatMessage): Color {
  if (message.color) return message.color as Color
  const key: string = message.authorId || message.authorName
  let hash: number = 0
  for (let index = 0; index < key.length; index++) {
    hash = (hash * 31 + key.charCodeAt(index)) % 100003
  }
  return NAME_COLORS[hash % NAME_COLORS.length]
}

function RunBody(props: { message: LiveChatMessage }): VirtualNode {
  const message: LiveChatMessage = props.message
  const runs: LiveChatRun[] = message.runs
  const hasImage: boolean = runs.some((run: LiveChatRun): boolean => Boolean(run.imageUrl))
  const bodyColor: "label" | Color = message.kind === "text" ? "label" : palette.brand
  if (!hasImage) {
    return (
      <Text
        font={type.cardTitle}
        lineSpacing={2}
        foregroundStyle={bodyColor}
        multilineTextAlignment="leading"
        frame={{ maxWidth: "infinity", alignment: "leading" }}
      >
        {message.text}
      </Text>
    )
  }
  return (
    <HStack alignment="top" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      {runs.map((run: LiveChatRun, index: number): VirtualNode =>
        run.imageUrl ? (
          <Image
            key={`run-${index}`}
            imageUrl={run.imageUrl}
            resizable
            scaleToFit
            frame={{ width: EMOJI_SIZE, height: EMOJI_SIZE }}
            offset={{ x: 0, y: 2 }}
          />
        ) : (
          <Text
            key={`run-${index}`}
            font={type.cardTitle}
            foregroundStyle={bodyColor}
            lineLimit={3}
            frame={{ alignment: "leading" }}
          >
            {run.text ?? ""}
          </Text>
        ),
      )}
    </HStack>
  )
}

function ChatRow(props: { message: LiveChatMessage }): VirtualNode {
  const message: LiveChatMessage = props.message
  return (
    <HStack
      alignment="top"
      spacing={8}
      padding={{ horizontal: space.page, vertical: 5 }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
    >
      <Avatar url={message.avatarUrl} name={message.authorName} size={AVATAR_SIZE} />
      <VStack alignment="leading" spacing={1} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={type.meta + 1} fontWeight="semibold" lineLimit={1} foregroundStyle={colorFor(message)}>
          {message.authorName}
        </Text>
        <RunBody message={message} />
      </VStack>
    </HStack>
  )
}

export interface LiveChatProps {
  videoId: string
}

export function LiveChat(props: LiveChatProps): VirtualNode {
  const [messages, setMessages] = useState<LiveChatMessage[]>([])
  const [status, setStatus] = useState<ChatStatus>("loading")
  const [attempt, setAttempt] = useState<number>(0)
  const cursorRef = useRef<LiveChatCursor | null>(null)
  const seenRef = useRef<Set<string>>(new Set())
  const keepRef = useRef<LiveChatMessage[]>([])
  const timerRef = useRef<number | null>(null)
  const disposedRef = useRef<boolean>(false)

  useEffect(() => {
    disposedRef.current = false
    cursorRef.current = null
    seenRef.current = new Set()
    keepRef.current = []
    setMessages([])
    setStatus("loading")

    const push = (batch: LiveChatMessage[]): void => {
      let changed: boolean = false
      for (const message of batch) {
        if (seenRef.current.has(message.id)) continue
        seenRef.current.add(message.id)
        keepRef.current.push(message)
        changed = true
      }
      if (!changed) return
      if (keepRef.current.length > MAX_MESSAGES) {
        keepRef.current = keepRef.current.slice(keepRef.current.length - MAX_MESSAGES)
      }
      setMessages(keepRef.current.slice())
    }

    let failures: number = 0
    const schedule = (ms: number): void => {
      timerRef.current = setTimeout(() => {
        void tick()
      }, ms)
    }
    const tick = async (): Promise<void> => {
      try {
        const liveChatMod = await import("../services/youtube/liveChat")
        if (disposedRef.current) return
        if (!cursorRef.current) {
          const start: LiveChatCursor | null = await liveChatMod.fetchLiveChatStart(props.videoId)
          if (disposedRef.current) return
          if (!start) {
            setStatus("unavailable")
            return
          }
          cursorRef.current = start
        }
        const startedAt: number = Date.now()
        const batch = await liveChatMod.fetchLiveChatBatch(props.videoId, cursorRef.current)
        const elapsed: number = Date.now() - startedAt
        if (disposedRef.current) return
        push(batch.messages)
        failures = 0
        if (!batch.cursor) {
          setStatus("ended")
          return
        }
        cursorRef.current = batch.cursor
        setStatus("ready")
        const delay: number =
          batch.messages.length > 0 ? AFTER_MESSAGES_MS : elapsed >= LONG_POLL_MS ? 0 : IDLE_POLL_MS
        schedule(Math.max(MIN_POLL_MS, delay))
      } catch (_error) {
        if (disposedRef.current) return
        failures += 1
        if (failures > MAX_RETRIES) {
          setStatus("error")
          return
        }
        schedule(RETRY_MS)
      }
    }

    void tick()
    return (): void => {
      disposedRef.current = true
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [props.videoId, attempt])

  if (status === "unavailable") {
    return <EmptyState icon="bubble.left.and.exclamationmark.bubble.right" title="這場直播沒有開放聊天室" />
  }
  if (status === "error") {
    return (
      <EmptyState
        icon="wifi.exclamationmark"
        title="聊天室連線中斷"
        message="直播可能已經結束，或網路暫時不通。"
        actionLabel="重試"
        onAction={() => setAttempt(attempt + 1)}
      />
    )
  }
  if (messages.length === 0) {
    return (
      <VStack padding={{ top: 40 }}>
        <Text font={type.meta} foregroundStyle="secondaryLabel">
          {status === "ended" ? "聊天室已結束" : "正在連上聊天室…"}
        </Text>
      </VStack>
    )
  }

  return (
    <ScrollView
      axes="vertical"
      scrollIndicator="hidden"
      defaultScrollAnchor="bottom"
      frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}
    >
      <VStack spacing={0} padding={{ top: 8, bottom: 24 }} frame={{ maxWidth: "infinity" }}>
        {messages.map((message: LiveChatMessage) => (
          <ChatRow key={message.id} message={message} />
        ))}
        {status === "ended" ? (
          <Text font={type.meta} foregroundStyle="tertiaryLabel" padding={{ horizontal: space.page, top: 12 }}>
            聊天室已結束
          </Text>
        ) : null}
      </VStack>
    </ScrollView>
  )
}
