/**
 * Which documents are open in an editor **right now**, in this process.
 *
 * The guard in `@craft-agent/office-host` answers a different question — "has this file changed
 * since we last read it" — and it answers it from a record kept for the life of the process. That
 * makes it the wrong thing to ask "is somebody editing this": a file read this morning is still in
 * that map at midnight.
 *
 * This is the other half: a **count**, raised when an editor shows a document and lowered when it
 * goes away. A path is open while somebody is holding it, and closed the moment they are not. Two
 * windows showing one file is a count of two, which is why it is a count and not a set.
 *
 * Two callers, one rule:
 *
 * - the **renderer** raises and lowers it through an RPC as its editors mount and unmount;
 * - the **agent's document tool** asks before it writes (a document tool's `apply`, and the outputs of
 *   `create` / `convert`), because a write that lands under an open editor leaves the person's
 *   model stale — they only find out when their own save is refused, and their unsaved work is
 *   what gets lost in the meantime.
 *
 * Deliberately *not* a file lock: nothing here stops a write. The refusal lives in the tool, in
 * one place, next to the message that explains it. A lock would have to be released by whoever
 * holds it, and a crashed window would leave a workspace nobody can write to.
 */

/**
 * An edit addressed to the editor showing a document.
 *
 * The two editors that take one address their contents differently — character offsets for a
 * document, an A1 range for a workbook — and each carries the fingerprint its editor checks. This
 * is the type the bridge passes through; it does not interpret either shape.
 */
export type OfficeEditRequest =
  | { from: number; to: number; expectedText: string; text: string }
  | { sheet?: string; range: string; expectEmpty?: boolean; expected?: unknown[][]; values: unknown[][] }
  | { slide: number; find: string; replace: string; expectCount: number; elementId?: string }
  /**
   * A text document: one occurrence of `expectedText` becomes `text`, found in the **live** document.
   *
   * The discriminant exists because this shape has no offsets to tell it apart from the first member, and because a
   * caller reading a request should see what it is aimed at. `markdown` and `html` are kept apart for the day the two
   * may mean different things — an element path instead of an anchor, say — and **both are answered by the same path
   * today**: whoever is showing the file (`applyOfficeEdit` → the text-edit table). A third text format does not have
   * to add a member; it has to be sure that path still answers it.
   */
  | { kind: 'markdown'; expectedText: string; text: string }
  | { kind: 'html'; expectedText: string; text: string }

/** How many editors are showing each path. Absent means closed. */
import { isWindowsPath } from '../utils/path-shape'

const open = new Map<string, number>()

/**
 * Which connection is showing it — the client an edit has to be asked of.
 *
 * A frame's document can only be changed by the frame, so "apply this here" needs the client that
 * holds it. The RPC call that reports an open already carries `clientId`; this remembers it so the
 * tool, which runs in this same process, can address the right one later.
 */
const shownBy = new Map<string, string>()

/**
 * Which of those have **unsaved changes**.
 *
 * This decides whether a write is harmless or destructive, and it is not the same question as
 * "open". An editor showing a file nobody has typed in holds exactly what the disk holds: an
 * agent's write leaves it stale, the editor says so, one press reloads it, nothing is lost.
 * Refusing that is ceremony. The work is what deserves protecting, so the guard asks about work.
 */
const dirty = new Set<string>()

/** Normalize so `/a/b.md` and `C:\a\b.md` on Windows agree on being the same file. */
function keyOf(path: string): string {
  const trimmed = path.trim()
  return isWindowsPath(trimmed) ? trimmed.toLowerCase() : trimmed
}

/**
 * An editor is showing this document.
 *
 * Paired with `closeDocument` — a caller that opens without closing leaves a path that looks open
 * forever, and the agent then refuses to touch a file nobody has on screen. `useFileWriter` and
 * `useOfficeDocument` do the pairing, once each, so no component has to remember.
 */
export function openDocument(path: string, clientId?: string): void {
  if (!path) return
  const key = keyOf(path)
  open.set(key, (open.get(key) ?? 0) + 1)
  // The most recent opener wins: it is the one the person is looking at.
  if (clientId) shownBy.set(key, clientId)
}

/** The connection showing this document, if one is known. */
export function documentShownBy(path: string): string | null {
  if (!path) return null
  return shownBy.get(keyOf(path)) ?? null
}

/** An editor stopped showing it. A count that would go below zero is dropped, not trusted. */
export function closeDocument(path: string): void {
  if (!path) return
  const key = keyOf(path)
  const count = open.get(key)
  if (count === undefined) return
  if (count <= 1) {
    open.delete(key)
    // A closed editor has no unsaved work by definition, and nothing left to ask.
    dirty.delete(key)
    shownBy.delete(key)
  } else open.set(key, count - 1)
}

/**
 * This editor now has unsaved changes (or has just saved them away).
 *
 * Published by the surfaces that can tell: the text chain compares what it holds with what it last
 * wrote, and an office editor reports its own dirty flag.
 */
export function setDocumentDirty(path: string, dirtyNow: boolean): void {
  if (!path) return
  const key = keyOf(path)
  if (dirtyNow) dirty.add(key)
  else dirty.delete(key)
}

/** Is there unsaved work in an editor showing this file? */
export function isDocumentDirty(path: string): boolean {
  if (!path) return false
  return dirty.has(keyOf(path))
}

/** Is anybody editing this file at this moment? */
export function isDocumentOpen(path: string): boolean {
  if (!path) return false
  return (open.get(keyOf(path)) ?? 0) > 0
}

/** The paths as the callers named them, for a diagnostic that has to say *which*. */
export function openDocuments(): string[] {
  return [...open.keys()]
}

/**
 * The documents an editor is holding **unsaved work** for.
 *
 * What an agent needs before it reads anything: the file on disk is a debounced copy, so a document
 * somebody is in the middle of typing into is *not* on it yet. Asking those editors to save first is
 * how a read becomes "what is on the screen" instead of "what was on the screen a moment ago".
 *
 * Empty is the common answer and the cheap one — nothing is open, or nothing is pending.
 */
export function dirtyDocuments(): string[] {
  return [...dirty.keys()]
}

/** Test seam, and the process-exit cleanup next to `clearRecords`. */
export function clearOpenDocuments(): void {
  open.clear()
  dirty.clear()
  shownBy.clear()
}
