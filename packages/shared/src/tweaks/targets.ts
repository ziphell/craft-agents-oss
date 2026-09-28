/**
 * What a tweak expects to find on the page, and what it actually matched.
 *
 * A tweak's code is applied wholesale — there is no per-line declaration language, and
 * inventing one would be a second way to write CSS and JS. What there is instead is the
 * same single marker a patch writes (`../markers.ts`):
 *
 *   /* @target .cart-total *\/
 *   .cart-total { font-variant-numeric: tabular-nums; }
 *
 * It earns its place because of what happens **later**. A tweak keeps running on a page
 * somebody else redesigns; the selector stops matching; nothing says so, and the page
 * quietly loses something nobody notices until a person complains. The marker is what
 * lets the answer be recorded — which selectors matched, and which used to — instead of
 * leaving "the page moved" and "the tweak stopped being delivered" to look identical.
 *
 * A tweak that declares no target is simply not checked. Nothing here is required.
 */

import { existsSync, readFileSync } from 'fs'
import { cleanMarkerValue, markerIndex } from '../markers.ts'
import { atomicWriteFileSync } from '../utils/files.ts'
import type { TweakHits, TweakTargetHit } from './types.ts'

const TARGET_MARKER = '@target'

/**
 * The targets one source file declares, in the order it declares them.
 *
 * Everything after the marker on its line is the selector, so a selector containing
 * spaces works. An empty value, or the literal `TBD`, is a note to self rather than a
 * selector that matches nothing.
 */
export function extractTweakTargets(source: string, file: TweakTargetHit['file']): TweakTargetHit[] {
  const targets: TweakTargetHit[] = []
  const seen = new Set<string>()

  for (const line of source.split('\n')) {
    const marker = markerIndex(line, TARGET_MARKER)
    if (marker === -1) continue

    const selector = cleanMarkerValue(line.slice(marker + TARGET_MARKER.length))
    if (selector.length === 0 || /^tbd$/i.test(selector)) continue
    if (seen.has(selector)) continue
    seen.add(selector)
    targets.push({ selector, file })
  }

  return targets
}

/** Every target a tweak declares, across the files it actually has. */
export function tweakTargets(sources: { css: string | null; js: string | null }): TweakTargetHit[] {
  return [
    ...(sources.css === null ? [] : extractTweakTargets(sources.css, 'tweak.css')),
    ...(sources.js === null ? [] : extractTweakTargets(sources.js, 'tweak.js')),
  ]
}

/**
 * Read a tweak's hit record, or null when there is none.
 *
 * A damaged file reads as "no record" rather than throwing: a record is evidence about a
 * page, and the honest answer to unreadable evidence is to say nothing rather than to
 * fail the thing that was asking.
 */
export function parseTweakHits(source: string): TweakHits | null {
  try {
    const parsed = JSON.parse(source) as TweakHits
    if (!parsed || !Array.isArray(parsed.targets)) return null
    return parsed
  } catch {
    return null
  }
}

export function readTweakHits(hitsPath: string): TweakHits | null {
  if (!existsSync(hitsPath)) return null
  try {
    return parseTweakHits(readFileSync(hitsPath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * The record after applying a tweak on one page: the targets that matched get a time and
 * the address they matched on, and the ones that did not keep whatever they had.
 *
 * Keeping the old time is the point — it is what separates "this has never matched"
 * (absent) from "this stopped matching" (a time, and no new one), and only the second
 * one means the page moved.
 */
export function recordTweakHits(
  hits: TweakHits | null,
  targets: TweakTargetHit[],
  matched: ReadonlySet<string>,
  url: string,
  now: number,
): TweakHits {
  const previous = new Map((hits?.targets ?? []).map((hit) => [hit.selector, hit]))

  return {
    schemaVersion: 1,
    updatedAt: now,
    targets: targets.map((target) => {
      if (matched.has(target.selector)) {
        return { ...target, lastMatchedAt: now, lastMatchedUrl: url }
      }

      // Not matched this time: keep the last time it *did* match, which is the whole
      // difference between "never matched" (no time at all) and "stopped matching"
      // (a time, and no new one — the page moved). The selector and file come from the
      // current source, since that is where a reader has to go and fix it.
      const before = previous.get(target.selector)
      return before?.lastMatchedAt === undefined
        ? target
        : { ...target, lastMatchedAt: before.lastMatchedAt, lastMatchedUrl: before.lastMatchedUrl }
    }),
  }
}

/** Write a tweak's hit record. Only ever called with what an apply actually saw. */
export function writeTweakHits(hitsPath: string, hits: TweakHits): void {
  atomicWriteFileSync(hitsPath, `${JSON.stringify(hits, null, 2)}\n`)
}
