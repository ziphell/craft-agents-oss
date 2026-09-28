/**
 * Prototype status — one report of a prototype, derived from its files.
 *
 * Composes the derived facts (requirements, findings) into one report, so the state of
 * a prototype can be inspected without opening the filesystem by hand.
 *
 * All facts are recomputed from disk; nothing here is cached or persisted.
 */

import { readFileSync, readdirSync } from 'fs'
import { getWorkspacePrototypesPath } from '../workspaces/storage.ts'
import { pictureStanding } from '../drawio/picture.ts'
import { notice, type PrototypeNotice } from './notices.ts'
import { resolveRequirementCoverage } from './coverage.ts'
import { readPrototypeFindings } from './research.ts'
import { readPrototypeLinks, type PrototypeLink } from './links.ts'
import {
  getPrototypeDirPath,
  listPrototypeFiles,
  type PrototypeFileEntry,
} from './storage.ts'

/**
 * One requirement, and what implements it.
 *
 * The lists are the whole value. A requirement that no file refers to is
 * the finding this report exists to produce: the delivery claims something that
 * nothing in it does.
 */
export interface PrototypeStatusRequirement {
  id: string
  title: string
  /**
   * The markdown file whose heading defines this requirement — `PRD.md`, `docs/features.md`. Which
   * file carries a requirement is no longer implied by the file name, so it travels with the row.
   */
  file: string
  /** Files of the prototype folder that declare it (`@requirement R-001`). */
  files: string[]
  /** Findings in `research/` that argue for it. */
  findings: string[]
}

/** A finding from `research/` — what was learned, and about whose product. */
export interface PrototypeStatusFinding {
  id: string
  /** Null when the file has no `claim:` line — reported in `briefIssues`. */
  claim: string | null
  /** The address it was observed at. */
  source: string | null
  /** Requirement ids it argues for. */
  requirements: string[]
  /** Path relative to the prototype directory, e.g. `research/F-001-sticky.md`. */
  file: string
}

export interface PrototypeStatus {
  slug: string
  /** Absolute path to the prototype's directory. */
  dir: string
  /**
   * The specification's requirements, each with the files that refer to it. Empty when no markdown
   * file states one — the honest state of a prototype whose requirements have not been written down
   * yet.
   */
  requirements: PrototypeStatusRequirement[]
  /**
   * The markdown files that *define* requirements — one file or several. The page renders these as
   * the specification; which requirement lives in which of them is on each row (`requirements[].file`).
   * Empty when nothing has been written down yet.
   */
  specificationFiles: PrototypeFileEntry[]
  /**
   * Everything else in the prototype's own directory, in **any format** and recursively — the
   * material and the work's own files. The folder is the author's and there is no rule about what may
   * sit in it (`listPrototypeFiles`); the files that define requirements are excluded here only
   * because they are shown as the specification rather than listed twice.
   *
   * Paths rather than text: the panel reads what it shows through `file:read`, and a list of
   * status reports is no place to carry every prototype's files.
   */
  files: PrototypeFileEntry[]
  /**
   * How the documents point at each other (ordinary markdown links — `links.ts`), read from both
   * ends: a link with its `from` and `to` is simultaneously an outgoing link for `from` and a
   * backlink for `to`, so the page can say "links to" and "linked from" without a second reading.
   *
   * A link carries nothing about the work — it is navigation, never a claim that a requirement is
   * implemented (that is still `@requirement R-00x`). A link that resolves to nothing is in
   * `briefIssues`.
   */
  links: PrototypeLink[]
  /** Findings under `research/` — what was learned about other products. */
  findings: PrototypeStatusFinding[]
  /**
   * What this prototype still owes **as a matter of fact** — the gate's own input
   * (`whyPrototypeIsNotSettled`): a requirement nothing implements, a link that points at nothing.
   *
   * Both are read off the files and can be checked by anyone, which is what makes them a gate.
   */
  unresolved: {
    /** Requirement ids nothing implements — the proposal claims what the delivery does not do. */
    unmet: string[]
    /** Links whose target is not in the prototype — a reader following one arrives nowhere. */
    brokenLinks: Array<{ from: string; target: string }>
  }
  /**
   * {@link whyPrototypeIsNotSettled} of this very report — the gate in its own words, carried as
   * data so the panel can say what stands between the work and its handover.
   *
   * It is computed here rather than by each reader for the reason the gate exists at all: two
   * statements of "is it done?" would drift. The renderer is a reader now, and it cannot call a
   * runtime function from the shared barrel, so the verdict travels with the facts
   * it was reached from. Empty when there is nothing outstanding.
   */
  settleBlockers: PrototypeNotice[]
  /**
   * Everything worth saying about the specification, the research and the pictures in it: a
   * reference to an id no document defines, a document that cannot be read as written, a finding
   * with no claim or with evidence that is not on disk, a diagram shown an earlier drawing of.
   * Each is a silent failure otherwise — precisely the kind this report exists to make loud.
   *
   * A requirement nothing implements and a link that points at nothing are **not** here, because
   * they are what {@link unresolved} — and so the gate — already says.
   */
  briefIssues: PrototypeNotice[]
}

/**
 * List every prototype in a workspace, each with its full status.
 *
 * A directory under `prototypes/` counts as a prototype even before anything is written into it —
 * the folder *is* the prototype, and a prototype with no requirements yet is an honest state rather
 * than a broken one.
 */
export function listPrototypeStatuses(workspaceRootPath: string): PrototypeStatus[] {
  let entries
  try {
    entries = readdirSync(getWorkspacePrototypesPath(workspaceRootPath), { withFileTypes: true })
  } catch {
    // The prototypes folder is created lazily, so a missing one means "none yet".
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
    .map((slug) => buildPrototypeStatus(workspaceRootPath, slug))
}

/** Build the full status report for a prototype. */
export function buildPrototypeStatus(workspaceRootPath: string, slug: string): PrototypeStatus {
  const dir = getPrototypeDirPath(workspaceRootPath, slug)

  // The thread from the specification to what implements it, derived in one place so this
  // report and the delivered spec cannot disagree (see `coverage.ts`).
  const coverage = resolveRequirementCoverage(workspaceRootPath, slug)
  // The prototype's own files, recursively, with no filter of any kind: the folder is the author's,
  // and what sits in it is their business. The files that define requirements are separated out so a
  // caller that renders them does not list them a second time among the material.
  const allFiles = listPrototypeFiles(workspaceRootPath, slug)
  const defining = new Set(coverage.requirements.map((requirement) => requirement.file))
  const specificationFiles = allFiles.filter((file) => defining.has(file.name))
  const files = allFiles.filter((file) => !defining.has(file.name))
  const findings = readPrototypeFindings(workspaceRootPath, slug)
  const linkReport = readPrototypeLinks(workspaceRootPath, slug)

  // What the *layers* could not read, plus the pictures that disagree with their own source. The
  // two facts the gate already owns — a requirement nothing implements, a link that points at
  // nothing — are deliberately **not** here: they are `unresolved`, and this is the page's other
  // warning box, so repeating them would say one thing twice in two wordings.
  const briefIssues = [...coverage.issues, ...staleDrawings(allFiles)]

  const report: Omit<PrototypeStatus, 'settleBlockers'> = {
    slug,
    dir,
    requirements: coverage.requirements,
    specificationFiles,
    files,
    links: linkReport.links,
    findings: findings.findings.map((finding) => ({
      id: finding.id,
      claim: finding.claim,
      source: finding.source,
      requirements: finding.requirements,
      file: finding.file,
    })),
    unresolved: {
      unmet: coverage.requirements
        .filter((requirement) => requirement.files.length === 0)
        .map((requirement) => requirement.id),
      brokenLinks: linkReport.links
        .filter((link) => link.to === null)
        .map((link) => ({ from: link.from, target: link.target })),
    },
    briefIssues,
  }

  // The gate's verdict travels with the facts it was reached from, so every reader — the strict
  // export, the status output, the panel — answers "is it done?" the same way. Computed after the
  // literal because it reads the report it belongs to.
  return { ...report, settleBlockers: whyPrototypeIsNotSettled({ ...report, settleBlockers: [] }) }
}

/**
 * The pictures in the folder, against the diagrams they were drawn from.
 *
 * A specification document shows a diagram as an ordinary markdown image, so what a reader of it
 * sees is an exported SVG — and the `.drawio` it was drawn from is a *snapshot's* source, not a
 * second copy of it: edit the diagram and the document goes on showing the drawing as it was.
 * Nothing else in this report can see that, because nothing else pairs the two files.
 *
 * The pair is a name here (`cart.drawio.svg` is `cart.drawio`'s) and the *judgement* is content:
 * `pictureStanding` compares the document the picture carries against the file beside it. A picture with
 * no file of that name next to it is passed over in silence — it may have been drawn anywhere, and this
 * is not a report about where a file came from.
 */
function staleDrawings(files: PrototypeFileEntry[]): PrototypeNotice[] {
  const issues: PrototypeNotice[] = []
  const byName = new Map(files.map((file) => [file.name, file]))

  for (const picture of files) {
    const source = byName.get(sourceNameOf(picture.name))
    if (!source) continue

    try {
      const standing = pictureStanding(
        readFileSync(picture.path, 'utf-8'),
        readFileSync(source.path, 'utf-8'),
      )
      if (standing === 'stale') {
        issues.push(notice('diagram.stale', { svg: picture.name, source: source.name }))
      }
    } catch {
      // A file that cannot be read is not a fact about a diagram, and this is not the report that
      // reports a file it could not read.
    }
  }

  return issues
}

/**
 * The file a picture belongs to, by the name it is kept under — `cart.drawio.svg` is `cart.drawio`'s.
 *
 * Only this shape pairs: `.svg` is what makes a reader draw it as a picture, and `drawio` in front is
 * what says it can be regenerated from something somebody drew (see `docs/prototypes.md`). Any other
 * name is a picture with nothing to compare it to, which is not a problem to report — the folder is the
 * author's.
 */
function sourceNameOf(name: string): string {
  if (!name.toLowerCase().endsWith('.svg')) return name
  const withoutSuffix = name.slice(0, -'.svg'.length)
  return withoutSuffix.toLowerCase().endsWith('.drawio') ? withoutSuffix : name
}

/**
 * What this prototype still owes — empty when there is nothing outstanding.
 *
 * This is the **gate**, expressed once: the status output prints it, a task graph branches on it,
 * and the panel's badge counts it. Reason-first, for the same reader — an agent that has to decide
 * whether to keep working, or whether what it has is finished.
 *
 * **Only facts count**, because a gate has to be answerable: a requirement nothing implements, a
 * link that points at nothing. Both are read off the files, either can be checked by anyone, and
 * there is work to do about each.
 */
export function whyPrototypeIsNotSettled(status: PrototypeStatus): PrototypeNotice[] {
  const reasons: PrototypeNotice[] = []

  for (const id of status.unresolved.unmet) {
    const file = status.requirements.find((requirement) => requirement.id === id)?.file ?? ''
    reasons.push(notice('gate.requirementUnmet', { id, file }))
  }

  for (const link of status.unresolved.brokenLinks) {
    reasons.push(notice('gate.linkBroken', { from: link.from, target: link.target }))
  }

  return reasons
}
