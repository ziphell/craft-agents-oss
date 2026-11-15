/**
 * Turning the path a tool *said* into the path the disk *has*.
 *
 * Three things in real transcripts make this more than `path.resolve`, and all three were found
 * by running a scan over an existing workspace rather than by reading a spec:
 *
 * - **`{{SESSION_PATH}}`** — an older prompt substituted this token before the tool saw it, so a
 *   transcript can contain the placeholder literally. Unsubstituted, every one of those paths
 *   resolves into a directory that never existed (`…/{{SESSION_PATH}}/plans/x.md`), which is a
 *   33%-missing library for no reason. It is substituted here, for the same reason.
 * - **`~`** — expanded to the *home directory*, never to the workspace. Expanding it to the
 *   workspace prefixes the workspace onto a path that already contains it.
 * - **Separation** — a transcript on Windows carries `C:\a\\b` as often as `C:/a/b`.
 *
 * Everything here is pure and takes the workspace as an argument, so it is testable on any
 * platform. `node:path` is used rather than hand-rolled string work: on Windows it is `win32`,
 * which is exactly the behaviour a path from a Windows transcript needs.
 */

import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { CreationFormat, CreationPlace } from './types'

/** What a path needs in order to be resolved: where the session was, and where the workspace is. */
export interface PathContext {
  workspaceRootPath: string
  /** The session folder — what `{{SESSION_PATH}}` means. */
  sessionDir: string
  /** The directory the agent ran in (`workingDirectory` from the session header). */
  cwd: string
}

/** The document formats a creation can be. Everything else is a file, not a work. */
const FORMAT_BY_EXTENSION: Record<string, CreationFormat> = {
  md: 'md',
  mdx: 'md',
  markdown: 'md',
  html: 'html',
  htm: 'html',
  drawio: 'drawio',
  docx: 'docx',
  doc: 'docx',
  odt: 'docx',
  xlsx: 'xlsx',
  xls: 'xlsx',
  xlsm: 'xlsx',
  ods: 'xlsx',
  pptx: 'pptx',
  ppt: 'pptx',
  odp: 'pptx',
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  // Clips and recordings made through an account. A generated one is a work; a copied file is not,
  // which is why the scan also asks who named it (see `isMediaFormat`).
  mp4: 'video',
  mov: 'video',
  m4v: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
  opus: 'audio',
  flac: 'audio',
  csv: 'csv',
  tsv: 'csv',
  json: 'json',
  txt: 'text',
  log: 'text',
}

/**
 * The formats the library keeps. **Documents, not data.**
 *
 * `.json`, `.csv` and `.txt` parse as files but are not things a person opens to read what the
 * agent made: a workflow definition, an intermediate `diagram.json` beside a drawio experiment, a
 * `tsconfig.json` — data that the file tree already shows exactly as it is. Keeping them here made
 * the library read like a directory listing with extra steps, which is the one thing it must not
 * be. They still open in their own previews; they simply are not *works*.
 *
 * **Images are not documents** — but a picture a tool named as its output *is* a work. The scan
 * keeps them apart with `isMediaFormat` plus the hit's `explicit` flag: a `Write` copies a file,
 * while `--out` / a `.gen.json` note proves something was made.
 */
export const WORK_FORMATS: ReadonlySet<CreationFormat> = new Set<CreationFormat>([
  'md',
  'html',
  'drawio',
  'docx',
  'xlsx',
  'pptx',
  'pdf',
])

/** Media formats: a work only when something proves it was produced (see `WORK_FORMATS`). */
export const MEDIA_FORMATS: ReadonlySet<CreationFormat> = new Set<CreationFormat>([
  'image',
  'video',
  'audio',
])

export function isWorkFormat(format: CreationFormat): boolean {
  return WORK_FORMATS.has(format)
}

export function isMediaFormat(format: CreationFormat): boolean {
  return MEDIA_FORMATS.has(format)
}

/** The library's badge for a path, or null when the format is not a document. */
export function formatOfPath(path: string): CreationFormat | null {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  return FORMAT_BY_EXTENSION[base.slice(dot + 1).toLowerCase()] ?? null
}

/** Replace the two tokens older prompts could leave behind, and normalize separators. */
export function expandPath(raw: string, ctx: PathContext): string | null {
  let value = raw.trim()
  // Tool arguments are sometimes quoted (a path with spaces in a `--out "a b.pdf"`).
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim()
  }
  if (!value) return null

  value = value
    .replace(/\{\{\s*SESSION_PATH\s*\}\}/gi, ctx.sessionDir)
    .replace(/\{\{\s*WORKSPACE_PATH\s*\}\}/gi, ctx.workspaceRootPath)

  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(homedir(), value.slice(2))

  return value.replace(/\\\\/g, '\\')
}

/**
 * An absolute, comparable path — or null when the value cannot be a file at all.
 *
 * A relative path is resolved against the session's `cwd`, falling back to the workspace: a tool
 * that wrote `plans/x.md` meant it relative to where the agent was standing.
 */
export function normalizeArtifactPath(raw: string, ctx: PathContext): string | null {
  const expanded = expandPath(raw, ctx)
  if (!expanded) return null
  if (isAbsolute(expanded)) return resolve(expanded)
  const base = resolve(expandPath(ctx.cwd, ctx) ?? ctx.workspaceRootPath)
  return resolve(base, expanded)
}

/** Compare two absolute paths the way the platform does (case-insensitive on Windows). */
export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** How a path relates to the workspace — which is also how much it is worth showing. */
export interface PathPlace {
  place: CreationPlace
  projectSlug: string | null
}

/** Workspace folders that hold machinery, never a document a person asked for. */
const MACHINERY = ['sources', 'skills', 'tweaks', 'pages', 'prototypes', 'tasks', 'statuses', 'labels']

export function placeOfPath(absolutePath: string, workspaceRootPath: string): PathPlace {
  const rel = relative(workspaceRootPath, absolutePath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return { place: 'external', projectSlug: null }
  }
  const segments = rel.split(sep).filter(Boolean)
  const first = segments[0]?.toLowerCase()

  if (first === 'sessions') return { place: 'session', projectSlug: null }
  if (first === 'projects') {
    return { place: 'project', projectSlug: segments[1] ?? null }
  }
  if (first && MACHINERY.includes(first)) return { place: 'source', projectSlug: null }

  // The workspace root's own files (config.json, events.jsonl, …) are machinery too.
  return { place: 'source', projectSlug: null }
}

/** The file name, which is what a person reads on a card. */
export function titleOfPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/**
 * Files the app itself keeps, which are never a work.
 *
 * Not a guess about naming taste — these are *conventions this product owns*:
 *
 * - `MEMORY.md` at a project's root is the project memory the agent maintains across sessions
 *   (the same file the system prompt hands it as `project_memory_path`). It is a scratchpad that
 *   is rewritten constantly, not something made for a person to read.
 * - `AGENTS.md` / `CLAUDE.md` are the instructions a project gives its agent.
 * - Anything under a `.agents/` directory is a skill definition.
 *
 * Everything else in a project folder stays: a report is a report, whatever it is called.
 */
const BOOKKEEPING_FILES = new Set(['MEMORY.md', 'AGENTS.md', 'CLAUDE.md'])

export function isBookkeepingPath(absolutePath: string, workspaceRootPath: string): boolean {
  const segments = relative(workspaceRootPath, absolutePath).split(sep).filter(Boolean)
  // `projects/<slug>/MEMORY.md` — the project's own root, not a file a person happened to name.
  if (segments[0] === 'projects' && segments.length === 3 && BOOKKEEPING_FILES.has(segments[2]!)) {
    return true
  }
  return segments.includes('.agents')
}
