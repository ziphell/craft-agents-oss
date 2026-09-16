/**
 * Requirements and what implements them — the thread, resolved once.
 *
 * Everything else this workbench derives is a fact about one artifact: a page is
 * a document, a patch is a file, a finding is a claim. This module is the only one
 * that answers the question the reader actually has — **which requirement does
 * this change serve, and which requirement does nothing serve** — and it answers
 * it from markers in the files rather than from a stored link:
 *
 * - a requirement is a heading with an id in `prd.md` (see `requirements.ts`);
 * - a change declares what it serves with `@requirement R-001` in its patch
 *   header, or in a comment in a page document;
 * - a finding declares what it argues for with `requirements:` (see `research.ts`).
 *
 * Markers rather than a mapping in `config.json`, because the files are what gets
 * edited: a patch is written by a lane that never touches the config, and a link
 * maintained by hand goes stale without saying so. The price is that the thread is
 * *derived* — which is why it is derived in exactly one place: the status report
 * and the delivered dev spec both read it here, so the two cannot disagree about
 * what covers what.
 *
 * The failures are the point, and both are invisible when files are read one at a
 * time:
 *
 * - a requirement nothing refers to — the proposal claims something the delivery
 *   does not do;
 * - a marker naming an id the PRD does not define — a change whose reason was
 *   never written down.
 *
 * @see docs/prototype-workbench-plan.md §20.1
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { listPrototypePages } from './pages.ts'
import {
  extractRequirementIds,
  PROTOTYPE_PRD_FILENAME,
  readPrototypeRequirements,
  type PrototypeCheck,
} from './requirements.ts'
import { readPrototypeFindings } from './research.ts'
import { getPrototypeDirPath, scanPrototypePatches } from './storage.ts'

/** One requirement of the PRD, and everything that refers to it. */
export interface RequirementCoverage {
  /** `R-001`. */
  id: string
  /** The rest of the PRD heading, or an empty string. */
  title: string
  /** Pages whose document declares it. */
  pages: string[]
  /** Patch files that declare it, as `patches/…` paths. */
  patches: string[]
  /** Findings in `research/` that argue for it — evidence, not implementation. */
  findings: string[]
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
   * (a lane building what it felt like). Both are for the reader to judge, which
   * requires seeing them.
   */
  unclaimed: string[]
  /** The two derived failures, plus whatever the PRD itself could not be read as. */
  issues: string[]
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
  const pages = listPrototypePages(workspaceRootPath, slug)
  const patches = scanPrototypePatches(workspaceRootPath, slug)
  const dir = getPrototypeDirPath(workspaceRootPath, slug)

  const issues = [...prd.issues, ...findings.issues]
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
      checks: prd.requirements.find((requirement) => requirement.id === id)?.checks ?? [],
    }
    declared.set(id, created)
    return created
  }

  for (const page of pages) {
    if (page.file === null) continue
    let document: string
    try {
      document = readFileSync(join(dir, page.file), 'utf-8')
    } catch {
      continue
    }
    for (const id of extractRequirementIds(document)) {
      const entry = claim(id)
      if (!entry.pages.includes(page.name)) entry.pages.push(page.name)
    }
  }

  const unclaimed: string[] = []
  for (const patch of patches) {
    const ids = extractRequirementIds(patch.source)
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

  // A requirement nothing *implements* is the gap this module exists to name. A
  // finding is evidence, not implementation, so it does not count as covering one:
  // a requirement argued for and never built is exactly the case that must not
  // read as done.
  for (const requirement of prd.requirements) {
    const entry = declared.get(requirement.id)
    if (entry && (entry.pages.length > 0 || entry.patches.length > 0)) continue
    issues.push(
      `${requirement.id} is in ${PROTOTYPE_PRD_FILENAME} but no page or patch refers to it, so nothing in this ` +
        `prototype implements it.`,
    )
  }

  for (const entry of declared.values()) {
    if (prd.requirements.some((requirement) => requirement.id === entry.id)) continue
    const where = [
      ...entry.pages.map((name) => `${name} (page)`),
      ...entry.patches,
      ...entry.findings,
    ].join(', ')
    issues.push(`${where} refers to ${entry.id}, which ${PROTOTYPE_PRD_FILENAME} does not define.`)
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
        checks: requirement.checks,
      },
  )

  return { requirements: ordered, unclaimed, issues }
}
