import { createContext } from "scripting"

export interface ZoomScope {
  namespace: NamespaceID | null
}

// Provided at the app root (namespace null) and again inside each tab stack, so reads never throw.
export const ZoomContext = createContext<ZoomScope>()

const PENDING_TTL_MS: number = 2000

let pendingSource: { id: string; at: number } | null = null

// Cards record which thumbnail was tapped; the watch page push picks it up as the zoom origin.
export function markZoomSource(id: string): void {
  pendingSource = { id, at: Date.now() }
}

export function takeZoomSource(): string | null {
  const source = pendingSource
  pendingSource = null
  if (!source || Date.now() - source.at > PENDING_TTL_MS) return null
  return source.id
}
