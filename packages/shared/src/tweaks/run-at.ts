/**
 * When a tweak's JavaScript runs.
 *
 * The three moments are the **browser's own** (`content_scripts.run_at`), because the
 * extension carrier *is* a content script and this is the one thing besides the patterns the
 * two carriers have to agree on: a tweak that needs the DOM, delivered before it in one
 * carrier and after it in the other, would be two different tweaks.
 *
 *   /* @run-at document_end *\/
 *
 * - `document_start` — before any DOM exists. For a tweak that has to get in front of the
 *   page's own scripts; anything that touches elements finds none.
 * - `document_end` — as soon as the DOM is complete, which is what `DOMContentLoaded` marks.
 *   Where a tweak that changes what is on a page belongs, and **the default**.
 * - `document_idle` — whenever the browser gets round to it, after `load`. The platform's own
 *   default, chosen to keep pages loading fast; a tweak exists to change a page, so it is not
 *   ours, and `document_end` is the earliest moment that is safe.
 *
 * Read from `tweak.js` first — the timing is its own — then `tweak.css`. A value that is not
 * one of the three is ignored, and a tweak that declares nothing runs at `document_end`.
 *
 * `@run-at` says nothing about the stylesheet. CSS is inserted before the DOM exists whatever
 * this says, because that is what stops the page flashing the state the tweak is there to
 * change; a tweak whose JavaScript *creates* what its CSS styles may still want
 * `document_start` and a wait of its own.
 */

import { cleanMarkerValue, markerIndex } from '../markers.ts'

const RUN_AT_MARKER = '@run-at'

export const TWEAK_RUN_AT_VALUES = ['document_start', 'document_end', 'document_idle'] as const

export type TweakRunAt = (typeof TWEAK_RUN_AT_VALUES)[number]

/** Where a tweak runs when it declares nothing — see the note above for why not `idle`. */
export const TWEAK_RUN_AT_DEFAULT: TweakRunAt = 'document_end'

function isTweakRunAt(value: string): value is TweakRunAt {
  return (TWEAK_RUN_AT_VALUES as readonly string[]).includes(value)
}

/** The moment one source file declares, or null when it declares none (or not a moment). */
function declaredRunAt(source: string | null): TweakRunAt | null {
  if (source === null) return null

  for (const line of source.split('\n')) {
    const marker = markerIndex(line, RUN_AT_MARKER)
    if (marker === -1) continue

    const value = cleanMarkerValue(line.slice(marker + RUN_AT_MARKER.length))
    if (isTweakRunAt(value)) return value
  }

  return null
}

/** When a tweak's JavaScript runs: what its own files declare, or the default. */
export function tweakRunAt(sources: { css: string | null; js: string | null }): TweakRunAt {
  return declaredRunAt(sources.js) ?? declaredRunAt(sources.css) ?? TWEAK_RUN_AT_DEFAULT
}
