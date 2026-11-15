import { afterAll, describe, expect, it } from 'bun:test'
import { parseHTML } from 'linkedom'
import { blockTexts, layoutMarkdown } from '../markdown-blocks'
import { blocksToDocument } from '../block-parse'
import { buildBlockTable } from '../block-table'
import { parseDocText, serializeDocText } from '../markdown-envelope'
import { bridgeOf, saveBlocks } from '../markdown-save'

/**
 * Line endings, through the **save path** — not just the envelope.
 *
 * `markdown-envelope.test.ts` covers what an envelope remembers. This is the other half: a file opened on Windows,
 * edited in the document, written back by the block save. The envelope normalises the body to `\n` so every offset in
 * the editor is one kind of newline; the assertion here is that the file gets its own kind back, and that the blocks
 * nobody touched keep their bytes — a CRLF file must not come back with half of it rewritten to LF.
 *
 * Headless: a real TipTap editor and a real markdown engine, `linkedom` standing in for a DOM.
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
const { AlignedTable, AlignedTableCell, AlignedTableHeader } = await import('../../markdown/extensions/TableAlignment')

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

/** Open `raw` as the editor does, type one character into `甲段。`, and hand back the file that would be saved. */
function editOneCharacter(raw: string): string {
  const envelope = parseDocText(raw)
  const editor = open()
  const bridge = bridgeOf(editor)!
  const blocks = blockTexts(layoutMarkdown(envelope.body))
  editor.commands.setContent(blocksToDocument(bridge, blocks) as never, { emitUpdate: false } as never)
  const table = buildBlockTable(envelope.body, bridge)

  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text === '甲段。') at = pos + 2
  })
  expect(at).toBeGreaterThan(0)

  const tr = editor.state.tr.insertText('改', at)
  editor.view.dispatch(tr)
  const saved = saveBlocks(editor, table, tr, (md) => md)!
  return serializeDocText(envelope, saved.text)
}

/** A file whose every break is `\r\n`, one whose every break is `\n`, and the count of each. */
const LF = '# 标题\n\n甲段。\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'
const CRLF = LF.replace(/\n/g, '\r\n')
const breaksOf = (text: string) => ({
  crlf: (text.match(/\r\n/g) ?? []).length,
  lone: (text.match(/(^|[^\r])\n/g) ?? []).length,
})

describe('a CRLF file, edited in the document', () => {
  it('comes back with CRLF on every line, and nothing else changed', () => {
    const out = editOneCharacter(CRLF)
    expect(breaksOf(out)).toEqual({ crlf: 7, lone: 0 })
    // The one block that was edited was rewritten; the table below it is still the file's own bytes.
    expect(out).toBe(CRLF.replace('甲段。', '甲段改。'))
    expect(out).toContain('| a | b |')
  })

  it('keeps the frontmatter’s line endings too', () => {
    const file = '---\r\ntitle: x\r\n---\r\n\r\n# 标题\r\n\r\n甲段。\r\n'
    const out = editOneCharacter(file)
    expect(breaksOf(out)).toEqual({ crlf: 7, lone: 0 })
    expect(out.startsWith('---\r\ntitle: x\r\n---\r\n')).toBe(true)
  })

  it('keeps a CRLF file’s missing final newline missing', () => {
    const out = editOneCharacter('# 标题\r\n\r\n甲段。')
    expect(out).toBe('# 标题\r\n\r\n甲段改。')
    expect(out.endsWith('\n')).toBe(false)
  })
})

describe('an LF file, edited in the document', () => {
  it('comes back with LF on every line', () => {
    const out = editOneCharacter(LF)
    expect(breaksOf(out)).toEqual({ crlf: 0, lone: 5 })
    expect(out).toBe(LF.replace('甲段。', '甲段改。'))
  })
})

describe('a file with both kinds of newline', () => {
  it('is written back with one kind — the file is taken to be the kind it mostly is (CRLF wins when it appears)', () => {
    // Not a preference: the envelope records `\r\n` as soon as the file contains one, because a document is edited as
    // `\n` and a *file* has one line ending. Mixed files are therefore normalised, never half-and-half.
    const out = editOneCharacter('# 标题\r\n\n甲段。\n')
    expect(breaksOf(out)).toEqual({ crlf: 3, lone: 0 })
    expect(out).toBe('# 标题\r\n\r\n甲段改。\r\n')
  })
})
