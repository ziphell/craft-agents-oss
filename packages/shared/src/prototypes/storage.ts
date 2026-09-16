/**
 * Prototype workbench storage.
 *
 * The patch index is *derived* — {@link scanPrototypePatches} rebuilds it from
 * the `patches/` directory on every call. There is intentionally no
 * `manifest.json` to hand-write, which is what lets parallel lanes write their
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
import { join } from 'path'
import { getWorkspacePrototypesPath } from '../workspaces/storage.ts'
import type { PrototypeArtifacts, PrototypePatch, PrototypePatchKind } from './types.ts'
import { PROTOTYPE_LAYOUT_FILENAME } from './types.ts'

const PATCHES_DIRNAME = 'patches'
const DIST_DIRNAME = 'dist'

/**
 * Patch files must be named `{lane}-{nnn}-{slug}.{css|js}`, either at the root of
 * `patches/` (shared) or one directory deep (`patches/<page>/…`). Anything else in
 * the directory (READMEs, editor backups, notes) is ignored rather than replayed.
 */
const PATCH_NAME_RE = /^([A-Za-z])-(\d+)-.+\.(css|js)$/

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

/** Absolute path to the optional shell a scratch page shares (plan §19.2). */
export function getPrototypeLayoutPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), PROTOTYPE_LAYOUT_FILENAME)
}

/** Absolute path to a prototype's exported deliverables. */
export function getPrototypeDistPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), DIST_DIRNAME)
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
  const match = PATCH_NAME_RE.exec(file)
  if (!match) return null

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
    kind: match[3] as PrototypePatchKind,
    lane: match[1] ?? null,
    order: Number(match[2] ?? 0),
    source,
    page,
    key: getPrototypePatchKey(slug, relative),
  }
}

/** Deterministic replay order: lane → declared order → path, so listing order never matters. */
function byReplayOrder(a: PrototypePatch, b: PrototypePatch): number {
  const laneCompare = (a.lane ?? '').localeCompare(b.lane ?? '')
  if (laneCompare !== 0) return laneCompare
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
