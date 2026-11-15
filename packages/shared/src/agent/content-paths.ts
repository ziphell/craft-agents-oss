/**
 * Where a conversation's files live, and how a command names one.
 *
 * A conversation has one **content root**: the project it belongs to when it belongs to one, and
 * its own session folder otherwise. It is the folder *containing* `assets/` — not `assets/`
 * itself. The pane doors (a screenshot, a recording's frames, a download) count a relative
 * path and an omitted output from it, so a conversation in no project writes beside its own
 * transcript instead of into the workspace.
 *
 * Cuts are different: they belong to a project's own store, are only offered to a conversation
 * that is in a project, and their files land under `<project>/reels/`. Media generation follows the
 * content root instead — a generated file and its source note are meaningful beside a plain
 * conversation too. Moving a conversation into a project moves where its *next* files go, without
 * rewriting anything already on disk.
 *
 * A path in a command is a **handle**, never an absolute path:
 *
 * - `assets/x.png` — relative to the content root (the project, or the session folder).
 * - `project:x` — the attached project. Refused, by name, when the conversation is in none: a
 *   working directory that happens to sit inside a project folder is not an attachment.
 * - `session:x` — this conversation's own folder, wherever the conversation currently lives.
 * - `cwd:x` — the conversation's working directory (the project folder, usually).
 * - `workspace:x` — the workspace root.
 *
 * An absolute path inside one of those roots is accepted and normalised to the matching handle; one
 * outside them is refused. URLs are refused: this works on files, and a provider URL is not one.
 *
 * Everything is resolved **per call** from the session's live binding — a conversation can move
 * into or out of a project between two tool calls.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { loadProjectById } from '../projects/storage.ts'
import { toPosix } from '../provenance/paths.ts'
import { getSessionPath } from '../sessions/storage.ts'

/** What the caller knows about the conversation when it asks where a path points. */
export interface ContentContext {
  sessionId?: string | undefined
  workspaceRootPath?: string | undefined
  /** The session folder, when the caller already resolved it (`ctx.sessionPath`). */
  sessionDir?: string | undefined
  /** The workspace project the conversation is bound to. */
  projectId?: string | undefined
  /** The conversation's working directory — the project folder when it is in one. */
  workingDirectory?: string | undefined
}

/** The places a handle may name, resolved once per tool call. */
export interface ContentRoots {
  /** The folder that contains `assets/` — not `assets/` itself. */
  contentRoot: string
  projectDir: string | null
  sessionDir: string | null
  workingDirectory: string | null
  workspaceRoot: string | null
  /** True when a bare handle is printed as `assets/x` (a project, or a root with no session). */
  bareHandles: boolean
}

export type ContentRootsResult = { ok: true; roots: ContentRoots } | { ok: false; error: string }

export type ResolvedFilePath =
  | { ok: true; path: string; handle: string }
  | { ok: false; error: string }

const NAMESPACES = ['project', 'session', 'cwd', 'workspace'] as const
type Namespace = (typeof NAMESPACES)[number]

/** Is `target` the same as `root`, or inside it? */
export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('../')
}

/** `<rel>` as a handle, by the namespace this conversation prints. */
export function handleForRelative(relativePath: string, roots: ContentRoots): string {
  const rel = toPosix(relativePath).replace(/^\.?\//, '')
  return roots.bareHandles ? rel : `session:${rel}`
}

/** The handle a resolved file is printed as. Never an absolute path when it lives in a root. */
export function handleForPath(absolutePath: string, roots: ContentRoots): string {
  const absolute = resolve(absolutePath)
  if (isInside(roots.contentRoot, absolute)) {
    return handleForRelative(relative(roots.contentRoot, absolute) || '.', roots)
  }
  const named: Array<[Namespace, string | null]> = [
    ['session', roots.sessionDir],
    ['cwd', roots.workingDirectory],
    ['workspace', roots.workspaceRoot],
  ]
  for (const [namespace, root] of named) {
    if (root && isInside(root, absolute)) {
      return `${namespace}:${toPosix(relative(root, absolute))}`
    }
  }
  // Only reachable for a path a caller resolved outside the roots; the resolvers refuse those.
  return absolute
}

/** The project folder a session is attached to, or the reason it has none. */
function projectFolderOf(
  context: ContentContext,
  workspaceRoot: string | null,
): { ok: true; dir: string | null } | { ok: false; error: string } {
  if (!context.projectId) {
    // A working directory that happens to sit inside a project folder is **not** a binding: the
    // conversation's scope stays its own session folder, and `project:` keeps refusing. Only the
    // explicit `projectId` makes that project this conversation's project.
    return { ok: true, dir: null }
  }

  if (!workspaceRoot) {
    return {
      ok: false,
      error: `This conversation belongs to a project (${context.projectId}), but its workspace is not known here.`,
    }
  }
  let folder: string | null = null
  try {
    folder = loadProjectById(workspaceRoot, context.projectId)?.folderPath ?? null
  } catch {
    folder = null
  }
  if (!folder) {
    return {
      ok: false,
      error:
        `The project this conversation belongs to (${context.projectId}) is no longer in this workspace. ` +
        'Rebind the conversation to a project, or use `session:` paths.',
    }
  }
  return { ok: true, dir: folder }
}

/** Resolve the roots once, from the conversation's live state. */
export function resolveContentRoots(context: ContentContext): ContentRootsResult {
  const workspaceRoot = context.workspaceRootPath ? resolve(context.workspaceRootPath) : null
  const sessionDir =
    context.sessionDir ??
    (workspaceRoot && context.sessionId ? getSessionPath(workspaceRoot, context.sessionId) : null)
  const workingDirectory = context.workingDirectory ? resolve(context.workingDirectory) : null

  const project = projectFolderOf(context, workspaceRoot)
  if (!project.ok) return project

  const contentRoot = project.dir ?? sessionDir ?? workingDirectory ?? workspaceRoot
  if (!contentRoot) {
    return {
      ok: false,
      error:
        'This conversation has no workspace, working directory or session folder, so there is nowhere to put a file.',
    }
  }

  return {
    ok: true,
    roots: {
      contentRoot: resolve(contentRoot),
      projectDir: project.dir,
      sessionDir,
      workingDirectory,
      workspaceRoot,
      // A project prints bare `assets/x`; a session folder prints `session:assets/x`. A bare root
      // (a test, a host with no session) keeps the old bare spelling.
      bareHandles: project.dir !== null || sessionDir === null,
    },
  }
}

function anchorFor(namespace: Namespace, roots: ContentRoots): { ok: true; root: string } | { ok: false; error: string } {
  if (namespace === 'project') {
    if (!roots.projectDir) {
      return {
        ok: false,
        error:
          '`project:` names the attached project, and this conversation is not in one. ' +
          'Use a bare `assets/…` path for this conversation, or `session:…`.',
      }
    }
    return { ok: true, root: roots.projectDir }
  }
  if (namespace === 'session') {
    if (!roots.sessionDir) {
      return { ok: false, error: '`session:` names this conversation’s own folder, and this tool does not know one here.' }
    }
    return { ok: true, root: roots.sessionDir }
  }
  if (namespace === 'cwd') {
    if (!roots.workingDirectory) {
      return { ok: false, error: '`cwd:` names the working directory, and this conversation has none.' }
    }
    return { ok: true, root: roots.workingDirectory }
  }
  if (!roots.workspaceRoot) {
    return { ok: false, error: '`workspace:` names the workspace root, and this tool does not know one here.' }
  }
  return { ok: true, root: roots.workspaceRoot }
}

/**
 * Resolve one path from a command to a real file, and the handle to print for it.
 *
 * The handle is what every reply prints and what the next command takes, so a file is named the
 * same way on both sides of a call.
 */
export function resolveFilePath(raw: string, roots: ContentRoots): ResolvedFilePath {
  const value = raw.trim()
  if (!value) return { ok: false, error: 'A path is needed.' }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^data:/i.test(value)) {
    return {
      ok: false,
      error:
        `"${value}" is a URL, not a file. This door works on files: download it first ` +
        '(browser_tool download) and pass the path it wrote.',
    }
  }

  if (isAbsolute(value)) {
    const rootsToCheck = [roots.projectDir, roots.sessionDir, roots.workingDirectory, roots.workspaceRoot]
    if (!rootsToCheck.some((root) => root && isInside(root, value))) {
      return {
        ok: false,
        error:
          `"${value}" is outside this conversation’s workspace. Start from a path inside it, ` +
          'or name a project:, session:, cwd: or workspace: handle.',
      }
    }
    return { ok: true, path: resolve(value), handle: handleForPath(value, roots) }
  }

  const lower = value.toLowerCase()
  const namespace = NAMESPACES.find((candidate) => lower.startsWith(`${candidate}:`))
  if (namespace) {
    const rest = value.slice(namespace.length + 1)
    if (!rest.trim()) return { ok: false, error: `\`${namespace}:\` needs a path after it.` }
    const anchor = anchorFor(namespace, roots)
    if (!anchor.ok) return anchor
    const absolute = resolve(anchor.root, rest)
    if (!isInside(anchor.root, absolute)) {
      return { ok: false, error: `"${value}" leads outside \`${namespace}:\`.` }
    }
    return { ok: true, path: absolute, handle: handleForPath(absolute, roots) }
  }

  const absolute = resolve(roots.contentRoot, value)
  if (!isInside(roots.contentRoot, absolute)) {
    return {
      ok: false,
      error:
        `"${value}" leads outside ${roots.bareHandles ? 'this project' : 'this conversation’s folder'}. ` +
        `Paths are relative to ${roots.bareHandles ? 'the project' : 'the conversation folder'} ` +
        `(${roots.bareHandles ? 'assets/…' : 'session:assets/…'}).`,
    }
  }
  return { ok: true, path: absolute, handle: handleForPath(absolute, roots) }
}
