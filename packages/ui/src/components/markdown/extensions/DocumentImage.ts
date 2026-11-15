/**
 * A picture that names a file beside the document.
 *
 * The reading face has always drawn these (`MarkdownImage`): a relative `src` is resolved against the document's own
 * folder and the file is read through the platform, because the renderer's origin is not where the document is. The
 * editing face has a plain `<img src="pics/a.png">`, which the browser requests from the app's origin — measured
 * result: a picture that shows when read and is broken the moment it is edited. That is a second way the two faces
 * disagreed, and the worse of the two, since a broken image looks like a broken document.
 *
 * What is resolved is **display only**, and that distinction is the whole design:
 *
 * - `src` stays exactly what the file says (`pics/a.png`). The markdown serializer writes `src`, so a save can never
 *   put a data URL into somebody's document, and the block table still sees the block it came from.
 * - `previewSrc` carries the data URL and is never parsed from or rendered into markdown — it exists between the
 *   reader and the DOM. It is dropped by `renderMarkdown` (which only knows `src`) and by `parseMarkdown`.
 *
 * The read is asynchronous and lands as a transaction that is **not** an edit: `addToHistory: false`, no save (the
 * block serializes to the same bytes it did before), and no effect on the block table.
 */

import Image from '@tiptap/extension-image'
import { mergeAttributes } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { resolveDocumentPath } from '../document-path'

/** Where each editor has already asked for a file, so one picture is not read twice per render. */
const asked = new WeakMap<object, Set<string>>()

export const DocumentImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      /** The data URL drawn instead of `src`, for a picture that lives beside the document. Never serialized. */
      previewSrc: {
        default: null,
        parseHTML: () => null,
        renderHTML: () => ({}),
      },
    }
  },

  renderHTML({ node, HTMLAttributes }) {
    const preview = typeof node.attrs.previewSrc === 'string' ? node.attrs.previewSrc : null
    // `previewSrc` last: it is a replacement for `src`, not an addition to it.
    return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, preview ? { src: preview } : {})]
  },
})

/**
 * Read every picture the document holds beside itself, and draw it.
 *
 * `baseDir` is the document's folder; `readFile` is the host's read (a data URL back). Called when a document is
 * built and again whenever the text outside the editor changes — the two moments a picture can appear.
 *
 * A read that comes back late is applied by **looking the picture up again**, not by the position it had when the
 * read started: an edit above it in the meantime would have moved it, and putting a data URL on the wrong node is a
 * silent way to show the wrong picture.
 */
export function resolveDocumentPictures(
  editor: Editor,
  baseDir: string | undefined,
  readFile: ((path: string) => Promise<string>) | undefined,
): void {
  if (!baseDir || !readFile || editor.isDestroyed) return

  let seen = asked.get(editor)
  if (!seen) {
    seen = new Set<string>()
    asked.set(editor, seen)
  }

  const pending: Array<{ src: string; local: string }> = []
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'image') return
    const src = typeof node.attrs.src === 'string' ? node.attrs.src : ''
    if (!src || node.attrs.previewSrc) return
    const local = resolveDocumentPath(baseDir, src)
    if (!local || seen!.has(local)) return
    seen!.add(local)
    pending.push({ src, local })
  })

  for (const { src, local } of pending) {
    void readFile(local)
      .then((url) => {
        if (!url || editor.isDestroyed) return
        let tr = editor.state.tr
        let touched = false
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name !== 'image' || node.attrs.src !== src || node.attrs.previewSrc) return
          tr = tr.setNodeAttribute(pos, 'previewSrc', url)
          touched = true
        })
        if (touched) editor.view.dispatch(tr.setMeta('addToHistory', false))
      })
      .catch(() => {
        // The host refused the read, or there is no such file. There is then no picture to show, and the read is what
        // said so — this is a document's picture, not a report about one.
        seen!.delete(local)
      })
  }
}
