/**
 * What a playbook's steps aim at, and what a run actually found.
 *
 * A playbook is a skill whose body is a set of steps, and a step that presses something has to
 * say **which** thing — otherwise "the page moved and this stopped working" is
 * indistinguishable from "this never worked", and the playbook breaks quietly on somebody
 * else's redesign. So a step may declare its target with a marker on its own line:
 *
 *   - Press the Export button. <!-- @anchor .toolbar .export -->
 *
 * It is a markdown comment, so the reader of the skill sees a step and nothing else; and it is
 * the same `@word …` marker a tweak writes (`../markers.ts`), which is what makes the comment's
 * terminator come off without a second parser.
 *
 * A **run** — a conversation following those steps — checks them and writes what it saw to
 * `hits.json` beside `SKILL.md`. Only a run writes it: a record somebody could have typed says
 * nothing, which is the whole reason the file is evidence rather than notes. Keeping the old
 * time is the point, exactly as it is for a tweak: no time means "never matched", a time and no
 * new one means "it stopped matching".
 *
 * Declaring nothing is allowed and means the playbook is simply not checked.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { markerIndex, cleanMarkerValue } from '../markers.ts'
import { atomicWriteFileSync } from '../utils/files.ts'
import { getWorkspaceSkillsPath } from '../workspaces/storage.ts'
import { SKILL_HITS_FILENAME, type SkillAnchorHit, type SkillHits } from './types.ts'

const ANCHOR_MARKER = '@anchor'

/**
 * The anchors a skill body declares, in the order it declares them.
 *
 * Everything after the marker on its line is the selector — up to the comment that closes it —
 * so a selector containing spaces works. An empty value, or the literal `TBD`, is a note to self
 * rather than a selector that matches nothing.
 */
export function parseAnchors(content: string): string[] {
  const anchors: string[] = []
  const seen = new Set<string>()

  for (const line of content.split('\n')) {
    const marker = markerIndex(line, ANCHOR_MARKER)
    if (marker === -1) continue

    const selector = cleanMarkerValue(line.slice(marker + ANCHOR_MARKER.length))
    if (selector.length === 0 || /^tbd$/i.test(selector)) continue
    if (seen.has(selector)) continue
    seen.add(selector)
    anchors.push(selector)
  }

  return anchors
}

/** Where a skill's hit record goes: beside the `SKILL.md` it is about. */
export function getSkillHitsPath(workspaceRootPath: string, slug: string): string {
  return join(getWorkspaceSkillsPath(workspaceRootPath), slug, SKILL_HITS_FILENAME)
}

/**
 * Read a hit record, or null when there is none.
 *
 * A damaged file reads as "no record" rather than throwing: a record is evidence about a page,
 * and the honest answer to unreadable evidence is to say nothing rather than to fail the thing
 * that was asking.
 */
export function parseSkillHits(source: string): SkillHits | null {
  try {
    const parsed = JSON.parse(source) as SkillHits
    if (!parsed || !Array.isArray(parsed.targets)) return null
    return parsed
  } catch {
    return null
  }
}

export function readSkillHits(hitsPath: string): SkillHits | null {
  if (!existsSync(hitsPath)) return null
  try {
    return parseSkillHits(readFileSync(hitsPath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * What a run found, and where.
 *
 * A bare set is the common case: every anchor was checked on one page, so they all share the url
 * the run reports. A map is for the playbook whose steps cross pages — the anchor's url is the page
 * its own step ran on, which is not where the run happened to end. Without it, a step one page back
 * would have to be recorded as matching on a page it was never on, or as "never matched" because the
 * run had already moved on.
 */
export type MatchedAnchors = ReadonlySet<string> | ReadonlyMap<string, string>

/** The url `selector` matched on, or null when this run did not find it. */
function matchedUrl(matched: MatchedAnchors, selector: string, fallbackUrl: string): string | null {
  if (matched instanceof Map) {
    const url = matched.get(selector)
    return typeof url === 'string' && url.length > 0 ? url : null
  }
  return matched.has(selector) ? fallbackUrl : null
}

/**
 * The record after one run: the anchors that matched get a time and the address they matched on,
 * and the ones that did not keep whatever they had.
 */
export function recordSkillHits(
  hits: SkillHits | null,
  anchors: readonly string[],
  matched: MatchedAnchors,
  url: string,
  now: number,
): SkillHits {
  const previous = new Map((hits?.targets ?? []).map((hit) => [hit.selector, hit]))

  return {
    schemaVersion: 1,
    updatedAt: now,
    targets: anchors.map((selector) => {
      const on = matchedUrl(matched, selector, url)
      if (on !== null) return { selector, lastMatchedAt: now, lastMatchedUrl: on }

      // Not matched this time: keep the last time it *did*, which is the whole difference between
      // "never matched" (no time at all) and "stopped matching" (a time, and no new one).
      const before = previous.get(selector)
      return before?.lastMatchedAt === undefined
        ? { selector }
        : { selector, lastMatchedAt: before.lastMatchedAt, lastMatchedUrl: before.lastMatchedUrl }
    }),
  }
}

/** Write a skill's hit record. Only ever called with what a run actually saw. */
export function writeSkillHits(hitsPath: string, hits: SkillHits): void {
  atomicWriteFileSync(hitsPath, `${JSON.stringify(hits, null, 2)}\n`)
}

/** The anchors of a skill's body, as the hits record needs them. */
export function skillAnchors(skill: { content: string }): SkillAnchorHit[] {
  return parseAnchors(skill.content).map((selector) => ({ selector }))
}
