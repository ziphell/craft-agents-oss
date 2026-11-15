/**
 * What the editor should do with a `content` prop that just arrived.
 *
 * The editor owns the document; the pane owns the file. Between them, one prop travels **down** on every keystroke
 * (`draft` → `content`), so the same text comes back as an input after each save. Landing it again is not a no-op: a
 * landing is a transaction marked `agentEdit`, and that mark is what paints the wash and the caret.
 *
 * Measured (2026-11-02): a paragraph was bolded by hand in a document that also holds a table, and the **whole
 * paragraph** came back washed and carrying the "Craft Agent" caret. The guard that was supposed to catch it compared
 * the document's own serialization with the file's body — and those are never equal once a table is in the file,
 * because the serializer pads columns (`| a   | b   |` vs `| a | b |`). So every save of every document with a table
 * looked like an outside write, and the editor landed its own edit back onto itself.
 *
 * The distinction that was missing is **provenance**: a text this editor emitted a moment ago is its own save coming
 * home, whatever the serializer would say about it. `emitted` is that memory, and it has to be checked *before* the
 * content comparison, because the content comparison cannot tell an echo from an arrival.
 */
export type SyncVerdict =
  /** Nothing changed, or the document already says this: no transaction, nothing to draw. */
  | 'nothing'
  /** The incoming text is this editor's own save: the document already holds it. */
  | 'echo'
  /** Somebody else wrote the file: land it as one transaction over the blocks that differ. */
  | 'land'

export interface SyncInput {
  /** The new `content` prop. */
  content: string
  /** The value it had last time this ran. */
  previous: string
  /** The last text this editor handed to `onUpdate`, or `null` before the first save. */
  emitted: string | null
  /** The document, serialized whole — padded tables and all. */
  editorMarkdown: string
  /** The file's body, from the envelope of `content`. */
  body: string
}

export function syncVerdict(input: SyncInput): SyncVerdict {
  if (input.content === input.previous) return 'nothing'
  // Provenance first: our own save coming back is not an outside write, however its serialization compares.
  if (input.emitted !== null && input.content === input.emitted) return 'echo'
  // A file change that did not touch the body (frontmatter, line endings) needs no transaction either.
  if (input.editorMarkdown === input.body) return 'echo'
  return 'land'
}
