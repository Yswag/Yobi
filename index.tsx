import {
  Divider,
  HStack,
  Image,
  Navigation,
  NavigationStack,
  Script,
  Text,
  VStack,
  ZStack,
  useState,
} from "scripting"
import type { Color, VirtualNode } from "scripting"
import type { Provider } from "./types/index"
import { stopLocalProxy } from "./services/index"
import {
  closePlayer,
  minimizeToMiniPlayer,
  usePlayerStore,
} from "./state/playerStore"
import { MiniPlayerBar } from "./components/MiniPlayerBar"
import { ChannelView } from "./views/ChannelView"
import { DownloadsView } from "./views/DownloadsView"
import { HomeView } from "./views/HomeView"
import { LibraryView } from "./views/LibraryView"
import { SearchView } from "./views/SearchView"
import { SettingsView } from "./views/SettingsView"
import { SubscriptionsView } from "./views/SubscriptionsView"
import { WatchView } from "./views/WatchView"

type RootTab = "home" | "subscriptions" | "search" | "library" | "downloads" | "settings"

interface ChannelTarget {
  provider: Provider
  channelId: string
  initialName?: string
  initialAvatar?: string
}

const ACTIVE_TINT: Color = "rgba(255,46,77,1)"

const TAB_ITEMS: { key: RootTab; label: string; icon: string }[] = [
  { key: "home", label: "首頁", icon: "house.fill" },
  { key: "subscriptions", label: "訂閱", icon: "play.square.stack.fill" },
  { key: "search", label: "搜尋", icon: "magnifyingglass" },
  { key: "library", label: "媒體庫", icon: "folder.fill" },
  { key: "downloads", label: "下載", icon: "arrow.down.circle.fill" },
  { key: "settings", label: "設定", icon: "gearshape.fill" },
]

function YobiRootView(): VirtualNode {
  const dismiss = Navigation.useDismiss()
  const store = usePlayerStore()
  const [activeTab, setActiveTab] = useState<RootTab>("home")
  const [channelTarget, setChannelTarget] = useState<ChannelTarget | null>(null)

  const handleOpenChannel = (
    provider: Provider,
    authorId: string,
    authorName: string,
    avatarUrl?: string,
  ): void => {
    if (!authorId) return
    if (store.presentationMode === "expanded") {
      minimizeToMiniPlayer()
    }
    setChannelTarget({
      provider,
      channelId: authorId,
      initialName: authorName,
      initialAvatar: avatarUrl,
    })
  }

  const handleSelectTab = (tab: RootTab): void => {
    setChannelTarget(null)
    setActiveTab(tab)
  }

  const handleExitApp = (): void => {
    void closePlayer().finally(() => {
      stopLocalProxy()
      dismiss()
    })
  }

  const renderMainContent = (): VirtualNode => {
    if (channelTarget) {
      return (
        <ChannelView
          provider={channelTarget.provider}
          channelId={channelTarget.channelId}
          initialName={channelTarget.initialName}
          initialAvatar={channelTarget.initialAvatar}
          onClose={() => setChannelTarget(null)}
          onOpenChannel={handleOpenChannel}
        />
      )
    }

    switch (activeTab) {
      case "home":
        return (
          <HomeView
            onOpenSearch={() => handleSelectTab("search")}
            onOpenChannel={handleOpenChannel}
            onExitApp={handleExitApp}
          />
        )
      case "subscriptions":
        return (
          <SubscriptionsView
            onOpenChannel={handleOpenChannel}
            onOpenSearch={() => handleSelectTab("search")}
          />
        )
      case "search":
        return <SearchView onOpenChannel={handleOpenChannel} />
      case "library":
        return (
          <LibraryView
            onOpenChannel={handleOpenChannel}
            onOpenSettings={() => handleSelectTab("settings")}
          />
        )
      case "settings":
        return <SettingsView onExitApp={handleExitApp} />
      case "downloads":
        return <DownloadsView onOpenSettings={() => handleSelectTab("settings")} />
    }
  }

  const isExpandedWatch: boolean =
    store.presentationMode === "expanded" && store.currentItem !== null

  return (
    <NavigationStack>
      <ZStack
        alignment="bottom"
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        background="systemBackground"
        toolbarVisibility="hidden"
        statusBarHidden={store.isFullscreen}
      >
        <VStack
          spacing={0}
          frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        >
          <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
            {renderMainContent()}
          </ZStack>

          <MiniPlayerBar />

          <Divider />

          <HStack
            spacing={0}
            padding={{ top: 6, bottom: 6 }}
            frame={{ maxWidth: "infinity" }}
            background="secondarySystemBackground"
          >
            {TAB_ITEMS.map(item => {
              const selected: boolean = !channelTarget && activeTab === item.key
              return (
                <VStack
                  key={`tab-${item.key}`}
                  spacing={3}
                  frame={{ maxWidth: "infinity" }}
                  onTapGesture={() => handleSelectTab(item.key)}
                >
                  <Image
                    systemName={item.icon}
                    font={18}
                    foregroundStyle={selected ? ACTIVE_TINT : "secondaryLabel"}
                  />
                  <Text
                    font={10}
                    fontWeight={selected ? "semibold" : "regular"}
                    foregroundStyle={selected ? ACTIVE_TINT : "secondaryLabel"}
                  >
                    {item.label}
                  </Text>
                </VStack>
              )
            })}
          </HStack>
        </VStack>

        {isExpandedWatch ? (
          <WatchView onOpenChannel={handleOpenChannel} />
        ) : null}
      </ZStack>
    </NavigationStack>
  )
}

async function run(): Promise<void> {
  try {
    await Navigation.present({
      element: <YobiRootView />,
      modalPresentationStyle: "fullScreen",
      swipeBackBehavior: "dismiss",
    })
  } finally {
    await closePlayer()
    stopLocalProxy()
    Script.exit()
  }
}

void run()
