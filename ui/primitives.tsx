import {
  Button,
  HStack,
  Image,
  Rectangle,
  Spacer,
  Text,
  TextField,
  VStack,
  ZStack,
  useEffect,
  useState,
} from "scripting"
import type { Color, VirtualNode } from "scripting"
import type { Provider } from "../types"
import { formatDuration, providerBadgeLabel } from "../utils/format"
import { palette, providerColor, radius, space, thumbHeight, type } from "./theme"

export function GlassIconButton(props: {
  icon: string
  size?: number
  tint?: Color
  onTap: () => void
}): VirtualNode {
  const size: number = props.size ?? 38
  return (
    <VStack
      frame={{ width: size, height: size }}
      contentShape={{ type: "rect", cornerRadius: size / 2 }}
      glassEffect={{
        glass: UIGlass.regular().interactive(),
        shape: { type: "rect", cornerRadius: size / 2 },
      }}
      onTapGesture={props.onTap}
    >
      <Image
        systemName={props.icon}
        font={Math.round(size * 0.42)}
        fontWeight="semibold"
        foregroundStyle={props.tint ?? "label"}
      />
    </VStack>
  )
}

export function Chip(props: {
  label: string
  active: boolean
  dot?: Color
  onTap: () => void
}): VirtualNode {
  return (
    <HStack
      spacing={6}
      padding={{ horizontal: 14, vertical: 8 }}
      background={{
        style: props.active ? "label" : "tertiarySystemFill",
        shape: "capsule",
      }}
      contentShape="capsule"
      animation={{ animation: Animation.smooth({ duration: 0.25 }), value: props.active }}
      onTapGesture={props.onTap}
    >
      {props.dot ? (
        <Rectangle
          fill={props.dot}
          frame={{ width: 7, height: 7 }}
          clipShape={{ type: "rect", cornerRadius: 3.5 }}
        />
      ) : null}
      <Text
        font={type.meta + 1}
        fontWeight="semibold"
        foregroundStyle={props.active ? "systemBackground" : "label"}
        lineLimit={1}
      >
        {props.label}
      </Text>
    </HStack>
  )
}

export interface ChipOption<T extends string> {
  key: T
  label: string
  dot?: Color
}

export const PROVIDER_FILTERS: ChipOption<"all" | Provider>[] = [
  { key: "all", label: "全部" },
  { key: "yt", label: "YouTube", dot: palette.yt },
  { key: "bili", label: "BiliBili", dot: palette.bili },
]

export function ChipBar<T extends string>(props: {
  options: ChipOption<T>[]
  value: T
  onChange: (value: T) => void
  trailing?: VirtualNode
}): VirtualNode {
  return (
    <HStack spacing={8} padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      {props.options.map(option => (
        <Chip
          key={`chip-${option.key}`}
          label={option.label}
          dot={option.dot}
          active={props.value === option.key}
          onTap={() => props.onChange(option.key)}
        />
      ))}
      <Spacer />
      {props.trailing ?? null}
    </HStack>
  )
}

export function PillButton(props: {
  label: string
  icon: string
  prominent?: boolean
  destructive?: boolean
  onTap: () => void
}): VirtualNode {
  const fill: Color = props.prominent ? palette.brand : props.destructive ? palette.dangerSoft : "tertiarySystemFill"
  const ink: Color = props.prominent ? palette.onMedia : props.destructive ? palette.danger : "label"
  return (
    <HStack
      spacing={6}
      padding={{ vertical: 11, horizontal: 16 }}
      frame={{ maxWidth: "infinity" }}
      background={{ style: fill, shape: "capsule" }}
      contentShape="capsule"
      animation={{ animation: Animation.smooth({ duration: 0.25 }), value: Boolean(props.prominent) }}
      onTapGesture={props.onTap}
    >
      <Image systemName={props.icon} font={14} fontWeight="bold" foregroundStyle={ink} contentTransition="symbolEffectReplace" />
      <Text font={type.body + 1} fontWeight="semibold" foregroundStyle={ink} lineLimit={1}>
        {props.label}
      </Text>
    </HStack>
  )
}

export function SearchField(props: {
  value: string
  prompt: string
  onChange: (value: string) => void
  onCommit?: () => void
}): VirtualNode {
  const onCommit: (() => void) | undefined = props.onCommit
  return (
    <HStack
      spacing={8}
      padding={{ horizontal: 12, vertical: 10 }}
      frame={{ maxWidth: "infinity" }}
      background={{ style: "tertiarySystemFill", shape: { type: "rect", cornerRadius: radius.sm + 2, style: "continuous" } }}
    >
      <Image systemName="magnifyingglass" font={14} foregroundStyle="secondaryLabel" />
      <TextField
        title={props.prompt}
        value={props.value}
        onChanged={props.onChange}
        prompt={props.prompt}
        font={15}
        frame={{ maxWidth: "infinity" }}
        submitLabel={onCommit ? "search" : undefined}
        onSubmit={onCommit}
      />
      {props.value.length > 0 ? (
        <HStack spacing={0} contentShape="rect" onTapGesture={() => props.onChange("")}>
          <Image systemName="xmark.circle.fill" font={15} foregroundStyle="tertiaryLabel" />
        </HStack>
      ) : null}
    </HStack>
  )
}

export function PlainIconButton(props: { icon: string; onTap: () => void; tint?: Color }): VirtualNode {
  return (
    <HStack spacing={0} frame={{ width: 34, height: 34 }} contentShape="rect" onTapGesture={props.onTap}>
      <Image
        systemName={props.icon}
        font={16}
        fontWeight="semibold"
        foregroundStyle={props.tint ?? "secondaryLabel"}
        contentTransition="symbolEffectReplace"
      />
    </HStack>
  )
}

export function LayoutToggle(props: { layout: "grid" | "row"; onChange: (layout: "grid" | "row") => void }): VirtualNode {
  return (
    <PlainIconButton
      icon={props.layout === "grid" ? "list.bullet" : "rectangle.grid.1x2"}
      onTap={() => props.onChange(props.layout === "grid" ? "row" : "grid")}
    />
  )
}

export function ProviderTag(props: { provider: Provider }): VirtualNode {
  return (
    <HStack
      spacing={4}
      padding={{ horizontal: 6, vertical: 3 }}
      background={{ style: palette.scrim, shape: "capsule" }}
    >
      <Rectangle
        fill={providerColor(props.provider)}
        frame={{ width: 6, height: 6 }}
        clipShape={{ type: "rect", cornerRadius: 3 }}
      />
      <Text font={9} fontWeight="heavy" foregroundStyle={palette.onMedia}>
        {providerBadgeLabel(props.provider)}
      </Text>
    </HStack>
  )
}

export function MediaTag(props: { text: string; live?: boolean }): VirtualNode {
  return (
    <Text
      font={type.caption}
      fontWeight="semibold"
      monospacedDigit
      foregroundStyle={palette.onMedia}
      padding={{ horizontal: 6, vertical: 3 }}
      background={{
        style: props.live ? palette.danger : palette.scrim,
        shape: { type: "rect", cornerRadius: radius.xs, style: "continuous" },
      }}
    >
      {props.text}
    </Text>
  )
}

export function ProgressTrack(props: {
  ratio: number
  color: Color
  height?: number
  onMedia?: boolean
}): VirtualNode {
  const height: number = props.height ?? 3
  const ratio: number = Math.max(0, Math.min(1, props.ratio))
  return (
    <ZStack
      alignment="leading"
      frame={{ maxWidth: "infinity", height }}
      background={{
        style: props.onMedia === false ? palette.trackOnSurface : palette.track,
        shape: "capsule",
      }}
      clipShape="capsule"
    >
      <Rectangle
        fill={props.color}
        frame={{ maxWidth: "infinity", height }}
        scaleEffect={{ x: ratio, y: 1, anchor: "leading" }}
      />
    </ZStack>
  )
}

import { thumbnailUrl, avatarUrl } from "../utils/image"

export function Thumbnail(props: {
  url?: string
  width?: number
  cornerRadius?: number
  provider?: Provider
  duration?: number
  durationText?: string
  isLive?: boolean
  membersOnly?: boolean
  progress?: number
  onTap?: () => void
}): VirtualNode {
  const corner: number = props.cornerRadius ?? radius.md
  const progress: number = props.progress ?? 0
  const tagText: string | null = props.isLive
    ? "LIVE"
    : props.durationText ?? (props.duration && props.duration > 0 ? formatDuration(props.duration) : null)
  const compact: boolean = props.width !== undefined && props.width < 200
  const inset: number = compact ? 6 : 10
  const image: string | undefined = thumbnailUrl(props.url, props.width ?? 480)

  return (
    <Rectangle
      fill="secondarySystemFill"
      frame={props.width !== undefined
        ? { width: props.width, height: thumbHeight(props.width) }
        : { maxWidth: "infinity" }}
      aspectRatio={{ value: 16 / 9, contentMode: "fit" }}
      overlay={
        <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
          <VStack
            spacing={0}
            frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
            padding={inset}
            allowsHitTesting={false}
            background={image ? (
              <Image
                imageUrl={image}
                resizable
                scaleToFill
                frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
              />
            ) : (
              <Image
                systemName="play.rectangle.fill"
                font={compact ? 22 : 34}
                foregroundStyle="tertiaryLabel"
              />
            )}
          >
            <HStack spacing={4} frame={{ maxWidth: "infinity" }}>
              {props.provider ? <ProviderTag provider={props.provider} /> : null}
              {props.membersOnly ? (
                <HStack
                  spacing={3}
                  padding={{ horizontal: 6, vertical: 3 }}
                  background={{ style: palette.scrim, shape: "capsule" }}
                >
                  <Image systemName="star.fill" font={8} foregroundStyle={palette.member} />
                  <Text font={9} fontWeight="heavy" foregroundStyle={palette.onMedia}>會員</Text>
                </HStack>
              ) : null}
              <Spacer />
            </HStack>
            <Spacer />
            <HStack spacing={0} frame={{ maxWidth: "infinity" }}>
              <Spacer />
              {tagText ? <MediaTag text={tagText} live={props.isLive} /> : null}
            </HStack>
            {progress > 0 ? (
              <ProgressTrack ratio={progress} color={palette.brand} padding={{ top: 6 }} />
            ) : null}
          </VStack>
        </ZStack>
      }
      clipShape={{ type: "rect", cornerRadius: corner, style: "continuous" }}
      contentShape={{ type: "rect", cornerRadius: corner }}
      onTapGesture={props.onTap}
    />
  )
}

export function Avatar(props: {
  url?: string
  name: string
  size: number
  provider?: Provider
  onTap?: () => void
}): VirtualNode {
  const shape = { type: "rect" as const, cornerRadius: props.size / 2 }
  const image: string | undefined = avatarUrl(props.url, props.size)
  if (image) {
    return (
      <Image
        imageUrl={image}
        resizable
        scaleToFill
        frame={{ width: props.size, height: props.size }}
        clipShape={shape}
        onTapGesture={props.onTap}
      />
    )
  }
  const initial: string = (props.name.trim().charAt(0) || "?").toUpperCase()
  return (
    <VStack
      frame={{ width: props.size, height: props.size }}
      background={{
        style: props.provider ? providerColor(props.provider) : "tertiarySystemFill",
        shape,
      }}
      onTapGesture={props.onTap}
    >
      <Text
        font={Math.round(props.size * 0.42)}
        fontWeight="bold"
        fontDesign="rounded"
        foregroundStyle={props.provider ? palette.onMedia : "label"}
      >
        {initial}
      </Text>
    </VStack>
  )
}

export function PageHeader(props: { title: string; trailing?: VirtualNode }): VirtualNode {
  return (
    <HStack
      spacing={10}
      padding={{ horizontal: space.page, top: 8, bottom: 12 }}
      frame={{ maxWidth: "infinity" }}
    >
      <Text font={type.largeTitle} fontWeight="heavy" foregroundStyle="label" lineLimit={1}>
        {props.title}
      </Text>
      <Spacer />
      {props.trailing ?? null}
    </HStack>
  )
}

export function SectionHeader(props: {
  title: string
  detail?: string
  onDetail?: () => void
  action?: { label: string; onTap: () => void }
}): VirtualNode {
  return (
    <HStack spacing={8} padding={{ horizontal: space.page }} frame={{ maxWidth: "infinity" }}>
      <Text font={type.section} fontWeight="bold" foregroundStyle="label">
        {props.title}
      </Text>
      <Spacer />
      {props.action ? (
        <Text
          font={type.meta + 2}
          fontWeight="semibold"
          foregroundStyle={palette.brand}
          contentShape="rect"
          onTapGesture={props.action.onTap}
        >
          {props.action.label}
        </Text>
      ) : props.detail ? (
        <HStack spacing={3} onTapGesture={props.onDetail}>
          <Text font={type.meta + 1} fontWeight="medium" foregroundStyle="secondaryLabel">
            {props.detail}
          </Text>
          {props.onDetail ? (
            <Image systemName="chevron.right" font={11} fontWeight="semibold" foregroundStyle="tertiaryLabel" />
          ) : null}
        </HStack>
      ) : null}
    </HStack>
  )
}

export function EmptyState(props: {
  icon: string
  title: string
  message?: string
  actionLabel?: string
  onAction?: () => void
}): VirtualNode {
  return (
    <VStack spacing={14} padding={{ horizontal: 40, vertical: 56 }} frame={{ maxWidth: "infinity" }}>
      <VStack
        frame={{ width: 64, height: 64 }}
        background={{ style: "tertiarySystemFill", shape: { type: "rect", cornerRadius: 32 } }}
      >
        <Image systemName={props.icon} font={26} fontWeight="medium" foregroundStyle="secondaryLabel" />
      </VStack>
      <VStack spacing={6}>
        <Text font={17} fontWeight="semibold" foregroundStyle="label" multilineTextAlignment="center">
          {props.title}
        </Text>
        {props.message ? (
          <Text font={type.body} foregroundStyle="secondaryLabel" multilineTextAlignment="center">
            {props.message}
          </Text>
        ) : null}
      </VStack>
      {props.actionLabel && props.onAction ? (
        <Button
          title={props.actionLabel}
          action={props.onAction}
          buttonStyle="glassProminent"
          tint={palette.brand}
        />
      ) : null}
    </VStack>
  )
}

export function Skeleton(props: {
  width?: number
  height: number
  cornerRadius?: number
}): VirtualNode {
  const [dim, setDim] = useState<boolean>(false)
  useEffect(() => {
    setDim(true)
  }, [])
  return (
    <Rectangle
      fill="tertiarySystemFill"
      frame={props.width ? { width: props.width, height: props.height } : { maxWidth: "infinity", height: props.height }}
      clipShape={{ type: "rect", cornerRadius: props.cornerRadius ?? radius.xs, style: "continuous" }}
      opacity={dim ? 0.45 : 1}
      animation={{ animation: Animation.smooth({ duration: 0.9 }).repeatForever(true), value: dim }}
    />
  )
}
