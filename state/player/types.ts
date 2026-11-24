import type {
  CommentItem,
  CommentSort,
  PlayerSettings,
  SponsorSegment,
  StreamManifest,
  UnifiedVideoItem,
  VideoChapter,
  VideoDetail,
} from "../../types/index"

export type PlayerPresentationMode = "hidden" | "expanded" | "mini"

export type PlaybackStatus =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "buffering"
  | "ended"
  | "error"

export interface PlayerStoreSnapshot {
  presentationMode: PlayerPresentationMode
  currentItem: UnifiedVideoItem | null
  detail: VideoDetail | null
  manifest: StreamManifest | null
  sponsorSegments: SponsorSegment[]
  activeSponsorPrompt: SponsorSegment | null
  skippedToast: string | null
  status: PlaybackStatus
  errorText: string | null
  playbackRate: number
  isBoosting2x: boolean
  selectedQualityId: string
  selectedQualityLabel: string
  selectedSubtitleId: string | null
  activeCid?: number
  activePage: number
  isFullscreen: boolean
  isPortraitFullscreen: boolean
  isPiPActive: boolean
  pipAvailable: boolean
  audioUnavailable: boolean
  liveSeekable: boolean
  danmakuEnabled: boolean
  danmakuCount: number
  statsVisible: boolean
  queue: UnifiedVideoItem[]
  queueIndex: number
  settings: PlayerSettings
}

export interface CommentsStoreSnapshot {
  comments: CommentItem[]
  loading: boolean
  sort: CommentSort
  cursor: string | null
  loadingMore: boolean
  repliesLoading: Record<string, boolean>
}

export interface PlayerRootSnapshot {
  isFullscreen: boolean
  hasItem: boolean
}

export interface LiveWindow {
  start: number
  end: number
}

export interface PlayerProgressSnapshot {
  position: number
  duration: number
  bufferedUntil: number
  activeChapter: VideoChapter | null
  liveWindow: LiveWindow | null
}

export interface LiveViewerSnapshot {
  videoId: string
  count: number | null
}

export interface OpenVideoOptions {
  cid?: number
  page?: number
  startSeconds?: number
  queue?: UnifiedVideoItem[]
  autoExpand?: boolean
  resumeFromHistory?: boolean
}
