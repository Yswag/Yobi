import { Group, NavigationDestination, NavigationStack } from "scripting"
import type { VirtualNode } from "scripting"
import type { Provider } from "../types"
import { ChannelView } from "../views/ChannelView"
import { PlaybackSettingsView } from "../views/PlaybackSettingsView"
import { SettingsView } from "../views/SettingsView"
import { SponsorBlockSettingsView } from "../views/SponsorBlockSettingsView"

export type OpenChannel = (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void

export interface ChannelTarget {
  provider: Provider
  channelId: string
  initialName?: string
  initialAvatar?: string
}

export const SETTINGS_ROUTE: string = "settings"
export const SPONSORBLOCK_ROUTE: string = "settings/sponsorblock"
export const PLAYBACK_ROUTE: string = "settings/playback"
const CHANNEL_ROUTE_PREFIX: string = "channel:"

export function channelRoute(target: ChannelTarget): string {
  return `${CHANNEL_ROUTE_PREFIX}${JSON.stringify(target)}`
}

export function TabStack(props: {
  path: Observable<string[]>
  onOpenChannel: OpenChannel
  onExitApp: () => void
  showsNavigationBar?: boolean
  /** Extra bottom safe area so scroll content clears the floating mini player. */
  bottomInset?: number
  children: VirtualNode
}): VirtualNode {
  const pop = (): void => {
    props.path.setValue(props.path.value.slice(0, -1))
  }

  const push = (route: string): void => {
    if (props.path.value[props.path.value.length - 1] === route) return
    props.path.setValue([...props.path.value, route])
  }

  const renderRoute = (route: string): VirtualNode => {
    if (route.startsWith(CHANNEL_ROUTE_PREFIX)) {
      const target: ChannelTarget = JSON.parse(route.slice(CHANNEL_ROUTE_PREFIX.length))
      return (
        <ChannelView
          provider={target.provider}
          channelId={target.channelId}
          initialName={target.initialName}
          initialAvatar={target.initialAvatar}
          onClose={pop}
          onOpenChannel={props.onOpenChannel}
        />
      )
    }
    if (route === SPONSORBLOCK_ROUTE) {
      return <SponsorBlockSettingsView />
    }
    if (route === PLAYBACK_ROUTE) {
      return <PlaybackSettingsView />
    }
    return (
      <SettingsView
        onExitApp={props.onExitApp}
        onOpenPlayback={() => push(PLAYBACK_ROUTE)}
        onOpenSponsorBlock={() => push(SPONSORBLOCK_ROUTE)}
      />
    )
  }

  const bottomPadding = { bottom: props.bottomInset ?? 0 }

  return (
    <NavigationStack path={props.path}>
      {/* Each page is hosted separately, so the stack's own safe area never reaches it; pad every page root. */}
      <Group
        toolbarVisibility={props.showsNavigationBar ? "automatic" : "hidden"}
        safeAreaPadding={bottomPadding}
        navigationDestination={
          <NavigationDestination>
            {(route: string) => (
              // 推入頁都用系統導覽列：邊緣返回、標題截斷、捲動材質都靠它，自己畫標頭拿不到這些。
              <Group toolbarVisibility="automatic" safeAreaPadding={bottomPadding}>
                {renderRoute(route)}
              </Group>
            )}
          </NavigationDestination>
        }
      >
        {props.children}
      </Group>
    </NavigationStack>
  )
}
