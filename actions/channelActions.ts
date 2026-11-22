import type { Provider, SubscriptionChannel, VideoCollaborator } from "../types/index"
import { isSubscribed, toggleSubscription } from "../services/index"

export interface ChannelSubscriptionInput {
  provider: Provider
  rawId: string
  name: string
  avatarUrl?: string
}

export function buildSubscriptionChannel(input: ChannelSubscriptionInput): SubscriptionChannel {
  return {
    id: `${input.provider}:${input.rawId}`,
    provider: input.provider,
    rawId: input.rawId,
    name: input.name,
    avatarUrl: input.avatarUrl ?? "",
    subscribedAt: Date.now(),
  }
}

export function toggleChannelSubscription(input: ChannelSubscriptionInput): boolean {
  return toggleSubscription(buildSubscriptionChannel(input))
}

export function isChannelGroupSubscribed(
  provider: Provider,
  channelRawId: string,
  collaborators: VideoCollaborator[],
): boolean {
  if (collaborators.length > 1) {
    return collaborators.every((channel: VideoCollaborator): boolean =>
      isSubscribed(`${provider}:${channel.id}`),
    )
  }
  return isSubscribed(`${provider}:${channelRawId}`)
}

export async function pickCollaborator(
  collaborators: VideoCollaborator[],
  title: string,
  labelFor: (channel: VideoCollaborator) => string,
): Promise<VideoCollaborator | null> {
  const index: number | null | undefined = await Dialog.actionSheet({
    title,
    actions: collaborators.map((channel: VideoCollaborator) => ({ label: labelFor(channel) })),
  })
  return typeof index === "number" ? collaborators[index] ?? null : null
}
