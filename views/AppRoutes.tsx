import type { VirtualNode } from "scripting"
import type { OpenChannel } from "../types/index"
import {
  PLAYBACK_ROUTE,
  SPONSORBLOCK_ROUTE,
  parseChannelRoute,
  type ChannelTarget,
  type TabStackNav,
} from "../components/TabStack"
import { ChannelView } from "./ChannelView"
import { PlaybackSettingsView } from "./PlaybackSettingsView"
import { SettingsView } from "./SettingsView"
import { SponsorBlockSettingsView } from "./SponsorBlockSettingsView"

export interface AppRouteHandlers {
  onOpenChannel: OpenChannel
  onExitApp: () => void
}

export function renderAppRoute(
  route: string,
  nav: TabStackNav,
  handlers: AppRouteHandlers,
): VirtualNode {
  const channel: ChannelTarget | null = parseChannelRoute(route)
  if (channel) {
    return (
      <ChannelView
        provider={channel.provider}
        channelId={channel.channelId}
        initialName={channel.initialName}
        initialAvatar={channel.initialAvatar}
        onClose={nav.pop}
        onOpenChannel={handlers.onOpenChannel}
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
      onExitApp={handlers.onExitApp}
      onOpenPlayback={() => nav.push(PLAYBACK_ROUTE)}
      onOpenSponsorBlock={() => nav.push(SPONSORBLOCK_ROUTE)}
    />
  )
}
