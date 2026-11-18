import { ScrollView, Text, VStack, useEffect, useRef, useState } from "scripting"
import type { Color, VirtualNode } from "scripting"
import {
  fetchLiveChatBatch,
  fetchLiveChatStart,
  type LiveChatCursor,
  type LiveChatMessage,
} from "../services/youtube/liveChat"
import { EmptyState } from "../ui/primitives"
import { palette, space, type } from "../ui/theme"

/** 留下來的訊息上限；聊天室刷很快，全部留著會愈來愈慢。 */
const MAX_MESSAGES: number = 300
const RETRY_MS: number = 4000
const MAX_RETRIES: number = 3

type ChatStatus = "loading" | "ready" | "ended" | "unavailable" | "error"

function ChatRow(props: { message: LiveChatMessage }): VirtualNode {
  const message: LiveChatMessage = props.message
  const name: VirtualNode = message.color ? (
    <Text font={type.meta} fontWeight="semibold" lineLimit={1} foregroundStyle={message.color as Color}>
      {message.authorName}
    </Text>
  ) : (
    <Text font={type.meta} fontWeight="semibold" lineLimit={1} foregroundStyle="secondaryLabel">
      {message.authorName}
    </Text>
  )
  return (
    <VStack
      alignment="leading"
      spacing={1}
      padding={{ horizontal: space.page, vertical: 3 }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
    >
      {name}
      <Text
        font={type.meta + 1}
        lineSpacing={2}
        foregroundStyle={message.kind === "text" ? "label" : palette.brand}
        multilineTextAlignment="leading"
        frame={{ maxWidth: "infinity", alignment: "leading" }}
      >
        {message.text}
      </Text>
    </VStack>
  )
}

export interface LiveChatProps {
  videoId: string
}

/** 直播聊天室：自己輪詢、自己留訊息，不進全域 store。 */
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
      // 只留最新的幾則；游標照樣往前推進，聊天室不會因此中斷。
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
        if (!cursorRef.current) {
          const start: LiveChatCursor | null = await fetchLiveChatStart(props.videoId)
          if (disposedRef.current) return
          if (!start) {
            setStatus("unavailable")
            return
          }
          cursorRef.current = start
        }
        const batch = await fetchLiveChatBatch(props.videoId, cursorRef.current)
        if (disposedRef.current) return
        push(batch.messages)
        failures = 0
        if (!batch.cursor) {
          setStatus("ended")
          return
        }
        cursorRef.current = batch.cursor
        setStatus("ready")
        schedule(batch.cursor.pollMs)
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
