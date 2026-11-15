/**
 * Subtitle housekeeping — the batch edits a transcript needs before it is usable.
 *
 * A transcript arrives as a hundred cues that share one look, are often a line late, and may
 * repeat a sentence the recogniser emitted twice. Doing that one cue at a time is the slowest
 * possible path, so these are the pure operations a batch is made of: shift, replace, dedupe and
 * one style for every line. They touch **subtitle** overlays only — a title or a 花字 is a
 * graphic and is never moved by a caption edit.
 *
 * Pure functions: the document in, the document out, no `fs` and no DOM.
 */

import type { EditDocument } from './document.ts'
import { type EditOverlay, type TextPreset, type TextStyle } from './overlay.ts'
import { isSubtitleOverlay } from './srt.ts'

/** A window on the timeline, in seconds, used to limit a batch to part of the cut. */
export interface SubtitleRange {
  /** Inclusive start; cues before it are left alone. */
  from?: number
  /** Exclusive end; cues at or after it are left alone. */
  to?: number
}

export const subtitleOverlaysOf = (doc: EditDocument): EditOverlay[] =>
  doc.overlays.filter(isSubtitleOverlay)

const inRange = (overlay: EditOverlay, range?: SubtitleRange): boolean => {
  if (!range) return true
  if (range.from !== undefined && overlay.start < range.from) return false
  if (range.to !== undefined && overlay.start >= range.to) return false
  return true
}

/** Move every subtitle in range by `by` seconds; a cue that would start before zero stops at 0. */
export function shiftSubtitles(
  doc: EditDocument,
  by: number,
  range?: SubtitleRange,
): EditDocument {
  if (!Number.isFinite(by) || by === 0) return doc
  return {
    ...doc,
    overlays: doc.overlays.map((overlay) =>
      isSubtitleOverlay(overlay) && inRange(overlay, range)
        ? { ...overlay, start: Math.max(0, overlay.start + by) }
        : overlay,
    ),
  }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Replace words inside subtitle text.
 *
 * The match is literal, not a pattern: a transcript's "(" should not become a regex group. With
 * `wholeWords`, ASCII word characters on either side stop a match, so `cat` does not rewrite
 * `concatenate`; CJK text has no such boundaries and is replaced wherever it occurs.
 */
export function replaceSubtitleText(
  doc: EditDocument,
  find: string,
  replace: string,
  options: { matchCase?: boolean; wholeWords?: boolean } = {},
): EditDocument {
  if (!find) return doc
  const source = escapeRegExp(find)
  const pattern = options.wholeWords ? `(?<![\\w])${source}(?![\\w])` : source
  const regex = new RegExp(pattern, options.matchCase ? 'g' : 'gi')
  return {
    ...doc,
    overlays: doc.overlays.map((overlay) => {
      if (!isSubtitleOverlay(overlay) || !overlay.text) return overlay
      const text = overlay.text.replace(regex, replace)
      return text === overlay.text ? overlay : { ...overlay, text }
    }),
  }
}

const compactText = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Drop repeated cues: the same words starting within `window` seconds of each other.
 *
 * Of a repeated pair the longer one is kept — a recogniser often emits the same sentence twice
 * with the second copy cut short. Different words on the same frame are a real edit, so only
 * text-identical cues are considered duplicates.
 */
export function dedupeSubtitles(doc: EditDocument, window = 0.02): EditDocument {
  const subtitles = subtitleOverlaysOf(doc)
    .slice()
    .sort((left, right) => left.start - right.start)
  const dropped = new Set<string>()
  for (let index = 0; index < subtitles.length; index += 1) {
    const current = subtitles[index]!
    if (dropped.has(current.id)) continue
    for (let next = index + 1; next < subtitles.length; next += 1) {
      const candidate = subtitles[next]!
      if (candidate.start - current.start > window) break
      if (compactText(candidate.text ?? '') !== compactText(current.text ?? '')) continue
      if (current.duration >= candidate.duration) {
        dropped.add(candidate.id)
      } else {
        dropped.add(current.id)
        break
      }
    }
  }
  if (dropped.size === 0) return doc
  return { ...doc, overlays: doc.overlays.filter((overlay) => !dropped.has(overlay.id)) }
}

/** Drop every subtitle in range — the other half of a re-transcription. Titles and 花字 stay. */
export function clearSubtitles(doc: EditDocument, range?: SubtitleRange): EditDocument {
  const dropped = new Set(
    subtitleOverlaysOf(doc)
      .filter((overlay) => inRange(overlay, range))
      .map((overlay) => overlay.id),
  )
  if (dropped.size === 0) return doc
  return { ...doc, overlays: doc.overlays.filter((overlay) => !dropped.has(overlay.id)) }
}

/** Merge one style into every subtitle in range; `preset` switches the base look as well. */
export function styleSubtitles(
  doc: EditDocument,
  style: TextStyle,
  options: { preset?: TextPreset; range?: SubtitleRange } = {},
): EditDocument {
  return {
    ...doc,
    overlays: doc.overlays.map((overlay) => {
      if (!isSubtitleOverlay(overlay) || !inRange(overlay, options.range)) return overlay
      return {
        ...overlay,
        ...(options.preset ? { preset: options.preset } : {}),
        style: { ...overlay.style, ...style },
      }
    }),
  }
}
