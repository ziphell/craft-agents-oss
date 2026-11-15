/**
 * An edit addressed to the editor showing a text document.
 *
 * `office_tool` can already change a `.docx` inside the editor that has it open, which is what makes the change one
 * undoable step instead of a file that moved underneath somebody's caret. Markdown and HTML have the same problem
 * and now have the same answer, so the request is deliberately shaped like `OfficeEditRequest`'s text form:
 *
 * - `replace` — the whole document, the way `Write` means it;
 * - `replace-span` — one occurrence of `expectedText` becomes `text`, the way `Edit` means it.
 *
 * A span that no longer says what the caller was told it says is **refused**, not applied somewhere else: that is the
 * one property of an anchored edit worth having. Which is also why the search happens against the *live* document
 * rather than the file — the editor's copy is ahead of the file by whatever the person has typed and not saved.
 */

import { isWindowsPath } from '@craft-agent/shared/utils/path-shape'
import type { Editor } from '@tiptap/core'
import { landMarkdown } from './markdown-land'
import { parseDocText, serializeDocText, type DocEnvelope } from './markdown-envelope'
import { bridgeOf } from './markdown-save'

export type TextEditRequest =
  | { kind: 'replace'; text: string }
  | { kind: 'replace-span'; expectedText: string; text: string }

export interface TextEditResult {
  ok: boolean
  /** Why not, in words the agent can act on. */
  message?: string
  /** The document as it now reads, when it changed. */
  text?: string
}

/**
 * The document's markdown, enveloped as a file — what the editor would save right now.
 *
 * Empty paragraphs are left out. They are blank lines — the editor's place to put a caret — and the engine serializes
 * one as `&nbsp;`, a sentinel it uses to keep such a node alive across a round trip. Taking that for content is what
 * put a non-breaking space into text no file ever had. A paragraph that *says* something is not one of these: it is a
 * block the file has not got yet, so it stays in.
 */
export function liveTextOf(editor: Editor, envelope: DocEnvelope): string | null {
  const doc = editor.state.doc
  /**
   * An empty paragraph is a blank line, not a block — the same rule the save path uses (`markdown-save.ts`), and the
   * reason the tail of this text no longer ends in `&nbsp;`: the engine writes that sentinel for a paragraph with no
   * content, to keep the node alive across a round trip, and a blank line needs no such thing. It was also the
   * `&nbsp;` the agent saw in a "file" that never had one.
   */
  const isBlank = (node: { type: { name: string }; content: { size: number } }) =>
    node.type.name === 'paragraph' && node.content.size === 0
  const bridge = doc.childCount > 0 ? bridgeOf(editor) : null
  if (bridge) {
    const content: unknown[] = []
    doc.forEach((node) => {
      if (!isBlank(node)) content.push(node.toJSON())
    })
    return serializeDocText(envelope, bridge.serialize({ type: 'doc', content }))
  }
  const markdown = (editor as unknown as { getMarkdown?: () => string }).getMarkdown
  if (typeof markdown !== 'function') return null
  return serializeDocText(envelope, markdown.call(editor))
}

/** Exactly one occurrence, or nothing: an edit that could mean two places is not an edit. */
function replaceOnce(haystack: string, needle: string, replacement: string): { text: string } | { problem: string } {
  if (!needle) return { problem: 'there is no text to look for' }
  const first = haystack.indexOf(needle)
  if (first < 0) return { problem: 'that text is no longer in the document' }
  if (haystack.indexOf(needle, first + needle.length) >= 0) {
    return { problem: 'that text appears more than once in the document' }
  }
  return { text: haystack.slice(0, first) + replacement + haystack.slice(first + needle.length) }
}

/**
 * Apply `request` to the open document, as one transaction in its history.
 *
 * Nothing is written here: the caller's `onUpdate` path owns the file, so the change reaches the disk by the same
 * route as typing and is bounded by the same rules (debounce, conflict, block-scoped save).
 */
export function applyTextEdit(editor: Editor, envelope: DocEnvelope, request: TextEditRequest): TextEditResult {
  if (editor.isDestroyed) return { ok: false, message: 'the editor is gone' }
  const live = liveTextOf(editor, envelope)
  if (live === null) return { ok: false, message: 'this editor cannot read its own markdown' }

  let next: string
  if (request.kind === 'replace') {
    next = request.text
  } else {
    const outcome = replaceOnce(live, request.expectedText, request.text)
    if ('problem' in outcome) return { ok: false, message: outcome.problem }
    next = outcome.text
  }

  if (next === live) return { ok: true, text: live }

  // The document holds the body; the envelope (frontmatter, line endings) is the file's and is compared as such.
  const landed = landMarkdown(editor, parseDocText(next).body, { current: parseDocText(live).body })
  if (!landed.applied) return { ok: false, message: landed.reason ?? 'the editor refused the change' }
  return { ok: true, text: next }
}

/* ---------------------------------------------------------------------------------------------
 * Where a mounted editor is, by the path it is showing.
 *
 * The same table `office-edits.ts` keeps, for the same reason: only the editor holding the document can change it,
 * so "apply this to `SKILL.md`" needs to find the editor that has it. One editor per path — two windows on one
 * document would mean two histories, and applying the same edit to both is a decision nobody made. The later mount
 * wins, which is the one the person most recently opened.
 * ------------------------------------------------------------------------------------------- */

export interface TextEditTarget {
  applyEdit: (request: TextEditRequest) => Promise<TextEditResult> | TextEditResult
}

const targets = new Map<string, TextEditTarget>()

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

/** An editor is now showing this path. Answers the unsubscribe, so a component can pair it with its own mount. */
export function registerTextEditTarget(path: string, target: TextEditTarget): () => void {
  if (!path) return () => undefined
  const key = keyOf(path)
  targets.set(key, target)
  return () => {
    // Only drop it if this registration is still the one there: a remount that already replaced it must not be
    // unregistered by the previous mount's cleanup.
    if (targets.get(key) === target) targets.delete(key)
  }
}

export async function applyTextEditAt(path: string, request: TextEditRequest): Promise<TextEditResult> {
  const target = path ? targets.get(keyOf(path)) : undefined
  if (!target) return { ok: false, message: 'no editor is showing this document' }
  return target.applyEdit(request)
}

export function hasTextEditTarget(path: string): boolean {
  return Boolean(path) && targets.has(keyOf(path))
}

/** Test seam: the table is process-wide state, like every other registry here. */
export function clearTextEditTargets(): void {
  targets.clear()
}
