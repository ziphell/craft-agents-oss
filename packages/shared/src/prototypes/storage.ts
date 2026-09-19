/**
 * Prototype workbench storage.
 *
 * The patch index is *derived* — {@link scanPrototypePatches} rebuilds it from
 * the `patches/` directory on every call. There is intentionally no
 * `manifest.json` to hand-write, which is what lets parallel writers write their
 * own patch files without ever contending on a shared file.
 *
 * The directory is also the ownership rule (plan §19.4): a patch at the root is
 * shared by every page, a patch in `patches/<page>/` belongs to that page alone.
 * Both are the same mechanism — one file per change, one writer per path — so
 * scoping patches by page cost no new machinery, and every patch written before
 * pages had names (all of them at the root) keeps its exact meaning.
 *
 * @see docs/prototype-workbench-plan.md §3.3 (constraint 2), §6.2 and §19.4
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { getWorkspacePrototypesPath } from '../workspaces/storage.ts'
import {
  isConsolidatedWriter,
  parsePrototypePatchName,
  PROTOTYPE_ACCEPTANCE_DIRNAME,
  PROTOTYPE_ANCHORS_DIRNAME,
  PROTOTYPE_LAYOUT_FILENAME,
  PROTOTYPE_RESEARCH_DIRNAME,
  PROTOTYPE_REVIEWS_DIRNAME,
  type PrototypeArtifacts,
  type PrototypePatch,
  type PrototypePatchKind,
} from './types.ts'
import { extractPatchTargets } from './patch-header.ts'

const PATCHES_DIRNAME = 'patches'
const DIST_DIRNAME = 'dist'

/**
 * Paths inside a prototype's own directory.
 *
 * "Directory", never "project": this workspace also has real **projects**
 * (`{workspace}/projects/{slug}/` — the containers that group sessions, tasks
 * and shared assets), and they are unrelated to prototypes. A prototype is not
 * nested inside a project, and nothing records an ownership edge between them.
 * @see docs/prototype-workbench-plan.md §15
 */

/** Absolute path to a prototype's directory. */
export function getPrototypeDirPath(workspaceRootPath: string, slug: string): string {
  return join(getWorkspacePrototypesPath(workspaceRootPath), slug)
}

/** Absolute path to a prototype's patches directory — the shared patches. */
export function getPrototypePatchesPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), PATCHES_DIRNAME)
}

/** Absolute path to one page's own patches, replayed on that page only. */
export function getPrototypePagePatchesPath(workspaceRootPath: string, slug: string, page: string): string {
  return join(getPrototypePatchesPath(workspaceRootPath, slug), page)
}

/** Absolute path to the optional layout a scratch page shares (plan §19.2). */
export function getPrototypeLayoutPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), PROTOTYPE_LAYOUT_FILENAME)
}

/** Absolute path to a prototype's exported deliverables. */
export function getPrototypeDistPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), DIST_DIRNAME)
}

/**
 * Absolute path to a prototype's research directory.
 *
 * Sits with the other path builders because it is the same kind of fact — a
 * directory name that more than one module agrees on — and because the
 * distinction it draws is a rule, not a preference: `assets/` is what a page
 * loads at runtime and therefore ships in the package, while `research/` is how
 * the author got to the requirements and therefore does not (plan §20.2).
 */
export function getPrototypeResearchPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), PROTOTYPE_RESEARCH_DIRNAME)
}

/**
 * Absolute path to a prototype's anchor records.
 *
 * Same kind of fact as the two above — a directory name more than one module
 * agrees on — and the same distinction as `research/`: `anchors/` is evidence
 * about the page (never rendered, never packaged), while `patches/` is the
 * change itself (plan §21.2).
 */
export function getPrototypeAnchorsPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), PROTOTYPE_ANCHORS_DIRNAME)
}

/** Absolute path to a prototype's reviews — the arguments against the work (plan §3.7). */
export function getPrototypeReviewsPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), PROTOTYPE_REVIEWS_DIRNAME)
}

/** Absolute path to a prototype's acceptance state — the per-round record of what passed. */
export function getPrototypeAcceptancePath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), PROTOTYPE_ACCEPTANCE_DIRNAME)
}

/** One file of a prototype's own directory: a name to show, and the absolute path to open. */
export interface PrototypeFileEntry {
  name: string
  path: string
}

/**
 * The files in a prototype's own directory, with one of them picked out as the entry.
 *
 * Everything directly in that directory, in file-name order, in **any format** (§20.1): what an
 * author keeps beside the brief is a screenshot, a spreadsheet or a design file as often as it is
 * prose, and the folder is theirs. That is also why there is no filter here — not by extension,
 * and not by ownership, which has nothing to say about a folder nobody contends for
 * (`ownership.ts`).
 *
 * The entry is returned separately rather than dropped: it is the file the workbench reads
 * requirements out of, and a caller that renders it does not want it listed twice.
 *
 * Hidden files are skipped — an editor's swap file is not something the author put there — and
 * directories are not listed at all: this is a list of *files*, and the directories beside them
 * have their own readers.
 */
export function listPrototypeFiles(
  workspaceRootPath: string,
  slug: string,
  entryName: string,
): { entry: PrototypeFileEntry | null; files: PrototypeFileEntry[] } {
  const dir = getPrototypeDirPath(workspaceRootPath, slug)

  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isFile() && !item.name.startsWith('.'))
      .map((item) => item.name)
      .sort()
  } catch {
    // No directory is an empty directory: a prototype that has not been created yet, or one
    // whose directory was removed behind us.
    return { entry: null, files: [] }
  }

  const toEntry = (name: string): PrototypeFileEntry => ({ name, path: join(dir, name) })
  const entry = names.includes(entryName) ? toEntry(entryName) : null

  return {
    entry,
    files: names.filter((name) => name !== entryName).map(toEntry),
  }
}

/**
 * A short content fingerprint of a patch, for the one thing a fingerprint is for here: telling
 * "this file changed" from "this file is as it was" without keeping a copy of it.
 *
 * Used by `reviews/`: a dispute records the fingerprint of the patch it disputes when it is filed,
 * and is reported as **stale** if that file no longer hashes to it — the same trick `anchors/` uses
 * to tell "the page moved" from "the selector never matched" (plan §21.2).
 */
export function patchFingerprint(source: string): string {
  return createHash('sha256').update(source, 'utf-8').digest('hex').slice(0, 8)
}

/** Init-script key for a patch — stable across re-scans so re-apply is idempotent. */
export function getPrototypePatchKey(slug: string, file: string): string {
  return `prototype:${slug}:${file}`
}

/** Read one patch file into a patch record, or null when it does not follow the convention. */
function readPatch(
  slug: string,
  patchesDir: string,
  file: string,
  page: string | null,
): PrototypePatch | null {
  const name = parsePrototypePatchName(file)
  if (!name) return null

  let source: string
  try {
    source = readFileSync(join(patchesDir, file), 'utf-8')
  } catch {
    // Unreadable patch (permissions, race) — skip rather than fail the replay.
    return null
  }

  // The key and the reported path are relative to `patches/`, so two pages can
  // each have an `A-001-nav.css` without their registrations colliding.
  const relative = page ? `${page}/${file}` : file
  return {
    file: relative,
    kind: name.kind,
    writer: name.writer,
    order: name.order,
    source,
    targets: extractPatchTargets(source),
    page,
    key: getPrototypePatchKey(slug, relative),
  }
}

/**
 * Deterministic replay order: the consolidated layer, then declared order → path, so listing
 * order never matters.
 *
 * Two rules, both stated rather than inherited:
 * - the consolidated layer (`fold.ts`) is checked **first**, and **by rule**: what a fold
 *   brought together has to replay after everything it folded;
 * - the writer id is **not** a sort key. It used to be, which meant a patch's position depended
 *   on what the other writers happened to be called — and now that a writer id can be anything
 *   the graph declares, that dependency would be a way to reorder history by renaming a writer.
 */
function byReplayOrder(a: PrototypePatch, b: PrototypePatch): number {
  const aConsolidated = isConsolidatedWriter(a.writer)
  const bConsolidated = isConsolidatedWriter(b.writer)
  if (aConsolidated !== bConsolidated) return aConsolidated ? 1 : -1

  if (a.order !== b.order) return a.order - b.order
  return a.file.localeCompare(b.file)
}

/** Page names that have a patch directory of their own — valid or not (status decides that). */
export function listPrototypePatchPages(workspaceRootPath: string, slug: string): string[] {
  const patchesDir = getPrototypePatchesPath(workspaceRootPath, slug)
  if (!existsSync(patchesDir)) return []
  try {
    return readdirSync(patchesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Rebuild the ordered patch index by scanning the patches directory.
 *
 * Every patch of the prototype — the shared ones at the root and each page's own,
 * one level down. `PrototypePatch.page` says which is which, so a caller that
 * renders a single page can filter (or use {@link scanPrototypePatchesForPage}).
 */
export function scanPrototypePatches(workspaceRootPath: string, slug: string): PrototypePatch[] {
  const patchesDir = getPrototypePatchesPath(workspaceRootPath, slug)
  if (!existsSync(patchesDir)) return []

  const patches: PrototypePatch[] = []

  let entries
  try {
    entries = readdirSync(patchesDir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of entries) {
    if (entry.isFile()) {
      const patch = readPatch(slug, patchesDir, entry.name, null)
      if (patch) patches.push(patch)
      continue
    }
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue

    const pageDir = join(patchesDir, entry.name)
    let files: string[]
    try {
      files = readdirSync(pageDir)
    } catch {
      continue
    }
    for (const file of files) {
      const patch = readPatch(slug, pageDir, file, entry.name)
      if (patch) patches.push(patch)
    }
  }

  return patches.sort(byReplayOrder)
}

/**
 * The patches that apply to one page: the shared ones plus that page's own.
 *
 * This is the rule the host renders with and the extension packages with, so
 * "what this page carries" has one answer everywhere (plan §19.4).
 */
export function scanPrototypePatchesForPage(
  workspaceRootPath: string,
  slug: string,
  page: string,
): PrototypePatch[] {
  return scanPrototypePatches(workspaceRootPath, slug).filter(
    (patch) => patch.page === null || patch.page === page,
  )
}

/** Load a prototype's derived artifact index. */
export function loadPrototypeArtifacts(workspaceRootPath: string, slug: string): PrototypeArtifacts {
  return {
    slug,
    dir: getPrototypeDirPath(workspaceRootPath, slug),
    patches: scanPrototypePatches(workspaceRootPath, slug),
  }
}
