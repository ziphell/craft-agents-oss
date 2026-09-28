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
 * about: requirement R-003
 * on: 3f9a1c2e
 * status: open
 * claim: The summary row is not on screen once the list is longer than the viewport.
 *
 * The requirement does not say what happens when the line is gone…
 * ```
 *
 * Why it is a file rather than a line in the run log: an objection that lives only in the
 * conversation disappears with the window, and the person handed the prototype then sees a piece of
 * work nobody ever disagreed with. A verdict asks the reader to trust the transcript; a review is
 * something they can read and judge.
 *
 * Three properties, the same ones `research.ts` insists on:
 *
 * - **`about:`** — what is being disputed: a requirement. A dispute that
 *   names nothing is an opinion, and it is reported as one.
 * - **`status:`** — `open` (it stands), `fixed` (the thing was changed), `rebutted` (judged
 *   unfounded, with the reason in the body) or `accepted` (judged valid, and the cost was taken).
 * - **`on:`** — the fingerprint of the disputed requirement *as it was written* when the review was
 *   filed ({@link requirementFingerprint}). This is what makes the record checkable: a dispute is
 *   reported **stale** when the requirement no longer hashes to it, so "argued about a wording that
 *   no longer exists" cannot pass for a live objection. Required for every dispute, because a
 *   requirement is one entry of one file and its fingerprint is free.
 *
 * The status is checked against the disk, never trusted on its own: `open` on a requirement that has
 * been rewritten is stale, and `fixed` on one that has *not* changed is stale too. A record that
 * disagrees with the files is exactly the failure this module exists to name.
 *
 * Nothing here is delivered as a separate artifact: what still stands against the specification is
 * read from `reviews/`.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  normalizeRequirementId,
  readPrototypeRequirements,
  requirementFingerprint,
} from './requirements.ts'
import { getPrototypeReviewsPath } from './storage.ts'
import { PROTOTYPE_REVIEWS_DIRNAME } from './types.ts'

export { PROTOTYPE_REVIEWS_DIRNAME, getPrototypeReviewsPath }

/** What can be disputed: the requirement. */
export type PrototypeReviewTargetKind = 'requirement'

export interface PrototypeReviewTarget {
  kind: PrototypeReviewTargetKind
  /** `R-003` — as written. */
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
  /** The fingerprint of the disputed requirement when this was filed, or null. */
  on: string | null
  /** The one sentence being argued. Null when the file has no `claim:` line. */
  claim: string | null
  /** As written — a count, a file. */
  evidence: string[]
  /**
   * The record disagrees with the files: an `open` dispute whose requirement has been rewritten
   * since it was filed, or a `fixed` one whose requirement has not. Always false when no
   * fingerprint was recorded.
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
/** `status: open`, `about: requirement R-003` — one labelled line. */
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
 * The one shape a disagreement can be acted on is a requirement the PRD defines, written the way
 * it is written elsewhere in the workbench (`requirement R-003`). Anything else is not recognised,
 * and `null` says so rather than guessing at an interpretation.
 */
export function parseReviewTarget(value: string): PrototypeReviewTarget | null {
  const trimmed = value.trim()
  const [word, ...rest] = trimmed.split(/\s+/)
  const kind = (word ?? '').toLowerCase()
  const ref = rest.join(' ').trim()
  if (ref.length === 0) return null

  if (kind === 'requirement') {
    const id = normalizeRequirementId(ref)
    return id ? { kind: 'requirement', ref: id } : null
  }
  return null
}

/** How a target is written back out — one spelling, used by the report and the prompt. */
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
 * Two expectations, and only two: an `open` dispute expects the requirement to still be the one it
 * names, and a `fixed` one expects it to have changed. `rebutted` and `accepted` are adjudications
 * about the argument rather than about the text, so nothing on disk can contradict them.
 */
function judgeAgainstDisk(
  review: PrototypeReview,
  fingerprints: Map<string, { fingerprint: string; file: string }>,
): { stale: boolean; staleReason: string | null; missing: boolean } {
  const target = review.target
  if (!target) return { stale: false, staleReason: null, missing: false }

  const current = fingerprints.get(target.ref)
  // Reported by the caller as its own issue: a dispute about a requirement no document defines
  // is not a stale argument, it is an argument about nothing.
  if (!current) return { stale: false, staleReason: null, missing: true }

  if (!review.on) return { stale: false, staleReason: null, missing: false }

  const where = `${target.ref} in ${current.file}`
  if (review.status === 'open' && current.fingerprint !== review.on) {
    return {
      stale: true,
      staleReason: `${where} has changed since this was filed (${review.on} → ${current.fingerprint}) — check that it still says what you meant`,
      missing: false,
    }
  }
  if (review.status === 'fixed' && current.fingerprint === review.on) {
    return {
      stale: true,
      staleReason: `marked fixed, but ${where} has not changed since this was filed (${current.fingerprint})`,
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
 * one with no status, one with no claim, or a requirement dispute with no fingerprint is reported
 * with the line to add — because each of those reads as "someone objected" while being unanswerable.
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

  // The current text of every requirement a document defines, so a dispute can be judged against it.
  const fingerprints = new Map<string, { fingerprint: string; file: string }>()
  for (const requirement of readPrototypeRequirements(workspaceRootPath, slug).requirements) {
    fingerprints.set(requirement.id, {
      fingerprint: requirementFingerprint(requirement),
      file: requirement.file,
    })
  }

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
        `${review.file}: no usable "about:" line — write "about: requirement <R-00x>". ` +
          `A dispute that names nothing is an opinion, and nothing downstream can answer it.`,
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

    if (review.target && !review.on) {
      issues.push(
        `${review.file}: a dispute needs "on:" — the fingerprint of ${review.target.ref} as you are ` +
          `looking at it (printed by 'status'). Without it nothing can tell an objection about the ` +
          `current wording from one about a wording that no longer exists.`,
      )
    }

    const judged = judgeAgainstDisk(review, fingerprints)
    if (judged.missing) {
      issues.push(`${review.file}: disputes ${review.target!.ref}, which no document here defines.`)
    }

    reviews.push({ ...review, stale: judged.stale, staleReason: judged.staleReason })
  }

  return { reviews, issues }
}

/** A review that still stands: open, or a record that disagrees with the files. */
export function isUnresolved(review: PrototypeReview): boolean {
  return review.status === 'open' || review.stale
}
