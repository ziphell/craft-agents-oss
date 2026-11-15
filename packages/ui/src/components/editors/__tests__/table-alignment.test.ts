import { afterAll, describe, expect, it } from 'bun:test'
import { parseHTML } from 'linkedom'
import { blockTexts, layoutMarkdown } from '../markdown-blocks'
import { blocksToDocument, blockToNode } from '../block-parse'
import { buildBlockTable } from '../block-table'
import { parseDocText } from '../markdown-envelope'
import { bridgeOf, saveBlocks } from '../markdown-save'

/**
 * GFM column alignment — `|:--|:-:|--:|` — through a real editor.
 *
 * The colons are standard syntax, and every parser on the way in carries them (marked's table token has `align`,
 * mdast's table node too, `remark-rehype` puts it on each `<th>`/`<td>`). This editor lost them in two places: the
 * cell node had no attribute to hold alignment, and the delimiter row was written as `---` for every column — so a
 * table kept its alignment only until somebody typed in it.
 */

const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as Record<string, unknown>
const added = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'DOMParser', 'customElements', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'getSelection']
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
globals.customElements = (window as unknown as Record<string, unknown>).customElements ?? { define() {}, get() {}, whenDefined: () => Promise.resolve() }
globals.MutationObserver = (window as unknown as Record<string, unknown>).MutationObserver ?? class {
  observe() {}
  disconnect() {}
  takeRecords() {
    return []
  }
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
const { TableRow } = await import('@tiptap/extension-table')
const { AlignedTable, AlignedTableCell, AlignedTableHeader, tableCellAlignOf, tableCellAlignStyle, normalizeTableAlign } =
  await import('../../markdown/extensions/TableAlignment')

function open() {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit,
      AlignedTable,
      TableRow,
      AlignedTableHeader,
      AlignedTableCell,
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    injectCSS: false,
    content: '',
  })
  created.push(editor)
  return editor
}

const ALIGNED = '| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| a | b | c |'
const PLAIN = '| a | b |\n| --- | --- |\n| 1 | 2 |'

describe('an aligned table', () => {
  it('carries each column’s alignment on its cells', () => {
    const editor = open()
    const built = blockToNode(bridgeOf(editor)!, ALIGNED)
    expect(built.literal).toBe(false)
    const table = built.json as { content: Array<{ content: Array<{ attrs?: Record<string, unknown> }> }> }
    const header = table.content[0]!.content
    expect(header.map((cell) => cell.attrs?.align)).toEqual(['left', 'center', 'right'])
    // The body rows say the same, so a cell keeps its alignment wherever it is asked from.
    expect(table.content[1]!.content.map((cell) => cell.attrs?.align)).toEqual(['left', 'center', 'right'])
  })

  it('draws it — the cells carry `text-align`', () => {
    const editor = open()
    editor.commands.setContent(ALIGNED, { contentType: 'markdown' } as never)
    const cells = Array.from(editor.view.dom.querySelectorAll('th')) as HTMLElement[]
    expect(cells.map((cell) => cell.style.textAlign)).toEqual(['left', 'center', 'right'])
  })

  it('writes the colons back into the delimiter row', () => {
    const editor = open()
    const bridge = bridgeOf(editor)!
    const node = editor.schema.nodeFromJSON(blockToNode(bridge, ALIGNED).json)
    const out = bridge.serialize({ type: 'doc', content: [node.toJSON()] }).trim()
    expect(out).toContain('| :--- | :---: | ---: |')
    expect(out).toContain('| 左 ')
  })

  it('keeps them when the person types in the table', () => {
    const file = `${ALIGNED}\n`
    const envelope = parseDocText(file)
    const editor = open()
    const bridge = bridgeOf(editor)!
    const blocks = blockTexts(layoutMarkdown(envelope.body))
    editor.commands.setContent(blocksToDocument(bridge, blocks) as never, { emitUpdate: false } as never)
    const table = buildBlockTable(envelope.body, bridge)

    // A keystroke inside a body cell (`a`): that block is rewritten, and the alignment has to survive being written.
    let at = -1
    editor.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text === 'a') at = pos + node.nodeSize - 1
    })
    expect(at).toBeGreaterThan(0)
    const tr = editor.state.tr.insertText('改', at)
    editor.view.dispatch(tr)
    const saved = saveBlocks(editor, table, tr, (md) => md)!
    // Column by column: left, centre, right — the padding is whatever the text needs now.
    expect(saved.plan.text).toMatch(/\| :---\s+\| :---:\s+\| ---: \|/)
    expect(saved.plan.text).toContain('改')
  })

  it('adds no colons to a table that had none', () => {
    const editor = open()
    const bridge = bridgeOf(editor)!
    const node = editor.schema.nodeFromJSON(blockToNode(bridge, PLAIN).json)
    const out = bridge.serialize({ type: 'doc', content: [node.toJSON()] }).trim()
    expect(out).toContain('| --- | --- |')
    expect(out).not.toContain(':')
  })
})

describe('what the file’s own bytes buy', () => {
  it('leaves an untouched aligned table exactly as the file wrote it', () => {
    const file = `# 标题\n\n${ALIGNED}\n| 1 | 2 | 3 |\n`
    const envelope = parseDocText(file)
    const editor = open()
    const bridge = bridgeOf(editor)!
    const blocks = blockTexts(layoutMarkdown(envelope.body))
    editor.commands.setContent(blocksToDocument(bridge, blocks) as never, { emitUpdate: false } as never)
    const table = buildBlockTable(envelope.body, bridge)

    const tr = editor.state.tr.insertText('改', 1)
    editor.view.dispatch(tr)
    const saved = saveBlocks(editor, table, tr, (md) => md)!
    // The heading changed; the table below it is still the file's bytes — tight `:--` columns and all.
    expect(saved.plan.text).toContain('| :-- | :-: | --: |')
  })
})

/** The document position where top-level block `index` starts. */
function blockStart(editor: { state: { doc: { forEach(cb: (node: unknown, offset: number, index: number) => void): void } } }, index: number): number {
  let position = 0
  editor.state.doc.forEach((_node, offset, i) => {
    if (i === index) position = offset
  })
  return position
}

describe('what the reading face reads', () => {
  it('takes the alignment off the element react-markdown hands over', () => {
    expect(tableCellAlignOf({ properties: { align: 'left' } })).toBe('left')
    expect(tableCellAlignOf({ properties: {} })).toBeNull()
    expect(tableCellAlignOf(undefined)).toBeNull()
    // An element without a `properties` bag is not a reason to throw at render time.
    expect(tableCellAlignOf({ type: 'element', tagName: 'th' })).toBeNull()
  })

  it('turns it into the one style it means, and knows the three values GFM defines', () => {
    expect(tableCellAlignStyle('center')).toEqual({ textAlign: 'center' })
    expect(tableCellAlignStyle('middle')).toBeUndefined()
    expect(normalizeTableAlign('right')).toBe('right')
    expect(normalizeTableAlign(null)).toBeNull()
  })
})

/**
 * A line break inside a cell.
 *
 * A row is one line of markdown, so a break in a cell can only be the HTML for one — `<br>`, which is what every
 * table written by a person uses. Measured before this: the engine read `<br>` as a stray `html` token, put an empty
 * paragraph inside the cell's paragraph, and wrote the whole thing back as `&nbsp;` — the break gone, the words still
 * there, so nothing looked wrong until the next save. A cell holding two blocks fared worse: they were joined with a
 * `\u001f` control character, which is not even printable.
 */
describe('a break inside a cell', () => {
  it('is a hard break in the document, not an empty paragraph', () => {
    const editor = open()
    const built = blockToNode(bridgeOf(editor)!, '| a<br>b |\n| --- |\n| 1 |')
    expect(built.literal).toBe(false)
    const table = built.json as { content: Array<{ content: Array<{ content: Array<{ content?: Array<{ type: string }> }> }> }> }
    const cell = table.content[0]!.content[0]!.content[0]!
    expect(cell.content?.map((node) => node.type)).toEqual(['text', 'hardBreak', 'text'])
  })

  it('is written back as `<br>`, not as a non-breaking space', () => {
    const editor = open()
    const bridge = bridgeOf(editor)!
    const node = editor.schema.nodeFromJSON(blockToNode(bridge, '| a<br>b |\n| --- |\n| 1 |').json)
    const out = bridge.serialize({ type: 'doc', content: [node.toJSON()] }).trim()
    expect(out).toContain('<br>')
    expect(out).not.toContain('&nbsp;')
    expect(out.split('\n')).toHaveLength(3) // header, delimiter, one body row — the row did not split
  })

  it('draws as a `<br>` in the cell', () => {
    const editor = open()
    editor.commands.setContent('| a<br>b |\n| --- |\n| 1 |', { contentType: 'markdown' } as never)
    expect(editor.view.dom.querySelector('th br')).not.toBeNull()
  })

  it('carries two blocks in one cell on one line, joined by `<br>`', () => {
    const editor = open()
    const bridge = bridgeOf(editor)!
    // Two paragraphs in a cell: what pressing Enter in a cell makes.
    const doc = {
      type: 'doc',
      content: [{
        type: 'table',
        content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [
          { type: 'paragraph', content: [{ type: 'text', text: '上' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '下' }] },
        ] }] }],
      }],
    }
    const out = bridge.serialize(doc as never).trim()
    expect(out).toContain('上<br>下')
    expect(out).not.toContain('\u001f')
    expect(out.split('\n')).toHaveLength(3)
  })

  it('keeps an empty middle line instead of tidying it away', () => {
    const editor = open()
    const bridge = bridgeOf(editor)!
    // 上 / 空一段 / 下 — the extra break is the person's, and it survives.
    const doc = {
      type: 'doc',
      content: [{
        type: 'table',
        content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [
          { type: 'paragraph', content: [{ type: 'text', text: '上' }] },
          { type: 'paragraph' },
          { type: 'paragraph', content: [{ type: 'text', text: '下' }] },
        ] }] }],
      }],
    }
    const out = bridge.serialize(doc as never).trim()
    expect(out).toContain('上<br><br>下')
  })
})

/**
 * A pipe inside a cell.
 *
 * `|` is the column delimiter, so a cell's own pipe has to be escaped or the row gains a column. Upstream TipTap
 * escapes it (`escapePipesInCellText`, 3.32), genoffice does it while rendering a table, and Outline's `esc()` does it
 * under `inTable` — three implementations, one rule.
 */
describe('a pipe inside a cell', () => {
  it('is escaped when written, so the row keeps its columns', () => {
    const editor = open()
    const bridge = bridgeOf(editor)!
    const doc = {
      type: 'doc',
      content: [{
        type: 'table',
        content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'a | b' }] },
        ] }] }],
      }],
    }
    const out = bridge.serialize(doc as never).trim()
    expect(out).toContain('a \\| b')
    // One header line, one delimiter, one body row — the pipe did not open a new column.
    expect(out.split('\n')).toHaveLength(3)
    expect(out.split('\n')[2]!.split('|')).toHaveLength(4)
  })

  it('is read back as the pipe the document says', () => {
    const editor = open()
    const built = blockToNode(bridgeOf(editor)!, '| a \\| b |\n| --- |\n| 1 |')
    expect(built.literal).toBe(false)
    const table = built.json as { content: Array<{ content: Array<{ content: Array<{ content?: Array<{ text?: string }> }> }> }> }
    expect(table.content[0]!.content[0]!.content[0]!.content?.[0]?.text).toBe('a | b')
  })

  it('does not escape a pipe the file already escaped, twice', () => {
    const editor = open()
    const bridge = bridgeOf(editor)!
    const built = blockToNode(bridge, '| a \\| b |\n| --- |\n| 1 |')
    const node = editor.schema.nodeFromJSON(built.json)
    const out = bridge.serialize({ type: 'doc', content: [node.toJSON()] }).trim()
    expect(out).toContain('a \\| b')
    expect(out).not.toContain('\\\\|') // not `\\|`: one escape is the pipe's, two would put a backslash in the file
  })
})
