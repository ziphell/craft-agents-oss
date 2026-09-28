/**
 * Requirements and what implements them — the thread, resolved once.
 *
 * Everything else this workbench derives is a fact about one artifact: a finding is a claim, a
 * review is an objection. This module is the only one that answers the question the reader actually
 * has — **which requirement does this work serve, and which requirement does nothing serve** — and
 * it answers it from markers in the files rather than from a stored link:
 *
 * - a requirement is a heading with an id in any markdown file of the folder (see `requirements.ts`);
 * - any file of the prototype declares what it serves with `@requirement R-001` in a comment;
 * - a finding declares what it argues for with `requirements:` (see `research.ts`);
 * - a review declares what it disputes with `about:` (see `reviews.ts`).
 *
 * Markers rather than a mapping in a stored index, because the files are what gets edited: a file
 * is written by whoever owns it and never touches the index, and a link maintained by hand goes
 * stale without saying so. The price is that the thread is *derived* — which is why it is derived
 * in exactly one place: the status report and the panel both read it here, so the two
 * cannot disagree about what covers what.
 *
 * What is **not** a source, deliberately:
 *
 * - the files that define requirements, which is where a requirement is *defined* rather than
 *   referred to (a specification document is not an implementation of what it specifies);
 * - the record directories (`research/`, `reviews/`), which are how the author got
 *   to the requirements and what was argued about them — counting a record as implementation would
 *   make "this requirement is implemented by nothing" lie.
 *
 * The failures are the point, and all of them are invisible when files are read one
 * at a time:
 *
 * - a requirement nothing refers to — the proposal claims something the delivery
 *   does not do;
 * - a marker naming an id no document defines — a file whose reason was never
 *   written down;
 * - a dispute that still stands — an objection nothing has answered, which is the
 *   one thing a reader of a "finished" prototype is entitled to see.
 */

import { readFileSync } from 'fs'
import { notice, rawNotice, type PrototypeNotice } from './notices.ts'
import {
  extractRequirementIds,
  readPrototypeRequirements,
  requirementFingerprint,
} from './requirements.ts'
import { readPrototypeFindings } from './research.ts'
import {
  formatReviewTarget,
  isUnresolved,
  readPrototypeReviews,
  type PrototypeReviewStatus,
} from './reviews.ts'
import { listPrototypeFiles } from './storage.ts'

/** A dispute, attached to the requirement it is about. */
export interface RequirementDispute {
  /** `D-001`. */
  id: string
  /** `reviews/D-001-….md`. */
  file: string
  status: PrototypeReviewStatus | null
  /** The record disagrees with the files — see `reviews.ts`. */
  stale: boolean
  /** Why it is stale, when it is. */
  staleReason: string | null
  /** What it disputes, as one line: `requirement R-003`. */
  about: string
  /** The one sentence being argued. */
  claim: string | null
}

/** One requirement of the specification, and everything that refers to it. */
export interface RequirementCoverage {
  /** `R-001`. */
  id: string
  /** The rest of the heading, or an empty string. */
  title: string
  /**
   * The markdown file whose heading defines it — `PRD.md`, `docs/features.md`. Empty for an id no
   * document defines, which has no file to name.
   */
  file: string
  /**
   * The fingerprint of the requirement's heading and prose, as its document states them now
   * ({@link requirementFingerprint}). A review of this requirement records it as `on:`, and is
   * judged stale against it — derived here so the report and the stale check cannot disagree.
   * Empty for an id no document defines, which has no wording to fingerprint.
   */
  fingerprint: string
  /** Prototype-relative paths of files whose `@requirement` marker names it. */
  files: string[]
  /** Findings in `research/` that argue for it — evidence, not implementation. */
  findings: string[]
  /**
   * Disputes about it: filed against the requirement itself. Arguments arrive where the thing
   * they are about is written, and the reader of a requirement row is the person who has to decide
   * whether it holds — so this is where they belong.
   */
  disputes: RequirementDispute[]
}

export interface RequirementCoverageReport {
  /** In the order the PRD states them — a document's order is part of its argument. */
  requirements: RequirementCoverage[]
  /** The derived failures, plus whatever the PRD itself could not be read as. */
  issues: PrototypeNotice[]
  /**
   * The argument against the work, as one list.
   *
   * Here rather than in a report of its own because a second report is a second thing that can
   * drift from this one: "which requirement nothing implements" and "which objection nobody
   * answered" are the same question asked twice — what does this prototype still owe?
   */
  reviews: {
    total: number
    byStatus: Record<PrototypeReviewStatus, number>
    /** Disputes that still stand: open, or a record that disagrees with the files. */
    unresolved: RequirementDispute[]
  }
}

/**
 * Resolve the thread for a prototype.
 *
 * Never throws and never guesses: files that cannot be read are skipped (their absence from a
 * requirement's list is a fact about the disk), and an id written in an unknown spelling is ignored
 * by `extractRequirementIds` rather than being coerced into a reference.
 */
export function resolveRequirementCoverage(
  workspaceRootPath: string,
  slug: string,
): RequirementCoverageReport {
  const documents = readPrototypeRequirements(workspaceRootPath, slug)
  const findings = readPrototypeFindings(workspaceRootPath, slug)
  const reviews = readPrototypeReviews(workspaceRootPath, slug)

  // The documents', the research's and the reviews' own file-level problems keep their
  // wording (`rawNotice`): each names a file and what is wrong with it. The derived
  // failures below are the ones a person acts on, so those are codes.
  const issues: PrototypeNotice[] = [...documents.issues, ...findings.issues, ...reviews.issues].map(rawNotice)
  const declared = new Map<string, RequirementCoverage>()

  const claim = (id: string): RequirementCoverage => {
    const existing = declared.get(id)
    if (existing) return existing
    const requirement = documents.requirements.find((entry) => entry.id === id)
    const created: RequirementCoverage = {
      id,
      title: requirement?.title ?? '',
      file: requirement?.file ?? '',
      fingerprint: requirement ? requirementFingerprint(requirement) : '',
      files: [],
      findings: [],
      disputes: [],
    }
    declared.set(id, created)
    return created
  }

  // Every file of the prototype folder. A file whose headings *define* requirements is the
  // specification, not an implementation of it, so it is not read for `@requirement` markers —
  // counting the document that states a requirement as the thing that builds it would make every
  // requirement look done. `listPrototypeFiles` never descends into `research/` or `reviews/`:
  // those are how the author got to the requirements, not an implementation of them.
  const definingFiles = new Set(documents.requirements.map((requirement) => requirement.file))
  for (const file of listPrototypeFiles(workspaceRootPath, slug)) {
    if (definingFiles.has(file.name)) continue

    let source: string
    try {
      source = readFileSync(file.path, 'utf-8')
    } catch {
      continue
    }

    for (const id of extractRequirementIds(source)) {
      const requirement = claim(id)
      if (!requirement.files.includes(file.name)) requirement.files.push(file.name)
    }
  }

  for (const finding of findings.findings) {
    for (const id of finding.requirements) {
      const entry = claim(id)
      if (!entry.findings.includes(finding.id)) entry.findings.push(finding.id)
    }
  }

  // The argument against the work, attached where it is about something named.
  const byStatus: Record<PrototypeReviewStatus, number> = { open: 0, fixed: 0, rebutted: 0, accepted: 0 }
  const unresolved: RequirementDispute[] = []

  for (const review of reviews.reviews) {
    if (review.status) byStatus[review.status] += 1

    const dispute: RequirementDispute = {
      id: review.id,
      file: review.file,
      status: review.status,
      stale: review.stale,
      staleReason: review.staleReason,
      about: review.target ? formatReviewTarget(review.target) : '(nothing named)',
      claim: review.claim,
    }
    if (isUnresolved(review)) unresolved.push(dispute)

    // A dispute is about the requirement it names. The review file never restates the thread.
    if (!review.target) continue
    const entry = claim(review.target.ref)
    if (!entry.disputes.some((existing) => existing.id === dispute.id || existing.file === dispute.file)) {
      entry.disputes.push(dispute)
    }
  }

  // A requirement nothing *implements* is the gap this module exists to name. A
  // finding is evidence, not implementation, so it does not count as covering one:
  // a requirement argued for and never built is exactly the case that must not
  // read as done.
  for (const requirement of documents.requirements) {
    const entry = declared.get(requirement.id)
    if (entry && entry.files.length > 0) continue
    issues.push(notice('requirement.unimplemented', { id: requirement.id, file: requirement.file }))
  }

  for (const entry of declared.values()) {
    if (documents.requirements.some((requirement) => requirement.id === entry.id)) continue
    const where = [...entry.files, ...entry.findings].join(', ')
    issues.push(notice('requirement.undefined', { where, id: entry.id }))
  }

  // Reading order, and only the requirements a document states: the table mirrors the documents. A
  // marker naming an id no document defines is already reported above and deliberately
  // gets no row — a row without a title would read as a requirement rather than as
  // the broken reference it is.
  const ordered = documents.requirements.map(
    (requirement) =>
      declared.get(requirement.id) ?? {
        id: requirement.id,
        title: requirement.title,
        file: requirement.file,
        fingerprint: requirementFingerprint(requirement),
        files: [],
        findings: [],
        disputes: [],
      },
  )

  return { requirements: ordered, issues, reviews: { total: reviews.reviews.length, byStatus, unresolved } }
}
