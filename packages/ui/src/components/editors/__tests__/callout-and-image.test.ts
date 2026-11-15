import { afterAll, describe, expect, it } from 'bun:test'
import { parseHTML } from 'linkedom'
import { blockTexts, layoutMarkdown } from '../markdown-blocks'
import { blocksToDocument, blockToNode } from '../block-parse'
import { buildBlockTable } from '../block-table'
import { parseDocText, serializeDocText } from '../markdown-envelope'
import { bridgeOf, saveBlocks } from '../markdown-save'

/**
 * `> [!NOTE]` and `![](pics/a.png)` — the two places the reading face knew something the editing face did not.
 *
 * Both were measured, not assumed: a callout used to be a quote whose first line read `[!NOTE]` in the editor, and a
 * picture beside the document was a broken image there (the browser asked the app's origin for `pics/a.png`).
 *
 * Headless: a real TipTap editor with a real markdown engine, `linkedom` standing in for the DOM. Nothing renders.
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
const { CalloutBlockquote } = await import('../../markdown/extensions/CalloutBlockquote')
const { DocumentImage, resolveDocumentPictures } = await import('../../markdown/extensions/DocumentImage')

function open() {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ blockquote: false }),
      CalloutBlockquote,
      DocumentImage.configure({ inline: false, allowBase64: true }),
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    injectCSS: false,
    content: '',
  })
  created.push(editor)
  return editor
}

describe('a callout', () => {
  const file = '> [!note]\n> 甲段。\n'

  it('is one node that says which type it is, not a quote reading `[!note]`', () => {
    const editor = open()
    const built = blockToNode(bridgeOf(editor)!, '> [!note]\n> 甲段。')
    expect(built.literal).toBe(false)
    const node = built.json as { type: string; attrs?: Record<string, unknown>; content?: Array<{ content?: Array<{ text?: string }> }> }
    expect(node.type).toBe('blockquote')
    expect(node.attrs?.callout).toBe('note')
    // The marker is not text in the document any more: the type is the attribute, and the label is drawn from it.
    expect(JSON.stringify(node)).not.toContain('[!note]')
    expect(node.content?.[0]?.content?.[0]?.text).toBe('甲段。')
  })

  it('draws with the type name the reading face uses', () => {
    const editor = open()
    editor.commands.setContent('> [!warning]\n> 小心。\n', { contentType: 'markdown' } as never)
    const quote = editor.view.dom.querySelector('blockquote')
    expect(quote?.getAttribute('data-callout')).toBe('warning')
    expect(quote?.getAttribute('data-callout-label')).toBe('Warning')
  })

  it('says the file back, marker and all', () => {
    const editor = open()
    const bridge = bridgeOf(editor)!
    const node = editor.schema.nodeFromJSON(blockToNode(bridge, '> [!note]\n> 甲段。').json)
    expect(bridge.serialize({ type: 'doc', content: [node.toJSON()] }).trim()).toBe('> [!note]\n> 甲段。')
  })

  it('keeps the fold character GitHub writes after the marker', () => {
    const editor = open()
    const bridge = bridgeOf(editor)!
    const built = blockToNode(bridge, '> [!note]-\n> 折叠的。')
    expect((built.json as { attrs?: Record<string, unknown> }).attrs?.calloutFold).toBe('-')
    const node = editor.schema.nodeFromJSON(built.json)
    expect(bridge.serialize({ type: 'doc', content: [node.toJSON()] }).trim()).toBe('> [!note]-\n> 折叠的。')
  })

  /*
   * GitHub writes the type in capitals (`> [!NOTE]`), and that was the one spelling this node got wrong: the marker
   * was lower-cased on the way out, `says()` read the case change as a lost word, and the whole block fell to the
   * literal path — so a callout written the way GitHub writes it was shown in the editor as its own source.
   */
  it('writes the marker in the case the file used', () => {
    const editor = open()
    const bridge = bridgeOf(editor)!
    const built = blockToNode(bridge, '> [!NOTE]\n> 大写提示')
    expect(built.literal).toBe(false)
    expect((built.json as { attrs?: Record<string, unknown> }).attrs?.callout).toBe('note')
    expect((built.json as { attrs?: Record<string, unknown> }).attrs?.calloutMarker).toBe('NOTE')
    const node = editor.schema.nodeFromJSON(built.json)
    expect(bridge.serialize({ type: 'doc', content: [node.toJSON()] }).trim()).toBe('> [!NOTE]\n> 大写提示')
  })

  it('keeps a mixed-case marker, fold and all', () => {
    const editor = open()
    const bridge = bridgeOf(editor)!
    const built = blockToNode(bridge, '> [!Warning]-\n> 小心。')
    expect(built.literal).toBe(false)
    const node = editor.schema.nodeFromJSON(built.json)
    expect(bridge.serialize({ type: 'doc', content: [node.toJSON()] }).trim()).toBe('> [!Warning]-\n> 小心。')
  })

  it('draws the label from the type, not from the spelling', () => {
    const editor = open()
    editor.commands.setContent('> [!IMPORTANT]\n> 重点。\n', { contentType: 'markdown' } as never)
    const quote = editor.view.dom.querySelector('blockquote')
    expect(quote?.getAttribute('data-callout')).toBe('important')
    expect(quote?.getAttribute('data-callout-label')).toBe('Important')
  })

  it('keeps the spelling through a document built block by block', () => {
    const envelope = parseDocText('# 标题\n\n> [!NOTE]\n> 大写提示\n')
    const editor = open()
    const bridge = bridgeOf(editor)!
    const blocks = blockTexts(layoutMarkdown(envelope.body))
    editor.commands.setContent(blocksToDocument(bridge, blocks) as never, { emitUpdate: false } as never)

    expect(editor.view.dom.querySelectorAll('blockquote[data-callout]').length).toBe(1)
    // A keystroke in the heading: the callout is written from the file's own bytes, in its own case.
    const tr = editor.state.tr.insertText('改', 3)
    editor.view.dispatch(tr)
    const saved = saveBlocks(editor, buildBlockTable(envelope.body, bridge), tr, (md) => md)!
    expect(saved.plan.text).toContain('> [!NOTE]\n> 大写提示')
  })

  it('leaves an ordinary quote an ordinary quote', () => {
    const editor = open()
    const bridge = bridgeOf(editor)!
    const built = blockToNode(bridge, '> 只是引用。')
    expect((built.json as { attrs?: Record<string, unknown> }).attrs?.callout ?? null).toBeNull()
    expect((built.json as { attrs?: Record<string, unknown> }).attrs?.calloutMarker ?? null).toBeNull()
    expect(bridge.serialize({ type: 'doc', content: [built.json as never] }).trim()).toBe('> 只是引用。')
  })

  it('opens in the editor as a callout, and keeps the file’s own bytes while nobody touches it', () => {
    const envelope = parseDocText(`${file}
甲段。
`)
    const editor = open()
    const bridge = bridgeOf(editor)!
    const blocks = blockTexts(layoutMarkdown(envelope.body))
    editor.commands.setContent(blocksToDocument(bridge, blocks) as never, { emitUpdate: false } as never)

    expect(editor.view.dom.querySelectorAll('blockquote[data-callout]').length).toBe(1)

    // A keystroke in the paragraph *below* the callout: the callout is written from the file's own bytes.
    let secondBlock = 0
    editor.state.doc.forEach((node, offset, index) => {
      if (index === 1) secondBlock = offset
    })
    const table = buildBlockTable(envelope.body, bridge)
    const tr = editor.state.tr.insertText('改', secondBlock + 1)
    editor.view.dispatch(tr)
    const saved = saveBlocks(editor, table, tr, (md) => md)!
    expect(saved.plan.text).toContain('> [!note]\n> 甲段。')
    expect(saved.plan.text).toContain('改甲段。')
  })

  it('writes the marker back when the callout itself is edited', () => {
    const envelope = parseDocText(file)
    const editor = open()
    const bridge = bridgeOf(editor)!
    editor.commands.setContent(blocksToDocument(bridge, blockTexts(layoutMarkdown(envelope.body))) as never, {
      emitUpdate: false,
    } as never)
    const table = buildBlockTable(envelope.body, bridge)

    const tr = editor.state.tr.insertText('改', 2)
    editor.view.dispatch(tr)
    const saved = saveBlocks(editor, table, tr, (md) => md)!
    expect(saved.plan.text).toContain('> [!note]')
    expect(saved.plan.text).not.toContain('[!note]\n[!note]')
    expect(saved.plan.text).toContain('改甲段。')
  })
})

describe('a picture beside the document', () => {
  const file = '![图](pics/a.png)\n'
  const dataUrl = 'data:image/png;base64,AAAA'

  it('is drawn from the file, and still says what the document says', async () => {
    const envelope = parseDocText(file)
    const editor = open()
    const bridge = bridgeOf(editor)!
    editor.commands.setContent(blocksToDocument(bridge, blockTexts(layoutMarkdown(envelope.body))) as never, {
      emitUpdate: false,
    } as never)

    const read: string[] = []
    resolveDocumentPictures(editor, 'C:/docs', async (path) => {
      read.push(path)
      return dataUrl
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The file's relative path is resolved against the document's folder, and read through the platform.
    expect(read).toEqual(['C:/docs/pics/a.png'])
    // What is on screen is the data URL…
    expect(editor.view.dom.querySelector('img')?.getAttribute('src')).toBe(dataUrl)
    // …and what would be saved is still the path in the document.
    const node = editor.schema.nodeFromJSON(editor.state.doc.child(0).toJSON())
    expect(bridge.serialize({ type: 'doc', content: [node.toJSON()] }).trim()).toBe('![图](pics/a.png)')
  })

  it('asks for each file once', async () => {
    const envelope = parseDocText(file)
    const editor = open()
    editor.commands.setContent(
      blocksToDocument(bridgeOf(editor)!, blockTexts(layoutMarkdown(envelope.body))) as never,
      { emitUpdate: false } as never,
    )
    const read: string[] = []
    const reader = async (path: string) => {
      read.push(path)
      return dataUrl
    }
    resolveDocumentPictures(editor, 'C:/docs', reader)
    resolveDocumentPictures(editor, 'C:/docs', reader)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(read).toEqual(['C:/docs/pics/a.png'])
  })

  it('leaves a URL alone — a browser fetches that itself', async () => {
    const editor = open()
    editor.commands.setContent('![图](https://example.com/a.png)\n', { contentType: 'markdown' } as never)
    const read: string[] = []
    resolveDocumentPictures(editor, 'C:/docs', async (path) => {
      read.push(path)
      return dataUrl
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(read).toEqual([])
    expect(editor.view.dom.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png')
  })

  it('does nothing without a folder to resolve against', async () => {
    const editor = open()
    editor.commands.setContent(file, { contentType: 'markdown' } as never)
    const read: string[] = []
    resolveDocumentPictures(editor, undefined, async (path) => {
      read.push(path)
      return dataUrl
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(read).toEqual([])
  })
})

describe('the document these two share', () => {
  it('is still one node per file block, callouts and pictures included', () => {
    const source = '> [!tip]\n> 提示。\n\n![图](pics/a.png)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    const editor = open()
    const bridge = bridgeOf(editor)!
    const blocks = blockTexts(layoutMarkdown(parseDocText(source).body))
    const doc = blocksToDocument(bridge, blocks)
    expect((doc.content as unknown[]).length).toBe(blocks.length)
    editor.commands.setContent(doc as never, { emitUpdate: false } as never)
    expect(editor.state.doc.childCount).toBe(blocks.length)
    expect(serializeDocText(parseDocText(source), editor.getMarkdown())).toContain('> [!tip]')
  })
})

/**
 * Inline math as these documents write it.
 *
 * Measured on 3.20 before this: `行内 $$a^2$$ 结束` parsed as **plain text** (the stock tokenizer wants a single `$`),
 * while `价格 $100 与 $200` parsed as **inline math with `latex: "100 与 "`** — a price band drawn as a formula. Both
 * are the tokenizer's, and the block-level one made it worse: its `start` fires on any `$$`, so a paragraph holding
 * `$$…$$` was cut into three blocks. See `extensions/InlineMathMarkdown.ts`.
 */
describe('inline math', () => {
  function parsed(md: string): { blocks: string[]; inline: string[] } {
    const editor = open()
    const json = (editor as unknown as { markdown: { parse(md: string): { content?: Array<{ type: string; content?: Array<{ type: string }> }> } } }).markdown.parse(md)
    const blocks = (json.content ?? []).map((node) => node.type)
    const inline = (json.content?.[0]?.content ?? []).map((node) => node.type)
    return { blocks, inline }
  }

  // The editor in this file does not carry the math extensions; the tokenizer is tested through its own editor.
  it('keeps a price band as text, and reads `$$…$$` on one line as math', async () => {
    const { Editor } = await import('@tiptap/core')
    const StarterKit = (await import('@tiptap/starter-kit')).default
    const { Markdown } = await import('@tiptap/markdown')
    const { BlockMathMarkdown, InlineMathMarkdown } = await import('../../markdown/extensions/InlineMathMarkdown')
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        StarterKit,
        BlockMathMarkdown,
        InlineMathMarkdown,
        Markdown.configure({ markedOptions: { gfm: true } }),
      ],
      injectCSS: false,
      content: '',
    })
    const parse = (md: string) =>
      (editor as unknown as { markdown: { parse(md: string): { content?: Array<{ type: string; content?: Array<{ type: string }> }> } } }).markdown.parse(md)

    const single = parse('行内 $a^2$ 结束')
    expect(single.content?.map((node) => node.type)).toEqual(['paragraph'])
    expect(single.content?.[0]?.content?.map((node) => node.type)).toEqual(['text', 'inlineMath', 'text'])

    // `$$…$$` inside a sentence is inline math, and it no longer splits the paragraph.
    const double = parse('行内 $$a^2$$ 结束')
    expect(double.content?.map((node) => node.type)).toEqual(['paragraph'])
    expect(double.content?.[0]?.content?.map((node) => node.type)).toEqual(['text', 'inlineMath', 'text'])

    // Money is money.
    const money = parse('价格 $100 与 $200')
    expect(money.content?.map((node) => node.type)).toEqual(['paragraph'])
    expect(money.content?.[0]?.content?.every((node) => node.type === 'text')).toBe(true)

    // A line of its own is still display math.
    expect(parse('$$a^2$$').content?.map((node) => node.type)).toEqual(['blockMath'])

    editor.destroy()
  })
})
