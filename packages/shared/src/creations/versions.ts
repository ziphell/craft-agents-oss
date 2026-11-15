/**
 * Versions of a work: what it looked like before the last few times it changed.
 *
 * A library that only knows the current file cannot answer the question people actually ask —
 * "what did this say yesterday". Two decisions shape this file:
 *
 * - **Nothing is stored in the workspace.** A version is a cache, not a document: it lives beside
 *   the posters, under a root the caller owns (the app's data folder on a desktop, the hub's own on
 *   a hub). A user's folder does not grow a `.versions/` because we decided it should.
 * - **Identity is the bytes, not the clock.** A version is named after a hash of its content, so
 *   saving the same file twice (or touching it without changing it) records nothing. Order comes
 *   from the modification time that *came with* the copy, not from when we happened to notice.
 *
 * Text and binary works are stored the same way — a copy each. A diff is a way to *read* two
 * versions; it is not a way to store them, and a few kilobytes per version is cheaper than a
 * document model nobody asked for.
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

/** How many versions one work keeps. Older ones are deleted when a new one lands. */
export const VERSIONS_KEPT = 12

/** The marker file `recordIfChanged` keeps beside the copies (never listed as a version). */
const LAST_MARKER = 'last.json'

/** A stored version of one work. */
export interface CreationVersion {
  /** The file name inside the work's directory — also the handle to read it back. */
  id: string
  /** When the file said it changed (ms), which is the order they are shown in. */
  at: number
  bytes: number
}

/** One directory per path, named after it, so a work's history follows the work and not the title. */
function workKey(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 16)
}

function workDir(root: string, path: string): string {
  return join(root, workKey(path))
}

/**
 * A version's name: the content hash first, then the time it changed.
 *
 * The hash is what makes a repeat save free — the same bytes are the same version, whatever the
 * clock says. The time is what makes the list readable, and it is the file's own.
 */
/** The time and size a recorded name carries, without reading the file again. */
function parseVersionName(id: string): { at: number; bytes: number } | null {
  const match = /^[0-9a-f]{12}-(\d+)\./.exec(id)
  return match ? { at: Number(match[1]), bytes: 0 } : null
}

/**
 * Record the file as it is now, if it is not already the newest version.
 *
 * Answers the version's id when something was stored, and `null` when the file matched what is
 * already there — which is the common case, and the one that must stay free.
 */
export async function recordVersion(
  root: string,
  path: string,
  options: { bytes: Uint8Array; mtimeMs: number; keep?: number },
): Promise<string | null> {
  const { bytes, mtimeMs } = options
  const keep = options.keep ?? VERSIONS_KEPT
  const dir = workDir(root, path)
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
  const id = `${hash}-${Math.round(mtimeMs)}.${extname(path).replace('.', '') || 'bin'}`
  await mkdir(dir, { recursive: true })

  // The **bytes** are the identity. Touching a file, or saving it without a change, is not a
  // version — only new content is, dated by when that content first appeared.
  const alreadyKept = (await listVersions(root, path)).some((version) => version.id.startsWith(`${hash}-`))
  if (alreadyKept) return null
  await writeFile(join(dir, id), bytes)

  // Prune by the time each version carries, oldest first. The new one is always inside the window.
  const versions = await listVersions(root, path)
  for (const stale of versions.slice(keep)) {
    await rm(join(dir, stale.id), { force: true }).catch(() => undefined)
  }
  return id
}

/**
 * Record only when the file changed since the last look.
 *
 * The list refreshes often (a transcript grew, the window came back), and reading every work's
 * bytes each time would be the whole library's size in I/O for nothing. The previous
 * `(mtime, size)` is remembered beside the copies, so an unchanged file costs one small read.
 */
export async function recordIfChanged(
  root: string,
  path: string,
  options: { mtimeMs: number; size: number; read: () => Promise<Uint8Array>; keep?: number },
): Promise<string | null> {
  const dir = workDir(root, path)
  const marker = join(dir, LAST_MARKER)
  const stamp = { mtimeMs: Math.round(options.mtimeMs), size: options.size }

  try {
    const previous = JSON.parse(await readFile(marker, 'utf8')) as { mtimeMs?: number; size?: number }
    if (previous?.mtimeMs === stamp.mtimeMs && previous?.size === stamp.size) return null
  } catch {
    // No marker yet: this is the first look, and the first look records a baseline.
  }

  const bytes = await options.read()
  const id = await recordVersion(root, path, { bytes, mtimeMs: options.mtimeMs, keep: options.keep })
  await mkdir(dir, { recursive: true })
  await writeFile(marker, JSON.stringify(stamp), 'utf8')
  return id
}

/** Every version of one work, newest first. */
export async function listVersions(root: string, path: string): Promise<CreationVersion[]> {
  const dir = workDir(root, path)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const versions: CreationVersion[] = []
  for (const id of names) {
    if (id === LAST_MARKER) continue
    const parsed = parseVersionName(id)
    if (!parsed) continue
    let bytes = 0
    try {
      bytes = (await stat(join(dir, id))).size
    } catch {
      continue
    }
    versions.push({ id, at: parsed.at, bytes })
  }
  return versions.sort((left, right) => right.at - left.at)
}

/** One version's bytes, or null when that version is gone. */
export async function readVersion(root: string, path: string, id: string): Promise<Uint8Array | null> {
  // The id arrives from a client: only a name we could have written is readable.
  if (!parseVersionName(id)) return null
  try {
    return new Uint8Array(await readFile(join(workDir(root, path), id)))
  } catch {
    return null
  }
}

/** The version of a work that its current file corresponds to, if any (for "you are looking at v3"). */
export async function currentVersion(
  root: string,
  path: string,
  bytes: Uint8Array,
  mtimeMs: number,
): Promise<string | null> {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
  const kept = (await listVersions(root, path)).find((version) => version.id.startsWith(`${hash}-`))
  return kept?.id ?? null
}

/** A version's file name, for a caller that wants to hand one back as a download. */
export function suggestedVersionName(path: string, version: CreationVersion): string {
  const stem = basename(path).replace(/\.[^.]+$/, '') || 'work'
  const extension = extname(path) || '.bin'
  const at = new Date(version.at)
  const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}-${String(at.getMinutes()).padStart(2, '0')}`
  return `${stem} (${stamp})${extension}`
}
