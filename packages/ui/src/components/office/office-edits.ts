/**
 * Where a mounted editor is, by the path it is showing.
 *
 * An anchored edit has to reach the frame that is drawing the document — and only that frame can
 * perform it, because the document being edited lives inside it. Nothing outside can address a
 * cross-origin frame's JS, so "apply this replacement to `report.docx`" needs a way to find the
 * frame that has it open.
 *
 * That is all this is: a table from a path to the one editor showing it. It holds no document, no
 * queue and no policy — a path with no editor answers "nothing is showing this", which is the
 * honest outcome for an offer that arrived after the person closed the document.
 *
 * One editor per path is a real constraint, not an oversight: two windows on one document would
 * mean two histories, and applying the same replacement to both would be a decision nobody made.
 * The later mount wins, so the table always names the one the person most recently opened.
 */

import { isWindowsPath } from '@craft-agent/shared/utils/path-shape'
import type { OfficeFrameEdit, OfficeFrameEditResult, OfficeFrameHandle } from './OfficeFrame'
import { applyTextEditAt } from '../editors/text-edits'

/** What a caller needs from a frame: the one ability this table is for. */
export type OfficeEditTarget = Pick<OfficeFrameHandle, 'applyEdit'>

const targets = new Map<string, OfficeEditTarget>()

/**
 * Compare paths the way their own spelling does — a command line and an editor may differ in case.
 *
 * `isWindowsPath` rather than `process.platform`: this runs in the renderer, which has no
 * `process`, and reading it there took the whole preview panel down with `process is not defined`.
 */
function keyOf(path: string): string {
  const trimmed = path.trim()
  return isWindowsPath(trimmed) ? trimmed.toLowerCase() : trimmed
}

/**
 * An editor is now showing this path. Answers the unsubscribe, so a component can pair it with its
 * own mount and not think about it again.
 */
export function registerOfficeEditTarget(path: string, target: OfficeEditTarget): () => void {
  if (!path) return () => undefined
  const key = keyOf(path)
  targets.set(key, target)
  return () => {
    // Only drop it if this registration is still the one there: a remount that has already
    // replaced it must not be unregistered by the previous mount's cleanup.
    if (targets.get(key) === target) targets.delete(key)
  }
}

/**
 * Replace one span of the document at `path`.
 *
 * `ok: false` is an answer, not an exception: no editor is showing the file, or the editor refused
 * because the span no longer says what the caller was told it says.
 */
export async function applyOfficeEdit(path: string, edit: OfficeFrameEdit): Promise<OfficeFrameEditResult> {
  // A markdown or html document is a different kind of editor (a document model, or a page frame) and keeps its own
  // table; both answer the same request.
  if ('kind' in edit && (edit.kind === 'markdown' || edit.kind === 'html')) {
    return applyTextEditAt(path, { kind: 'replace-span', expectedText: edit.expectedText, text: edit.text })
  }
  const target = path ? targets.get(keyOf(path)) : undefined
  if (!target) return { ok: false, message: 'no editor is showing this document' }
  return target.applyEdit(edit)
}

/** Is anything showing this document? Used to offer the action only when it can land. */
export function hasOfficeEditTarget(path: string): boolean {
  return Boolean(path) && targets.has(keyOf(path))
}

/** Test seam: the table is process-wide state, like every other registry here. */
export function clearOfficeEditTargets(): void {
  targets.clear()
}
