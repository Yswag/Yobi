import {
  Navigation,
  Script,
  Tab,
  TabView,
  useObservable,
} from "scripting"
import type { VirtualNode } from "scripting"
import { stopLocalProxy } from "./services/index"
import { closePlayer, usePlayerStore } from "./state/playerStore"
import { useWatchNavigationSync } from "./state/watchNavigation"
import { MiniPlayerBar } from "./components/MiniPlayerBar"
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
  useWatchNavigationSync(selection, paths)

  const push = (route: string): void => {
    const path: Observable<string[]> = paths[selection.value]
    if (path.value[path.value.length - 1] === route) return
    path.setValue([...path.value, route])
  }

  // From the watch page this stacks the channel on top; the sync hook minimizes the player meanwhile.
  const handleOpenChannel: OpenChannel = (provider, authorId, authorName, avatarUrl) => {
    if (!authorId) return
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
    >
      {content}
    </TabStack>
  )

  const showMiniPlayer: boolean = store.presentationMode === "mini" && store.currentItem !== null

  return (
    <ZoomContext.Provider value={{ namespace: null }}>
      <TabView
        selection={selection}
        tint={palette.brand}
        tabBarMinimizeBehavior="onScrollDown"
        tabViewSearchActivation="searchTabSelection"
        // Omit the key entirely when hidden: passing undefined still mounts an empty accessory capsule.
        {...(showMiniPlayer ? { tabViewBottomAccessory: <MiniPlayerBar /> } : {})}
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
