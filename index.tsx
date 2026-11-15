import {
  Navigation,
  Script,
  Tab,
  TabView,
  ZStack,
  useObservable,
} from "scripting"
import type { VirtualNode } from "scripting"
import { stopLocalProxy } from "./services/index"
import { closePlayer, getPlayerStoreSnapshot, minimizeToMiniPlayer, usePlayerStore } from "./state/playerStore"
import { MINI_PLAYER_RESERVED_HEIGHT, PlayerHost } from "./components/PlayerHost"
import { channelRoute, SETTINGS_ROUTE, TabStack } from "./components/TabStack"
import type { OpenChannel } from "./components/TabStack"
import { DownloadsView } from "./views/DownloadsView"
import { HomeView } from "./views/HomeView"
import { LibraryView } from "./views/LibraryView"
import { SearchView } from "./views/SearchView"
import { SubscriptionsView } from "./views/SubscriptionsView"
import { palette } from "./ui/theme"
import { ZoomContext } from "./ui/zoom"

const TAB = { home: 0, subscriptions: 1, library: 2, downloads: 3, search: 4 }

function YobiRootView(): VirtualNode {
  const dismiss = Navigation.useDismiss()
  const store = usePlayerStore()
  const selection = useObservable<number>(TAB.home)
  const paths: Observable<string[]>[] = [
    useObservable<string[]>([]),
    useObservable<string[]>([]),
    useObservable<string[]>([]),
    useObservable<string[]>([]),
    useObservable<string[]>([]),
  ]

  const push = (route: string): void => {
    const path: Observable<string[]> = paths[selection.value]
    if (path.value[path.value.length - 1] === route) return
    path.setValue([...path.value, route])
  }

  // From the player this minimizes it first, so the channel opens on the tab underneath.
  const handleOpenChannel: OpenChannel = (provider, authorId, authorName, avatarUrl) => {
    if (!authorId) return
    if (getPlayerStoreSnapshot().presentationMode === "expanded") minimizeToMiniPlayer()
    push(channelRoute({ provider, channelId: authorId, initialName: authorName, initialAvatar: avatarUrl }))
  }

  const openSettings = (): void => push(SETTINGS_ROUTE)

  const handleExitApp = (): void => {
    void closePlayer().finally(() => {
      stopLocalProxy()
      dismiss()
    })
  }

  const stack = (tab: number, content: VirtualNode): VirtualNode => (
    <TabStack
      path={paths[tab]}
      onOpenChannel={handleOpenChannel}
      onExitApp={handleExitApp}
      showsNavigationBar={tab === TAB.search}
      bottomInset={store.currentItem ? MINI_PLAYER_RESERVED_HEIGHT : 0}
    >
      {content}
    </TabStack>
  )

  return (
    <ZoomContext.Provider value={{ namespace: null }}>
      <ZStack alignment="topLeading" statusBarHidden={store.isFullscreen}>
        <TabView
          selection={selection}
          tint={palette.brand}
          // The mini player is placed against the full-size tab bar.
          tabBarMinimizeBehavior="never"
          tabViewSearchActivation="searchTabSelection"
        >
          <Tab title="首頁" systemImage="house.fill" value={TAB.home}>
            {stack(TAB.home, <HomeView onOpenChannel={handleOpenChannel} onOpenSettings={openSettings} />)}
          </Tab>
          <Tab title="訂閱" systemImage="play.square.stack.fill" value={TAB.subscriptions}>
            {stack(TAB.subscriptions, (
              <SubscriptionsView
                onOpenChannel={handleOpenChannel}
                onOpenSearch={() => selection.setValue(TAB.search)}
              />
            ))}
          </Tab>
          <Tab title="媒體庫" systemImage="books.vertical.fill" value={TAB.library}>
            {stack(TAB.library, <LibraryView onOpenChannel={handleOpenChannel} onOpenSettings={openSettings} />)}
          </Tab>
          <Tab title="下載" systemImage="arrow.down.circle.fill" value={TAB.downloads}>
            {stack(TAB.downloads, <DownloadsView onOpenSettings={openSettings} />)}
          </Tab>
          <Tab title="搜尋" systemImage="magnifyingglass" value={TAB.search} role="search">
            {stack(TAB.search, <SearchView onOpenChannel={handleOpenChannel} />)}
          </Tab>
        </TabView>
        <PlayerHost onOpenChannel={handleOpenChannel} />
      </ZStack>
    </ZoomContext.Provider>
  )
}

async function run(): Promise<void> {
  try {
    await Navigation.present({
      element: <YobiRootView />,
      modalPresentationStyle: "fullScreen",
      swipeBackBehavior: "disabled",
    })
  } finally {
    await closePlayer()
    stopLocalProxy()
    Script.exit()
  }
}

void run()
