/**
 * The two pure functions an artifact library is built from.
 *
 * Neither touches the disk or a conversation store: the walk that lists the files
 * and the reads that produced the write events are the caller's, and what happens
 * here is only the decision — which files are artifacts, and which conversations
 * touched which path.
 */

import type {
  ArtifactEntry,
  ArtifactFileRef,
  ArtifactKind,
  ArtifactOrigin,
  ArtifactWriteEvent,
} from './types.ts'

/**
 * Which extension is which kind — the one place that answers "is this file an
 * artifact, and which one", so the scan cannot disagree with the ignore rule.
 */
const KIND_BY_EXTENSION: Record<string, ArtifactKind> = {
  '.drawio': 'drawio',
}

/**
 * Directories never walked. A convention rather than a config: these two are
 * never anybody's artifact, and descending into them costs only time.
 */
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git'])

/**
 * Is this directory name one the walk and the path rule both skip?
 *
 * Exported because the two must agree: the walk (`scan.ts`) prunes by name while
 * descending, and `isArtifactPath` rejects by name after the fact — one set, so a
 * file cannot be skipped by one and kept by the other.
 */
export function isIgnoredDirectoryName(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name)
}

/**
 * A POSIX-normalized path, so a walk on either platform agrees with the other.
 *
 * Exported because the artifact's identity is this string — the library and the
 * origins derived from a conversation's writes both look a path up by it, and two
 * spellings of one rule is how a `.drawio` gets an origin nobody can find.
 */
export function normalizeArtifactPath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * An artifact's absolute path: the workspace root joined with the artifact's
 * workspace-relative path, using the separator the root itself uses — a Windows
 * root keeps `\`, a POSIX root keeps `/`.
 *
 * The join has one home because two callers must agree: the library's "open
 * folder" action hands this path to the shell, and the artifact page binds its
 * editor to the same string. A second spelling is a file that reveals in one
 * place and edits in another.
 */
export function artifactAbsolutePath(rootPath: string, relativePath: string): string {
  const separator = rootPath.includes('\\') ? '\\' : '/'
  return `${rootPath}${separator}${relativePath.split('/').join(separator)}`
}

/** The kind a path is, or null when it is no artifact at all. */
export function artifactKindOf(relativePath: string): ArtifactKind | null {
  const path = normalizeArtifactPath(relativePath)
  const dot = path.lastIndexOf('.')
  if (dot <= 0) return null
  return KIND_BY_EXTENSION[path.slice(dot).toLowerCase()] ?? null
}

/**
 * Is this path one the library shows?
 *
 * Asked wherever the answer is needed — what the scan keeps, what it skips — so
 * it is one function rather than a second list of extensions kept in step with
 * the first.
 */
export function isArtifactPath(relativePath: string): boolean {
  const path = normalizeArtifactPath(relativePath)
  if (path.split('/').some(isIgnoredDirectoryName)) return false
  return artifactKindOf(path) !== null
}

/** The title shown for a file — the file's own name, without the extension. */
function titleOf(relativePath: string): string {
  const name = normalizeArtifactPath(relativePath).split('/').pop() ?? relativePath
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * The library: the artifact files, most recently changed first.
 *
 * Pure — nothing from `files` is kept, because the list is a **view of the disk**
 * and a second copy of it is a second thing to fall out of step. Newest first
 * because "what just changed" is the question a list of co-edited files answers.
 */
export function deriveArtifactEntries(files: ArtifactFileRef[]): ArtifactEntry[] {
  const entries: ArtifactEntry[] = []
  for (const file of files) {
    if (!isArtifactPath(file.path)) continue
    const kind = artifactKindOf(file.path)
    if (!kind) continue
    entries.push({
      path: normalizeArtifactPath(file.path),
      kind,
      title: titleOf(file.path),
      mtimeMs: file.mtimeMs,
    })
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return entries
}

/**
 * The bidirectional link: which conversations touched which path.
 *
 * Derived from the writes the conversations already recorded — nothing is stored,
 * and the one Map answers both directions (a conversation's own artifacts, and an
 * artifact's origin conversations). A path edited by two conversations keeps both
 * origins: an artifact handed between conversations is the collaboration itself,
 * not noise to be resolved.
 */
export function deriveArtifactLinks(events: ArtifactWriteEvent[]): Map<string, ArtifactOrigin[]> {
  const byPath = new Map<string, Map<string, number>>()
  for (const event of events) {
    const path = normalizeArtifactPath(event.path)
    const bySession = byPath.get(path) ?? new Map<string, number>()
    const seen = bySession.get(event.sessionId)
    if (seen === undefined || event.at > seen) bySession.set(event.sessionId, event.at)
    byPath.set(path, bySession)
  }

  const links = new Map<string, ArtifactOrigin[]>()
  for (const [path, bySession] of byPath) {
    const origins = [...bySession].map(([sessionId, at]) => ({ sessionId, at }))
    origins.sort((a, b) => b.at - a.at)
    links.set(path, origins)
  }
  return links
}
