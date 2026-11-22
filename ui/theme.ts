import type { Color } from "scripting"
import type { Provider } from "../types"

export const palette = {
  brand: "rgba(255,55,95,1)" as Color,
  brandSoft: "rgba(255,55,95,0.14)" as Color,
  yt: "rgba(255,46,77,1)" as Color,
  bili: "rgba(251,114,153,1)" as Color,
  success: "rgba(48,209,88,1)" as Color,
  danger: "rgba(255,59,48,1)" as Color,
  member: "rgba(255,196,0,1)" as Color,
  dangerSoft: "rgba(255,59,48,0.14)" as Color,
  scrim: "rgba(0,0,0,0.62)" as Color,
  onMedia: "rgba(255,255,255,1)" as Color,
  onMediaDim: "rgba(255,255,255,0.7)" as Color,
  track: "rgba(255,255,255,0.3)" as Color,
  trackOnSurface: "rgba(120,120,128,0.24)" as Color,
}

export const radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
}

export const space = {
  page: 16,
  section: 28,
  cardGap: 24,
}

export const type = {
  largeTitle: 32,
  title: 22,
  section: 19,
  cardTitle: 15,
  body: 14,
  meta: 12,
  caption: 11,
  micro: 10,
}

export const motion = {
  enter: Animation.easeOut(0.26),
  exit: Animation.easeIn(0.14),
  move: Animation.smooth({ duration: 0.3 }),
  morph: Animation.smooth({ duration: 0.38 }),
  confirm: Animation.bouncy({ duration: 0.34, extraBounce: 0.1 }),
  settle: Animation.spring({ response: 0.34, dampingFraction: 0.8 }),
  duration: {
    enter: 0.26,
    exit: 0.14,
    move: 0.3,
    morph: 0.38,
  },
}

export function providerColor(provider: Provider): Color {
  return provider === "bili" ? palette.bili : palette.yt
}

export function thumbHeight(width: number): number {
  return Math.round((width * 9) / 16)
}

export function pageContentWidth(): number {
  return Math.max(1, Device.screen.width - space.page * 2)
}
