/**
 * What a source surface is holding, on its way to the file.
 *
 * `useFileWriter` answers "when to write, may I, and what if the file changed"; this adds the one
 * thing every *text* surface in front of it needs, which is a copy that follows the caret rather
 * than the disk.
 *
 * **The working copy is not the file as last read.** `document` deliberately does not follow an
 * edit — a document is real when it is saved — and handing that value to a controlled editor
 * rewrites the text under the caret on every keystroke (measured: the caret jumps to the end and
 * nothing lands). So the surface edits `draft`, which is re-seeded only when the file is read again
 * — from outside, or by taking the version on disk — and `reloadToken` is what a caller keys its
 * editor by, so a re-read is a new document rather than a new value.
 *
 * Two surfaces use it and they are shaped differently on purpose (a document has a reading face
 * beside its source, a page is a picture beside its source), so this is a hook with no chrome: the
 * row, the placeholder and every size belong to whoever draws them.
 */

import * as React from 'react'
import { useFileWriter, type FileWriter } from './useFileWriter'

export interface SourceDraft extends FileWriter {
  /** What the surface holds. Null until the first read lands. */
  draft: string | null
  /** A change on its way to the file: shows immediately, is written after the debounce. */
  change: (next: string) => void
}

export function useSourceDraft(src: string, onSaved?: (document: string) => void): SourceDraft {
  const writer = useFileWriter(src, onSaved)
  const [draft, setDraft] = React.useState<string | null>(null)
  /** What the surface holds, for `change` to compare against without a render of its own. */
  const draftRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    draftRef.current = writer.document
    setDraft(writer.document)
    // `reloadToken` is part of the identity of "the file as last read": the same text may be read
    // again after a conflict, and a surface holding an identical string need not be told.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writer.document, writer.reloadToken])

  const change = React.useCallback(
    (next: string) => {
      /*
       * A surface that hands back the document it was given is **re-announcing** it, not editing: a rendered document
       * re-serializes itself (a table's columns padded, a block normalized) and every one of those would otherwise arm
       * a write. Nothing is written unless a block really moved — `runSave` refuses a write the disk already holds —
       * but a document that was only *opened* should not even ask.
       */
      if (draftRef.current === next) return
      draftRef.current = next
      setDraft(next)
      writer.report(next)
    },
    [writer.report],
  )

  return { ...writer, draft, change }
}
