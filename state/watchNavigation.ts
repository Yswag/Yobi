import { useEffect } from "scripting"
import { isWatchRoute, watchRoute } from "../components/TabStack"
import { takeZoomSource } from "../ui/zoom"
import type { PlayerPresentationMode } from "./playerStore"
import {
  expandFromMiniPlayer,
  getPlayerStoreSnapshot,
  minimizeToMiniPlayer,
  subscribePlayerStore,
} from "./playerStore"

function topOf(path: Observable<string[]>): string | undefined {
  return path.value[path.value.length - 1]
}

function withoutWatch(routes: string[]): string[] {
  return routes.filter((route: string): boolean => !isWatchRoute(route))
}

function dropWatch(path: Observable<string[]>): void {
  if (path.value.some(isWatchRoute)) path.setValue(withoutWatch(path.value))
}

/**
 * Keeps the player's expanded/mini state and the tab stacks in agreement:
 * - player expands → the watch page is pushed onto the selected tab (removed everywhere else);
 * - player minimizes or closes → the watch page is popped;
 * - user pops it, pushes past it or switches tabs → the player minimizes; landing back on it re-expands.
 * Only one watch page ever exists, so only one view binds the shared player controller.
 */
export function useWatchNavigationSync(selection: Observable<number>, paths: Observable<string[]>[]): void {
  useEffect(() => {
    let prevMode: PlayerPresentationMode = getPlayerStoreSnapshot().presentationMode
    let lastTab: number = selection.value

    const onStoreChange = (): void => {
      const store = getPlayerStoreSnapshot()
      const mode: PlayerPresentationMode = store.presentationMode
      const becameExpanded: boolean = mode === "expanded" && prevMode !== "expanded"
      prevMode = mode
      const current: Observable<string[]> = paths[selection.value]

      if (mode === "hidden" || !store.currentItem) {
        paths.forEach(dropWatch)
        return
      }
      if (becameExpanded && !isWatchRoute(topOf(current))) {
        paths.forEach((path: Observable<string[]>, index: number) => {
          if (index !== selection.value) dropWatch(path)
        })
        current.setValue([...withoutWatch(current.value), watchRoute(takeZoomSource())])
        return
      }
      if (mode === "mini" && isWatchRoute(topOf(current))) {
        current.setValue(current.value.slice(0, -1))
      }
    }

    const onNavigationChange = (): void => {
      const tab: number = selection.value
      if (tab !== lastTab) {
        dropWatch(paths[lastTab])
        lastTab = tab
      }
      const store = getPlayerStoreSnapshot()
      if (!store.currentItem) return
      const watchOnTop: boolean = isWatchRoute(topOf(paths[tab]))
      if (watchOnTop && store.presentationMode === "mini") {
        expandFromMiniPlayer()
      } else if (!watchOnTop && store.presentationMode === "expanded") {
        minimizeToMiniPlayer()
      }
    }

    const unsubscribeStore: () => void = subscribePlayerStore(onStoreChange)
    selection.subscribe(onNavigationChange)
    paths.forEach((path: Observable<string[]>) => path.subscribe(onNavigationChange))
    return () => {
      unsubscribeStore()
      selection.unsubscribe(onNavigationChange)
      paths.forEach((path: Observable<string[]>) => path.unsubscribe(onNavigationChange))
    }
  }, [])
}
