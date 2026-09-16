/**
 * Prototype anchors — what a patch was aimed at, and whether it is still there.
 *
 * A patch's selector is written against the DOM of the day, and that DOM is not
 * ours: a live page gets redeployed and the selector quietly matches nothing.
 * "Matched nothing" looks exactly like "the patch did nothing", which is the
 * class of silent failure this workbench spends the most effort avoiding. The
 * fix is not to keep a copy of the page (that is the deleted "freeze the live
 * page into `base.html`" idea — a copy runs none of the page's own JavaScript
 * and carries none of its session). It is to keep a **record of the anchors**:
 * which selector was used, what it matched at the time, and when.
 *
 * That record is the overlay's **virtual base** — the thing a delta is a delta
 * *against*, even though the page itself is not, and never will be, ours. It
 * buys three facts that are unavailable without it:
 *
 * - **checked, not merely replayed** — an apply counts what each declared
 *   `@target` matched (`patch-script.ts` reports it), so a patch that matched
 *   nothing is named instead of being indistinguishable from a no-op;
 * - **drift** — an anchor that matched when it was recorded and matches nothing
 *   now means *the page moved*, which is a different problem with a different
 *   fix than "the selector was wrong when you wrote it";
 * - **re-anchoring** — a fingerprint (tag, text, attributes, a structural path)
 *   is enough to propose a selector for the element that moved, so drift is
 *   recoverable rather than only reportable.
 *
 * Files live under `anchors/`, one per scope: `anchors/<page>.json` for a page's
 * own patches and `anchors/shared.json` for the ones that replay everywhere.
 * The name avoids "base" on purpose — a `base.html` is a document, and this is
 * not one; nothing here is ever rendered or replayed.
 *
 * Recording is a **by-product of use**: the control plane writes (and refreshes)
 * the fingerprint when an apply actually matched, on the page that is in front
 * of it. There is no crawler and no capture step, which is the only reason a
 * record like this stays true instead of decaying into a second thing to
 * maintain. The file is rebuildable from the patches plus one apply, so it is
 * not a shared index any lane has to coordinate on.
 *
 * @see docs/prototype-workbench-plan.md §21.2
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getPrototypeAnchorsPath } from './storage.ts'
import { PROTOTYPE_ANCHORS_DIRNAME } from './types.ts'
import type { PrototypePatch } from './types.ts'

/** What one target matched, captured so it can be compared later. */
export interface PrototypeAnchorFingerprint {
  /** Lower-case tag name, e.g. `button`. */
  tag: string
  /** Collapsed `textContent`, capped — the part a person recognises. */
  text: string
  /** A structural selector from the document root, for when nothing else is left. */
  path: string
  /** Candidate stable selectors (`#id`, `[data-role="pay"]`, `.a.b`) in preference order. */
  attrs: string[]
}

/** One selector a patch declares, and what it matched. */
export interface PrototypeAnchor {
  /** The selector as declared by `@target`. */
  target: string
  /** Patches that declare it, as `patches/…` paths. */
  patches: string[]
  /** What it matched when it was recorded. */
  fingerprint: PrototypeAnchorFingerprint
  /** When it was first seen to match. */
  firstSeenAt: string
  /** When it last matched — unchanged when the anchor later stopped matching. */
  lastMatchedAt: string
  /** Elements matched by the most recent apply (0 = the page moved, or the selector never worked). */
  matched: number
}

/** One scope's anchors, as stored on disk. */
export interface PrototypeAnchorFile {
  /** The page name, or null for the shared scope (`anchors/shared.json`). */
  page: string | null
  /** The address the anchors were observed on — a live page's location when recorded. */
  url: string | null
  /** When the file was last written. */
  updatedAt: string
  anchors: PrototypeAnchor[]
}

/** What one apply observed about one target. */
export interface PrototypeAnchorObservation {
  target: string
  /** Elements matched on the page at apply time. */
  matched: number
  /** Patches that declare this target in the current scan, as `patches/…` paths. */
  patches: string[]
  /** What the first match looked like, or null when nothing matched. */
  fingerprint: PrototypeAnchorFingerprint | null
}

/** `anchors/shared.json` — the scope name of the patches that replay on every page. */
export const SHARED_ANCHOR_SCOPE = 'shared'

/** File name for a scope: `shared` for the shared patches, otherwise the page name. */
function scopeFileName(scope: string | null): string {
  return `${scope ?? SHARED_ANCHOR_SCOPE}.json`
}

function parseAnchorFile(source: string, fallbackPage: string | null): PrototypeAnchorFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const record = parsed as Record<string, unknown>
  const anchors: PrototypeAnchor[] = []
  const rawAnchors = Array.isArray(record.anchors) ? record.anchors : []

  for (const raw of rawAnchors) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    const target = typeof entry.target === 'string' ? entry.target : null
    if (!target) continue

    const rawFingerprint = (entry.fingerprint ?? {}) as Record<string, unknown>
    anchors.push({
      target,
      patches: Array.isArray(entry.patches)
        ? entry.patches.filter((value): value is string => typeof value === 'string')
        : [],
      fingerprint: {
        tag: typeof rawFingerprint.tag === 'string' ? rawFingerprint.tag : '',
        text: typeof rawFingerprint.text === 'string' ? rawFingerprint.text : '',
        path: typeof rawFingerprint.path === 'string' ? rawFingerprint.path : '',
        attrs: Array.isArray(rawFingerprint.attrs)
          ? rawFingerprint.attrs.filter((value): value is string => typeof value === 'string')
          : [],
      },
      firstSeenAt: typeof entry.firstSeenAt === 'string' ? entry.firstSeenAt : '',
      lastMatchedAt: typeof entry.lastMatchedAt === 'string' ? entry.lastMatchedAt : '',
      matched: typeof entry.matched === 'number' && Number.isFinite(entry.matched) ? entry.matched : 0,
    })
  }

  const page = typeof record.page === 'string' ? record.page : fallbackPage
  return {
    page,
    url: typeof record.url === 'string' ? record.url : null,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    anchors,
  }
}

/**
 * Read one scope's anchors.
 *
 * Tolerant in the same way every other reader here is: a missing file is "never
 * recorded" (the honest state of a prototype nobody has applied yet) and an
 * unreadable one must not make the prototype unusable. Neither is silent — the
 * status report says which scopes exist, so an empty answer here is a fact
 * rather than a guess.
 */
export function readPrototypeAnchors(
  workspaceRootPath: string,
  slug: string,
  scope: string | null,
): PrototypeAnchorFile | null {
  const path = join(getPrototypeAnchorsPath(workspaceRootPath, slug), scopeFileName(scope))
  if (!existsSync(path)) return null
  try {
    return parseAnchorFile(readFileSync(path, 'utf-8'), scope)
  } catch {
    return null
  }
}

/** Every scope that has a record, for the status report. */
export function readAllPrototypeAnchors(workspaceRootPath: string, slug: string): PrototypeAnchorFile[] {
  const dir = getPrototypeAnchorsPath(workspaceRootPath, slug)
  if (!existsSync(dir)) return []

  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }

  const files: PrototypeAnchorFile[] = []
  for (const name of names) {
    const scope = name.slice(0, -'.json'.length)
    const file = readPrototypeAnchors(workspaceRootPath, slug, scope === SHARED_ANCHOR_SCOPE ? null : scope)
    if (file) files.push(file)
  }
  return files
}

/**
 * Merge what an apply observed into a scope's record and write it.
 *
 * Merge, never replace: an anchor whose target matched nothing is **kept** with
 * its old fingerprint. Dropping it would erase exactly the evidence that says
 * the page moved — the next apply would then look like a first apply, and drift
 * would be indistinguishable from a selector that never worked.
 */
export function recordPrototypeAnchors(
  workspaceRootPath: string,
  slug: string,
  scope: string | null,
  input: { url: string | null; observed: PrototypeAnchorObservation[]; now?: Date },
): PrototypeAnchorFile {
  const now = (input.now ?? new Date()).toISOString()
  const existing = readPrototypeAnchors(workspaceRootPath, slug, scope)
  const byTarget = new Map<string, PrototypeAnchor>()

  for (const anchor of existing?.anchors ?? []) byTarget.set(anchor.target, anchor)

  for (const observation of input.observed) {
    const previous = byTarget.get(observation.target)
    const matched = observation.fingerprint ? observation.matched : 0

    byTarget.set(observation.target, {
      target: observation.target,
      patches: observation.patches,
      // A failed match keeps the fingerprint it was recorded with; that is what
      // the re-anchor suggestion compares against.
      fingerprint: observation.fingerprint ?? previous?.fingerprint ?? { tag: '', text: '', path: '', attrs: [] },
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastMatchedAt: observation.fingerprint ? now : (previous?.lastMatchedAt ?? ''),
      matched,
    })
  }

  const file: PrototypeAnchorFile = {
    page: scope,
    url: input.url ?? existing?.url ?? null,
    updatedAt: now,
    anchors: [...byTarget.values()].sort((a, b) => a.target.localeCompare(b.target)),
  }

  const dir = getPrototypeAnchorsPath(workspaceRootPath, slug)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, scopeFileName(scope)), `${JSON.stringify(file, null, 2)}\n`, 'utf-8')
  } catch {
    // A record that cannot be written must not fail the apply it describes: the
    // replay itself already happened.
  }

  return file
}

/** The two ways an anchor and the patches on disk can disagree. */
export interface PrototypeAnchorReport {
  /**
   * Anchors that stopped matching: recorded with a fingerprint, and the latest
   * apply found nothing. The page moved — re-anchor rather than rewrite.
   */
  drifted: PrototypeAnchor[]
  /**
   * Anchors no current patch declares any more: the patch was edited or deleted
   * and the record outlived it. Not a failure, but noise that should be cleaned.
   */
  orphaned: PrototypeAnchor[]
}

/**
 * Compare a record against the current scan.
 *
 * The disk-derived half of drift: `orphaned` needs nothing but the files, so the
 * status report can name it without a browser. The runtime half (`drifted`
 * because the page changed) needs an apply and is computed from live match
 * counts — see `apply-prototype.ts`.
 */
export function resolveAnchorOrphans(
  files: PrototypeAnchorFile[],
  patches: PrototypePatch[],
): PrototypeAnchorReport {
  const declared = new Set<string>()
  for (const patch of patches) {
    for (const target of patch.targets) declared.add(target)
  }

  const orphaned: PrototypeAnchor[] = []
  for (const file of files) {
    for (const anchor of file.anchors) {
      if (!declared.has(anchor.target)) orphaned.push(anchor)
    }
  }

  return { drifted: [], orphaned }
}

/**
 * The anchors that matched when recorded and are not matching now.
 *
 * Called with a record and one apply's observations, so it answers a question
 * that only a browser can: has this page moved since we wrote against it? The
 * ones with no record at all are a different fact — a selector that has never
 * worked — and are reported separately by the caller.
 */
export function resolveAnchorDrift(
  file: PrototypeAnchorFile | null,
  observed: PrototypeAnchorObservation[],
): PrototypeAnchor[] {
  if (!file) return []

  const observedByTarget = new Map(observed.map((entry) => [entry.target, entry]))
  const drifted: PrototypeAnchor[] = []

  for (const anchor of file.anchors) {
    const observation = observedByTarget.get(anchor.target)
    if (!observation) continue
    if (observation.matched > 0) continue
    // Recorded with nothing to compare against is not drift — it is a patch
    // whose `@target` was never seen to match in the first place.
    if (anchor.lastMatchedAt === '') continue
    drifted.push(anchor)
  }

  return drifted
}

/**
 * Forget the anchors for targets that no longer point at someone else's page.
 *
 * Called by a commit that folded a **scratch** page's patches into that page's
 * own document: after that the element is in a file we own, so there is nothing
 * to drift against, and keeping the record would only report every one of them as
 * orphaned. A commit over a live page does the opposite and keeps them — the page
 * is still someone else's, which is exactly when a drift check is worth having.
 */
export function dropPrototypeAnchors(
  workspaceRootPath: string,
  slug: string,
  scope: string | null,
  targets: string[],
): PrototypeAnchorFile | null {
  const existing = readPrototypeAnchors(workspaceRootPath, slug, scope)
  if (!existing || targets.length === 0) return existing

  const drop = new Set(targets)
  const kept: PrototypeAnchorFile = {
    ...existing,
    updatedAt: new Date().toISOString(),
    anchors: existing.anchors.filter((anchor) => !drop.has(anchor.target)),
  }

  const path = join(getPrototypeAnchorsPath(workspaceRootPath, slug), scopeFileName(scope))
  try {
    writeFileSync(path, `${JSON.stringify(kept, null, 2)}\n`, 'utf-8')
  } catch {
    // Same rule as recording: losing the record must not fail the work it describes.
  }
  return kept
}

/**
 * The shared helpers every anchor script needs: a structural path and a
 * fingerprint. Interpolated into the generated expressions rather than fetched,
 * because the injected script has to be self-contained.
 */
const ANCHOR_HELPERS = `
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(part); break; }
      const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
      if (sameTag.length > 1) part = part + ':nth-child(' + (Array.prototype.indexOf.call(parent.children, node) + 1) + ')';
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };
  const fingerprintOf = (el) => {
    const attrs = [];
    const id = el.getAttribute && el.getAttribute('id');
    if (id && /^[A-Za-z][\\w-]*$/.test(id)) attrs.push('#' + id);
    const classes = (el.getAttribute && el.getAttribute('class')) || '';
    const cls = classes.trim().split(/\\s+/).filter(Boolean).slice(0, 3);
    if (cls.length > 0) attrs.push('.' + cls.join('.'));
    for (const attr of Array.prototype.slice.call(el.attributes || [])) {
      if (attr.name.startsWith('data-')) attrs.push('[' + attr.name + '="' + attr.value + '"]');
    }
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
      path: cssPath(el),
      attrs,
    };
  };
`

/**
 * An expression that describes what each target matched, or null for none.
 *
 * Run through `evaluate` on the live page right after an apply, so the record
 * describes the page that was actually patched rather than the one that was
 * expected.
 */
export function buildAnchorProbeScript(targets: string[]): string {
  return [
    '(() => {',
    ANCHOR_HELPERS,
    `  const targets = ${JSON.stringify(targets)};`,
    '  const out = {};',
    '  for (const target of targets) {',
    '    try {',
    '      const el = document.querySelector(target);',
    '      out[target] = el ? fingerprintOf(el) : null;',
    '    } catch {',
    // An invalid selector is "nothing matched", which is reported as such rather
    // than thrown: a broken selector must not abort the probe of the others.
    '      out[target] = null;',
    '    }',
    '  }',
    '  return out;',
    '})()',
  ].join('\n')
}

/**
 * An expression that proposes selectors for elements a drifted anchor used to
 * point at — a candidate per target, best first, empty when nothing is close.
 *
 * Deliberately conservative: it only proposes a selector that resolves to
 * exactly one element on the page as it is now, and it prefers the recorded
 * stable attributes over text matching. A wrong suggestion costs more than no
 * suggestion, because it is accepted and then silently patches the wrong thing.
 */
export function buildAnchorCandidateScript(
  entries: Array<{ target: string; fingerprint: PrototypeAnchorFingerprint }>,
): string {
  return [
    '(() => {',
    ANCHOR_HELPERS,
    `  const entries = ${JSON.stringify(entries)};`,
    '  const out = {};',
    '  const unique = (selector) => {',
    '    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }',
    '  };',
    '  for (const entry of entries) {',
    '    const found = [];',
    '    for (const candidate of entry.fingerprint.attrs || []) {',
    '      if (unique(candidate) && !found.includes(candidate)) found.push(candidate);',
    '      if (found.length >= 3) break;',
    '    }',
    '    if (found.length < 3 && entry.fingerprint.text) {',
    '      const want = entry.fingerprint.text;',
    '      const sameTag = Array.prototype.filter.call(',
    '        document.getElementsByTagName(entry.fingerprint.tag || "*"),',
    '        (el) => (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80) === want,',
    '      );',
    '      for (const el of sameTag) {',
    '        const candidate = fingerprintOf(el).path;',
    '        if (unique(candidate) && !found.includes(candidate)) found.push(candidate);',
    '        if (found.length >= 3) break;',
    '      }',
    '    }',
    '    out[entry.target] = found;',
    '  }',
    '  return out;',
    '})()',
  ].join('\n')
}

/** The directory name, re-exported so a reader of anchors needs no second import. */
export { PROTOTYPE_ANCHORS_DIRNAME }
