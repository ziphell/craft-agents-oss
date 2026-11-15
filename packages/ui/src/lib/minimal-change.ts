/**
 * The smallest replacement that turns one version of a document into another.
 *
 * An editor that is handed a new version has two options: replace the whole document, or replace
 * the span that differs. The first is one line and loses everything the person was looking at —
 * caret, selection, scroll — and puts a "the document" step in the undo history where a "this
 * paragraph" step belongs. The second keeps all three, which is what makes an outside change (an
 * agent's write, a reload) something a person can undo rather than only accept.
 *
 * Trimming the common prefix and suffix is not a diff: it cannot find a moved paragraph, and for a
 * large rewrite the span it returns is most of the document. That is fine, and deliberate — the
 * goal is that *nothing changed* costs nothing and *one spot changed* costs one spot, which is what
 * outside edits actually look like.
 */

export interface MinimalChange {
  /** Character offset where the replacement starts, in the *before* text. */
  from: number
  /** Character offset where it ends, in the *before* text. */
  to: number
  /** What goes there. */
  insert: string
}

export function minimalChange(before: string, after: string): MinimalChange {
  if (before === after) return { from: 0, to: 0, insert: '' }

  const shortest = Math.min(before.length, after.length)
  let start = 0
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start += 1

  // Walk back from the ends, but never into the prefix already matched: for "abc" → "ab" the
  // prefix pass already consumed everything, and a suffix pass would produce a negative length.
  let suffix = 0
  while (
    suffix < shortest - start &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1
  }

  return {
    from: start,
    to: before.length - suffix,
    insert: after.slice(start, after.length - suffix),
  }
}
