/**
 * Prototype status — one report of a prototype, derived from its files.
 *
 * Composes the derived facts (specs, links, the files) into one report, so the state of
 * a prototype can be inspected without opening the filesystem by hand.
 *
 * All facts are recomputed from disk; nothing here is cached or persisted.
 */

import { readFileSync, readdirSync } from 'fs'
import { getWorkspacePrototypesPath } from '../workspaces/storage.ts'
import { pictureStanding } from '../drawio/picture.ts'
import { notice, rawNotice, type PrototypeNotice } from './notices.ts'
import { readPrototypeSpecs } from './spec.ts'
import { readPrototypeLinks, type PrototypeLink } from './links.ts'
import { isPrototypeEntryFile, isSpecFile } from './types.ts'
import {
  getPrototypeDirPath,
  listPrototypeFiles,
  type PrototypeFileEntry,
} from './storage.ts'

/**
 * One spec, as its own document states it.
 *
 * A spec is a file (`<name>.spec.md`), so its **path** is its identity and its title is the
 * file's first heading (or its own file name). The workbench keeps no statement of what
 * implements a spec: that would be a second description of the work, and it would go stale
 * the moment a file changed.
 */
export interface PrototypeStatusSpec {
  /** The `.spec.md` file's prototype-relative path — the spec's identity. */
  file: string
  title: string
}

export interface PrototypeStatus {
  slug: string
  /** Absolute path to the prototype's directory. */
  dir: string
  /**
   * The specification's specs — one per `*.spec.md` file. Empty when the folder holds none:
   * the honest state of a prototype whose specs have not been written down yet.
   */
  specs: PrototypeStatusSpec[]
  /**
   * The specification: the entry (`spec.md`) first, then the `*.spec.md` files that **are** the
   * specs — one file each. The page renders these as the specification, and each
   * spec's file is named on its own row (`specs[].file`). The entry is here even when
   * the folder holds no spec yet, so this is empty only when the folder holds neither.
   */
  specificationFiles: PrototypeFileEntry[]
  /**
   * Everything else in the prototype's own directory, in **any format** and recursively — the
   * material and the work's own files. The folder is the author's and there is no rule about what may
   * sit in it (`listPrototypeFiles`); the spec files and the entry are excluded here only
   * because the report names them elsewhere rather than listing them twice.
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
   * A link carries nothing about the work — it is navigation, and nothing about a link says a
   * spec is done. A link that resolves to nothing is in `unresolved`.
   */
  links: PrototypeLink[]
  /**
   * What this prototype still owes **as a matter of fact** — the gate's own input
   * (`whyPrototypeIsNotSettled`): a link that points at nothing.
   *
   * Read off the files and checkable by anyone, which is what makes it a gate.
   */
  unresolved: {
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
   * Everything worth saying about the specification and the pictures in it — a diagram shown an
   * earlier drawing of. Each is a silent failure otherwise — precisely the kind this report exists
   * to make loud.
   *
   * A link that points at nothing is **not** here, because that is what {@link unresolved} — and
   * so the gate — already says.
   */
  briefIssues: PrototypeNotice[]
}

/**
 * List every prototype in a workspace, each with its full status.
 *
 * A directory under `prototypes/` counts as a prototype even before anything is written into it —
 * the folder *is* the prototype, and a prototype with no specs yet is an honest state rather
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

  // The specification: one spec per `*.spec.md` file of the folder, in path order
  // (`spec.ts`). Read here rather than through a derived layer, because a spec is now
  // only a file — nothing claims to implement it.
  const documents = readPrototypeSpecs(workspaceRootPath, slug)
  // The prototype's own files, recursively, with no filter of any kind: the folder is the author's,
  // and what sits in it is their business. What a section of the report names is separated out so
  // nothing is listed twice — which is what the two lists below do between them.
  const allFiles = listPrototypeFiles(workspaceRootPath, slug)
  const linkReport = readPrototypeLinks(workspaceRootPath, slug)
  // The entry is the specification's first row whether or not any spec exists yet: it is
  // where the specification begins, so a reader sent to find it among the material has been told
  // the wrong thing about the folder. It is therefore in neither of the two lists by the rule the
  // other files are in them — it is named here, and the rest is what is left once that is done.
  const entryName = allFiles.find((file) => isPrototypeEntryFile(file.name))?.name ?? null
  // The spec files are the `*.spec.md` files by name, not by whether they parsed: a
  // spec file belongs to the specification even in the moment it cannot be read.
  const defining = new Set(allFiles.filter((file) => isSpecFile(file.name)).map((file) => file.name))
  const specificationFiles = [
    ...allFiles.filter((file) => file.name === entryName),
    ...allFiles.filter((file) => file.name !== entryName && defining.has(file.name)),
  ]
  const files = allFiles.filter((file) => file.name !== entryName && !defining.has(file.name))

  // What could not be read as written — the pictures that disagree with their own source. The fact
  // the gate already owns — a link that points at nothing — is deliberately **not** here: it is
  // `unresolved`, and this is the page's other warning box, so repeating it would say one thing twice.
  const briefIssues = [...documents.issues].map(rawNotice).concat(staleDrawings(allFiles))

  const report: Omit<PrototypeStatus, 'settleBlockers'> = {
    slug,
    dir,
    specs: documents.specs.map((spec) => ({
      file: spec.file,
      title: spec.title,
    })),
    specificationFiles,
    files,
    links: linkReport.links,
    unresolved: {
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
 * **Only facts count**, because a gate has to be answerable: a link that points at nothing. It is
 * read off the files, anyone can check it, and there is work to do about it.
 */
export function whyPrototypeIsNotSettled(status: PrototypeStatus): PrototypeNotice[] {
  const reasons: PrototypeNotice[] = []

  for (const link of status.unresolved.brokenLinks) {
    reasons.push(notice('gate.linkBroken', { from: link.from, target: link.target }))
  }

  return reasons
}
