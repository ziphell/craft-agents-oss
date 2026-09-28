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
 * The components are the ones from `Markdown.tsx`'s dispatch, not copies of them, so a document
 * in a conversation and the same document in the editor are drawn by one implementation — which
 * is the point of the node existing at all rather than the editor having its own preview stack.
 */

import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import * as React from 'react'
import { MarkdownDatatableBlock } from '../MarkdownDatatableBlock'
import { MarkdownDiffBlock } from '../MarkdownDiffBlock'
import { MarkdownDrawioBlock } from '../MarkdownDrawioBlock'
import { MarkdownHtmlBlock } from '../MarkdownHtmlBlock'
import { MarkdownImageBlock } from '../MarkdownImageBlock'
import { MarkdownJsonBlock } from '../MarkdownJsonBlock'
import { MarkdownPdfBlock } from '../MarkdownPdfBlock'
import { MarkdownSpreadsheetBlock } from '../MarkdownSpreadsheetBlock'
import { isPreviewBlockLanguage, type PreviewBlockLanguage } from './preview-block-languages'

type PreviewBlockComponent = React.ComponentType<{ code: string; className?: string }>

/**
 * What draws each of those fences.
 *
 * Typed as a complete record of the language list rather than as a lookup, so the two cannot
 * drift: a language the list has and this does not is a type error, and a key the list does not
 * have is one too.
 */
const PREVIEW_BLOCK_COMPONENTS: Record<PreviewBlockLanguage, PreviewBlockComponent> = {
  'drawio-preview': MarkdownDrawioBlock,
  'html-preview': MarkdownHtmlBlock,
  'pdf-preview': MarkdownPdfBlock,
  'image-preview': MarkdownImageBlock,
  datatable: MarkdownDatatableBlock,
  spreadsheet: MarkdownSpreadsheetBlock,
  diff: MarkdownDiffBlock,
  json: MarkdownJsonBlock,
}

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
    return ReactNodeViewRenderer(({ node }) => {
      const Block = PREVIEW_BLOCK_COMPONENTS[node.attrs.lang as PreviewBlockLanguage]
      if (!Block) return <NodeViewWrapper contentEditable={false} />

      return (
        /* The block's own chrome is the way in to what it names — the diagram editor behind a
           drawio block, the page editor behind an HTML one — so nothing here intercepts a click
           the way the Mermaid shell does: every button inside belongs to the component.

           In an editor, though, the mouse belongs to the document: a click places the cursor rather
           than opening a window on top of what is being edited, which is why the drawio block is
           told to leave the mouse alone (as the mermaid node does with `interactive={false}`). */
        <NodeViewWrapper contentEditable={false} className="tiptap-preview-block">
          {node.attrs.lang === 'drawio-preview' ? (
            <MarkdownDrawioBlock code={node.attrs.code as string} className="my-2" interactive={false} />
          ) : (
            <Block code={node.attrs.code as string} className="my-2" />
          )}
        </NodeViewWrapper>
      )
    })
  },
})
