import {
  Button,
  HStack,
  Image,
  Menu,
  ProgressView,
  Text,
  VStack,
} from "scripting"
import type { VirtualNode } from "scripting"
import type { UnifiedVideoItem } from "../../types/index"
import type { DirectLinkTarget } from "../../actions/index"
import { ProviderTag } from "../../ui/primitives"
import { palette, radius, space, type } from "../../ui/theme"

export type SearchSortBy = "default" | "views" | "recent"

export const SORT_OPTIONS: { label: string; value: SearchSortBy; icon: string }[] = [
  { label: "綜合", value: "default", icon: "sparkles" },
  { label: "觀看數最多", value: "views", icon: "eye" },
  { label: "最新發布", value: "recent", icon: "clock" },
]

export function sortResults(items: UnifiedVideoItem[], sortBy: SearchSortBy): UnifiedVideoItem[] {
  if (sortBy === "default") return items
  const list: UnifiedVideoItem[] = items.slice()
  if (sortBy === "views") {
    list.sort((a: UnifiedVideoItem, b: UnifiedVideoItem): number => (b.viewCount ?? 0) - (a.viewCount ?? 0))
  } else {
    list.sort((a: UnifiedVideoItem, b: UnifiedVideoItem): number => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
  }
  return list
}

export function QueryRow(props: { icon: string; text: string; onTap: () => void }): VirtualNode {
  return (
    <HStack
      spacing={14}
      padding={{ horizontal: space.page, vertical: 12 }}
      frame={{ maxWidth: "infinity" }}
      contentShape="rect"
      onTapGesture={props.onTap}
    >
      <Image systemName={props.icon} font={15} foregroundStyle="tertiaryLabel" frame={{ width: 20 }} />
      <Text font={16} foregroundStyle="label" lineLimit={1} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        {props.text}
      </Text>
      <Image systemName="arrow.up.left" font={13} foregroundStyle="tertiaryLabel" />
    </HStack>
  )
}

export function SortMenu(props: { value: SearchSortBy; onChange: (value: SearchSortBy) => void }): VirtualNode {
  return (
    <Menu
      label={
        <HStack spacing={0} frame={{ width: 34, height: 34 }} contentShape="rect">
          <Image
            systemName="arrow.up.arrow.down"
            font={15}
            fontWeight="semibold"
            foregroundStyle={props.value === "default" ? "secondaryLabel" : palette.brand}
          />
        </HStack>
      }
    >
      {SORT_OPTIONS.map(option => (
        <Button
          key={`sort-${option.value}`}
          title={option.label}
          systemImage={props.value === option.value ? "checkmark" : option.icon}
          action={() => props.onChange(option.value)}
        />
      ))}
    </Menu>
  )
}

export interface DirectLinkCardProps {
  target: DirectLinkTarget
  loading: boolean
  error: string | null
  onPlay: () => void
}

export function DirectLinkCard(props: DirectLinkCardProps): VirtualNode {
  const target: DirectLinkTarget = props.target
  return (
    <HStack
      spacing={12}
      padding={14}
      frame={{ maxWidth: "infinity" }}
      background={{ style: "secondarySystemFill", shape: { type: "rect", cornerRadius: radius.lg, style: "continuous" } }}
    >
      <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <ProviderTag provider={target.provider} />
        <Text font={type.cardTitle} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>
          {target.label}
        </Text>
        <Text font={type.meta} foregroundStyle={props.error ? palette.danger : "secondaryLabel"} lineLimit={1}>
          {props.error ?? "直接解析播放"}
        </Text>
      </VStack>
      {props.loading ? (
        <ProgressView controlSize="small" frame={{ width: 44, height: 44 }} />
      ) : (
        <Button action={props.onPlay} buttonStyle="plain">
          <VStack
            frame={{ width: 44, height: 44 }}
            background={{ style: palette.brand, shape: { type: "rect", cornerRadius: 22 } }}
          >
            <Image systemName="play.fill" font={17} foregroundStyle="white" />
          </VStack>
        </Button>
      )}
    </HStack>
  )
}
