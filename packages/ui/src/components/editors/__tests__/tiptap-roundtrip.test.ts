import { afterAll, describe, expect, it, jest } from 'bun:test'
import { parseHTML } from 'linkedom'
import { blockTexts, layoutMarkdown } from '../markdown-blocks'
import { buildBlockTable, type BlockBridge } from '../block-table'
import { landMarkdown } from '../markdown-land'
import { parseDocText, serializeDocText } from '../markdown-envelope'
import { applyTextEdit, liveTextOf } from '../text-edits'
import { blockToNode, blocksToDocument } from '../block-parse'
import { bridgeOf, saveBlocks } from '../markdown-save'

/**
 * What the real editor does with a block, measured rather than assumed.
 *
 * The app's markdown editor is TipTap with the official `@tiptap/markdown` engine, so the questions this file
 * answers are the engine's: does one file block become one document node, and does a block's markdown come back
 * out as the same bytes? Both turn out to be **no** for tables and frontmatter, which is why the block table keeps
 * file bytes as the diff basis instead of trusting the serializer.
 *
 * Headless: TipTap needs a DOM, so `linkedom` stands in for one (the app's own `packages/shared` already uses it
 * for document parsing). Nothing here renders — only parse and serialize — so a measurement like this does not
 * need a window on screen.
 */
const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as Record<string, unknown>

// Every key this file adds, so it can be taken away again: other test files run in the same process, and a global
// `document` changes what they do (CodeMirror's, for one, takes the browser path and needs a real one).
const added = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'DOMParser', 'customElements', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'getSelection']
const before = new Map(added.map((key) => [key, Object.prototype.hasOwnProperty.call(globals, key) ? globals[key] : undefined]))
afterAll(() => {
  // Editors still hold a DOM they will keep using (selections, frames). Tear them down before the shim goes away,
  // or a timer fires later, in somebody else's test, against a `document` that is no longer there.
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
// React's DOM renderer takes the browser path as soon as `window` exists, and other test files in this package
// then expect a few more browser globals. Fill them in rather than leave a half-built window behind.
globals.customElements = (window as unknown as Record<string, unknown>).customElements ?? {
  define() {},
  get() {
    return undefined
  },
  whenDefined: () => Promise.resolve(),
}
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
// The nodes the app actually uses: tables here carry GFM's column alignment (`extensions/TableAlignment.ts`).
const { AlignedTable, AlignedTableHeader, AlignedTableCell } = await import('../../markdown/extensions/TableAlignment')
const { AgentPresence, clearAgentPresence, agentPresenceExpiry } = await import('../../markdown/extensions/AgentPresence')

const created: Array<{ destroy(): void }> = []

function open(source: string) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit,
      AlignedTable.configure({ resizable: false }),
      TableRow,
      AlignedTableHeader,
      AlignedTableCell,
      Markdown,
      AgentPresence,
    ],
    injectCSS: false,
    content: source,
    contentType: 'markdown' as never,
  })
  created.push(editor)
  return editor
}

const SOURCE = ['# 标题', '第一段。', '- 甲\n- 乙', '| a | b |\n| --- | --- |\n| 1 | 2 |'].join('\n\n') + '\n'

describe('the official markdown engine, measured', () => {
  const editor = open(SOURCE)

  it('keeps the block count in step with the file — the premise of a block splice', () => {
    expect(editor.state.doc.childCount).toBe(blockTexts(layoutMarkdown(SOURCE)).length)
  })

  it('gives a heading, a paragraph, a list and a code fence back unchanged', () => {
    const blocks: string[] = []
    editor.state.doc.forEach((node) => {
      blocks.push(editor.markdown!.serialize({ type: 'doc', content: [node.toJSON()] }).trim())
    })
    expect(blocks[0]).toBe('# 标题')
    expect(blocks[1]).toBe('第一段。')
  })

  it('pads a table, so its serialization is not the file’s bytes', () => {
    const table = editor.state.doc.child(3).toJSON()
    const out = editor.markdown!.serialize({ type: 'doc', content: [table] }).trim()
    expect(out).toContain('| a   | b   |')
    expect(out).not.toBe('| a | b |\n| --- | --- |\n| 1 | 2 |')
  })

  it('is why a table is not a live block unless its own baseline is the yardstick', () => {
    const bridge: BlockBridge = {
      parse: (md) => ({ content: (editor.markdown!.parse(md).content ?? []) as unknown[] }),
      serialize: (json) => editor.markdown!.serialize(json as never),
    }
    const table = buildBlockTable(SOURCE, bridge)
    // Every block is one node here, so all four are live…
    expect(table.rows.every((row) => row.baseline !== null)).toBe(true)
    // …and the table's baseline is the padded form, which is what makes "untouched" detectable at all.
    expect(table.rows[3]!.baseline).toContain('| a   | b   |')
  })
})

describe('frontmatter, measured', () => {
  it('becomes more nodes than the file has blocks — the one case a block splice must refuse', () => {
    const source = '---\ntitle: 笔记\n---\n\n# 标题\n'
    const editor = open(source)
    const blocks = blockTexts(layoutMarkdown(source))
    expect(blocks.length).toBe(2) // frontmatter, heading
    expect(editor.state.doc.childCount).toBeGreaterThan(blocks.length) // …but the parser reads it as a break + heading
  })
})

describe('a SKILL.md, end to end', () => {
  const file = '---\nname: daily-digest\ndescription: 日报\n---\n\n# 日报\n\n甲段。\n\n乙段。\n'

  it('lands an agent edit in the body, as one block, and writes the file back with its frontmatter intact', () => {
    const envelope = parseDocText(file)
    const editor = open(envelope.body)
    const nextBody = envelope.body.replace('甲段。', '甲段，改过。')

    const result = landMarkdown(editor, nextBody, { current: envelope.body })
    expect(result.applied).toBe(true)
    expect(result.landing?.blocks).toEqual(['甲段，改过。'])

    expect(serializeDocText(envelope, editor.getMarkdown())).toBe(file.replace('甲段。', '甲段，改过。'))
  })

  it('keeps the caret where the person put it, and the block below it untouched', () => {
    const envelope = parseDocText(file)
    const editor = open(envelope.body)
    // Start of the last block: every node before it, then two positions into the paragraph.
    let lastBlockStart = 1
    editor.state.doc.forEach((node, _offset, index) => {
      if (index < editor.state.doc.childCount - 1) lastBlockStart += node.nodeSize
    })
    editor.commands.setTextSelection(Math.min(lastBlockStart, editor.state.doc.content.size - 1))
    const before = editor.state.selection.from

    const landed = landMarkdown(editor, envelope.body.replace('甲段。', '甲段，改过，而且更长一些。'), {
      current: envelope.body,
    })
    expect(landed.applied).toBe(true)
    // The caret moved by exactly the text that was inserted above it — no more, and not to the document start.
    // The inserted text is 10 characters longer than what it replaced, and it sits above the caret.
    expect(editor.state.selection.from).toBe(before + ('甲段，改过，而且更长一些。'.length - '甲段。'.length))
    expect(editor.state.doc.textContent).toContain('乙段。')
  })
})

describe('saving what was typed, not what the serializer would write', () => {
  // A table with the file's own tight alignment, which the serializer would pad.
  const file = '---\nname: doc\n---\n\n# 标题\n\n甲段。\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'
  const toFile = (md: string) => md.replaceAll('¤', '$')

  it('writes only the edited block, and leaves the table exactly as the file had it', () => {
    const envelope = parseDocText(file)
    const editor = open(envelope.body)
    const table = buildBlockTable(envelope.body, bridgeOf(editor)!)

    // Type into the paragraph. The heading and the table are untouched.
    const paragraphStart = envelope.body.indexOf('甲段。')
    const tr = editor.state.tr.insertText('改', paragraphStart + 2)
    editor.view.dispatch(tr)

    const saved = saveBlocks(editor, table, tr, toFile)!
    expect(saved.touched).toEqual([1])
    expect(saved.plan.written).toEqual([1])
    expect(saved.plan.text).toContain('| a | b |') // not `| a   | b   |`: the file's own alignment
    expect(saved.plan.text).not.toContain('| a   |')
    // (The insert position is a document position, not an offset in the string — hence the one character there.)
    expect(serializeDocText(envelope, saved.plan.text)).toBe(file.replace('甲段。', '甲段。改'))
  })

  it('costs nothing for a transaction that only moved the selection', () => {
    const envelope = parseDocText(file)
    const editor = open(envelope.body)
    const table = buildBlockTable(envelope.body, bridgeOf(editor)!)
    const tr = editor.state.tr.setSelection(editor.state.selection)
    const saved = saveBlocks(editor, table, tr, toFile)!
    expect(saved.touched).toEqual([])
    expect(saved.text).toBe(envelope.body)
  })
})

describe('what an agent edit looks like', () => {
  /*
   * The extension is registered **here** and not in `TiptapMarkdownEditor` (see its header: the fade clock re-armed on
   * every keystroke, so the caret followed the person's own typing). These tests stay as the guard for the day it is
   * registered again — they describe the extension, not the app.
   */
  const file = '# 标题\n\n甲段。\n\n乙段。\n'

  it('washes the text it wrote, and leaves a caret where it stopped', () => {
    const envelope = parseDocText(file)
    const editor = open(envelope.body)
    const landed = landMarkdown(editor, envelope.body.replace('甲段。', '甲段，新写的。'), { current: envelope.body })
    expect(landed.applied).toBe(true)

    const dom = editor.view.dom
    expect(dom.querySelectorAll('.agent-changed').length).toBeGreaterThan(0)
    const caret = dom.querySelector('.agent-caret')
    expect(caret).not.toBeNull()
    expect(caret!.textContent).toBe('Craft Agent')
  })

  it('says nothing about a person typing', () => {
    const envelope = parseDocText(file)
    const editor = open(envelope.body)
    const tr = editor.state.tr.insertText('手', 3)
    editor.view.dispatch(tr)
    expect(editor.view.dom.querySelector('.agent-changed')).toBeNull()
    expect(editor.view.dom.querySelector('.agent-caret')).toBeNull()
  })

  it('is due at a time, and a person typing does not push that time forward', () => {
    const envelope = parseDocText(file)
    const editor = open(envelope.body)
    landMarkdown(editor, envelope.body.replace('甲段。', '甲段，新写的。'), { current: envelope.body })
    const due = agentPresenceExpiry(editor)
    expect(due).toBeGreaterThan(Date.now())

    // The marks stay, and move with the text — but the deadline is the agent's, not the typist's.
    let at = -1
    editor.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text.includes('新写的')) at = pos + node.nodeSize - 1
    })
    for (const character of ['我', '自', '己']) {
      editor.view.dispatch(editor.state.tr.insertText(character, at))
      at += 1
    }
    expect(agentPresenceExpiry(editor)).toBe(due)
    expect(editor.view.dom.querySelector('.agent-caret')).not.toBeNull()
  })

  it('vanishes when the deadline passes, and does not come back when somebody types', () => {
    // A fake clock, because the claim is about eight seconds and a test that waited would be a slow one.
    jest.useFakeTimers()
    try {
      const envelope = parseDocText(file)
      const editor = open(envelope.body)
      landMarkdown(editor, envelope.body.replace('甲段。', '甲段，新写的。'), { current: envelope.body })
      expect(editor.view.dom.querySelector('.agent-caret')).not.toBeNull()

      jest.advanceTimersByTime(8_001)
      expect(editor.view.dom.querySelector('.agent-caret')).toBeNull()
      expect(agentPresenceExpiry(editor)).toBeNull()

      // The deadline has passed: typing is just typing.
      editor.view.dispatch(editor.state.tr.insertText('我', 3))
      expect(editor.view.dom.querySelector('.agent-caret')).toBeNull()
      expect(editor.view.dom.querySelector('.agent-changed')).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it('has no deadline once it has been cleared', () => {
    const envelope = parseDocText(file)
    const editor = open(envelope.body)
    landMarkdown(editor, envelope.body.replace('甲段。', '甲段，新写的。'), { current: envelope.body })
    clearAgentPresence(editor)
    expect(agentPresenceExpiry(editor)).toBeNull()
    expect(editor.view.dom.querySelector('.agent-caret')).toBeNull()
  })

  it('can be cleared before it fades', () => {
    const envelope = parseDocText(file)
    const editor = open(envelope.body)
    landMarkdown(editor, envelope.body.replace('甲段。', '甲段，新写的。'), { current: envelope.body })
    clearAgentPresence(editor)
    expect(editor.view.dom.querySelector('.agent-changed')).toBeNull()
    expect(editor.view.dom.querySelector('.agent-caret')).toBeNull()
  })
})

describe('an edit the agent addresses to the open document', () => {
  const file = '---\nname: doc\n---\n\n# 标题\n\n甲段。\n\n乙段。\n'

  it('lands one occurrence, as one block, and reads back as the file it would save', () => {
    const envelope = parseDocText(file)
    const editor = open(envelope.body)
    expect(liveTextOf(editor, envelope)).toBe(file)

    const result = applyTextEdit(editor, envelope, { kind: 'replace-span', expectedText: '乙段。', text: '乙段，改过。' })
    expect(result.ok).toBe(true)
    expect(serializeDocText(envelope, editor.getMarkdown())).toBe(file.replace('乙段。', '乙段，改过。'))
  })

  it('refuses a span the document no longer contains — rather than editing something else', () => {
    const envelope = parseDocText(file)
    const editor = open(envelope.body)
    const result = applyTextEdit(editor, envelope, { kind: 'replace-span', expectedText: '不存在的句子。', text: 'x' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('no longer in the document')
  })

  it('refuses a span that appears twice, because that is not an anchored edit', () => {
    const twice = '# 标题\n\n同一句。\n\n同一句。\n'
    const envelope = parseDocText(twice)
    const editor = open(envelope.body)
    const result = applyTextEdit(editor, envelope, { kind: 'replace-span', expectedText: '同一句。', text: '改。' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('more than once')
  })
})

describe('markup the serializer rewrites, said the same way', () => {
  /*
   * Every one of these is a block whose *markup* the official engine changes and whose *words* it keeps. The block
   * layer used to compare characters, so each of them fell to the literal path — a table rendered in the editor as
   * `| a | b |`, which is what a document's tables looked like.
   */
  const cases: Array<{ name: string; block: string; type: string }> = [
    { name: 'a table with an alignment row', block: '| 左 | 右 |\n| :-- | --: |\n| 1 | 2 |', type: 'table' },
    { name: 'a table whose cells have to be padded', block: '| 层级 | 存在哪 |\n|---|---|\n| 会话 | `Session.browsers` |', type: 'table' },
    { name: 'a table with a link in a cell', block: '| a |\n| --- |\n| [t](http://e.com) |', type: 'table' },
    { name: 'a `*` bullet list', block: '* 甲\n* 乙', type: 'bulletList' },
    { name: '`_` emphasis', block: '_斜_ 与 __粗__', type: 'paragraph' },
    { name: 'a `1)` ordered list', block: '1) 甲\n2) 乙', type: 'orderedList' },
    { name: 'a setext heading', block: '标题\n====', type: 'heading' },
  ]

  for (const { name, block, type } of cases) {
    it(`carries ${name} as what it is`, () => {
      const editor = open('')
      const built = blockToNode(bridgeOf(editor)!, block)
      expect(built.literal).toBe(false)
      expect((built.json as { type: string }).type).toBe(type)
    })
  }

  it('shows a document’s tables as tables, not as their own markdown', () => {
    const file = '# 标题\n\n| 层级 | 存在哪 |\n| :-- | --: |\n| 会话 | `Session.browsers` |\n'
    const envelope = parseDocText(file)
    const editor = open('')
    const bridge = bridgeOf(editor)!
    const blocks = blockTexts(layoutMarkdown(envelope.body))
    editor.commands.setContent(blocksToDocument(bridge, blocks) as never, { emitUpdate: false } as never)

    expect(editor.state.doc.child(1).type.name).toBe('table')
    expect(editor.state.doc.child(1).textContent).toBe('层级存在哪会话Session.browsers')
    // What the editor would save is the file's blocks and only those: the paragraph TipTap keeps past the end so
    // there is somewhere to type after the table is not content, and it serializes to `&nbsp;`.
    const live = liveTextOf(editor, envelope)!
    expect(live).not.toContain('&nbsp;')
    expect(live).toContain('| 会话  | `Session.browsers` |')
  })

  it('still keeps the file’s own table bytes when nothing in it was edited', () => {
    const file = '# 标题\n\n| 左 | 右 |\n| :-- | --: |\n| 1 | 2 |\n'
    const envelope = parseDocText(file)
    const editor = open('')
    const bridge = bridgeOf(editor)!
    const blocks = blockTexts(layoutMarkdown(envelope.body))
    editor.commands.setContent(blocksToDocument(bridge, blocks) as never, { emitUpdate: false } as never)
    const table = buildBlockTable(envelope.body, bridge)

    // Type in the heading: the table is re-serialized nowhere, so its alignment row is untouched.
    const tr = editor.state.tr.insertText('改', 3)
    editor.view.dispatch(tr)
    const saved = saveBlocks(editor, table, tr, (md) => md)!
    expect(saved.plan.text).toContain('| :-- | --: |')
  })

  it('still refuses a block that loses a word', () => {
    const editor = open('')
    const bridge = bridgeOf(editor)!
    // Both of these parse into exactly one node — it is the words that are gone, not the structure.
    expect(blockToNode(bridge, '按 <kbd>Ctrl</kbd> 保存').literal).toBe(true)
    expect(blockToNode(bridge, '<div style="color:red">红色的一段</div>').literal).toBe(true)
  })
})

describe('a block the engine cannot represent', () => {
  const file = '# 标题\n\n<div style="color:red">红色的一段</div>\n\n按 <kbd>Ctrl</kbd> 保存\n'

  it('is carried as its own text, visibly, instead of an empty paragraph', () => {
    const editor = open('')
    const bridge = bridgeOf(editor)!
    const built = blockToNode(bridge, '<div style="color:red">红色的一段</div>')
    expect(built.literal).toBe(true)
    expect(JSON.stringify(built.json)).toContain('红色的一段')
  })

  it('survives the round trip character for character', () => {
    const editor = open('')
    const bridge = bridgeOf(editor)!
    for (const block of ['<div style="color:red">红色的一段</div>', '按 <kbd>Ctrl</kbd> 保存']) {
      const built = blockToNode(bridge, block)
      const node = editor.schema.nodeFromJSON(built.json)
      const back = bridge.serialize({ type: 'doc', content: [node.toJSON()] }).trim()
      expect(back).toBe(block)
    }
  })

  it('leaves the blocks it can represent alone', () => {
    const editor = open('')
    const bridge = bridgeOf(editor)!
    const heading = blockToNode(bridge, '## 小标题')
    expect(heading.literal).toBe(false)
    const doc = blocksToDocument(bridge, ['# 标题', '<div>x</div>', '正文。'])
    expect((doc.content as Array<{ type: string }>).map((n) => n.type)).toEqual(['heading', 'paragraph', 'paragraph'])
  })

  it('keeps block count equal to node count — the premise of every splice', () => {
    const editor = open('')
    const bridge = bridgeOf(editor)!
    const blocks = blockTexts(layoutMarkdown(file))
    const doc = blocksToDocument(bridge, blocks)
    expect((doc.content as unknown[]).length).toBe(blocks.length)
  })
})

describe('what the document looks like after opening, block by block', () => {
  const file = '# 标题\n\n<div style="color:red">红色的一段</div>\n\n正文。\n'

  it('shows the markup as text instead of an empty paragraph, and says the file back unchanged', () => {
    const envelope = parseDocText(file)
    const editor = open('')
    const bridge = bridgeOf(editor)!
    const blocks = blockTexts(layoutMarkdown(envelope.body))

    editor.commands.setContent(blocksToDocument(bridge, blocks) as never, { emitUpdate: false } as never)

    // Visible: the words are in the document, not an empty paragraph where they used to be.
    expect(editor.state.doc.textContent).toContain('红色的一段')
    expect(editor.state.doc.childCount).toBe(blocks.length)
    // And saving reads back as the file, because the literal paragraph serializes to its own bytes.
    expect(serializeDocText(envelope, editor.getMarkdown())).toBe(file)
  })
})

/**
 * A file whose last block is a table.
 *
 * TipTap keeps one empty paragraph after it (StarterKit's `TrailingNode`) so there is somewhere for the caret to go —
 * a node the file does not have. Measured before this was handled: every outside write fell back to a whole-document
 * reload, and a person typing in that paragraph had their text dropped on save.
 */
describe('a document that ends with a table', () => {
  const file = '# 标题\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'

  function opened() {
    const envelope = parseDocText(file)
    const editor = open('')
    const bridge = bridgeOf(editor)!
    const blocks = blockTexts(layoutMarkdown(envelope.body))
    editor.commands.setContent(blocksToDocument(bridge, blocks) as never, { emitUpdate: false } as never)
    return { envelope, editor, bridge, blocks }
  }

  it('holds one paragraph more than the file has blocks — the editor’s own place to type', () => {
    const { editor, blocks } = opened()
    expect(editor.state.doc.childCount).toBe(blocks.length + 1)
    expect(editor.state.doc.child(blocks.length).type.name).toBe('paragraph')
  })

  it('still lands an outside edit as one transaction, instead of reloading the whole document', () => {
    const { envelope, editor, blocks } = opened()
    const landed = landMarkdown(editor, envelope.body.replace('| 1 | 2 |', '| 1 | 3 |'), { current: envelope.body })
    expect(landed.applied).toBe(true)
    // …and the paragraph past the end is still there, untouched.
    expect(editor.state.doc.childCount).toBe(blocks.length + 1)
  })

  it('writes what the person types below it as a new paragraph of the file', () => {
    const { envelope, editor, bridge } = opened()
    const table = buildBlockTable(envelope.body, bridge)
    const tr = editor.state.tr.insertText('新写的一段。', editor.state.doc.content.size - 1)
    editor.view.dispatch(tr)

    const saved = saveBlocks(editor, table, tr, (md) => md)!
    // The file gained a block and no row of it is involved: this is the structural path (`planSaveByDiff`), which
    // is where typing below a trailing table used to be dropped — nothing in the table had a row to put it in.
    expect(saved.changed).toBe(true)
    expect(serializeDocText(envelope, saved.text)).toBe(`${file}\n新写的一段。\n`)
  })

  it('keeps that paragraph out of what the editor says the file is', () => {
    const { envelope, editor } = opened()
    // This is the serializer's answer, not the block table's — the table comes back padded and gains a blank line —
    // but the editor's own paragraph is not in it, and that is the thing that would land in the person's file.
    const live = liveTextOf(editor, envelope)!
    expect(live).not.toContain('&nbsp;')
    expect(live).toContain('# 标题')
    expect(live).toContain('| a   | b   |')
  })

  it('does not write it into the file when an agent edits the document', () => {
    const { envelope, editor, blocks } = opened()
    const result = applyTextEdit(
      editor,
      envelope,
      { kind: 'replace-span', expectedText: '标题', text: '新标题' },
      blocks.length,
    )
    expect(result.ok).toBe(true)
    expect(result.text).not.toContain('&nbsp;')
    expect(result.text).toContain('# 新标题')
  })

  it('saves the first paragraph of an empty file', () => {
    const envelope = parseDocText('')
    const editor = open('')
    const bridge = bridgeOf(editor)!
    expect(editor.state.doc.childCount).toBe(0)
    const table = buildBlockTable('', bridge)
    const tr = editor.state.tr.insertText('第一段。', 0)
    editor.view.dispatch(tr)

    const saved = saveBlocks(editor, table, tr, (md) => md)!
    expect(saved.text).toBe('第一段。')
  })
})

/**
 * What people do all day, against the real engine.
 *
 * Each of these changes how many blocks the file has, which the save path used to refuse or mis-handle. Measured
 * before `planSaveByDiff`: Enter wrote half the paragraph and dropped the other half from the file, and joining two
 * paragraphs wrote the merged text into the first row and left the second row's bytes alone, so the text appeared
 * twice.
 */
describe('editing that changes the block count', () => {
  const file = '# 标题\n\n甲段。\n\n乙段。\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'

  /** The document position where top-level block `index` starts. */
  function blockStart(editor: { state: { doc: { forEach(cb: (node: unknown, offset: number, index: number) => void): void } } }, index: number): number {
    let position = 0
    editor.state.doc.forEach((_node, offset, i) => {
      if (i === index) position = offset
    })
    return position
  }

  function opened() {
    const envelope = parseDocText(file)
    const editor = open('')
    const bridge = bridgeOf(editor)!
    const blocks = blockTexts(layoutMarkdown(envelope.body))
    editor.commands.setContent(blocksToDocument(bridge, blocks) as never, { emitUpdate: false } as never)
    return { envelope, editor, bridge, table: buildBlockTable(envelope.body, bridge) }
  }

  it('saves both halves of a paragraph split by Enter', () => {
    const { envelope, editor, table } = opened()
    // Just inside 甲段。 (one character in), which is where a caret sits when Enter is pressed.
    const tr = editor.state.tr.split(blockStart(editor, 1) + 2)
    editor.view.dispatch(tr)

    const saved = saveBlocks(editor, table, tr, (md) => md)!
    expect(saved.changed).toBe(true)
    expect(serializeDocText(envelope, saved.text)).toBe(file.replace('甲段。', '甲\n\n段。'))
    // The table after the change keeps the file's own bytes, not the serializer's padding.
    expect(saved.text).toContain('| a | b |')
  })

  it('saves a merge, without leaving the swallowed paragraph behind', () => {
    const { envelope, editor, table } = opened()
    const tr = editor.state.tr.join(blockStart(editor, 2))
    editor.view.dispatch(tr)

    const saved = saveBlocks(editor, table, tr, (md) => md)!
    expect(serializeDocText(envelope, saved.text)).toBe(file.replace('甲段。\n\n乙段。', '甲段。乙段。'))
  })

  it('saves a paste that brings its own blank line', () => {
    const { envelope, editor, table } = opened()
    const pos = blockStart(editor, 1) + 2
    const tr = editor.state.tr.insertText('一\n\n二', pos, pos)
    editor.view.dispatch(tr)

    const saved = saveBlocks(editor, table, tr, (md) => md)!
    expect(serializeDocText(envelope, saved.text)).toBe(file.replace('甲段。', '甲一\n\n二段。'))
  })

  it('re-aligns the block table afterwards, so the next keystroke is the cheap path again', () => {
    const { envelope, editor, table } = opened()
    const tr = editor.state.tr.split(blockStart(editor, 1) + 2)
    editor.view.dispatch(tr)
    const saved = saveBlocks(editor, table, tr, (md) => md)!

    // The file now has one block more than the table it was saved against…
    expect(saved.table.rows.length).toBe(table.rows.length + 1)
    // …and typing in one of its blocks is again a per-block save.
    const next = editor.state.tr.insertText('改', blockStart(editor, 1) + 1)
    editor.view.dispatch(next)
    const again = saveBlocks(editor, saved.table, next, (md) => md)!
    expect(again.plan.written).toEqual([1])
    expect(serializeDocText(envelope, again.text)).toBe(file.replace('甲段。', '甲\n\n段。').replace('甲', '改甲'))
  })

  it('writes an edit to a block the engine could not carry — that is the person’s text now', () => {
    const raw = '# 标题\n\n<div style="color:red">红色的一段</div>\n'
    const envelope = parseDocText(raw)
    const editor = open('')
    const bridge = bridgeOf(editor)!
    const blocks = blockTexts(layoutMarkdown(envelope.body))
    editor.commands.setContent(blocksToDocument(bridge, blocks) as never, { emitUpdate: false } as never)
    const table = buildBlockTable(envelope.body, bridge)

    const tr = editor.state.tr.insertText('改', blockStart(editor, 1) + 6)
    editor.view.dispatch(tr)
    const saved = saveBlocks(editor, table, tr, (md) => md)!
    expect(saved.changed).toBe(true)
    expect(serializeDocText(envelope, saved.text)).toContain('红色的一段')
    expect(serializeDocText(envelope, saved.text)).not.toBe(raw)
  })
})

/**
 * The editor is allowed to have written past the end of the file.
 *
 * A person who is still typing when the agent writes is exactly the case this editor exists for, and "they started a
 * paragraph below the last block" is not a reason to reload the document under them. The span a landing replaces
 * lives inside the file's blocks, so what is past them is none of its business — as long as the blocks at the edges
 * of the span still say what the file says.
 */
describe('landing while the person has written past the end', () => {
  const file = '# 标题\n\n甲段。\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'

  function opened() {
    const envelope = parseDocText(file)
    const editor = open('')
    const bridge = bridgeOf(editor)!
    const blocks = blockTexts(layoutMarkdown(envelope.body))
    editor.commands.setContent(blocksToDocument(bridge, blocks) as never, { emitUpdate: false } as never)
    return { envelope, editor, bridge, blocks }
  }

  it('lands the agent’s block and leaves the new paragraph below it alone', () => {
    const { envelope, editor } = opened()
    // A paragraph the person has typed below the table and not saved yet.
    editor.view.dispatch(editor.state.tr.insertText('我还在写。', editor.state.doc.content.size - 1))

    const landed = landMarkdown(editor, envelope.body.replace('# 标题', '# 新标题'), { current: envelope.body })
    expect(landed.applied).toBe(true)
    expect(editor.state.doc.child(0).textContent).toBe('新标题')
    expect(editor.state.doc.textContent).toContain('我还在写。')
    // And the file those two would save together is the agent's heading plus the person's paragraph.
    expect(liveTextOf(editor, envelope)).toContain('我还在写。')
  })

  it('still refuses when a block was inserted in the middle, where the span would move', () => {
    const { envelope, editor } = opened()
    // The person split 甲段。 in two, and the agent changed the table below it.
    let start = 0
    editor.state.doc.forEach((node, offset, index) => {
      if (index === 1) start = offset
    })
    editor.view.dispatch(editor.state.tr.split(start + 2))

    const landed = landMarkdown(editor, envelope.body.replace('| 1 | 2 |', '| 1 | 3 |'), { current: envelope.body })
    expect(landed.applied).toBe(false)
    expect(landed.reason).toContain('blocks where the file has')
  })
})

/**
 * A blank line is not a block.
 *
 * Pressing Enter on an empty paragraph puts a node in the document that the file has no words for — a blank line,
 * which between two blocks is a gap, not content. Counting it as a block made the document diverge from the file by
 * one node, so every save after that took the structural path (serialise every block, diff the region) instead of
 * asking about the block that was typed in.
 *
 * Same fact as the trailing paragraph (`appendixIndex`), one level more general: the one at the end is just the most
 * common one.
 */
describe('a blank line in the middle of a document', () => {
  const file = '# 标题\n\n甲段。\n\n乙段。\n'

  function opened() {
    const envelope = parseDocText(file)
    const editor = open('')
    const bridge = bridgeOf(editor)!
    const blocks = blockTexts(layoutMarkdown(envelope.body))
    editor.commands.setContent(blocksToDocument(bridge, blocks) as never, { emitUpdate: false } as never)
    return { envelope, editor, bridge, table: buildBlockTable(envelope.body, bridge) }
  }

  /** Press Enter at the end of the first paragraph, which leaves an empty paragraph behind it. */
  function enterAfterFirst(editor: { state: { doc: { forEach(cb: (node: unknown, offset: number, index: number) => void): void } } }): number {
    let at = 0
    editor.state.doc.forEach((node, offset, index) => {
      if (index === 1) at = offset + (node as { nodeSize: number }).nodeSize - 1
    })
    return at
  }

  it('costs nothing to save, and the file does not grow a blank line', () => {
    const { envelope, editor, table } = opened()
    const tr = editor.state.tr.split(enterAfterFirst(editor))
    editor.view.dispatch(tr)
    expect(editor.state.doc.childCount).toBe(table.rows.length + 1)

    const saved = saveBlocks(editor, table, tr, (md) => md)!
    expect(serializeDocText(envelope, saved.text)).toBe(file)
    expect(saved.changed).toBe(false)
  })

  it('is not in the text the agent reads either — no `&nbsp;` for a blank line', () => {
    const { envelope, editor } = opened()
    editor.view.dispatch(editor.state.tr.split(enterAfterFirst(editor)))
    const live = liveTextOf(editor, envelope)!
    expect(live).not.toContain('&nbsp;')
    expect(live).toContain('甲段。')
    expect(live).toContain('乙段。')
  })

  it('leaves the next keystroke on the per-block path, not the structural one', () => {
    const { editor, table } = opened()
    const enter = editor.state.tr.split(enterAfterFirst(editor))
    editor.view.dispatch(enter)
    const afterBlank = saveBlocks(editor, table, enter, (md) => md)!

    // Type in the second paragraph, with the blank still in the document.
    let at = -1
    editor.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text === '乙段。') at = pos + 2
    })
    const tr = editor.state.tr.insertText('改', at)
    editor.view.dispatch(tr)
    const saved = saveBlocks(editor, afterBlank.table, tr, (md) => md)!

    // The per-block plan has no `region`; a structural save does. This is the difference the blank line used to force.
    expect('region' in saved.plan).toBe(false)
    expect(saved.plan.written).toEqual([2])
    expect(saved.text).toContain('乙段改。')
  })
})
