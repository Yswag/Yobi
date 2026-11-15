import { Group, NamespaceReader, NavigationDestination, NavigationStack } from "scripting"
import type { VirtualNode } from "scripting"
import type { Provider } from "../types"
import { ChannelView } from "../views/ChannelView"
import { SettingsView } from "../views/SettingsView"
import { ZoomContext } from "../ui/zoom"

export type OpenChannel = (provider: Provider, authorId: string, authorName: string, avatarUrl?: string) => void

export interface ChannelTarget {
  provider: Provider
  channelId: string
  initialName?: string
  initialAvatar?: string
}

export const SETTINGS_ROUTE: string = "settings"
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
    return <SettingsView onExitApp={props.onExitApp} />
  }

  const bottomPadding = { bottom: props.bottomInset ?? 0 }

  return (
    <NavigationStack path={props.path}>
      <NamespaceReader>
        {(namespace: NamespaceID) => (
          // Each page is hosted separately, so the stack's own safe area never reaches it; pad every page root.
          <Group
            toolbarVisibility={props.showsNavigationBar ? "automatic" : "hidden"}
            safeAreaPadding={bottomPadding}
            navigationDestination={
              <NavigationDestination>
                {(route: string) => (
                  // Pushed pages render outside the content subtree, so they need their own provider.
                  <ZoomContext.Provider value={{ namespace }}>
                    {/* Settings is a native Form and uses the system navigation bar; other pages draw their own header. */}
                    <Group toolbarVisibility={route === SETTINGS_ROUTE ? "automatic" : "hidden"} safeAreaPadding={bottomPadding}>
                      {renderRoute(route)}
                    </Group>
                  </ZoomContext.Provider>
                )}
              </NavigationDestination>
            }
          >
            <ZoomContext.Provider value={{ namespace }}>
              {props.children}
            </ZoomContext.Provider>
          </Group>
        )}
      </NamespaceReader>
    </NavigationStack>
  )
}
