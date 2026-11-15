/**
 * A fence the app draws as something other than code.
 *
 * `Markdown` (the renderer messages go through) has always read these fences as their subject —
 * a `drawio-preview` naming a diagram, an `html-preview` naming a page, a `datatable`, a `diff`,
 * a `json` — and drawn them with the app's own block components. A markdown *file* opened in the
 * editor has to be the same document, so the node below is what makes Tiptap read those fences
 * the same way, and it is also what keeps them whole: the editor saves the file back, and a
 * fence with no node of its own would come back as a code block — which is not a display
 * question, it is the diagram being gone.
 *
 * What it does *not* own is `markdown-preview`: that fence names another document, and drawing
 * it here would mount a second editor inside this one, with no bound on how deep that goes. It
 * stays a code block, which is what a nested one rendered as before.
 *
 * What draws each of those fences is `fence-components`, the same table the renderer draws them
 * from — not a copy of it. A document in a conversation and the same document in the editor are
 * drawn by one implementation, which is the point of the node existing at all rather than the
 * editor having its own preview stack.
 */

import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import * as React from 'react'
import { isPreviewBlockLanguage, fenceDrawing } from '../fences'
import { renderFence } from '../fence-components'
import { useMarkdownFenceView } from '../fence-view-context'
import { CodeBlock } from '../CodeBlock'

export const PreviewBlock = Node.create({
  name: 'previewBlock',

  group: 'block',
  atom: true,
  selectable: true,
  // Deliberately *not* draggable, unlike the diagram and LaTeX blocks: these blocks have mouse
  // behaviour of their own — a table that sorts from its header, a tree that opens on click — and
  // a drag handle over the whole thing would take that away from them.
  draggable: false,

  addAttributes() {
    return {
      /** The fence language, which is also what decides how it is drawn. */
      lang: { default: '' },
      /** The fence's body, verbatim — this is what goes back into the file. */
      code: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="preview-block"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'preview-block' })]
  },

  markdownTokenName: 'code',

  parseMarkdown: (token: any, helpers: any) => {
    const lang = (token.lang ?? '').toLowerCase()
    if (!isPreviewBlockLanguage(lang)) return []
    return helpers.createNode('previewBlock', { lang, code: token.text ?? '' })
  },

  renderMarkdown: (node: any) => {
    // Stripped the way `MermaidBlock` strips it: marked's text carries the newline that ended
    // the fence, and writing it back would grow a blank line before the closing fence on every
    // save. The fence's language is part of what is written — a block that lost it would come
    // back as a plain code block.
    const code = (node.attrs?.code ?? '').replace(/\n$/, '')
    return `\`\`\`${node.attrs?.lang ?? ''}\n${code}\n\`\`\``
  },

  addNodeView() {
    return ReactNodeViewRenderer(({ node, editor }) => {
      const drawing = fenceDrawing(node.attrs.lang as string)
      if (!drawing) return <NodeViewWrapper contentEditable={false} />

      /*
       * Two questions, both answered by the host through `fence-view-context`:
       *
       * - **May this be drawn at all?** A document opened *to be read* draws every fence it knows. A poster does not
       *   draw the ones that point somewhere else (`NOT_DRAWN` in `markdown-poster.tsx`), and the reading face of a
       *   file refuses to nest another document. Suppressed means: nothing here, rather than a second editor inside
       *   this one.
       * - **Does the mouse belong to the block or to the document?** In an editor a click places the cursor, so the
       *   blocks are told to leave the mouse alone; a document nobody can type in is read, so its diagrams are live
       *   — the reading face has always behaved that way. `editor.isEditable` is exactly that distinction.
       */
      const host = useMarkdownFenceView()
      if (host.suppressed?.has(drawing)) {
        /*
         * Not drawn: shown as the code block it is in every other editor. That is the rule the poster states — a
         * fence that only this app understands is a code block to an outside reader, so a picture that drew it would
         * show a document nobody else can open — and leaving it blank would say the document had nothing there.
         */
        return (
          <NodeViewWrapper contentEditable={false} className="tiptap-preview-block">
            <CodeBlock code={node.attrs.code as string} language={node.attrs.lang as string} mode="minimal" />
          </NodeViewWrapper>
        )
      }

      return (
        <NodeViewWrapper contentEditable={false} className="tiptap-preview-block">
          {renderFence(drawing, node.attrs.code as string, 'my-2', {
            interactive: !editor.isEditable,
            onUrlClick: host.onUrlClick,
            onFileClick: host.onFileClick,
          })}
        </NodeViewWrapper>
      )
    })
  },
})
