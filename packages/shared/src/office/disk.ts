/**
 * Is the file on disk still the one that was opened?
 *
 * A document open in an editor is a **snapshot**: the bytes arrived once, the person has been
 * changing them since, and nothing tells the editor that someone else wrote the file in between.
 * Saving would then replace work done elsewhere — silently, because the save succeeds.
 *
 * Two things can write such a file while it is open: the agent (a document tool's `apply`, which writes
 * the bytes itself) and any other program the person has. Neither is exotic; the first is the
 * whole point of the tool. So the save has to answer one question before it overwrites anything,
 * and this module is that question.
 *
 * The answer is deliberately cheap in the common case, and it is **not** a watcher: comparing a
 * record taken at open time against the file's current stamp needs one `stat`, and the hash is
 * only read when the stamp already disagrees. A save that has nothing to worry about therefore
 * never re-reads the file.
 *
 * What is *not* a conflict, on purpose — each of these was a decision, not an omission:
 *
 * - **No record.** A path this host never handed out (a file the person opened before the guard
 *   existed, or one the agent created) has nothing to compare against, and refusing would break
 *   saving a file that is merely new.
 * - **The file is gone.** It was deleted or replaced by rename; writing recreates it, and the
 *   person's save is still the newest thing they know about.
 * - **The stamp is unchanged**, even if the hash would differ: `mtimeMs` + `size` matching means
 *   nobody wrote the file, and the hash exists only to settle the case where they did.
 *
 * The one thing this cannot see is a write that preserves both `mtimeMs` and `size` exactly, and
 * a hash comparison would only catch it by destroying the fast path. That is the deliberate trade.
 */

/** What `stat` says about a file: enough to tell "nobody wrote this" without reading it. */
export interface DiskStamp {
  /** Modification time, in milliseconds — the whole reason a stamp is not a hash. */
  mtimeMs: number
  /** Byte length, the cheap second opinion on `mtimeMs` (same-ms writes differ here). */
  size: number
  /**
   * Link count, when the caller has it: a file replaced by rename reads back as gone
   * (`nlink === 0`) even though `stat` succeeded. Optional so a synthetic stamp is still a stamp.
   */
  nlink?: number
}

/** A stamp plus the digest of the bytes that went with it — what "the file I opened" means. */
export interface DiskRecord extends DiskStamp {
  /** SHA-256 of the file's bytes, in hex. Compared only when two stamps disagree. */
  hash: string
}

/**
 * True when a stamp describes a file that is no longer there.
 *
 * The `mtimeMs === 0 && size === 0` half is a leftover from a delete that left the inode behind;
 * the `nlink === 0` half is what an atomic replace looks like from the outside. Both are "there is
 * nothing on disk to overwrite", which is not a conflict.
 */
export function stampIsGone(stamp: DiskStamp | null | undefined): boolean {
  if (!stamp) return true
  return stamp.nlink === 0 || (stamp.mtimeMs === 0 && stamp.size === 0)
}

/** Two stamps describe the same state of the file. `nlink` is deliberately not compared. */
export function sameStamp(a: DiskStamp | null | undefined, b: DiskStamp | null | undefined): boolean {
  if (!a || !b) return false
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/** SHA-256 of some bytes, in hex. Web Crypto, so this file runs in a renderer as well as in main. */
export async function digestOf(bytes: Uint8Array): Promise<string> {
  // `Buffer` is a `Uint8Array`, but it may be a view onto a larger allocation — `subtle.digest`
  // hashes the view's window, which is what the caller means by "these bytes".
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** May this save go ahead? */
export type SaveVerdict =
  /** Nothing recorded, nothing on disk, or the same stamp: write it. */
  | 'ok'
  /** Someone else wrote the file since it was read. Ask, or refuse. */
  | 'conflict'

/**
 * Decide a save.
 *
 * `readHash` is a **function**, not a value: it is called only when the stamps disagree, which is
 * the rare case, and it is the caller that knows how to read the file (a path here, bytes held
 * in memory there). Returning `null` from it means "cannot tell" — the stamp already disagreed,
 * so the honest answer is a conflict rather than a write.
 */
export async function saveVerdict(
  recorded: DiskRecord | undefined,
  current: DiskStamp | null,
  readHash: () => Promise<string | null> | string | null,
): Promise<SaveVerdict> {
  if (!recorded) return 'ok'
  if (!current || stampIsGone(current)) return 'ok'
  if (sameStamp(recorded, current)) return 'ok'
  const hash = await readHash()
  return hash !== null && hash === recorded.hash ? 'ok' : 'conflict'
}

/** The extensions this guard applies to: the four the editors open, plus the two text ones. */
const GUARDED = new Set(['docx', 'doc', 'odt', 'xlsx', 'xls', 'xlsm', 'ods', 'pptx', 'ppt', 'odp', 'pdf', 'md', 'markdown', 'html', 'htm'])

/**
 * True for a file the editors may hold open across a save.
 *
 * Narrower than "any file": a `.txt` or a `.json` is written by tools that do their own locking,
 * and a guard that fired on every write would be noise. These are the formats the app itself puts
 * in an editor, which is exactly the set that can be edited in two places at once.
 */
export function isGuardedDocument(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return GUARDED.has(ext)
}
