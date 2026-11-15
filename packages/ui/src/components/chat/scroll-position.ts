/**
 * scroll-position.ts
 *
 * The one place that decides what "at the bottom of the conversation" means.
 *
 * Two things read it and they must agree: the sticky-bottom behaviour (which
 * decides whether new content pulls the view down) and the return-to-bottom
 * button (which is only worth showing once the reader has left the bottom).
 * Two thresholds would let the conversation sit in a state where it no longer
 * follows new content but still shows no way back.
 */

/**
 * How close to the bottom still counts as "at the bottom", in pixels.
 *
 * Non-zero on purpose: fractional device-pixel heights mean the exact bottom is
 * rarely reachable, and a strict comparison would flip the flag (and flicker the
 * button) at rest.
 */
export const AT_BOTTOM_THRESHOLD = 24

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Pixels between the current position and the end of the content. */
export function distanceFromBottom({ scrollTop, scrollHeight, clientHeight }: ScrollMetrics): number {
  // A viewport taller than its content reports a negative distance; the reader
  // is at the bottom (there is only one screen), so clamp rather than report it.
  return Math.max(0, scrollHeight - scrollTop - clientHeight)
}

/** True while the newest content is in view. */
export function isScrolledToBottom(
  metrics: ScrollMetrics,
  threshold: number = AT_BOTTOM_THRESHOLD
): boolean {
  return distanceFromBottom(metrics) <= threshold
}
