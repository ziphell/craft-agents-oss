import { basename, dirname, join, normalize, isAbsolute, parse, resolve, sep } from 'path'
import { homedir, tmpdir } from 'os'
import { realpath } from 'fs/promises'
import { getWorkspaceByNameOrId, type Workspace } from '@craft-agent/shared/config'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import { loadWorkspaceProjects } from '@craft-agent/shared/projects'
import type { ISessionManager } from './session-manager-interface'
import type { PlatformServices } from '../runtime/platform'

/**
 * Get workspace by ID or name, throwing if not found.
 * Use this when a workspace must exist for the operation to proceed.
 */
export function getWorkspaceOrThrow(workspaceId: string): Workspace {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`)
  }
  return workspace
}

export function buildBackendHostRuntimeContext(platform: PlatformServices) {
  return {
    appRootPath: platform.appRootPath,
    resourcesPath: platform.resourcesPath,
    isPackaged: platform.isPackaged,
  }
}

/**
 * Sanitizes a filename to prevent path traversal and filesystem issues.
 * Removes dangerous characters and limits length.
 */
export function sanitizeFilename(name: string): string {
  return name
    // Remove path separators and traversal patterns
    .replace(/[/\\]/g, '_')
    // Remove Windows-forbidden characters: < > : " | ? *
    .replace(/[<>:"|?*]/g, '_')
    // Remove control characters (ASCII 0-31)
    .replace(/[\x00-\x1f]/g, '')
    // Collapse multiple dots (prevent hidden files and extension tricks)
    .replace(/\.{2,}/g, '.')
    // Remove leading/trailing dots and spaces (Windows issues)
    .replace(/^[.\s]+|[.\s]+$/g, '')
    // Limit length (200 chars is safe for all filesystems)
    .slice(0, 200)
    // Fallback if name is empty after sanitization
    || 'unnamed'
}

/**
 * Extra context a caller can hand in when resolving the allowed directories.
 *
 * `sessionManager` lets the working directories of this workspace's conversations count
 * as allowed. A conversation's working directory is settable and may sit anywhere — outside
 * the workspace as easily as inside — and a file written there is still a file this
 * workspace showed, so reading or saving it back must not be refused.
 */
export interface WorkspaceAllowedDirsOptions {
  sessionManager?: Pick<ISessionManager, 'getSessions'>
}

/**
 * Resolve allowed directories for a workspace: its root path, its configured
 * working directory, every project's bound working directory, and — when a session
 * manager is given — every conversation's working directory. Returns an empty array
 * if the workspace is unknown or has no relevant paths.
 */
export function getWorkspaceAllowedDirs(
  workspaceId?: string | null,
  options?: WorkspaceAllowedDirsOptions,
): string[] {
  if (!workspaceId) return []
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) return []

  const dirs: string[] = [workspace.rootPath]
  const config = loadWorkspaceConfig(workspace.rootPath)
  if (config?.defaults?.workingDirectory) {
    dirs.push(config.defaults.workingDirectory)
  }

  // A project's own folder is always inside the workspace; only its bound working
  // directory can sit outside it, so only that one needs adding.
  for (const project of loadWorkspaceProjects(workspace.rootPath)) {
    if (project.config.workingDirectory) {
      dirs.push(project.config.workingDirectory)
    }
  }

  // A conversation's working directory is settable too, and may be anywhere.
  if (options?.sessionManager) {
    for (const session of options.sessionManager.getSessions(workspaceId)) {
      if (session.workingDirectory) {
        dirs.push(session.workingDirectory)
      }
    }
  }

  return dirs
}

/**
 * Expand a leading `~` to the user's home directory. Both separators are accepted
 * (`~/` and `~\`), because a portable path may carry either.
 */
function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(homedir(), p.slice(2))
  return p
}

/**
 * The absolute path a workspace-relative path names.
 *
 * A file link can reach the host written the way a message wrote it — relative to the folder the
 * work was happening in (`docs/plan.md`, `README.md`). A click site that knows that folder resolves
 * it first (a document's own `baseDir`); this is the host's fallback for the ones that arrive
 * without, and it uses the workspace's configured working directory, then the workspace root.
 *
 * An absolute path is returned unchanged, and so is a relative one on a host with no workspace to
 * resolve it against — the caller's own boundary check still decides what may be opened.
 */
export function resolveWorkspacePath(filePath: string, workspaceId?: string | null): string {
  const expanded = expandHome(filePath)
  if (isAbsolute(expanded) || !workspaceId) return expanded

  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) return expanded

  const base = loadWorkspaceConfig(workspace.rootPath)?.defaults?.workingDirectory || workspace.rootPath
  return join(expandHome(base), expanded)
}

/**
 * Windows' own meaning of `/tmp`: the `tmp` folder at the root of the current drive (and of the
 * system drive). The app makes `<drive>:\tmp` a junction to the real temp directory at startup,
 * so a file written through it already sits inside `tmpdir()` — this entry is what keeps reads
 * working on a machine where that junction could not be created.
 */
function windowsDriveRootTmpDirs(): string[] {
  if (process.platform !== 'win32') return []

  const dirs = new Set<string>()
  const cwdRoot = parse(process.cwd()).root
  if (cwdRoot) dirs.add(join(cwdRoot, 'tmp'))

  const systemDrive = process.env.SystemDrive
  if (systemDrive && /^[A-Za-z]:$/.test(systemDrive)) dirs.add(join(`${systemDrive}\\`, 'tmp'))

  return [...dirs]
}

/**
 * Resolve symlinks when the path exists; otherwise resolve the nearest existing ancestor and
 * re-append the rest — a file that does not exist yet is still a valid target for a write, and a
 * path written through a junction has to compare as its real folder even before it exists.
 */
async function realpathIfExists(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    const parent = dirname(p)
    if (parent === p) return p
    return join(await realpathIfExists(parent), basename(p))
  }
}

/**
 * Comparison form of a path: normalized, without a trailing separator, and
 * case-folded on Windows (where `C:\Users\Ryan` and `c:\users\ryan` are one folder).
 */
function toComparablePath(p: string): string {
  let normalized = normalize(p)
  if (normalized.length > 1 && normalized.endsWith(sep)) {
    normalized = normalized.slice(0, -1)
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Is `realPath` the directory `dir` itself or something inside it? */
function isWithinDir(realPath: string, dir: string): boolean {
  if (realPath === dir) return true
  return realPath.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

/**
 * Validates that a file path is within allowed directories to prevent path traversal attacks.
 * Allowed directories: user's home directory, the temp directory (plus `\tmp` at the root of the
 * current/system drive on Windows), and any additional dirs passed by the caller
 * (e.g. workspace root, workspace working directory). Additional dirs may be portable (`~/...`),
 * so they are expanded the same way as the path under check.
 *
 * Both sides of the containment check are resolved through symlinks and compared
 * case-insensitively on Windows. Comparing the file's resolved path against an unresolved
 * allowed dir (and with a case-sensitive `startsWith`) refused files that plainly sit inside
 * the workspace when a symlink or a case difference happened to sit between them.
 */
export async function validateFilePath(
  filePath: string,
  additionalAllowedDirs?: string[],
): Promise<string> {
  // Normalize to resolve . and .. components, then expand a leading ~
  const normalizedPath = expandHome(normalize(filePath))

  // Must be an absolute path
  if (!isAbsolute(normalizedPath)) {
    throw new Error('Only absolute file paths are allowed')
  }

  // A root-relative path (`/tmp/x`, which Windows reads as "root of the current drive") is
  // resolved against that drive up front, so both sides of the containment check are full paths.
  const resolvedPath = resolve(normalizedPath)

  // Resolve symlinks to get the real path
  const realFilePath = await realpathIfExists(resolvedPath)

  // Define allowed base directories
  const allowedDirs = [
    homedir(),
    tmpdir(),
    ...windowsDriveRootTmpDirs(),
    ...(additionalAllowedDirs ?? []),
  ].filter(Boolean).map(expandHome)

  // Check if the real path is within an allowed directory (cross-platform, case-aware on Windows)
  const comparableReal = toComparablePath(realFilePath)
  let isAllowed = false
  for (const dir of allowedDirs) {
    const comparableDir = toComparablePath(await realpathIfExists(dir))
    if (isWithinDir(comparableReal, comparableDir)) {
      isAllowed = true
      break
    }
  }

  if (!isAllowed) {
    throw new Error('Access denied: file path is outside allowed directories')
  }

  // Block sensitive files even within allowed directories.
  // Use [\\/] to match both Unix / and Windows \ separators.
  const sensitivePatterns = [
    /\.ssh[\\/]/,
    /\.gnupg[\\/]/,
    /\.aws[\\/]credentials/,
    /\.env$/,
    /\.env\./,
    /credentials\.json$/,
    /secrets?\./i,
    /\.pem$/,
    /\.key$/,
  ]

  if (sensitivePatterns.some(pattern => pattern.test(realFilePath))) {
    throw new Error('Access denied: cannot read sensitive files')
  }

  return realFilePath
}
