import {
  Navigation,
  Script,
  Tab,
  TabView,
  ZStack,
  useCallback,
  useEffect,
  useMemo,
  useObservable,
} from "scripting"
import type { VirtualNode } from "scripting"
import { disposeYoutubePageMinter, stopLocalProxy, stopMediaServer, warmYoutubePageMinter } from "./services/index"
import {
  closePlayer,
  getPlayerStoreSnapshot,
  minimizeToMiniPlayer,
  startOrientationAutoFullscreen,
  usePlayerRootState,
} from "./state/playerStore"
import type { OpenChannel } from "./types/index"
import { MINI_PLAYER_RESERVED_HEIGHT, PlayerHost, type PlayerWatchRenderProps } from "./components/PlayerHost"
import { channelRoute, SETTINGS_ROUTE, TabStack, type TabStackNav } from "./components/TabStack"
import { renderAppRoute } from "./views/AppRoutes"
import { HomeView } from "./views/HomeView"
import { LibraryView } from "./views/LibraryView"
import { SearchView } from "./views/SearchView"
import { SubscriptionsView } from "./views/SubscriptionsView"
import { WatchView } from "./views/WatchView"
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

  useEffect(() => {
    return startOrientationAutoFullscreen()
  }, [])

  const push = useCallback((route: string): void => {
    const path: Observable<string[]> = paths[selection.value]
    if (path.value[path.value.length - 1] === route) return
    path.setValue([...path.value, route])
  }, [])

  const handleOpenChannel: OpenChannel = useCallback((provider, authorId, authorName, avatarUrl) => {
    if (!authorId) return
    if (getPlayerStoreSnapshot().presentationMode === "expanded") minimizeToMiniPlayer()
    push(channelRoute({ provider, channelId: authorId, initialName: authorName, initialAvatar: avatarUrl }))
  }, [push])

  const openSettings = useCallback((): void => push(SETTINGS_ROUTE), [push])
  const openSearch = useCallback((): void => selection.setValue(TAB.search), [])

  const handleExitApp = useCallback((): void => {
    void closePlayer().finally(() => {
      stopMediaServer()
      stopLocalProxy()
      dismiss()
    })
  }, [dismiss])

  const renderRoute = useCallback(
    (route: string, nav: TabStackNav): VirtualNode =>
      renderAppRoute(route, nav, { onOpenChannel: handleOpenChannel, onExitApp: handleExitApp }),
    [handleOpenChannel, handleExitApp],
  )

  const renderWatch = useCallback(
    (watchProps: PlayerWatchRenderProps): VirtualNode => <WatchView {...watchProps} />,
    [],
  )

  const bottomInset: number = root.hasItem ? MINI_PLAYER_RESERVED_HEIGHT : 0

  const playerOverlay = useMemo(
    () => ({
      alignment: "topLeading" as const,
      content: <PlayerHost onOpenChannel={handleOpenChannel} renderWatch={renderWatch} />,
    }),
    [handleOpenChannel, renderWatch],
  )

  const homeTab = useMemo(
    () => (
      <TabStack
        path={paths[TAB.home]}
        renderRoute={renderRoute}
        showsNavigationBar={false}
        bottomInset={bottomInset}
      >
        <HomeView onOpenChannel={handleOpenChannel} onOpenSettings={openSettings} />
      </TabStack>
    ),
    [renderRoute, handleOpenChannel, openSettings, bottomInset],
  )

  const subscriptionsTab = useMemo(
    () => (
      <TabStack
        path={paths[TAB.subscriptions]}
        renderRoute={renderRoute}
        showsNavigationBar={false}
        bottomInset={bottomInset}
      >
        <SubscriptionsView onOpenChannel={handleOpenChannel} onOpenSearch={openSearch} />
      </TabStack>
    ),
    [renderRoute, handleOpenChannel, openSearch, bottomInset],
  )

  const libraryTab = useMemo(
    () => (
      <TabStack
        path={paths[TAB.library]}
        renderRoute={renderRoute}
        showsNavigationBar={false}
        bottomInset={bottomInset}
      >
        <LibraryView onOpenChannel={handleOpenChannel} onOpenSettings={openSettings} />
      </TabStack>
    ),
    [renderRoute, handleOpenChannel, openSettings, bottomInset],
  )

  const searchTab = useMemo(
    () => (
      <TabStack
        path={paths[TAB.search]}
        renderRoute={renderRoute}
        showsNavigationBar
        bottomInset={bottomInset}
      >
        <SearchView onOpenChannel={handleOpenChannel} />
      </TabStack>
    ),
    [renderRoute, handleOpenChannel, bottomInset],
  )

  return (
    <ZStack alignment="topLeading" statusBarHidden={root.isFullscreen}>
      <TabView
        selection={selection}
        tint={palette.brand}
        tabBarMinimizeBehavior="never"
        tabViewSearchActivation="searchTabSelection"
        overlay={playerOverlay}
      >
        <Tab title="首頁" systemImage="house.fill" value={TAB.home}>
          {homeTab}
        </Tab>
        <Tab title="訂閱" systemImage="play.square.stack.fill" value={TAB.subscriptions}>
          {subscriptionsTab}
        </Tab>
        <Tab title="媒體庫" systemImage="books.vertical.fill" value={TAB.library}>
          {libraryTab}
        </Tab>
        <Tab title="搜尋" systemImage="magnifyingglass" value={TAB.search} role="search">
          {searchTab}
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
    stopMediaServer()
    stopLocalProxy()
    disposeYoutubePageMinter()
    Script.exit()
  }
}

void run()
