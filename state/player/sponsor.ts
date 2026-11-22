import type { PlayerSettings, SponsorSegment, UnifiedVideoItem } from "../../types/index"
import {
  fetchSponsorSegments,
  filterSegmentsForCid,
  findActiveSponsorSegment,
  getSettings,
  subscribeStorageChanges,
} from "../../services/index"
import { reportError } from "../../services/errors"
import { SPONSOR_CATEGORY_LABELS } from "../../utils/format"
import {
  emitStore,
  isLivePlayback,
  patchStore,
  readDraftStore,
  runtime,
  showSkippedToast,
} from "./store"

let lastSkippedSegmentUuid: string = ""
let dismissedSegmentUuid: string = ""
let sponsorSegmentsAll: SponsorSegment[] = []
let sponsorReloadSeq: number = 0

function sponsorConfigSignature(settings: PlayerSettings): string {
  return `${settings.sponsorBlockEnabled}|${settings.sponsorBlockAutoSkip}|${[...settings.sponsorBlockCategories].sort().join(",")}`
}

let sponsorConfig: string = sponsorConfigSignature(readDraftStore().settings)

export function applySponsorSegmentsForCid(): void {
  const store = readDraftStore()
  patchStore({
    sponsorSegments: filterSegmentsForCid(sponsorSegmentsAll, store.activeCid),
  })
}

export function resetSponsorState(settings: PlayerSettings): void {
  lastSkippedSegmentUuid = ""
  dismissedSegmentUuid = ""
  sponsorSegmentsAll = []
  sponsorConfig = sponsorConfigSignature(settings)
}

export function resetSponsorForPageSwitch(): void {
  lastSkippedSegmentUuid = ""
  patchStore({ activeSponsorPrompt: null })
  applySponsorSegmentsForCid()
}

export function loadSponsorSegments(
  item: UnifiedVideoItem,
  settings: PlayerSettings,
  requestId: number,
): void {
  if (!settings.sponsorBlockEnabled) return
  void fetchSponsorSegments(item.provider, item.rawId, settings.sponsorBlockCategories)
    .then((segments: SponsorSegment[]) => {
      if (requestId !== runtime.openRequestSeq) return
      sponsorSegmentsAll = segments
      applySponsorSegmentsForCid()
      emitStore()
    })
    .catch((error: unknown) => {
      reportError("player", "sponsor.load", error)
    })
}

export function handleSponsorProgress(ctrl: VideoPlaybackController, pos: number): void {
  const store = readDraftStore()
  if (!store.settings.sponsorBlockEnabled || store.sponsorSegments.length === 0) return
  const seg: SponsorSegment | null = findActiveSponsorSegment(store.sponsorSegments, pos)
  if (seg) {
    if (store.settings.sponsorBlockAutoSkip && seg.actionType === "skip" && !isLivePlayback()) {
      if (lastSkippedSegmentUuid !== seg.uuid && seg.endTime > pos + 0.5) {
        lastSkippedSegmentUuid = seg.uuid
        void ctrl.seek(seg.endTime).catch(() => {})
        const label: string = SPONSOR_CATEGORY_LABELS[seg.category] ?? "片段"
        showSkippedToast(`已自動跳過：${label}`)
      }
    } else if (dismissedSegmentUuid !== seg.uuid && !isLivePlayback()) {
      if (store.activeSponsorPrompt?.uuid !== seg.uuid) {
        patchStore({ activeSponsorPrompt: seg })
        emitStore()
      }
    }
  } else if (store.activeSponsorPrompt !== null) {
    patchStore({ activeSponsorPrompt: null })
    emitStore()
  }
}

export function consumeActiveSponsorPrompt(): SponsorSegment | null {
  const seg: SponsorSegment | null = readDraftStore().activeSponsorPrompt
  if (!seg) return null
  lastSkippedSegmentUuid = seg.uuid
  patchStore({ activeSponsorPrompt: null })
  emitStore()
  return seg
}

export function dismissActiveSponsorSegment(): void {
  const seg: SponsorSegment | null = readDraftStore().activeSponsorPrompt
  if (!seg) return
  dismissedSegmentUuid = seg.uuid
  patchStore({ activeSponsorPrompt: null })
  emitStore()
}

subscribeStorageChanges(() => {
  const next: PlayerSettings = getSettings()
  const signature: string = sponsorConfigSignature(next)
  if (signature === sponsorConfig) return
  sponsorConfig = signature

  const store = readDraftStore()
  patchStore({
    settings: {
      ...store.settings,
      sponsorBlockEnabled: next.sponsorBlockEnabled,
      sponsorBlockAutoSkip: next.sponsorBlockAutoSkip,
      sponsorBlockCategories: next.sponsorBlockCategories,
    },
    activeSponsorPrompt: null,
  })

  const item: UnifiedVideoItem | null = store.currentItem
  const reload: number = ++sponsorReloadSeq
  if (!next.sponsorBlockEnabled || !item) {
    sponsorSegmentsAll = []
    patchStore({ sponsorSegments: [] })
    emitStore()
    return
  }

  emitStore()
  void fetchSponsorSegments(item.provider, item.rawId, next.sponsorBlockCategories)
    .then((segments: SponsorSegment[]) => {
      if (reload !== sponsorReloadSeq || readDraftStore().currentItem?.id !== item.id) return
      sponsorSegmentsAll = segments
      applySponsorSegmentsForCid()
      emitStore()
    })
    .catch((error: unknown) => {
      reportError("player", "sponsor.reload", error)
    })
}, ["settings"])
