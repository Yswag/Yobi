import {
  HStack,
  Rectangle,
  ScrollView,
  Text,
  VStack,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { UnifiedVideoItem, VideoCollaborator, VideoDetail } from "../../types/index"
import { Avatar } from "../../ui/primitives"
import { palette, providerColor, radius, space, type } from "../../ui/theme"
import { formatCount, providerFullName } from "../../utils/format"
import { ActionChip, LiveViewerLabel } from "./WatchSections"

export interface WatchInfoHeaderProps {
  item: UnifiedVideoItem
  detail: VideoDetail | null
  showDescription: boolean
  subscribed: boolean
  deliveryTag: string | null
  onToggleDescription: () => void
  onOpenChannel: () => void
  onToggleSubscription: () => void
}

export function WatchInfoHeader(props: WatchInfoHeaderProps): VirtualNode {
  const item: UnifiedVideoItem = props.item
  const detail: VideoDetail | null = props.detail
  const channelRawId: string = detail?.authorId || item.authorId
  const channelName: string = detail?.authorName || item.authorName
  const channelAvatar: string | undefined = detail?.authorAvatar || item.authorAvatar
  const collaborators: VideoCollaborator[] = detail?.collaborators ?? []
  const isCollab: boolean = collaborators.length > 1
  const tags: string[] = detail?.tags ?? []

  const headlineParts: string[] = []
  if (!item.isLive && item.viewCount !== undefined) headlineParts.push(`${formatCount(item.viewCount)} 次觀看`)
  if (item.publishedText) headlineParts.push(item.publishedText)

  const statParts: string[] = []
  if (item.likeCount !== undefined) statParts.push(`${formatCount(item.likeCount)} 個讚`)
  if (item.provider === "bili" && item.danmakuCount !== undefined) statParts.push(`${formatCount(item.danmakuCount)} 則彈幕`)
  if (item.membersOnly) statParts.push("會員專屬")
  if (props.deliveryTag) statParts.push(props.deliveryTag)

  return (
    <VStack alignment="leading" spacing={12} padding={{ horizontal: space.page, top: 14 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text
          font={type.title - 3}
          fontWeight="bold"
          foregroundStyle="label"
          lineLimit={props.showDescription ? undefined : 2}
          multilineTextAlignment="leading"
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          {item.title}
        </Text>
        <HStack spacing={6}>
          {item.isLive ? (
            <Text
              font={type.micro}
              fontWeight="heavy"
              foregroundStyle={palette.onMedia}
              padding={{ horizontal: 6, vertical: 2 }}
              background={{ style: palette.danger, shape: { type: "rect", cornerRadius: 4 } }}
            >
              LIVE
            </Text>
          ) : null}
          {item.isLive ? (
            <LiveViewerLabel videoId={item.id} publishedText={item.publishedText} />
          ) : (
            <Text font={type.meta + 1} foregroundStyle="secondaryLabel" lineLimit={1}>
              {headlineParts.join(" · ")}
            </Text>
          )}
        </HStack>
      </VStack>

      <VStack
        alignment="leading"
        spacing={8}
        padding={12}
        frame={{ maxWidth: "infinity", alignment: "leading" }}
        background={{ style: "secondarySystemFill", shape: { type: "rect", cornerRadius: radius.md, style: "continuous" } }}
        contentShape="rect"
        onTapGesture={props.onToggleDescription}
      >
        <HStack spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Rectangle
            fill={providerColor(item.provider)}
            frame={{ width: 7, height: 7 }}
            clipShape={{ type: "rect", cornerRadius: 3.5 }}
          />
          <Text font={type.meta + 1} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>
            {[providerFullName(item.provider), ...statParts].join(" · ")}
          </Text>
        </HStack>
        <Text
          font={type.body}
          foregroundStyle="secondaryLabel"
          lineSpacing={3}
          lineLimit={props.showDescription ? undefined : 2}
          multilineTextAlignment="leading"
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          {detail?.description || "沒有簡介"}
        </Text>
        {props.showDescription && tags.length > 0 ? (
          <Text font={type.meta} foregroundStyle={palette.brand} lineLimit={3}>
            {tags.map((tag: string) => `#${tag}`).join("  ")}
          </Text>
        ) : null}
        {props.showDescription ? (
          <Text font={type.caption} monospaced foregroundStyle="tertiaryLabel">{item.rawId}</Text>
        ) : (
          <Text font={type.meta} fontWeight="semibold" foregroundStyle="label">更多</Text>
        )}
      </VStack>

      <HStack spacing={12} frame={{ maxWidth: "infinity" }}>
        <HStack spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect" onTapGesture={props.onOpenChannel}>
          {isCollab ? (
            <HStack spacing={-14}>
              {collaborators.slice(0, 2).map((channel: VideoCollaborator) => (
                <VStack
                  key={`collab-${channel.id}`}
                  padding={2}
                  background={{ style: "systemBackground", shape: "circle" }}
                >
                  <Avatar url={channel.avatarUrl} name={channel.name} size={34} provider={item.provider} />
                </VStack>
              ))}
            </HStack>
          ) : (
            <Avatar url={channelAvatar} name={channelName} size={40} provider={item.provider} />
          )}
          <VStack alignment="leading" spacing={2}>
            <Text font={type.cardTitle} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>{channelName}</Text>
            {detail?.subscriberCountText ? (
              <Text font={type.meta} foregroundStyle="secondaryLabel" lineLimit={1}>{detail.subscriberCountText}</Text>
            ) : null}
          </VStack>
        </HStack>
        <Text
          font={type.body}
          fontWeight="semibold"
          foregroundStyle={props.subscribed ? "label" : palette.onMedia}
          padding={{ horizontal: 16, vertical: 8 }}
          background={{ style: props.subscribed ? "tertiarySystemFill" : palette.brand, shape: "capsule" }}
          contentShape="capsule"
          animation={{ animation: Animation.smooth({ duration: 0.25 }), value: props.subscribed }}
          onTapGesture={props.onToggleSubscription}
        >
          {props.subscribed ? "已訂閱" : "訂閱"}
        </Text>
      </HStack>
    </VStack>
  )
}

export interface WatchActionBarProps {
  item: UnifiedVideoItem
  watchLaterOn: boolean
  qualityLabel: string
  danmakuEnabled: boolean
  onWatchLater: () => void
  onAddToPlaylist: () => void
  onOpenQualitySheet: () => void
  onOpenDanmakuSheet: () => void
  onShare: () => void
}

export function WatchActionBar(props: WatchActionBarProps): VirtualNode {
  return (
    <ScrollView axes="horizontal" scrollIndicator="hidden">
      <HStack spacing={8} padding={{ horizontal: space.page }}>
        <ActionChip
          icon={props.watchLaterOn ? "bookmark.fill" : "bookmark"}
          label="稍後觀看"
          active={props.watchLaterOn}
          onTap={props.onWatchLater}
        />
        <ActionChip icon="text.badge.plus" label="加入清單" onTap={props.onAddToPlaylist} />
        <ActionChip icon="slider.horizontal.3" label={props.qualityLabel} onTap={props.onOpenQualitySheet} />
        {props.item.provider === "bili" ? (
          <ActionChip
            icon={props.danmakuEnabled ? "text.bubble.fill" : "text.bubble"}
            label="彈幕"
            active={props.danmakuEnabled}
            onTap={props.onOpenDanmakuSheet}
          />
        ) : null}
        <ActionChip icon="square.and.arrow.up" label="分享" onTap={props.onShare} />
      </HStack>
    </ScrollView>
  )
}
