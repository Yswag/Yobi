import {
  Button,
  HStack,
  Image,
  Menu,
  Picker,
  Spacer,
  Text,
  VStack,
} from "scripting"
import type { Color, VirtualNode } from "scripting"
import type { Provider, ProviderAuthState } from "../../types/index"
import type { SettingOption } from "../../utils/playbackOptions"
import { nearestOption } from "../../utils/playbackOptions"
import { providerBadgeLabel, providerFullName } from "../../utils/format"
import { palette, providerColor } from "../../ui/theme"

export function LinkRow(props: {
  icon: string
  color: Color
  title: string
  summary: string
  onTap?: () => void
}): VirtualNode {
  return (
    <Button buttonStyle="plain" action={() => props.onTap?.()}>
      <HStack spacing={12} frame={{ maxWidth: "infinity" }} contentShape="rect">
        <VStack
          frame={{ width: 32, height: 32 }}
          background={{ style: props.color, shape: { type: "rect", cornerRadius: 8 } }}
        >
          <Image systemName={props.icon} font={15} foregroundStyle="white" />
        </VStack>
        <VStack alignment="leading" spacing={2}>
          <Text font={16} foregroundStyle="label">{props.title}</Text>
          <Text font={12} foregroundStyle="secondaryLabel">{props.summary}</Text>
        </VStack>
        <Spacer />
        <Image systemName="chevron.right" font={13} fontWeight="semibold" foregroundStyle="tertiaryLabel" />
      </HStack>
    </Button>
  )
}

export function OptionPicker<T extends string>(props: {
  title: string
  options: SettingOption<T>[]
  value: T
  onChange: (value: T) => void
}): VirtualNode {
  return (
    <Picker
      title={props.title}
      value={props.value}
      onChanged={(value: string) => props.onChange(value as T)}
      pickerStyle="menu"
    >
      {props.options.map((option: SettingOption<T>) => (
        <Text key={`${props.title}-${option.value}`} tag={option.value}>{option.label}</Text>
      ))}
    </Picker>
  )
}

export function NumberPicker(props: {
  title: string
  options: SettingOption<number>[]
  value: number
  onChange: (value: number) => void
}): VirtualNode {
  return (
    <Picker
      title={props.title}
      value={nearestOption(props.options, props.value)}
      onChanged={props.onChange}
      pickerStyle="menu"
    >
      {props.options.map((option: SettingOption<number>) => (
        <Text key={`${props.title}-${option.value}`} tag={option.value}>{option.label}</Text>
      ))}
    </Picker>
  )
}

export function AccountRow(props: {
  provider: Provider
  state: ProviderAuthState
  onWebLogin: () => void
  onPasteCookies: () => void
  onLogout: () => void
}): VirtualNode {
  const cookieCount: number = Object.keys(props.state.cookies).length
  const statusText: string = props.state.loggedIn
    ? props.state.username ? props.state.username : "已登入"
    : cookieCount > 0 ? `已儲存 ${cookieCount} 個 Cookie` : "未登入"

  return (
    <Menu
      label={
        <HStack spacing={12} frame={{ maxWidth: "infinity" }} contentShape="rect">
          <VStack
            frame={{ width: 36, height: 36 }}
            background={{ style: providerColor(props.provider), shape: { type: "rect", cornerRadius: 18 } }}
          >
            <Text font={11} fontWeight="heavy" foregroundStyle={palette.onMedia}>
              {providerBadgeLabel(props.provider)}
            </Text>
          </VStack>
          <VStack alignment="leading" spacing={2}>
            <Text font={16} foregroundStyle="label">{providerFullName(props.provider)}</Text>
            <Text font={13} foregroundStyle={props.state.loggedIn ? palette.success : "secondaryLabel"}>
              {statusText}
            </Text>
          </VStack>
          <Spacer />
          <Image systemName="chevron.up.chevron.down" font={13} fontWeight="semibold" foregroundStyle="tertiaryLabel" />
        </HStack>
      }
    >
      <Button title="網頁登入" systemImage="globe" action={props.onWebLogin} />
      <Button title="貼上 Cookie" systemImage="doc.on.clipboard" action={props.onPasteCookies} />
      {cookieCount > 0 ? (
        <Button title="清除 Cookie" systemImage="trash" role="destructive" action={props.onLogout} />
      ) : null}
    </Menu>
  )
}
