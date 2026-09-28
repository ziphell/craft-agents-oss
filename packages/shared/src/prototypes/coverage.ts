/**
 * Requirements and what implements them — the thread, resolved once.
 *
 * Everything else this workbench derives is a fact about one artifact: a finding is a claim. This
 * module is the only one that answers the question the reader actually has — **which requirement
 * does this work serve, and which requirement does nothing serve** — and it answers it from markers
 * in the files rather than from a stored link:
 *
 * - a requirement is a heading with an id in any markdown file of the folder (see `requirements.ts`);
 * - any file of the prototype declares what it serves with `@requirement R-001` in a comment;
 * - a finding declares what it argues for with `requirements:` (see `research.ts`).
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
 *   referred to (a specification document is not an implementation of what it specifies).
 *
 * The failures are the point, and both of them are invisible when files are read one
 * at a time:
 *
 * - a requirement nothing refers to — the proposal claims something the delivery
 *   does not do;
 * - a marker naming an id no document defines — a file whose reason was never
 *   written down.
 */

import { readFileSync } from 'fs'
import { notice, rawNotice, type PrototypeNotice } from './notices.ts'
import { extractRequirementIds, readPrototypeRequirements } from './requirements.ts'
import { readPrototypeFindings } from './research.ts'
import { listPrototypeFiles } from './storage.ts'

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
  /** Prototype-relative paths of files whose `@requirement` marker names it. */
  files: string[]
  /** Findings in `research/` that argue for it — evidence, not implementation. */
  findings: string[]
}

export interface RequirementCoverageReport {
  /** In the order the PRD states them — a document's order is part of its argument. */
  requirements: RequirementCoverage[]
  /** The derived failures, plus whatever the PRD itself could not be read as. */
  issues: PrototypeNotice[]
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

  // The documents' and the research's own file-level problems keep their
  // wording (`rawNotice`): each names a file and what is wrong with it. The derived
  // failures below are the ones a person acts on, so those are codes.
  const issues: PrototypeNotice[] = [...documents.issues, ...findings.issues].map(rawNotice)
  const declared = new Map<string, RequirementCoverage>()

  const claim = (id: string): RequirementCoverage => {
    const existing = declared.get(id)
    if (existing) return existing
    const requirement = documents.requirements.find((entry) => entry.id === id)
    const created: RequirementCoverage = {
      id,
      title: requirement?.title ?? '',
      file: requirement?.file ?? '',
      files: [],
      findings: [],
    }
    declared.set(id, created)
    return created
  }

  // Every file of the prototype folder, whatever folder it sits in. A file whose headings *define*
  // requirements is the specification, not an implementation of it, so it is not read for
  // `@requirement` markers — counting the document that states a requirement as the thing that
  // builds it would make every requirement look done.
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
        files: [],
        findings: [],
      },
  )

  return { requirements: ordered, issues }
}
