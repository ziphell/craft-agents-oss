/**
 * Where a canvas lives: one file in the project's own folder.
 *
 * `<project>/canvas.json` — beside `assets/`, `generations/` and `MEMORY.md`, so a canvas is part
 * of the work rather than a database row: it can be copied, diffed, backed up, opened by a text
 * editor, and it survives the app. **A project has exactly one canvas.**
 *
 * Version 1 kept many canvases under `canvases/<slug>.canvas.json`. Those files are still readable
 * and are the migration source (`ensureCanvasFile` picks the most recently edited one); they are no
 * longer a second board in the app.
 *
 * The file is written atomically (temp file in the same directory, then rename) because two
 * editors — a person in one window, an agent in another — can land at once and a half-written
 * canvas is worse than a refused one.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import {
  CANVAS_DOC_VERSION,
  createCanvasDoc,
  parseCanvasDoc,
  serializeCanvasDoc,
  type CanvasDoc,
} from './document.ts'

/** One canvas per project: `<project>/canvas.json`. */
export const CANVAS_FILE_NAME = 'canvas.json'
/** The folder version 1 used; kept only to migrate and to leave old files readable. */
export const CANVASES_DIR = 'canvases'
export const CANVAS_EXTENSION = '.canvas.json'
/** Markdown documents created for text nodes that used to keep their words inline. */
export const CANVAS_NODES_DIR = 'docs/nodes'

export function canvasesDir(projectDir: string): string {
  return join(projectDir, CANVASES_DIR)
}

/** The project's one canvas. The optional slug is accepted for old callers and ignored. */
export function canvasPath(projectDir: string, _slug?: string): string {
  return join(projectDir, CANVAS_FILE_NAME)
}

/** Where a version-1 canvas lived. Only migration reads this. */
export function legacyCanvasPath(projectDir: string, slug: string): string {
  return join(canvasesDir(projectDir), `${slug}${CANVAS_EXTENSION}`)
}

/**
 * A file name a person can recognize.
 *
 * The name is the canvas's name (`我的画布`), not a uuid: a project folder is read by people, and
 * a list of hashes tells them nothing. Only characters that a file name cannot hold are replaced.
 */
export function canvasSlug(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60)
  return cleaned || 'canvas'
}

export function slugOfCanvasFile(fileName: string): string | null {
  if (!fileName.endsWith(CANVAS_EXTENSION)) return null
  return basename(fileName, CANVAS_EXTENSION)
}

export interface CanvasFileEntry {
  slug: string
  path: string
  /** Last write, ms — the list's "edited 3 minutes ago". */
  updatedAt: number
  name: string
  revision: number
  nodeCount: number
}

/** The version-1 canvases still on disk, newest edit first. Only migration reads this list. */
export function listCanvasFiles(projectDir: string): CanvasFileEntry[] {
  const dir = canvasesDir(projectDir)
  if (!existsSync(dir)) return []
  const entries: CanvasFileEntry[] = []
  for (const fileName of readdirSync(dir)) {
    const slug = slugOfCanvasFile(fileName)
    if (!slug) continue
    const path = join(dir, fileName)
    try {
      const doc = parseCanvasDoc(readFileSync(path, 'utf8'))
      entries.push({
        slug,
        path,
        updatedAt: Date.now(),
        name: doc.name,
        revision: doc.revision,
        nodeCount: doc.nodes.length,
      })
    } catch {
      // A canvas this build cannot read is still a file in the folder; it is listed so it can be
      // opened or deleted rather than silently disappearing from the list.
      entries.push({ slug, path, updatedAt: 0, name: slug, revision: -1, nodeCount: 0 })
    }
  }
  return entries.sort((a, b) => b.updatedAt - a.updatedAt || a.slug.localeCompare(b.slug))
}

export function readCanvasFile(path: string): CanvasDoc {
  return parseCanvasDoc(readFileSync(path, 'utf8'))
}

/** Write through a temp file in the same directory, then rename: a reader never sees half a doc. */
export function writeCanvasFile(path: string, doc: CanvasDoc): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, serializeCanvasDoc(doc), 'utf8')
    renameSync(temp, path)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // The temp file is best-effort cleanup; the original error is what the caller needs.
    }
    throw error
  }
}

/** The most recently edited version-1 canvas, when a project still has one. */
function latestLegacyCanvasPath(projectDir: string): string | null {
  const dir = canvasesDir(projectDir)
  if (!existsSync(dir)) return null
  const candidates: { path: string; mtimeMs: number }[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(CANVAS_EXTENSION)) continue
    const path = join(dir, name)
    try {
      candidates.push({ path, mtimeMs: statSync(path).mtimeMs })
    } catch {
      // A file that vanished while listing is not a canvas to migrate.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const candidate of candidates) {
    try {
      readCanvasFile(candidate.path)
      return candidate.path
    } catch {
      // Skip a file this build cannot read; another legacy canvas may still be usable.
    }
  }
  return null
}

/** A file name for a migrated text node: the node id, with characters a path cannot hold replaced. */
function nodeRelativePath(nodeId: string): string {
  const safe = nodeId
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 80)
  return `${CANVAS_NODES_DIR}/${safe || 'node'}.md`
}

/**
 * Turn version-1 inline text into markdown files.
 *
 * The document is the only thing that knows which nodes were text. This runs when the canvas is
 * opened, before a panel or an agent can write, so every later reader sees the same files.
 */
export function migrateInlineText(
  doc: CanvasDoc,
  projectDir: string,
): { doc: CanvasDoc; changed: boolean } {
  let changed = doc.version !== CANVAS_DOC_VERSION
  const nodes = doc.nodes.map((node) => {
    if (node.type !== 'text') return node
    if (node.src) {
      if (node.text === undefined) return node
      changed = true
      const { text: _legacyText, ...rest } = node
      return rest
    }
    const relative = nodeRelativePath(node.id)
    const absolute = join(projectDir, relative)
    if (!existsSync(absolute)) {
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, node.text ?? '', 'utf8')
    }
    changed = true
    const { text: _legacyText, ...rest } = node
    return { ...rest, src: relative }
  })
  return { doc: { ...doc, version: CANVAS_DOC_VERSION, nodes }, changed }
}

/**
 * The project's one canvas, created or migrated on first use.
 *
 * A project that still has `canvases/<slug>.canvas.json` keeps the most recently edited one as
 * `canvas.json`; the others stay on disk as ordinary files. Nothing is deleted.
 */
export function ensureCanvasFile(
  projectDir: string,
  name = '画布',
): { path: string; doc: CanvasDoc } {
  const path = canvasPath(projectDir)
  if (!existsSync(path)) {
    const legacy = latestLegacyCanvasPath(projectDir)
    const doc = legacy ? readCanvasFile(legacy) : createCanvasDoc(name)
    writeCanvasFile(path, doc)
  }
  // A file written by an older build is upgraded in memory by the parser; the upgrade only reaches
  // the disk here, where it is safe to write. Checking the stored version — not the parsed one,
  // which is always current — is what makes "open once" enough to modernise a project.
  const raw = readFileSync(path, 'utf8')
  let storedVersion: unknown
  try {
    storedVersion = (JSON.parse(raw) as { version?: unknown }).version
  } catch {
    storedVersion = undefined
  }
  const read = parseCanvasDoc(raw)
  const migrated = migrateInlineText(read, projectDir)
  if (migrated.changed || storedVersion !== CANVAS_DOC_VERSION) writeCanvasFile(path, migrated.doc)
  return { path, doc: migrated.doc }
}

/**
 * Create (or answer) the project's canvas.
 *
 * The old signature returned a slug because a project could hold many. One project now has one
 * canvas; `canvas` is the stable slug old callers can keep using.
 */
export function createCanvasFile(projectDir: string, name: string): { slug: string; path: string; doc: CanvasDoc } {
  const { path, doc } = ensureCanvasFile(projectDir, name)
  return { slug: 'canvas', path, doc }
}
