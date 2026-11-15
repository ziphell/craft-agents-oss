/**
 * The documents this app has read, as far as saving is concerned.
 *
 * `packages/shared/src/office/disk.ts` holds the rule; this holds the state — which file was read,
 * what it looked like at the time, and whether it still looks that way when a save arrives. The
 * split is on purpose: the rule is testable without a filesystem, and the half that needs `stat`
 * is the half only a desktop process can do.
 *
 * **A record is taken when the bytes are read, not when an editor appears.** `file:readBinary` is
 * the moment the app hands a document to an editor, so the stamp it gets is the stamp that copy
 * corresponds to; there is no window in which "opened" and "recorded" disagree.
 *
 * What this catches is *everyone else*: another program, and — the case that made this necessary —
 * the agent. the document tools write through the CLI, which knows nothing about an open editor, so a
 * person's save after an agent edit used to replace the agent's work with no sign that it had
 * happened. Now the save is refused, with the file's path, and the UI decides what to offer.
 *
 * Not a watcher, deliberately. Watching costs a `stat` a second per open document and only buys
 * the *proactive* half (a banner before you press save). The half that stops data being lost is
 * the check below, and it costs one `stat` per save, so it is the half worth having first.
 */

import { readFile, stat } from 'node:fs/promises'
import {
  digestOf,
  isGuardedDocument,
  saveVerdict,
  type DiskRecord,
  type SaveVerdict,
} from '@craft-agent/shared/office'

/**
 * Told whenever the hosts finish writing a document.
 *
 * The hosts are the only place a save lands (`deck`, `workbook`, `pdf`), so announcing it here is
 * one hook instead of five call sites. What listens is a view: an editor or a preview showing that
 * file can then say "the copy you are looking at is older than the disk" without polling and
 * without depending on a directory watcher that may not cover the file at all.
 */
let documentWritten: ((path: string) => void) | null = null

export function setDocumentWrittenListener(listener: ((path: string) => void) | null): void {
  documentWritten = listener
}

/** What the app last saw of a file it handed to an editor, keyed by absolute path. */
const records = new Map<string, DiskRecord>()

/**
 * Remember the file as it is now, from bytes already in hand — the read that produced them or the
 * save about to write them — so this never re-reads the file.
 *
 * Unguarded paths are dropped rather than skipped: a `.txt` that used to be a `.docx` (a rename
 * through save-as) must not keep a record that a later check would trust.
 */
export async function recordDocument(path: string, bytes: Uint8Array): Promise<void> {
  if (!isGuardedDocument(path)) {
    records.delete(path)
    return
  }
  try {
    const stats = await stat(path)
    records.set(path, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      nlink: stats.nlink,
      hash: await digestOf(bytes),
    })
  } catch {
    records.delete(path)
  }
}

/**
 * Same, for a file an engine wrote without this app ever holding its bytes: the pptx deck, the
 * xlsx workbook, a pdf save. One read per save, and only for the formats that need it.
 */
export async function recordFromDisk(path: string): Promise<void> {
  try {
    await recordDocument(path, await readFile(path))
    documentWritten?.(path)
  } catch {
    records.delete(path)
  }
}

/** May this save overwrite the file? Reads the hash only when the stamps already disagree. */
export async function checkDocument(path: string): Promise<SaveVerdict> {
  const recorded = records.get(path)
  if (!recorded) return 'ok'
  let current = null
  try {
    const stats = await stat(path)
    current = { mtimeMs: stats.mtimeMs, size: stats.size, nlink: stats.nlink }
  } catch {
    current = null
  }
  return saveVerdict(recorded, current, async () => {
    try {
      return await digestOf(await readFile(path))
    } catch {
      return null
    }
  })
}

/** What the refusal says. Carried in the error so every caller reports the same thing. */
export function conflictMessage(path: string): string {
  return (
    'The document changed on disk since it was opened, so this save would overwrite those ' +
    `changes: ${path}`
  )
}

/**
 * The bytes were written by somebody who already knows what they are doing (an engine saving its
 * own file, a headless export writing to a path it was handed).
 *
 * Refuses exactly like the guarded path unless `overwrite` is set, and re-records afterwards, so
 * the next save is compared against what this one wrote rather than against the old file.
 */
export async function writeDocument(
  path: string,
  write: () => Promise<unknown>,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  if (!options.overwrite && (await checkDocument(path)) === 'conflict') {
    throw new Error(conflictMessage(path))
  }
  await write()
  await recordFromDisk(path)
}

/**
 * A renderer has just read the file again (it reloaded the document): that is the state its editor
 * holds now, so it becomes what a later save is compared against.
 */
export async function acknowledgeDocument(path: string): Promise<void> {
  await recordFromDisk(path)
}

/** Is a record held for this path? For tests and for the guard's own reporting. */
export function hasRecord(path: string): boolean {
  return records.has(path)
}

/** Drop every record. Called on quit; a record is a claim about a file, and it should not outlive
 *  the process that made it. */
export function clearRecords(): void {
  records.clear()
}
