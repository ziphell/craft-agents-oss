/**
 * Prototype reviews — the argument against the work.
 *
 * `research/` records what was learned **for** a requirement (a claim, its source, its evidence).
 * This records what is argued **against** the work: one dispute per file, shaped exactly like a
 * finding so the two read the same way and can be referred to from anywhere.
 *
 * ```md
 * # D-001 The total is not actually pinned while the list scrolls
 *
 * about: patch ui-001-sticky-total.css
 * on: 3f9a1c2e
 * status: open
 * claim: The summary row is not on screen once the list is longer than the viewport.
 * evidence: prototype-verify — check: selector [data-cart-total] did not match
 *
 * `position: sticky` needs a scroll container that is not the page…
 * ```
 *
 * Why it is a file rather than a line in the run log: an objection that lives only in the
 * conversation disappears with the window, and the person handed the prototype then sees a piece of
 * work nobody ever disagreed with. A verdict asks the reader to trust the transcript; a review is
 * something they can read and judge.
 *
 * Three properties, the same three `research.ts` insists on:
 *
 * - **`about:`** — what is being disputed: a patch, a page, an endpoint, or a requirement. A
 *   dispute that names nothing is an opinion, and it is reported as one.
 * - **`status:`** — `open` (it stands), `fixed` (the thing was changed), `rebutted` (judged
 *   unfounded, with the reason in the body) or `accepted` (judged valid, and the cost was taken).
 * - **`on:`** — the fingerprint of the disputed patch when the review was filed. This is what
 *   makes the record checkable: a patch dispute is reported **stale** when the file no longer
 *   hashes to it, so "argued about a version that no longer exists" cannot pass for a live
 *   objection — the same distinction `anchors/` draws for selectors (plan §21.2). It is required
 *   for a patch dispute, because a patch is one file and its fingerprint is free; the other
 *   targets span several files, so there is nothing single to fingerprint and they carry none.
 *
 * The status is checked against the disk, never trusted on its own: `open` on a patch that has
 * changed is stale, and `fixed` on a patch that has *not* changed is stale too. A record that
 * disagrees with the files is exactly the failure this module exists to name.
 *
 * Nothing here is packaged for delivery: the receiver gets the requirements and the change spec,
 * and `dev-spec.md` carries the outstanding disputes into it (`export.ts`).
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { normalizeRequirementId } from './requirements.ts'
import { getPrototypePatchesPath, getPrototypeReviewsPath, patchFingerprint } from './storage.ts'
import { PROTOTYPE_REVIEWS_DIRNAME } from './types.ts'

export { PROTOTYPE_REVIEWS_DIRNAME, getPrototypeReviewsPath }

/** What can be disputed. Deliberately the same set a check can point at (plan §20.7). */
export type PrototypeReviewTargetKind = 'patch' | 'page' | 'endpoint' | 'requirement'

export interface PrototypeReviewTarget {
  kind: PrototypeReviewTargetKind
  /** `patches/ui-001-x.css` · a page name · `GET /api/cart` · `R-003` — as written. */
  ref: string
}

export type PrototypeReviewStatus = 'open' | 'fixed' | 'rebutted' | 'accepted'

/** Every status, in the order they are worth listing: what stands first. */
export const PROTOTYPE_REVIEW_STATUSES: readonly PrototypeReviewStatus[] = ['open', 'fixed', 'rebutted', 'accepted']

/** One dispute: what is argued against, why, and what was decided. */
export interface PrototypeReview {
  /** `D-001`. What other files refer to it by. */
  id: string
  title: string
  target: PrototypeReviewTarget | null
  status: PrototypeReviewStatus | null
  /** The fingerprint of the disputed patch when this was filed, or null. */
  on: string | null
  /** The one sentence being argued. Null when the file has no `claim:` line. */
  claim: string | null
  /** As written — a `prototype-verify` line, a match count, a file. */
  evidence: string[]
  /**
   * The record disagrees with the files: an `open` dispute whose patch has changed since it was
   * filed, or a `fixed` one whose patch has not. Always false when no fingerprint was recorded.
   */
  stale: boolean
  /** Why it is stale, in the words a reader needs. Null when it is not. */
  staleReason: string | null
  /** The prose under the labelled lines. */
  body: string
  /** Path relative to the prototype directory, e.g. `reviews/D-001-sticky-total.md`. */
  file: string
}

export interface PrototypeReviews {
  reviews: PrototypeReview[]
  /** Read problems — a duplicate id, a dispute that names nothing, a fingerprint that is missing. */
  issues: string[]
}

/** `# D-001 The total is not pinned` — the file's own id, at the top. */
const REVIEW_HEADING_RE = /^#\s+(D-\d{1,4})\b[\s:—–-]*(.*)$/i
/** `status: open`, `about: patch x` — one labelled line. */
const LABEL_RE = /^([A-Za-z][A-Za-z-]*)\s*:\s*(.*)$/

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Read an `about:` value.
 *
 * The four shapes are the four things a check or a patch can point at, and each is written the way
 * it is written elsewhere in the workbench — `patch <path>` the way `dev-spec.md` names a file,
 * `endpoint GET /api/cart` the way `check:` names one. Anything else is not recognised, and
 * `null` says so rather than guessing at an interpretation.
 */
export function parseReviewTarget(value: string): PrototypeReviewTarget | null {
  const trimmed = value.trim()
  const [word, ...rest] = trimmed.split(/\s+/)
  const kind = (word ?? '').toLowerCase()
  const ref = rest.join(' ').trim()
  if (ref.length === 0) return null

  if (kind === 'patch') {
    // Stored the way the rest of the workbench points at a patch (`patches/…`), whether or not the
    // author wrote the prefix: a review is read next to the spec that lists files that way.
    const path = ref.replace(/^\.?\//, '')
    return { kind: 'patch', ref: path.startsWith('patches/') ? path : `patches/${path}` }
  }
  if (kind === 'page') return { kind: 'page', ref }
  if (kind === 'endpoint') return { kind: 'endpoint', ref }
  if (kind === 'requirement') {
    const id = normalizeRequirementId(ref)
    return id ? { kind: 'requirement', ref: id } : null
  }
  return null
}

/** How a target is written back out — one spelling, used by the report, the prompt and the spec. */
export function formatReviewTarget(target: PrototypeReviewTarget): string {
  return `${target.kind} ${target.ref}`
}

/**
 * Parse one review file.
 *
 * Returns null when the file is not a review at all (no `# D-xxx` heading) — a plain note in
 * `reviews/` is a legitimate thing to keep and is ignored rather than reported as broken, exactly
 * as a note under `research/` is.
 */
export function parsePrototypeReview(source: string, file: string): PrototypeReview | null {
  const lines = source.split('\n')
  let heading: RegExpExecArray | null = null

  for (const line of lines) {
    heading = REVIEW_HEADING_RE.exec(line.trim())
    if (heading) break
  }
  if (!heading) return null

  const id = `D-${String(Number(heading[1]!.slice(2))).padStart(3, '0')}`
  const title = (heading[2] ?? '').trim()

  const labels = new Map<string, string>()
  const body: string[] = []
  let inBody = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) continue

    const label = inBody ? null : LABEL_RE.exec(trimmed)
    if (label) {
      labels.set(label[1]!.toLowerCase(), (label[2] ?? '').trim())
      continue
    }

    if (trimmed === '' && !inBody && labels.size > 0) {
      inBody = true
      continue
    }
    if (inBody || trimmed !== '') body.push(line)
  }

  const rawStatus = (labels.get('status') ?? '').trim().toLowerCase()
  const status = (PROTOTYPE_REVIEW_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as PrototypeReviewStatus)
    : null

  return {
    id,
    title,
    target: parseReviewTarget(labels.get('about') ?? ''),
    status,
    on: labels.get('on') ?? null,
    claim: labels.get('claim') ?? null,
    evidence: splitList(labels.get('evidence') ?? ''),
    // Filled in by `readPrototypeReviews`, which is the only place that can see the disk.
    stale: false,
    staleReason: null,
    body: body.join('\n').trim(),
    file,
  }
}

/**
 * The status checked against the disk.
 *
 * Two expectations, and only two: an `open` dispute expects the file to still be the one it names,
 * and a `fixed` one expects it to have changed. `rebutted` and `accepted` are adjudications about
 * the argument rather than about the file, so nothing on disk can contradict them.
 */
function judgeAgainstDisk(
  review: PrototypeReview,
  patchesDir: string,
): { stale: boolean; staleReason: string | null; missing: boolean } {
  const target = review.target
  if (!target || target.kind !== 'patch') return { stale: false, staleReason: null, missing: false }

  let source: string
  try {
    source = readFileSync(join(patchesDir, target.ref.slice('patches/'.length)), 'utf-8')
  } catch {
    // Reported by the caller as its own issue: a dispute about a file that is gone is not a stale
    // argument, it is an argument about nothing.
    return { stale: false, staleReason: null, missing: true }
  }

  const current = patchFingerprint(source)
  if (!review.on) return { stale: false, staleReason: null, missing: false }

  if (review.status === 'open' && current !== review.on) {
    return {
      stale: true,
      staleReason: `${target.ref} has changed since this was filed (${review.on} → ${current}) — check that it still says what you meant`,
      missing: false,
    }
  }
  if (review.status === 'fixed' && current === review.on) {
    return {
      stale: true,
      staleReason: `marked fixed, but ${target.ref} has not changed since this was filed (${current})`,
      missing: false,
    }
  }
  return { stale: false, staleReason: null, missing: false }
}

/**
 * Read a prototype's reviews.
 *
 * Every `*.md` directly under `reviews/` is read; a file with no `# D-xxx` heading is a note and is
 * skipped. What the module will not do is accept a dispute it cannot act on: one that names nothing,
 * one with no status, one with no claim, or a patch dispute with no fingerprint is reported with the
 * line to add — because each of those reads as "someone objected" while being unanswerable.
 */
export function readPrototypeReviews(workspaceRootPath: string, slug: string): PrototypeReviews {
  const dir = getPrototypeReviewsPath(workspaceRootPath, slug)
  if (!existsSync(dir)) return { reviews: [], issues: [] }

  let entries: string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return { reviews: [], issues: [] }
  }

  const patchesDir = getPrototypePatchesPath(workspaceRootPath, slug)
  const reviews: PrototypeReview[] = []
  const issues: string[] = []
  const seen = new Set<string>()

  for (const name of entries) {
    let source: string
    try {
      source = readFileSync(join(dir, name), 'utf-8')
    } catch {
      continue
    }

    const review = parsePrototypeReview(source, `${PROTOTYPE_REVIEWS_DIRNAME}/${name}`)
    if (!review) continue

    if (seen.has(review.id)) {
      issues.push(`${review.file}: id ${review.id} is already used by another review.`)
      continue
    }
    seen.add(review.id)

    if (!review.target) {
      issues.push(
        `${review.file}: no usable "about:" line — write "about: patch <file>", "about: page <name>", ` +
          `"about: endpoint <METHOD> <path>" or "about: requirement <R-00x>". A dispute that names nothing ` +
          `is an opinion, and nothing downstream can answer it.`,
      )
    }
    if (!review.status) {
      issues.push(
        `${review.file}: no usable "status:" line — use one of ${PROTOTYPE_REVIEW_STATUSES.join(', ')}. ` +
          `"open" means it stands; a dispute with no status is one nobody can close.`,
      )
    }
    if (!review.claim) {
      issues.push(`${review.file}: no "claim:" line — a review without a claim cannot be agreed or refuted.`)
    }

    if (review.target?.kind === 'patch' && !review.on) {
      issues.push(
        `${review.file}: a patch dispute needs "on:" — the fingerprint of ${review.target.ref} as you are ` +
          `looking at it (printed by 'prototype-status'). Without it nothing can tell an objection about the ` +
          `current file from one about a version that no longer exists.`,
      )
    }
    if (review.target && review.target.kind !== 'patch' && review.on) {
      issues.push(
        `${review.file}: "on:" applies to a patch dispute only — a ${review.target.kind} spans several files, ` +
          `so there is no single thing to fingerprint.`,
      )
    }

    const judged = judgeAgainstDisk(review, patchesDir)
    if (judged.missing) {
      issues.push(`${review.file}: disputes ${review.target!.ref}, which is not in this prototype.`)
    }

    reviews.push({ ...review, stale: judged.stale, staleReason: judged.staleReason })
  }

  return { reviews, issues }
}

/** A review that still stands: open, or a record that disagrees with the files. */
export function isUnresolved(review: PrototypeReview): boolean {
  return review.status === 'open' || review.stale
}
