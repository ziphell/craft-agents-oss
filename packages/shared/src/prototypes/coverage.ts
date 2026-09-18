/**
 * Requirements and what implements them — the thread, resolved once.
 *
 * Everything else this workbench derives is a fact about one artifact: a page is
 * a document, a patch is a file, a finding is a claim. This module is the only one
 * that answers the question the reader actually has — **which requirement does
 * this change serve, and which requirement does nothing serve** — and it answers
 * it from markers in the files rather than from a stored link:
 *
 * - a requirement is a heading with an id in `PRD.md` (see `requirements.ts`);
 * - a change declares what it serves with `@requirement R-001` in its patch
 *   header, or in a comment in a page document;
 * - a finding declares what it argues for with `requirements:` (see `research.ts`);
 * - a review declares what it disputes with `about:` (see `reviews.ts`).
 *
 * Markers rather than a mapping in `config.json`, because the files are what gets
 * edited: a patch is written by a writer that never touches the config, and a link
 * maintained by hand goes stale without saying so. The price is that the thread is
 * *derived* — which is why it is derived in exactly one place: the status report
 * and the delivered dev spec both read it here, so the two cannot disagree about
 * what covers what.
 *
 * The failures are the point, and all of them are invisible when files are read one
 * at a time:
 *
 * - a requirement nothing refers to — the proposal claims something the delivery
 *   does not do;
 * - a marker naming an id the PRD does not define — a change whose reason was
 *   never written down;
 * - a dispute that still stands — an objection nothing has answered, which is the
 *   one thing a reader of a "finished" prototype is entitled to see.
 *
 * @see docs/prototype-workbench-plan.md §20.1, §3.7
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { COMMITTED_CSS, COMMITTED_JS } from './fold.ts'
import { notice, rawNotice, type PrototypeNotice } from './notices.ts'
import { listPrototypePages } from './pages.ts'
import {
  extractRequirementIds,
  PROTOTYPE_PRD_FILENAME,
  readPrototypeRequirements,
  type PrototypeCheck,
} from './requirements.ts'
import { readPrototypeFindings } from './research.ts'
import {
  formatReviewTarget,
  isUnresolved,
  readPrototypeReviews,
  type PrototypeReviewStatus,
} from './reviews.ts'
import { getPrototypeDirPath, scanPrototypePatches } from './storage.ts'

/** A file's text, or null when it is not there or cannot be read — both mean "declares nothing". */
function readIfPresent(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

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
  /** What it disputes, as one line: `patch patches/ui-001-btn.css`. */
  about: string
  /** The one sentence being argued. */
  claim: string | null
}

/** One requirement of the PRD, and everything that refers to it. */
export interface RequirementCoverage {
  /** `R-001`. */
  id: string
  /** The rest of the PRD heading, or an empty string. */
  title: string
  /** Pages that declare it: their document, or the file their own delta was folded into. */
  pages: string[]
  /** Patch files that declare it, as `patches/…` paths. */
  patches: string[]
  /** Findings in `research/` that argue for it — evidence, not implementation. */
  findings: string[]
  /**
   * Disputes about it: filed against the requirement itself, or against a patch, page or endpoint
   * that serves it. Arguments arrive where the thing they are about is written, and the reader of a
   * requirement row is the person who has to decide whether it holds — so this is where they belong.
   */
  disputes: RequirementDispute[]
  /**
   * The acceptance checks the PRD puts under it (plan §20.7), carried through so
   * the verifier, the panel and the delivered spec all read the same list.
   */
  checks: PrototypeCheck[]
}

export interface RequirementCoverageReport {
  /** In the order the PRD states them — a document's order is part of its argument. */
  requirements: RequirementCoverage[]
  /**
   * Patch files that name no requirement.
   *
   * Listed rather than hidden: a change nobody asked for is sometimes exactly
   * right (a broken layout fixed on the way) and sometimes the whole problem
   * (a writer building what it felt like). Both are for the reader to judge, which
   * requires seeing them.
   */
  unclaimed: string[]
  /** The two derived failures, plus whatever the PRD itself could not be read as. */
  issues: PrototypeNotice[]
  /**
   * The argument against the work, as one list (plan §3.7).
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
 * Never throws and never guesses: pages that cannot be read are skipped (their
 * absence from a requirement's list is a fact about the disk), and an id written
 * in an unknown spelling is ignored by `extractRequirementIds` rather than being
 * coerced into a reference.
 */
export function resolveRequirementCoverage(
  workspaceRootPath: string,
  slug: string,
): RequirementCoverageReport {
  const prd = readPrototypeRequirements(workspaceRootPath, slug)
  const findings = readPrototypeFindings(workspaceRootPath, slug)
  const reviews = readPrototypeReviews(workspaceRootPath, slug)
  const pages = listPrototypePages(workspaceRootPath, slug)
  const patches = scanPrototypePatches(workspaceRootPath, slug)
  const dir = getPrototypeDirPath(workspaceRootPath, slug)

  // The PRD's, the research's and the reviews' own file-level problems keep their
  // wording (`rawNotice`): each names a file and what is wrong with it. The two
  // derived failures below are the ones a person acts on, so those are codes.
  const issues: PrototypeNotice[] = [...prd.issues, ...findings.issues, ...reviews.issues].map(rawNotice)
  const declared = new Map<string, RequirementCoverage>()

  const claim = (id: string): RequirementCoverage => {
    const existing = declared.get(id)
    if (existing) return existing
    const created: RequirementCoverage = {
      id,
      title: prd.requirements.find((requirement) => requirement.id === id)?.title ?? '',
      pages: [],
      patches: [],
      findings: [],
      disputes: [],
      checks: prd.requirements.find((requirement) => requirement.id === id)?.checks ?? [],
    }
    declared.set(id, created)
    return created
  }

  // What each *thing* a dispute can name refers to, so a dispute filed against a patch, a page or an
  // endpoint lands on the requirements that thing serves. Derived from the same markers as the rest
  // of this report rather than asked for again in the review file: a review that had to restate the
  // requirement would be a second copy of the thread, and copies drift.
  const patchIds = new Map<string, string[]>()
  const pageIds = new Map<string, string[]>()
  const endpointIds = new Map<string, string[]>()
  for (const requirement of prd.requirements) {
    for (const check of requirement.checks) {
      if (check.kind !== 'endpoint') continue
      const key = check.target.trim().toLowerCase()
      endpointIds.set(key, [...(endpointIds.get(key) ?? []), requirement.id])
    }
  }

  for (const page of pages) {
    if (page.file === null) continue
    let document: string
    try {
      document = readFileSync(join(dir, page.file), 'utf-8')
    } catch {
      continue
    }
    const ids = new Set(extractRequirementIds(document))

    // A page of ours keeps its own deltas in files it owns once the layer is folded
    // (`assets/<page>/committed.*`), and the fold carries the markers into them on purpose so the
    // thread survives (plan §21.3). Read them here too: `patches/` no longer holds that change, and a
    // reader that stopped at the document would report a converged requirement as implemented by
    // nothing — while the change is still on the page.
    for (const file of [COMMITTED_CSS, COMMITTED_JS]) {
      const folded = readIfPresent(join(dir, 'assets', page.name, file))
      if (folded === null) continue
      for (const id of extractRequirementIds(folded)) ids.add(id)
    }

    pageIds.set(page.name, [...ids])
    for (const id of ids) {
      const entry = claim(id)
      if (!entry.pages.includes(page.name)) entry.pages.push(page.name)
    }
  }

  const unclaimed: string[] = []
  for (const patch of patches) {
    const ids = extractRequirementIds(patch.source)
    patchIds.set(`patches/${patch.file}`, ids)
    if (ids.length === 0) unclaimed.push(`patches/${patch.file}`)
    for (const id of ids) {
      const entry = claim(id)
      const path = `patches/${patch.file}`
      if (!entry.patches.includes(path)) entry.patches.push(path)
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

    const target = review.target
    if (!target) continue

    const ids =
      target.kind === 'requirement'
        ? [target.ref]
        : target.kind === 'patch'
          ? (patchIds.get(target.ref) ?? [])
          : target.kind === 'page'
            ? (pageIds.get(target.ref) ?? [])
            : (endpointIds.get(target.ref.toLowerCase()) ?? [])

    // A dispute about something that serves no requirement still belongs to the report — it is in
    // `unresolved` above. What it does not get is a requirement row it is not about.
    for (const id of ids) {
      const entry = claim(id)
      if (!entry.disputes.some((existing) => existing.id === dispute.id || existing.file === dispute.file)) {
        entry.disputes.push(dispute)
      }
    }
  }

  // A requirement nothing *implements* is the gap this module exists to name. A
  // finding is evidence, not implementation, so it does not count as covering one:
  // a requirement argued for and never built is exactly the case that must not
  // read as done.
  for (const requirement of prd.requirements) {
    const entry = declared.get(requirement.id)
    if (entry && (entry.pages.length > 0 || entry.patches.length > 0)) continue
    issues.push(
      notice('requirement.unimplemented', { id: requirement.id, prd: PROTOTYPE_PRD_FILENAME }),
    )
  }

  for (const entry of declared.values()) {
    if (prd.requirements.some((requirement) => requirement.id === entry.id)) continue
    const where = [
      ...entry.pages.map((name) => `${name} (page)`),
      ...entry.patches,
      ...entry.findings,
    ].join(', ')
    issues.push(
      notice('requirement.undefined', { where, id: entry.id, prd: PROTOTYPE_PRD_FILENAME }),
    )
  }

  // PRD order, and only the PRD's requirements: the table mirrors the document. A
  // marker naming an id the PRD omits is already reported above and deliberately
  // gets no row — a row without a title would read as a requirement rather than as
  // the broken reference it is.
  const ordered = prd.requirements.map(
    (requirement) =>
      declared.get(requirement.id) ?? {
        id: requirement.id,
        title: requirement.title,
        pages: [],
        patches: [],
        findings: [],
        disputes: [],
        checks: requirement.checks,
      },
  )

  return { requirements: ordered, unclaimed, issues, reviews: { total: reviews.reviews.length, byStatus, unresolved } }
}
