/**
 * Patch header markers — what a change says about itself.
 *
 * A patch file's **name** says where it applies (`patches/<page>/…`) and which
 * lane wrote it (`{lane}-{nnn}-…`), but a name cannot say what element it is
 * aimed at or which requirement it serves. Both used to live only in the
 * conversation, which is the one place the next reader cannot look. So they are
 * written into the file as markers and parsed here:
 *
 * ```css
 * /* @target .pay-btn   @requirement R-001 *\/
 * .pay-btn { border-radius: 8px; }
 * ```
 *
 * Parsing them in one place is what makes the two edges available everywhere
 * without a second mechanism:
 *
 * - `@requirement` is the edge to `prd.md` (see `coverage.ts`) — the *why* of a
 *   change.
 * - `@target` is the edge to the element on the page — which is what lets a
 *   patch be **checked** rather than merely replayed. An apply counts what the
 *   selector matched, and the anchor record (`anchors.ts`) says whether that
 *   count changed since the patch was written, which is the difference between
 *   "the site moved" and "the selector was wrong".
 *
 * Tolerance is the same as `@requirement` already had: an unrecognised marker is
 * a note to self rather than a broken reference, and a missing marker means "not
 * declared" rather than "guessed at".
 *
 * **Imports nothing**, like `types.ts`, and for a related reason: `storage.ts`
 * needs this parser and `requirements.ts` re-exports it, so a cycle had to be
 * avoided by where the function lives rather than by how it is called.
 *
 * @see docs/prototype-workbench-plan.md §21.1
 */

const TARGET_MARKER = '@target'
const REQUIREMENT_MARKER = '@requirement'

export interface PrototypePatchHeader {
  /** Requirement ids the patch declares, normalized and de-duplicated. */
  requirements: string[]
  /** The selectors the patch is aimed at, in the order it declares them. */
  targets: string[]
}

/**
 * The index of the first `marker` on the line that is a marker and not part of a
 * word — `not-a-@target-marker` is prose, and reading a selector out of it would
 * invent one.
 */
function markerIndex(line: string, marker: string): number {
  let from = 0
  for (;;) {
    const index = line.indexOf(marker, from)
    if (index === -1) return -1
    const before = index === 0 ? '' : (line[index - 1] ?? '')
    if (!/[\w-]/.test(before)) return index
    from = index + 1
  }
}

/**
 * Normalize a requirement id written by hand.
 *
 * `r1`, `R-1`, `R-001` and `R-0001` are the same requirement: ids are written by
 * hand in three kinds of file, so this tolerance is what keeps a typo in a
 * reference from silently meaning "no such requirement".
 */
export function normalizeRequirementId(value: string): string | null {
  const match = /^R-?(\d{1,4})$/i.exec(value.trim())
  if (!match) return null
  return `R-${String(Number(match[1])).padStart(3, '0')}`
}

/**
 * The requirement ids a patch header, a page comment or a finding declares.
 *
 * A declaration is `@requirement R-001`, optionally with more ids on the same
 * line (`@requirement R-001 R-002` or `…, R-002`). Everything after the marker on
 * that line is read, so the marker can be followed by a reason: writing why a
 * change exists next to the id it serves is the behaviour this is meant to
 * encourage, not to reject.
 *
 * Unknown spellings are ignored rather than guessed at: a line that says
 * `@requirement TBD` is a note to self, and treating it as a reference to a
 * requirement would invent an id.
 */
export function extractRequirementIds(source: string): string[] {
  const ids: string[] = []
  const seen = new Set<string>()

  for (const line of source.split('\n')) {
    const marker = markerIndex(line, REQUIREMENT_MARKER)
    if (marker === -1) continue

    for (const match of line.slice(marker + REQUIREMENT_MARKER.length).matchAll(/R-?\d{1,4}/gi)) {
      const id = normalizeRequirementId(match[0])
      if (!id || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }

  return ids
}

/**
 * Strip what surrounds a selector on its own line: the comment terminator a
 * marker is written inside, quotes someone wrapped it in, and a leading
 * separator (`@target: .x` / `@target = .x`).
 */
function cleanTargetValue(raw: string): string {
  let value = raw
  // A marker is usually inside a comment, so the terminator of that comment is
  // part of the line and not part of the selector.
  for (const terminator of ['*/', '-->', '#}', '--}}']) {
    const cut = value.indexOf(terminator)
    if (cut !== -1) value = value.slice(0, cut)
  }
  value = value.trim().replace(/^[:=]\s*/, '').trim()
  if (
    (value.startsWith('`') && value.endsWith('`')) ||
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim()
  }
  return value
}

/**
 * The selectors a patch declares it is aimed at.
 *
 * A **list**, not one selector, and that is not a convenience: `prototype-commit`
 * folds several patches into one file and writes each source's marker into the
 * provenance comment it leaves behind. If only the first marker were read, every
 * other anchor would look like a patch that no longer exists — the record would
 * go stale the moment it was most useful (plan §21.3).
 *
 * Everything after the marker on that line is the selector, so a selector
 * containing spaces works. A value that is empty, or the literal `TBD`, is a
 * note to self and is skipped rather than reported as a selector that matches
 * nothing.
 */
export function extractPatchTargets(source: string): string[] {
  const targets: string[] = []
  const seen = new Set<string>()

  for (const line of source.split('\n')) {
    const marker = markerIndex(line, TARGET_MARKER)
    if (marker === -1) continue

    const value = cleanTargetValue(line.slice(marker + TARGET_MARKER.length))
    if (value.length === 0 || /^tbd$/i.test(value)) continue
    if (seen.has(value)) continue
    seen.add(value)
    targets.push(value)
  }

  return targets
}

/** Both markers of one patch, parsed in a single pass over its lines. */
export function extractPatchHeader(source: string): PrototypePatchHeader {
  return {
    requirements: extractRequirementIds(source),
    targets: extractPatchTargets(source),
  }
}
