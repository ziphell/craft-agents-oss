/**
 * A block the markdown engine cannot carry, to be drawn by whoever is showing the document.
 *
 * `block-parse.ts` asks the engine about **one block at a time** and keeps the ones it cannot say back as their own
 * source text — `<kbd>`, `<div>`, `<details>`, an angle-bracket autolink. In the editor that is the right answer: the
 * text is visible, it can be typed in, and it round-trips to the same bytes. In a document nobody can type in it is
 * the wrong one — the reading face has always *drawn* that markup, so a preview showing `按 <kbd>Ctrl</kbd> 保存` as
 * source would be a regression, not a conservative choice (measured: `docs/design/video-understanding-design.md`).
 *
 * So the reading face builds those blocks as this node: an atom whose only content is the block's own bytes. **What
 * draws it is the host's**, through `fence-view-context` (`renderLiteral`) — the reading face answers with `Markdown`,
 * and this module deliberately does not import that: the editor would then depend on the whole reader — a PDF viewer,
 * an office editor — for one node view, and every headless test of the block layer would have to load them too.
 *
 * It is never written back: the document it belongs to is read-only, and nothing about it reaches the file.
 */

import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import * as React from 'react'
import { useMarkdownFenceView } from '../fence-view-context'

/** The block's own markdown, as the file wrote it. */
interface LiteralAttrs {
  text?: string
}

function LiteralBlockView({ node }: { node: { attrs: LiteralAttrs } }) {
  const host = useMarkdownFenceView()
  const text = node.attrs.text ?? ''

  return (
    <NodeViewWrapper contentEditable={false} className="tiptap-literal-block">
      {host.renderLiteral ? host.renderLiteral(text) : <p>{text}</p>}
    </NodeViewWrapper>
  )
}

export const LiteralBlock = Node.create({
  name: 'literalBlock',

  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      /** The block's bytes, verbatim. */
      text: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="literal-block"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'literal-block' })]
  },

  /**
   * Never produced by the markdown parser: the block layer decides, per block, whether the engine may carry it
   * (`blocksToDocument(..., { literalAs: 'literalBlock' })`). A parser path would be a second opinion about that.
   */
  parseMarkdown: () => [],

  addNodeView() {
    return ReactNodeViewRenderer(LiteralBlockView)
  },
})
