import { isMac } from '@/lib/platform'
import {
  PANEL_EDGE_INSET,
  PANEL_GAP,
  PANEL_RADIUS_EDGE,
  PANEL_RADIUS_INNER,
} from '../../../shared/panel-geometry'

/**
 * The panel look's numbers come from `shared/panel-geometry.ts`, because the browser window's
 * page area is drawn by the main process with the same look. These re-exports are how the
 * renderer's call sites keep saying `PANEL_GAP` / `RADIUS_INNER` without a second copy of the
 * values existing.
 */
export { PANEL_EDGE_INSET, PANEL_GAP }

/** Corner radius for panel edges touching the window boundary (macOS native corners → larger) */
export const RADIUS_EDGE = isMac ? PANEL_RADIUS_EDGE.darwin : PANEL_RADIUS_EDGE.other

/** Corner radius for interior corners between panels */
export const RADIUS_INNER = PANEL_RADIUS_INNER

/** Minimum width for any content panel */
export const PANEL_MIN_WIDTH = 440

/** Extra vertical space reserved in panel stack for box-shadows. */
export const PANEL_STACK_VERTICAL_OVERFLOW = 8

/**
 * Shared resize sash geometry.
 *
 * Keep all seams (sidebar, navigator/content, panel/panel) aligned by deriving
 * offsets from these constants instead of hardcoded pixel literals.
 */
export const PANEL_SASH_HIT_WIDTH = 8
export const PANEL_SASH_LINE_WIDTH = 2

/**
 * When the sash is inserted between two flex items, flex gap would apply twice
 * (item↔sash and sash↔item). Pull it back by half the gap on both sides so
 * the visible distance remains exactly PANEL_GAP.
 */
export const PANEL_SASH_FLEX_MARGIN = -(PANEL_GAP / 2)

/** Half-width helper for centering sash containers on seam coordinates. */
export const PANEL_SASH_HALF_HIT_WIDTH = PANEL_SASH_HIT_WIDTH / 2
