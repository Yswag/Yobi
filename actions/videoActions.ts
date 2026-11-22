import type { CustomPlaylist, UnifiedVideoItem } from "../types/index"
import {
  addVideoToPlaylist,
  createPlaylist,
  getPlaylists,
  toggleWatchLater,
} from "../services/index"
import { openVideo } from "../state/playerStore"
import { getVideoShareUrl } from "../utils/format"

export function shuffleItems<T>(list: T[]): T[] {
  const out: T[] = list.slice()
  for (let i: number = out.length - 1; i > 0; i--) {
    const j: number = Math.floor(Math.random() * (i + 1))
    const tmp: T = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

export function playVideoQueue(
  items: UnifiedVideoItem[],
  options?: { startIndex?: number; shuffle?: boolean },
): void {
  if (items.length === 0) return
  if (options?.shuffle) {
    const shuffled: UnifiedVideoItem[] = shuffleItems(items)
    void openVideo(shuffled[0], { queue: shuffled })
    return
  }
  const index: number = Math.max(0, Math.min(items.length - 1, options?.startIndex ?? 0))
  void openVideo(items[index], { queue: items })
}

export function toggleWatchLaterAction(item: UnifiedVideoItem): {
  added: boolean
  message: string
} {
  const added: boolean = toggleWatchLater(item)
  return {
    added,
    message: added ? "已加入稍後觀看" : "已移出稍後觀看",
  }
}

export async function copyVideoLink(item: UnifiedVideoItem): Promise<string> {
  await Pasteboard.setString(getVideoShareUrl(item))
  return "已複製連結"
}

export async function addToPlaylistFlow(item: UnifiedVideoItem): Promise<boolean> {
  const playlists: CustomPlaylist[] = getPlaylists()
  const labels: string[] = playlists.map((playlist: CustomPlaylist): string => playlist.name)
  labels.push("＋ 新增播放清單")

  const index: number | null | undefined = await Dialog.actionSheet({
    title: "加入播放清單",
    actions: labels.map((label: string) => ({ label })),
  })
  if (typeof index !== "number") return false

  if (index < playlists.length) {
    addVideoToPlaylist(playlists[index].id, item)
    return true
  }

  const name: string | null = await Dialog.prompt({
    title: "新增播放清單",
    message: "輸入清單名稱",
    confirmLabel: "建立",
  })
  const trimmed: string = (name ?? "").trim()
  if (!trimmed) return false
  const created: CustomPlaylist = createPlaylist(trimmed)
  addVideoToPlaylist(created.id, item)
  return true
}
