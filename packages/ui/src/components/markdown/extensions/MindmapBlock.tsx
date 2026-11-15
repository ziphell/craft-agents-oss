import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import * as React from 'react'
import { MarkdownMindmapBlock } from '../MarkdownMindmapBlock'
import { RichBlockShell } from '../RichBlockShell'
import { RICH_BLOCK_EDIT_EVENT } from '../rich-block-events'

/**
 * A `mindmap` fence, as a block of its own rather than a `previewBlock`.
 *
 * The fence is a self-contained drawing — it names no file and takes no mouse of its own — so it
 * belongs with `MermaidBlock`, not with the preview blocks that exist to draw something else.
 * That is what gives it the drag handle and block selection a diagram has, and what keeps it out
 * of `disablePreviewBlocks` (which exists for blocks that would otherwise nest themselves).
 *
 * A mindmap written under a ```mermaid fence stays a `mermaidBlock` — the reader recognises the
 * header and draws it with the same block — and round-trips as the fence it was written as.
 */
export const MindmapBlock = Node.create({
  name: 'mindmapBlock',

  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      code: {
        default: '',
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="mindmap-block"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'mindmap-block' })]
  },

  markdownTokenName: 'code',

  parseMarkdown: (token: any, helpers: any) => {
    if ((token.lang ?? '').toLowerCase() !== 'mindmap') return []
    return helpers.createNode('mindmapBlock', { code: token.text ?? '' })
  },

  renderMarkdown: (node: any) => {
    const code = (node.attrs?.code ?? '').replace(/\n$/, '')
    return `\`\`\`mindmap\n${code}\n\`\`\``
  },

  addNodeView() {
    return ReactNodeViewRenderer(({ node, editor, getPos }) => {
      const selectNode = () => {
        const pos = getPos()
        if (typeof pos !== 'number') return
        editor.chain().focus().setNodeSelection(pos).run()
      }

      const handleEditClick = () => {
        selectNode()
        queueMicrotask(() => (editor as any).emit(RICH_BLOCK_EDIT_EVENT))
      }

      return (
        <NodeViewWrapper
          contentEditable={false}
          className="tiptap-mermaid-block"
          data-drag-handle
          onMouseDownCapture={(event: React.MouseEvent) => {
            if (event.button !== 0) return
            const target = event.target as HTMLElement | null
            if (target?.closest('button')) return
            event.preventDefault()
            event.stopPropagation()
            selectNode()
          }}
        >
          <RichBlockShell onEdit={handleEditClick} editTitle="Edit mind map">
            <MarkdownMindmapBlock
              code={(node.attrs.code as string) ?? ''}
              showExpandButton={false}
              interactive={false}
              minHeight={140}
            />
          </RichBlockShell>
        </NodeViewWrapper>
      )
    })
  },
})
