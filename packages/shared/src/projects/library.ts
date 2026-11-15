/**
 * A project's asset library, on disk.
 *
 * The library is two facts joined at read time:
 *
 * - **the files** — every file under the project's `assets/`, listed recursively, hidden entries
 *   skipped. These are the materials of the work, not the app's own state, which is why
 *   `config.json` and `MEMORY.md` are not here. Generation history is a different view
 *   (`provenance`); it is not a second source for this folder.
 * - **the meaning** — `<assets>/.index.json`, a small index of tags and notes keyed by a path
 *   relative to the project root. It sits beside the files it describes, and being a dotfile it is
 *   neither listed as an asset nor shown to a person browsing the folder.
 *
 * Nothing in the index is allowed to assert that a file exists: a deleted file is simply not
 * listed, and an unannotated file is simply untagged. That is what lets a person move files in
 * Explorer without the library calling it damage.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import {
  LIBRARY_FILE_NAME,
  emptyLibraryDoc,
  mergeRegistry,
  readLibraryFile,
  tagFacets,
  withLayout,
  withNote,
  withTags,
  withoutEntry,
  writeLibraryFile,
  type AssetAuthor,
  type AssetFileInfo,
  type AssetLayout,
  type AssetTaskInfo,
  type LibraryAsset,
  type LibraryDoc,
  type TagFacet,
} from '../library/index.ts'
import { atomicWriteFileSync } from '../utils/files.ts'
import { debug } from '../utils/debug.ts'
import { readGenerationRecords, toProjectPath } from '../provenance/storage.ts'
import { listMediaTasks } from '../media/tasks.ts'
import { getProjectPath } from './storage.ts'

/** The folder whose files are the project's assets. */
const ASSET_ROOT = 'assets'

/** Notes the app writes beside a file. They describe an asset; they are not one. */
const SIDECAR_SUFFIXES = ['.gen.json', '.task.json']

/** Where a root's library index lives: `<contentRoot>/assets/.index.json`. */
export function getLibraryFilePath(contentRoot: string): string {
  return join(contentRoot, ASSET_ROOT, LIBRARY_FILE_NAME)
}

export function getProjectLibraryFilePath(workspaceRootPath: string, projectSlug: string): string {
  return getLibraryFilePath(getProjectPath(workspaceRootPath, projectSlug))
}

function walk(dir: string, prefix: string, into: AssetFileInfo[]): void {
  let items
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    // A folder nobody made yet, or one removed while we read it, holds no assets. It is not an
    // error: the library's first state is empty.
    return
  }

  for (const item of items) {
    if (item.name.startsWith('.')) continue
    const path = join(dir, item.name)
    const relative = `${prefix}/${item.name}`
    if (item.isDirectory()) {
      walk(path, relative, into)
      continue
    }
    if (!item.isFile()) continue
    if (SIDECAR_SUFFIXES.some((suffix) => item.name.endsWith(suffix))) continue
    try {
      const stats = statSync(path)
      into.push({ path: relative, sizeBytes: stats.size, modifiedAt: stats.mtimeMs })
    } catch (error) {
      debug('[projectLibrary] Failed to stat asset:', path, error)
    }
  }
}

/** Every file the library shows, without any tags applied. */
export function scanAssets(contentRoot: string): AssetFileInfo[] {
  const files: AssetFileInfo[] = []
  walk(join(contentRoot, ASSET_ROOT), ASSET_ROOT, files)
  return files
}

export function scanProjectAssets(workspaceRootPath: string, projectSlug: string): AssetFileInfo[] {
  return scanAssets(getProjectPath(workspaceRootPath, projectSlug))
}

export interface LibraryRead {
  doc: LibraryDoc
  /** A problem worth telling a person about, when the index could not be read as written. */
  warning?: string
}

export function readLibrary(contentRoot: string): LibraryRead {
  const file = getLibraryFilePath(contentRoot)
  if (!existsSync(file)) return { doc: emptyLibraryDoc() }
  try {
    const result = readLibraryFile(readFileSync(file, 'utf8'))
    return result.ok ? { doc: result.doc } : { doc: result.doc, warning: result.message }
  } catch (error) {
    return {
      doc: emptyLibraryDoc(),
      warning: `The library index could not be read: ${(error as Error).message}`,
    }
  }
}

export function readProjectLibrary(
  workspaceRootPath: string,
  projectSlug: string,
): LibraryRead {
  return readLibrary(getProjectPath(workspaceRootPath, projectSlug))
}

export interface LibrarySnapshot {
  assets: LibraryAsset[]
  facets: TagFacet[]
  warning?: string
}

/** The asset registry: files, generation notes, tasks, and the board records in the index. */
export function listLibrary(contentRoot: string): LibrarySnapshot {
  const { doc, warning } = readLibrary(contentRoot)
  // The source description is not a second index: it is the `.gen.json` notes that already sit
  // beside the files. A note whose file is gone is kept here, because the registry answers "was
  // this path an asset?" rather than "is there a file right now?".
  const records = readGenerationRecords(contentRoot, { includeMissing: true }).filter((record) =>
    isAssetPath(record.file),
  )
  const scanned = listMediaTasks(join(contentRoot, ASSET_ROOT))

  // A renamed sound artifact keeps its terminal task at the requested path, so `task --out` still
  // finds it; the file and its note live at `finalPath`. Move the index entry with the file — in
  // memory, because a read must not write — or the board would keep a card at a name that never
  // existed while the real one appeared unplaced.
  const moves = renamedEntries(contentRoot, scanned)

  const tasks = scanned
    .map((task) => ({
      path: toProjectPath(contentRoot, task.finalPath ?? task.outPath),
      task,
    }))
    .filter(({ path }) => isAssetPath(path))
    .map(({ path, task }): AssetTaskInfo => ({
      path,
      status: task.status,
      updatedAt: task.updatedAt,
      cancellable: task.cancellable,
    }))
  const assets = mergeRegistry({
    files: scanAssets(contentRoot),
    doc: migrateEntries(doc, moves),
    records,
    tasks,
  })
  return { assets, facets: tagFacets(assets), warning }
}

/** Requested path → final path, for sound artifacts that were renamed to their real container. */
function renamedEntries(
  contentRoot: string,
  tasks: ReadonlyArray<{ outPath: string; finalPath?: string }>,
): Map<string, string> {
  const moves = new Map<string, string>()
  for (const task of tasks) {
    if (!task.finalPath || task.finalPath === task.outPath) continue
    const from = toProjectPath(contentRoot, task.outPath)
    const to = toProjectPath(contentRoot, task.finalPath)
    if (isAssetPath(from) && isAssetPath(to)) moves.set(from, to)
  }
  return moves
}

/** The index as if each moved file's entry had been written at its final path. */
function migrateEntries(doc: LibraryDoc, moves: ReadonlyMap<string, string>): LibraryDoc {
  if (moves.size === 0) return doc
  const entries = { ...doc.entries }
  for (const [from, to] of moves) {
    const entry = entries[from]
    if (!entry) continue
    delete entries[from]
    // A value already at the destination is newer: it was written after the move.
    entries[to] = entries[to] ? { ...entry, ...entries[to] } : entry
  }
  return { ...doc, entries }
}

/** The library only owns the `assets/` folder; a note or task elsewhere is another view's material. */
function isAssetPath(path: string): boolean {
  return path === ASSET_ROOT || path.startsWith(`${ASSET_ROOT}/`)
}

export function listProjectLibrary(
  workspaceRootPath: string,
  projectSlug: string,
): LibrarySnapshot {
  return listLibrary(getProjectPath(workspaceRootPath, projectSlug))
}

/**
 * Read, change, write.
 *
 * The whole file is rewritten because tags are keys on a small map and a person adds one at a
 * time. A malformed index is refused rather than replaced: silently discarding what somebody
 * wrote is worse than asking them to look at it.
 *
 * Reading never creates anything; only a write does, which is what keeps a read from leaving an
 * empty `assets/` folder behind in every conversation that merely looked.
 */
function updateLibrary(contentRoot: string, change: (doc: LibraryDoc) => LibraryDoc): LibraryDoc {
  const read = readLibrary(contentRoot)
  if (read.warning) throw new Error(read.warning)
  // A write is where a moved entry can be cleaned up for real: the next read gets the same answer
  // either way, but the index stops carrying a path that the file no longer lives at.
  const moved = migrateEntries(
    read.doc,
    renamedEntries(contentRoot, listMediaTasks(join(contentRoot, ASSET_ROOT))),
  )
  const next = change(moved)
  const dir = join(contentRoot, ASSET_ROOT)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(getLibraryFilePath(contentRoot), writeLibraryFile(next))
  return next
}

export function setAssetTags(
  contentRoot: string,
  assetPath: string,
  tags: readonly string[],
  author: AssetAuthor = 'human',
): LibraryDoc {
  return updateLibrary(contentRoot, (doc) => withTags(doc, assetPath, tags, author))
}

export function setProjectAssetTags(
  workspaceRootPath: string,
  projectSlug: string,
  assetPath: string,
  tags: readonly string[],
  author: AssetAuthor = 'human',
): LibraryDoc {
  return setAssetTags(getProjectPath(workspaceRootPath, projectSlug), assetPath, tags, author)
}

export function setAssetNote(
  contentRoot: string,
  assetPath: string,
  note: string,
  author: AssetAuthor = 'human',
): LibraryDoc {
  return updateLibrary(contentRoot, (doc) => withNote(doc, assetPath, note, author))
}

export function setProjectAssetNote(
  workspaceRootPath: string,
  projectSlug: string,
  assetPath: string,
  note: string,
  author: AssetAuthor = 'human',
): LibraryDoc {
  return setAssetNote(getProjectPath(workspaceRootPath, projectSlug), assetPath, note, author)
}

/**
 * Put one card on the board, or clear its place with `null`.
 *
 * The layout is written into the same index entry as the tags and note, so the board and the panel
 * share one record instead of keeping a second document in step.
 */
export function setAssetLayout(
  contentRoot: string,
  assetPath: string,
  layout: AssetLayout | null,
  author: AssetAuthor = 'human',
): LibraryDoc {
  return updateLibrary(contentRoot, (doc) => withLayout(doc, assetPath, layout, author))
}

export function setProjectAssetLayout(
  workspaceRootPath: string,
  projectSlug: string,
  assetPath: string,
  layout: AssetLayout | null,
  author: AssetAuthor = 'human',
): LibraryDoc {
  return setAssetLayout(getProjectPath(workspaceRootPath, projectSlug), assetPath, layout, author)
}

/** Forget an asset's tags, note and layout. The file is never touched. */
export function forgetAsset(contentRoot: string, assetPath: string): LibraryDoc {
  return updateLibrary(contentRoot, (doc) => withoutEntry(doc, assetPath))
}

export function forgetProjectAsset(
  workspaceRootPath: string,
  projectSlug: string,
  assetPath: string,
): LibraryDoc {
  return forgetAsset(getProjectPath(workspaceRootPath, projectSlug), assetPath)
}

/** The old names, kept for callers that speak of a project rather than any content root. */
export type ProjectLibraryRead = LibraryRead
export type ProjectLibrarySnapshot = LibrarySnapshot
