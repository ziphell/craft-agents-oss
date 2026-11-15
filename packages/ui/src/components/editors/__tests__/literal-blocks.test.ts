import { afterAll, describe, expect, it } from 'bun:test'
import { parseHTML } from 'linkedom'
import { blockTexts, layoutMarkdown } from '../markdown-blocks'
import { blocksToDocument } from '../block-parse'
import { bridgeOf } from '../markdown-save'
import { parseDocText } from '../markdown-envelope'

/**
 * A block the engine cannot carry, built for the **reading** face.
 *
 * `block-parse.ts` keeps such a block as its own text — visible, typable, round-tripping to the same bytes — which is
 * what an editor needs. A document nobody can type in needs the other answer: the reading face has always *drawn*
 * that markup, so a preview that showed `按 <kbd>Ctrl</kbd> 保存` as source would be a regression dressed as caution.
 *
 * Measured here rather than assumed: the same file is built twice, and only one of the two carries `literalBlock`.
 *
 * Headless: a real TipTap editor with the official markdown engine, `linkedom` standing in for the DOM. Nothing
 * renders — what is being checked is the document JSON.
 */

const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as Record<string, unknown>
const added = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'DOMParser',
  'customElements', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'getSelection',
]
const before = new Map(added.map((key) => [key, Object.prototype.hasOwnProperty.call(globals, key) ? globals[key] : undefined]))
const created: Array<{ destroy(): void }> = []

afterAll(() => {
  for (const editor of created) {
    try {
      editor.destroy()
    } catch {
      // best effort: a half-built editor may already be gone
    }
  }
  for (const key of added) {
    const was = before.get(key)
    if (was === undefined) delete globals[key]
    else globals[key] = was
  }
})

globals.window = window
globals.document = document
globals.navigator = window.navigator
globals.Node = window.Node
globals.Element = window.Element
globals.HTMLElement = window.HTMLElement
globals.DOMParser = window.DOMParser
globals.customElements = (window as unknown as Record<string, unknown>).customElements ?? {
  define() {},
  get() { return undefined },
  whenDefined: () => Promise.resolve(),
}
globals.MutationObserver = (window as unknown as Record<string, unknown>).MutationObserver ?? class {
  observe() {}
  disconnect() {}
  takeRecords() { return [] }
}
globals.getComputedStyle = (window as unknown as { getComputedStyle?: unknown }).getComputedStyle ?? (() => ({}))
globals.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0)
globals.cancelAnimationFrame = (id: unknown) => clearTimeout(id as number)

const emptySelection = {
  rangeCount: 0,
  isCollapsed: true,
  anchorNode: null,
  focusNode: null,
  anchorOffset: 0,
  focusOffset: 0,
  type: 'None',
  addRange() {},
  removeAllRanges() {},
  collapse() {},
  extend() {},
  getRangeAt: () => document.createRange(),
}
;(window as unknown as Record<string, unknown>).getSelection = () => emptySelection
;(document as unknown as Record<string, unknown>).getSelection = () => emptySelection
globals.getSelection = () => emptySelection

const { Editor } = await import('@tiptap/core')
const StarterKit = (await import('@tiptap/starter-kit')).default
const { Markdown } = await import('@tiptap/markdown')
const { LiteralBlock } = await import('../../markdown/extensions/LiteralBlock')
const { TableRow } = await import('@tiptap/extension-table')
// The tables the app actually uses: GFM's column alignment lives on these nodes (`extensions/TableAlignment.ts`).
const { AlignedTable, AlignedTableHeader, AlignedTableCell } = await import('../../markdown/extensions/TableAlignment')

function open() {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ blockquote: false }),
      AlignedTable.configure({ resizable: false }),
      TableRow,
      AlignedTableHeader,
      AlignedTableCell,
      LiteralBlock,
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    injectCSS: false,
    content: '',
  })
  created.push(editor)
  return editor
}

const FILE = [
  '# 标题',
  '<div style="color:red">红色的一段</div>',
  '按 <kbd>Ctrl</kbd> 保存',
  '普通的一段。',
  '| a | b |\n| --- | --- |\n| 1 | 2 |',
].join('\n\n')

function build(mode: 'paragraph' | 'literalBlock') {
  const editor = open()
  const bridge = bridgeOf(editor)!
  const blocks = blockTexts(layoutMarkdown(parseDocText(FILE).body))
  const doc = blocksToDocument(bridge, blocks, { literalAs: mode })
  return {
    editor,
    blocks,
    types: (doc.content as Array<{ type: string }>).map((node) => node.type),
    doc,
  }
}

describe('a file built for the reading face', () => {
  it('hands the blocks the engine cannot carry to the reader', () => {
    const { editor, doc } = build('literalBlock')
    // The schema accepts them — a document built with nodes the editor does not know would throw here.
    editor.commands.setContent(doc as never, { emitUpdate: false } as never)
    // Five file blocks, plus the paragraph the editor keeps past the end so there is somewhere to type after a table
    // (`trailingNode`, StarterKit's own) — the same node the block layer already accounts for.
    expect(editor.state.doc.childCount).toBe(6)
    expect(editor.state.doc.child(1).type.name).toBe('literalBlock')
    expect(editor.state.doc.child(2).type.name).toBe('literalBlock')
    expect(editor.state.doc.child(4).type.name).toBe('table')
  })

  it('keeps the block’s own bytes on the node, verbatim', () => {
    const { doc } = build('literalBlock')
    const nodes = doc.content as Array<{ type: string; attrs?: { text?: string } }>
    expect(nodes[1]?.attrs?.text).toBe('<div style="color:red">红色的一段</div>')
    expect(nodes[2]?.attrs?.text).toBe('按 <kbd>Ctrl</kbd> 保存')
  })

  it('leaves the blocks the engine can carry exactly as the editor would build them', () => {
    const { types } = build('literalBlock')
    expect(types).toEqual(['heading', 'literalBlock', 'literalBlock', 'paragraph', 'table'])
  })

  it('is a different document from the editing face, and only in the literal blocks', () => {
    const editing = build('paragraph')
    const reading = build('literalBlock')
    expect(editing.types).toEqual(['heading', 'paragraph', 'paragraph', 'paragraph', 'table'])
    // One node per file block either way: that promise is what every splice in the editor rests on.
    expect(editing.types.length).toBe(editing.blocks.length)
    expect(reading.types.length).toBe(reading.blocks.length)
  })
})
