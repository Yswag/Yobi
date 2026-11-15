import { Group, NamespaceReader, NavigationDestination, NavigationStack } from "scripting"
import type { VirtualNode } from "scripting"
import type { Provider } from "../types"
import { ChannelView } from "../views/ChannelView"
import { SettingsView } from "../views/SettingsView"
import { WatchView } from "../views/WatchView"
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
const WATCH_ROUTE_PREFIX: string = "watch:"

export function channelRoute(target: ChannelTarget): string {
  return `${CHANNEL_ROUTE_PREFIX}${JSON.stringify(target)}`
}

// The zoom source rides in the route so the page can zoom back to the same thumbnail when popped.
export function watchRoute(zoomSourceID: string | null): string {
  return `${WATCH_ROUTE_PREFIX}${zoomSourceID ?? ""}`
}

export function isWatchRoute(route: string | undefined): boolean {
  return route !== undefined && route.startsWith(WATCH_ROUTE_PREFIX)
}

export function TabStack(props: {
  path: Observable<string[]>
  onOpenChannel: OpenChannel
  onExitApp: () => void
  showsNavigationBar?: boolean
  children: VirtualNode
}): VirtualNode {
  const pop = (): void => {
    props.path.setValue(props.path.value.slice(0, -1))
  }

  const renderRoute = (route: string, namespace: NamespaceID): VirtualNode => {
    if (isWatchRoute(route)) {
      const sourceID: string = route.slice(WATCH_ROUTE_PREFIX.length)
      return (
        <WatchView
          onOpenChannel={props.onOpenChannel}
          zoom={sourceID ? { sourceID, namespace } : undefined}
        />
      )
    }
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

  return (
    <NavigationStack path={props.path}>
      <NamespaceReader>
        {(namespace: NamespaceID) => (
          <Group
            toolbarVisibility={props.showsNavigationBar ? "automatic" : "hidden"}
            navigationDestination={
              <NavigationDestination>
                {(route: string) => (
                  // Pushed pages render outside the content subtree, so they need their own provider.
                  // The watch page gets none: its related cards must not duplicate the source it zoomed from.
                  <ZoomContext.Provider value={{ namespace: isWatchRoute(route) ? null : namespace }}>
                    {/* Settings is a native Form and uses the system navigation bar; other pages draw their own header. */}
                    <Group toolbarVisibility={route === SETTINGS_ROUTE ? "automatic" : "hidden"}>
                      {renderRoute(route, namespace)}
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
