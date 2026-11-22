import {
  HStack,
  Image,
  Text,
  VStack,
  ZStack,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { SubscriptionChannel, UnifiedVideoItem } from "../../types/index"
import { providerFullName } from "../../utils/format"
import { Avatar } from "../../ui/primitives"
import { palette, providerColor, space, type } from "../../ui/theme"

export const STRIP_AVATAR_SIZE: number = 56
export const STRIP_RING: number = 3

export function buildTimeline(groups: UnifiedVideoItem[][]): UnifiedVideoItem[] {
  const merged: UnifiedVideoItem[] = []
  const seen: Set<string> = new Set()
  const longest: number = groups.reduce(
    (max: number, group: UnifiedVideoItem[]): number => Math.max(max, group.length),
    0,
  )
  for (let index = 0; index < longest; index++) {
    for (const group of groups) {
      const item: UnifiedVideoItem | undefined = group[index]
      if (!item || seen.has(item.id)) continue
      seen.add(item.id)
      merged.push(item)
    }
  }

  const allStamped: boolean = merged.every(
    (item: UnifiedVideoItem): boolean => typeof item.publishedAt === "number",
  )
  if (!allStamped) return merged

  return merged.sort(
    (a: UnifiedVideoItem, b: UnifiedVideoItem): number => (b.publishedAt as number) - (a.publishedAt as number),
  )
}

export interface ChannelStripItemProps {
  channel: SubscriptionChannel | null
  selected: boolean
  dimmed: boolean
  onTap: () => void
}

export function ChannelStripItem(props: ChannelStripItemProps): VirtualNode {
  const channel: SubscriptionChannel | null = props.channel
  const outer: number = STRIP_AVATAR_SIZE + STRIP_RING * 2 + 4

  return (
    <VStack
      spacing={6}
      frame={{ width: outer + 6 }}
      opacity={props.dimmed ? 0.45 : 1}
      contentShape="rect"
      animation={{ animation: Animation.smooth({ duration: 0.25 }), value: props.selected }}
      onTapGesture={props.onTap}
    >
      <ZStack
        frame={{ width: outer, height: outer }}
        background={{
          style: props.selected ? palette.brand : "rgba(0,0,0,0)",
          shape: { type: "rect", cornerRadius: outer / 2 },
        }}
      >
        <ZStack
          frame={{ width: STRIP_AVATAR_SIZE + 4, height: STRIP_AVATAR_SIZE + 4 }}
          background={{ style: "systemBackground", shape: { type: "rect", cornerRadius: (STRIP_AVATAR_SIZE + 4) / 2 } }}
        >
          {channel ? (
            <Avatar
              url={channel.avatarUrl || undefined}
              name={channel.name}
              size={STRIP_AVATAR_SIZE}
              provider={channel.provider}
            />
          ) : (
            <VStack
              frame={{ width: STRIP_AVATAR_SIZE, height: STRIP_AVATAR_SIZE }}
              background={{ style: "tertiarySystemFill", shape: { type: "rect", cornerRadius: STRIP_AVATAR_SIZE / 2 } }}
            >
              <Image systemName="square.stack.fill" font={20} foregroundStyle="label" />
            </VStack>
          )}
        </ZStack>
      </ZStack>
      <Text
        font={type.caption}
        fontWeight={props.selected ? "semibold" : "regular"}
        foregroundStyle={props.selected ? "label" : "secondaryLabel"}
        lineLimit={1}
      >
        {channel ? channel.name : "全部"}
      </Text>
    </VStack>
  )
}

export interface ManageRowProps {
  channel: SubscriptionChannel
  onOpen: () => void
  onUnsubscribe: () => void
}

export function ManageRow(props: ManageRowProps): VirtualNode {
  const channel: SubscriptionChannel = props.channel
  return (
    <HStack spacing={12} padding={{ horizontal: space.page, vertical: 10 }} frame={{ maxWidth: "infinity" }}>
      <HStack spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect" onTapGesture={props.onOpen}>
        <Avatar url={channel.avatarUrl || undefined} name={channel.name} size={44} provider={channel.provider} />
        <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={type.cardTitle} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>{channel.name}</Text>
          <HStack spacing={5}>
            <VStack
              frame={{ width: 6, height: 6 }}
              background={{ style: providerColor(channel.provider), shape: { type: "rect", cornerRadius: 3 } }}
            />
            <Text font={type.meta} foregroundStyle="secondaryLabel">{providerFullName(channel.provider)}</Text>
          </HStack>
        </VStack>
      </HStack>
      <Text
        font={type.meta + 1}
        fontWeight="semibold"
        foregroundStyle={palette.danger}
        padding={{ horizontal: 12, vertical: 7 }}
        background={{ style: palette.dangerSoft, shape: "capsule" }}
        onTapGesture={props.onUnsubscribe}
      >
        取消訂閱
      </Text>
    </HStack>
  )
}
