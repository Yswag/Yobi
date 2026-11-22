import {
  HStack,
  Image,
  Rectangle,
  Spacer,
  Text,
  VStack,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { LayoutMode, Provider } from "../../types/index"
import { providerFullName } from "../../utils/format"
import type { ChipOption } from "../../ui/primitives"
import {
  Avatar,
  ChipBar,
  LayoutToggle,
  PillButton,
  SearchField,
  Skeleton,
} from "../../ui/primitives"
import { providerColor, space, type } from "../../ui/theme"

export type ChannelSortMode = "latest" | "popular" | "oldest"

export const SORT_OPTIONS_YT: ChipOption<ChannelSortMode>[] = [
  { key: "latest", label: "最新" },
  { key: "popular", label: "熱門" },
  { key: "oldest", label: "最早" },
]

export const SORT_OPTIONS_BILI: ChipOption<ChannelSortMode>[] = [
  { key: "latest", label: "最新" },
  { key: "popular", label: "熱門" },
]

const BANNER_HEIGHT: number = 132
const AVATAR_SIZE: number = 76

export function ChannelBanner(props: { bannerUrl?: string }): VirtualNode {
  if (!props.bannerUrl) {
    return <Rectangle fill="rgba(0,0,0,0)" frame={{ maxWidth: "infinity", height: 52 }} />
  }
  return (
    <Rectangle
      fill="secondarySystemFill"
      frame={{ maxWidth: "infinity", height: BANNER_HEIGHT }}
      overlay={
        <Image
          imageUrl={props.bannerUrl}
          resizable
          scaleToFill
          frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        />
      }
      clipped
    />
  )
}

export interface ChannelHeroProps {
  provider: Provider
  name: string
  avatarUrl: string
  subscriberCountText?: string
  videoCountText?: string
  description?: string
  descriptionExpanded: boolean
  onToggleDescription: () => void
  showDescriptionSkeleton: boolean
  subscribed: boolean
  onToggleSubscription: () => void
  canPlayAll: boolean
  onPlayAll: () => void
}

export function ChannelHero(props: ChannelHeroProps): VirtualNode {
  const metaParts: string[] = [providerFullName(props.provider)]
  if (props.subscriberCountText) metaParts.push(props.subscriberCountText)
  if (props.videoCountText) metaParts.push(`${props.videoCountText} 部影片`)

  return (
    <VStack alignment="leading" spacing={14} padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <HStack spacing={14} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Avatar url={props.avatarUrl || undefined} name={props.name} size={AVATAR_SIZE} provider={props.provider} />
        <VStack alignment="leading" spacing={5} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={type.title + 2} fontWeight="heavy" foregroundStyle="label" lineLimit={2}>
            {props.name}
          </Text>
          <HStack spacing={6}>
            <Rectangle
              fill={providerColor(props.provider)}
              frame={{ width: 7, height: 7 }}
              clipShape={{ type: "rect", cornerRadius: 3.5 }}
            />
            <Text font={type.meta + 1} foregroundStyle="secondaryLabel" lineLimit={1}>
              {metaParts.join(" · ")}
            </Text>
          </HStack>
        </VStack>
      </HStack>

      {props.description ? (
        <Text
          font={type.body}
          foregroundStyle="secondaryLabel"
          lineLimit={props.descriptionExpanded ? undefined : 2}
          multilineTextAlignment="leading"
          frame={{ maxWidth: "infinity", alignment: "leading" }}
          onTapGesture={props.onToggleDescription}
        >
          {props.description}
        </Text>
      ) : props.showDescriptionSkeleton ? (
        <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Skeleton height={12} />
          <Skeleton width={180} height={12} />
        </VStack>
      ) : null}

      <HStack spacing={10} frame={{ maxWidth: "infinity" }}>
        <PillButton
          label={props.subscribed ? "已訂閱" : "訂閱"}
          icon={props.subscribed ? "checkmark" : "plus"}
          prominent={!props.subscribed}
          onTap={props.onToggleSubscription}
        />
        {props.canPlayAll ? (
          <PillButton label="全部播放" icon="play.fill" prominent={false} onTap={props.onPlayAll} />
        ) : null}
      </HStack>
    </VStack>
  )
}

export interface ChannelToolbarProps {
  provider: Provider
  query: string
  onQueryChange: (value: string) => void
  onSearch: () => void
  searching: boolean
  sortMode: ChannelSortMode
  onSortChange: (mode: ChannelSortMode) => void
  layoutMode: LayoutMode
  onLayoutChange: (mode: LayoutMode) => void
}

export function ChannelToolbar(props: ChannelToolbarProps): VirtualNode {
  return (
    <VStack spacing={12} frame={{ maxWidth: "infinity" }}>
      <VStack padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity" }}>
        <SearchField
          value={props.query}
          prompt="在頻道中搜尋"
          onChange={props.onQueryChange}
          onCommit={props.onSearch}
        />
      </VStack>
      {props.searching ? (
        <HStack padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity" }}>
          <Spacer />
          <LayoutToggle layout={props.layoutMode} onChange={props.onLayoutChange} />
        </HStack>
      ) : (
        <ChipBar
          options={props.provider === "yt" ? SORT_OPTIONS_YT : SORT_OPTIONS_BILI}
          value={props.sortMode}
          onChange={props.onSortChange}
          trailing={<LayoutToggle layout={props.layoutMode} onChange={props.onLayoutChange} />}
        />
      )}
    </VStack>
  )
}
