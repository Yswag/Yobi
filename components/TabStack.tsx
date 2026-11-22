import { Group, NavigationDestination, NavigationStack } from "scripting"
import type { VirtualNode } from "scripting"
import type { OpenChannel, Provider } from "../types/index"

export type { OpenChannel }

export interface ChannelTarget {
  provider: Provider
  channelId: string
  initialName?: string
  initialAvatar?: string
}

export interface TabStackNav {
  push: (route: string) => void
  pop: () => void
}

export const SETTINGS_ROUTE: string = "settings"
export const SPONSORBLOCK_ROUTE: string = "settings/sponsorblock"
export const PLAYBACK_ROUTE: string = "settings/playback"
const CHANNEL_ROUTE_PREFIX: string = "channel:"

export function channelRoute(target: ChannelTarget): string {
  return `${CHANNEL_ROUTE_PREFIX}${JSON.stringify(target)}`
}

export function parseChannelRoute(route: string): ChannelTarget | null {
  if (!route.startsWith(CHANNEL_ROUTE_PREFIX)) return null
  return JSON.parse(route.slice(CHANNEL_ROUTE_PREFIX.length)) as ChannelTarget
}

export function TabStack(props: {
  path: Observable<string[]>
  renderRoute: (route: string, nav: TabStackNav) => VirtualNode
  showsNavigationBar?: boolean
  bottomInset?: number
  children: VirtualNode
}): VirtualNode {
  const nav: TabStackNav = {
    pop: (): void => {
      props.path.setValue(props.path.value.slice(0, -1))
    },
    push: (route: string): void => {
      if (props.path.value[props.path.value.length - 1] === route) return
      props.path.setValue([...props.path.value, route])
    },
  }

  const bottomPadding = { bottom: props.bottomInset ?? 0 }

  return (
    <NavigationStack path={props.path}>
      <Group
        toolbarVisibility={props.showsNavigationBar ? "automatic" : "hidden"}
        safeAreaPadding={bottomPadding}
        navigationDestination={
          <NavigationDestination>
            {(route: string) => (
              <Group toolbarVisibility="automatic" safeAreaPadding={bottomPadding}>
                {props.renderRoute(route, nav)}
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
