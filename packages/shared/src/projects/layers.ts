/**
 * Work report — one report of a project's layers, derived from its files.
 *
 * A project's thinking is written down in **three layers**, each a file in the project's own
 * folder: the goal (`goal.md`, one file at the root), the specifications (`*.spec.md`, one file
 * per spec) and the plans (`*.plan.md`, one file per plan). A spec and a plan that share a stem
 * are the two layers of **one piece of work** (`cart.spec.md` and `cart.plan.md`), which is why
 * the report groups by stem rather than listing the files flat.
 *
 * Composes the derived facts (the layers, the links, the files) into one report, so the state of
 * a folder can be inspected without opening the filesystem by hand.
 *
 * All facts are recomputed from disk; nothing here is cached or persisted. The report states
 * **what the files say** and nothing about what is missing: which layer a folder holds is a fact
 * about its file names, and the one thing this report calls out is a link that points at nothing.
 */

import { readFileSync } from 'fs'
import { pictureStanding } from '../drawio/picture.ts'
import { notice, rawNotice, type SpecNotice } from './notices.ts'
import { parseSpecDocument, readSpecDocuments } from './spec-docs.ts'
import { readSpecLinks, type SpecLink } from './links.ts'
import {
  PLAN_SUFFIX,
  SPEC_SUFFIX,
  isGoalFile,
  isPlanFile,
  isSpecEntryFile,
  isSpecFile,
} from './spec-names.ts'
import { listFiles, type FolderFile } from './files.ts'

/**
 * One layer's document — a spec or a plan — as its own file states it.
 *
 * The layer is a file (`<name>.spec.md`, `<name>.plan.md`), so its **path** is its identity and
 * its title is the file's first heading (or its own file name). The workbench keeps no statement
 * of what implements a spec: that would be a second description of the work, and it would go stale
 * the moment a file changed.
 */
export interface LayerDocument {
  /** The layer file's folder-relative path — its identity. */
  file: string
  title: string
}

/**
 * One piece of work — the layers written for one stem.
 *
 * The stem is the file's name with its layer suffix stripped, relative to the folder: `cart`,
 * `docs/cart`. Each layer is optional, and a piece with a spec and no plan (or a plan and no spec)
 * is simply a piece whose other layer has not been written — not a fault for the report to raise.
 */
interface WorkPiece {
  /** The layer files' stem, folder-relative — the piece's identity. */
  stem: string
  spec: LayerDocument | null
  plan: LayerDocument | null
}

export interface WorkLayers {
  slug: string
  /** Absolute path to the folder. */
  dir: string
  /**
   * The **goal** — the root `goal.md`, read for its first heading (its own file name when it has
   * none). A project keeps one goal, so this is one value or none: null when the folder holds no
   * `goal.md` at its root.
   */
  goal: { file: FolderFile; title: string } | null
  /**
   * The **entry** — the root `spec.md`, the conventional index the specification is read through.
   * It is not a spec (its name ends in `.md`, not `.spec.md`), so it states nothing on its own; it
   * is the specification's first row whether or not any spec exists yet. Null when the folder holds
   * no root `spec.md`.
   */
  entry: FolderFile | null
  /**
   * The pieces of work, grouped by stem and in stem order. Each piece carries the spec written for
   * that stem, the plan written for it, or both — whichever layers the folder holds.
   */
  pieces: WorkPiece[]
  /**
   * Everything else in the folder, in **any format** and recursively — the material and the work's
   * own files. The folder is the author's and there is no rule about what may sit in it
   * (`listFiles`); the goal, the entry and the layer files are excluded here only because the
   * report names them elsewhere rather than listing them twice.
   *
   * Paths rather than text: the panel reads what it shows through `file:read`, and a list of
   * status reports is no place to carry every project's files.
   */
  files: FolderFile[]
  /**
   * How the documents point at each other (ordinary markdown links — `links.ts`), read from both
   * ends: a link with its `from` and `to` is simultaneously an outgoing link for `from` and a
   * backlink for `to`, so the page can say "links to" and "linked from" without a second reading.
   *
   * A link carries nothing about the work — it is navigation, and nothing about a link says a
   * spec is done. A link that resolves to nothing is in `unresolved`.
   */
  links: SpecLink[]
  /**
   * What this folder still owes **as a matter of fact** — the report's own input: a link that
   * points at nothing.
   *
   * Read off the files and checkable by anyone.
   */
  unresolved: {
    /** Links whose target is not in the folder — a reader following one arrives nowhere. */
    brokenLinks: Array<{ from: string; target: string }>
  }
  /**
   * {@link brokenLinkNotices} of this very report — the broken links in their own words, carried as
   * data so the panel can say which links point at nothing.
   *
   * It is computed here rather than by each reader for the reason it exists at all: two
   * statements of the same fact would drift. The renderer is a reader now, and it cannot call a
   * runtime function from the shared barrel, so the sentence travels with the facts
   * it was reached from. Empty when there is nothing outstanding.
   */
  brokenLinkNotices: SpecNotice[]
  /**
   * Everything worth saying about the documents and the pictures in them — a diagram shown an
   * earlier drawing of. Each is a silent failure otherwise — precisely the kind this report exists
   * to make loud.
   *
   * A link that points at nothing is **not** here, because that is what {@link unresolved} — and
   * so {@link brokenLinkNotices} — already says.
   */
  briefIssues: SpecNotice[]
}

/** Build the full work report for a folder. */
export function buildWorkLayers(dir: string, slug: string): WorkLayers {
  // The specification: one spec per `*.spec.md` file of the folder, in path order
  // (`spec-docs.ts`). Read here rather than through a derived layer, because a spec is only a file
  // — nothing claims to implement it. The plans are read by title below, the same way.
  const documents = readSpecDocuments(dir)
  // The folder's own files, recursively, with no filter of any kind: the folder is the author's,
  // and what sits in it is their business. What a section of the report names is separated out so
  // nothing is listed twice.
  const allFiles = listFiles(dir)
  const linkReport = readSpecLinks(dir)

  // The goal is the root `goal.md`, and the entry is the root `spec.md`: both are named here so the
  // rest of the folder is what is left once they are, and a `docs/goal.md` or `docs/spec.md` the
  // author filed away stays where the author put it — in the material.
  const goalName = allFiles.find((file) => isGoalFile(file.name))?.name ?? null
  const entryName = allFiles.find((file) => isSpecEntryFile(file.name))?.name ?? null

  // A spec's title is read with the documents (`spec-docs.ts`), which also says a spec file that
  // could not be read. A file it could not read has no title here, and falls back to its name.
  const specTitles = new Map(documents.specs.map((spec) => [spec.file, spec.title]))

  // The pieces, grouped by stem. A spec and a plan sharing a stem meet here as the two layers of
  // one piece; a layer written without the other still makes a piece, with the other one null.
  const pieces = new Map<string, WorkPiece>()
  const pieceFor = (stem: string): WorkPiece => {
    let piece = pieces.get(stem)
    if (!piece) {
      piece = { stem, spec: null, plan: null }
      pieces.set(stem, piece)
    }
    return piece
  }

  for (const file of allFiles) {
    // The stem is the file's own path with its layer suffix stripped — the suffix by the same
    // predicate that recognised the file (`isSpecFile` / `isPlanFile`), so `cart.spec.md` and
    // `docs/cart.plan.md` give the stems `cart` and `docs/cart`.
    if (isSpecFile(file.name)) {
      const piece = pieceFor(file.name.slice(0, -SPEC_SUFFIX.length))
      if (!piece.spec) {
        piece.spec = { file: file.name, title: specTitles.get(file.name) ?? file.name }
      }
    } else if (isPlanFile(file.name)) {
      const piece = pieceFor(file.name.slice(0, -PLAN_SUFFIX.length))
      if (!piece.plan) {
        piece.plan = { file: file.name, title: layerTitle(file.path, file.name) }
      }
    }
  }

  const goalFile = allFiles.find((file) => file.name === goalName) ?? null
  const goal = goalFile
    ? { file: goalFile, title: layerTitle(goalFile.path, goalFile.name) }
    : null
  const entry = allFiles.find((file) => file.name === entryName) ?? null

  // What is left once the goal, the entry and the layer files are named elsewhere.
  const files = allFiles.filter(
    (file) =>
      file.name !== goalName &&
      file.name !== entryName &&
      !isSpecFile(file.name) &&
      !isPlanFile(file.name),
  )

  // What could not be read as written — the pictures that disagree with their own source. The fact
  // the broken-link sentence already owns — a link that points at nothing — is deliberately **not**
  // here: it is `unresolved`, and this is the page's other warning box, so repeating it would say one
  // thing twice.
  const briefIssues = [...documents.issues].map(rawNotice).concat(staleDrawings(allFiles))

  const report: Omit<WorkLayers, 'brokenLinkNotices'> = {
    slug,
    dir,
    goal,
    entry,
    pieces: [...pieces.values()].sort((a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0)),
    files,
    links: linkReport.links,
    unresolved: {
      brokenLinks: linkReport.links
        .filter((link) => link.to === null)
        .map((link) => ({ from: link.from, target: link.target })),
    },
    briefIssues,
  }

  // The broken links travel with the facts they were reached from, so every reader — the strict
  // export, the status output, the panel — says the same thing. Computed after the
  // literal because it reads the report it belongs to.
  return { ...report, brokenLinkNotices: brokenLinkNotices({ ...report, brokenLinkNotices: [] }) }
}

/**
 * A document's title — its first markdown heading, or its own file name when it has none (or
 * cannot be read). The one reading the goal and the plans need; a spec's title travels with
 * `spec-docs.ts`, which reads the same file for its prose too.
 */
function layerTitle(path: string, name: string): string {
  try {
    return parseSpecDocument(readFileSync(path, 'utf-8'), name).title
  } catch {
    // A file that cannot be read is named by its own name here: it is still a layer the folder
    // holds, and this is not the report that reports a file it could not read.
    return name
  }
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
function staleDrawings(files: FolderFile[]): SpecNotice[] {
  const issues: SpecNotice[] = []
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
 * what says it can be regenerated from something somebody drew (see `docs/layers.md`). Any other
 * name is a picture with nothing to compare it to, which is not a problem to report — the folder is the
 * author's.
 */
function sourceNameOf(name: string): string {
  if (!name.toLowerCase().endsWith('.svg')) return name
  const withoutSuffix = name.slice(0, -'.svg'.length)
  return withoutSuffix.toLowerCase().endsWith('.drawio') ? withoutSuffix : name
}

/**
 * The broken links of a report, each as its own sentence — empty when there are none.
 *
 * Only facts count, and this is read off the files: a link that points at nothing. Anyone can
 * check it, and there is work to do about it.
 */
function brokenLinkNotices(status: WorkLayers): SpecNotice[] {
  const reasons: SpecNotice[] = []

  for (const link of status.unresolved.brokenLinks) {
    reasons.push(notice('gate.linkBroken', { from: link.from, target: link.target }))
  }

  return reasons
}
