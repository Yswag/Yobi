import {
  Navigation,
  Script,
  Tab,
  TabView,
  ZStack,
  useObservable,
} from "scripting"
import type { VirtualNode } from "scripting"
import { disposeYoutubePageMinter, stopLocalProxy, warmYoutubePageMinter } from "./services/index"
import { closePlayer, getPlayerStoreSnapshot, minimizeToMiniPlayer, usePlayerRootState } from "./state/playerStore"
import { MINI_PLAYER_RESERVED_HEIGHT, PlayerHost } from "./components/PlayerHost"
import { channelRoute, SETTINGS_ROUTE, TabStack } from "./components/TabStack"
import type { OpenChannel } from "./components/TabStack"
import { HomeView } from "./views/HomeView"
import { LibraryView } from "./views/LibraryView"
import { SearchView } from "./views/SearchView"
import { SubscriptionsView } from "./views/SubscriptionsView"
import { palette } from "./ui/theme"

const TAB = { home: 0, subscriptions: 1, library: 2, search: 3 }

function YobiRootView(): VirtualNode {
  const dismiss = Navigation.useDismiss()
  const root = usePlayerRootState()
  const selection = useObservable<number>(TAB.home)
  const paths: Observable<string[]>[] = [
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
      bottomInset={root.hasItem ? MINI_PLAYER_RESERVED_HEIGHT : 0}
    >
      {content}
    </TabStack>
  )

  return (
    <ZStack alignment="topLeading" statusBarHidden={root.isFullscreen}>
      <TabView
        selection={selection}
        tint={palette.brand}
        tabBarMinimizeBehavior="never"
        tabViewSearchActivation="searchTabSelection"
        overlay={{ alignment: "topLeading", content: <PlayerHost onOpenChannel={handleOpenChannel} /> }}
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
        <Tab title="搜尋" systemImage="magnifyingglass" value={TAB.search} role="search">
          {stack(TAB.search, <SearchView onOpenChannel={handleOpenChannel} />)}
        </Tab>
      </TabView>
    </ZStack>
  )
}

const WARM_DELAY_MS: number = 2000

async function run(): Promise<void> {
  const warmTimer: number = setTimeout(warmYoutubePageMinter, WARM_DELAY_MS)
  try {
    await Navigation.present({
      element: <YobiRootView />,
      modalPresentationStyle: "fullScreen",
      swipeBackBehavior: "disabled",
    })
  } finally {
    clearTimeout(warmTimer)
    await closePlayer()
    stopLocalProxy()
    disposeYoutubePageMinter()
    Script.exit()
  }
}

void run()
