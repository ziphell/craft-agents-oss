import { describe, expect, it } from 'bun:test'
import {
  buildBlockTable,
  planLandingFromTable,
  planSaveByDiff,
  planSaveFromTable,
  retable,
  touchedBlocks,
  type BlockBridge,
} from '../block-table'
import { spliceBlocks } from '../markdown-blocks'

/**
 * A stand-in for the editor's markdown bridge that misbehaves exactly the way the real one does: it pads a table
 * (`| a |` → `| a   |`), and it refuses to read frontmatter as one block.
 */
const bridge: BlockBridge = {
  parse(markdown) {
    if (markdown.startsWith('---')) return { content: [{ type: 'thematicBreak' }, { type: 'heading' }] }
    if (markdown.startsWith('|')) return { content: [{ type: 'table', padding: true }] }
    if (markdown.startsWith('```')) return { content: [{ type: 'codeBlock' }] }
    if (markdown.startsWith('#')) return { content: [{ type: 'heading' }] }
    return { content: [{ type: 'paragraph' }] }
  },
  serialize(json) {
    const node = (json as { content: Array<{ type: string; padding?: boolean }> }).content[0]!
    if (node.type === 'table') return '| a   | b   |\n| --- | --- |\n| 1   | 2   |'
    if (node.type === 'codeBlock') return '```ts\nconst x = 1\n```'
    if (node.type === 'heading') return '# 标题'
    if (node.type === 'thematicBreak') return '---'
    return ''
  },
}

const source = `---
title: 笔记
---

# 标题

| a | b |
| --- | --- |
| 1 | 2 |

\`\`\`ts
const x = 1
\`\`\`
`

describe('block table', () => {
  const table = buildBlockTable(source, bridge)

  it('keeps every block, and the file text it came from', () => {
    expect(table.rows.map((row) => row.text)).toEqual([
      '---\ntitle: 笔记\n---',
      '# 标题',
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
      '```ts\nconst x = 1\n```',
    ])
    expect(table.source).toBe(source)
  })

  it('marks a block that is not exactly one node as not live', () => {
    expect(table.rows[0]!.baseline).toBeNull() // frontmatter parses to two nodes
    expect(table.rows[1]!.baseline).toBe('# 标题') // …and a heading is serialized differently, but it is live
  })

  it('lands an outside write by comparing file bytes, so an untouched table is not a change', () => {
    const edited = source.replace('# 标题', '# 新标题')
    const plan = planLandingFromTable(table, edited)
    expect(plan.idle).toBe(false)
    expect(plan.blocks).toEqual(['# 新标题'])
    expect(plan.prefix).toBe(1)
    expect(plan.suffix).toBe(2)
  })

  it('is idle when the file says what the table says, table padding and all', () => {
    expect(planLandingFromTable(table, source).idle).toBe(true)
  })
})

describe('save from a table', () => {
  const table = buildBlockTable(source, bridge)
  const untouched = table.rows.map((row) => row.baseline)

  it('writes nothing when nothing was edited — the table keeps the file’s own alignment', () => {
    const plan = planSaveFromTable(table, untouched, (block) => [block])
    expect(plan.changed).toBe(false)
    expect(plan.text).toBe(source)
  })

  it('writes only the edited block, and keeps the others byte for byte', () => {
    const edited = [...untouched]
    edited[1] = '# 改过的标题'
    const plan = planSaveFromTable(table, edited, (block) => [block])
    expect(plan.written).toEqual([1])
    expect(plan.text).toBe(source.replace('# 标题', '# 改过的标题'))
    expect(plan.text).toContain('| a | b |') // still the file's alignment, not the serializer's
  })

  it('leaves a block that is not live alone, and writes it once the person edits it', () => {
    // Row 0 is frontmatter: two nodes for one block, so the engine is not trusted to give its bytes back.
    const untouchedPlan = planSaveFromTable(table, untouched, (block) => [block])
    expect(untouchedPlan.changed).toBe(false)

    const edited = [...untouched]
    edited[0] = '---\ntitle: 改过的\n---'
    const plan = planSaveFromTable(table, edited, (block) => [block])
    expect(plan.written).toEqual([0])
    expect(plan.text).toBe(source.replace('title: 笔记', 'title: 改过的'))
  })

  it('lets one block become several — Enter is not an error', () => {
    const edited = [...untouched]
    edited[1] = '甲\n\n乙'
    const plan = planSaveFromTable(table, edited, (block) => block.split('\n\n'))
    expect(plan.refused).toEqual([])
    expect(plan.written).toEqual([1])
    expect(plan.text).toBe(source.replace('# 标题', '甲\n\n乙'))
  })

  it('refuses only text the parser throws on', () => {
    const edited = [...untouched]
    edited[1] = '# 坏的'
    const plan = planSaveFromTable(table, edited, () => {
      throw new Error('nope')
    })
    expect(plan.refused[0]?.reason).toContain('did not parse')
    expect(plan.text).toBe(source)
  })
})

describe('which blocks an edit touched', () => {
  // Three blocks of nodeSize 5, 10, 5 → [0,5) [5,15) [15,20).
  const nodes = [{ nodeSize: 5 }, { nodeSize: 10 }, { nodeSize: 5 }]

  it('names the block an insertion landed in', () => {
    expect(touchedBlocks(nodes, [{ from: 8, to: 8 }])).toEqual([1])
    expect(touchedBlocks(nodes, [{ from: 2, to: 2 }])).toEqual([0])
  })

  it('names both sides of a replacement that spans a boundary', () => {
    expect(touchedBlocks(nodes, [{ from: 3, to: 7 }])).toEqual([0, 1])
  })

  it('keeps a deletion that ends on a boundary with the block it came from', () => {
    expect(touchedBlocks(nodes, [{ from: 12, to: 15 }])).toEqual([1])
  })

  it('touches nothing when the selection moved and no text did', () => {
    expect(touchedBlocks(nodes, [])).toEqual([])
    expect(touchedBlocks(nodes, [{ from: 7, to: 7 }])).not.toContain(2)
  })
})

describe('retable after a save', () => {
  const table = buildBlockTable(source, bridge)
  const after = source.replace('# 标题', '# 新标题')

  it('moves the offsets and keeps every row', () => {
    const next = retable(table, after, null)!
    expect(next.rows.length).toBe(table.rows.length)
    expect(next.rows[1]!.text).toBe('# 新标题')
    expect(next.rows[3]!.text).toBe('```ts\nconst x = 1\n```')
  })

  it('takes the new baseline for a block that was written, so the next save leaves it alone', () => {
    const written = [null, '## 新标题', null, null]
    const next = retable(table, after, written)!
    expect(next.rows[1]!.baseline).toBe('## 新标题')
    // …and the block is now untouched: nothing to write.
    const plan = planSaveFromTable(next, next.rows.map((row) => row.baseline), (block) => [block])
    expect(plan.changed).toBe(false)
    expect(plan.text).toBe(after)
  })

  it('refuses when the block count moved, rather than re-index itself', () => {
    expect(retable(table, '# 只有一块\n')).toBeNull()
  })
})

describe('a block the engine cannot represent', () => {
  /**
   * The measured case: the official markdown engine reads raw HTML as a paragraph, and that paragraph serializes to
   * `""`. If such a block were "live", the first save would replace the person's markup — and the text inside it —
   * with an empty line. It is not live: its bytes stay, and it is left out of the block count.
   */
  const swallowing: BlockBridge = {
    parse: (md) => ({ content: [{ type: 'html' in {} ? 'x' : 'paragraph' }] }),
    serialize: () => '',
  }
  const source = '# 标题\n\n<div style="color:red">红色的一段</div>\n\n正文。\n'

  it('is not live, so nothing writes it', () => {
    const table = buildBlockTable(source, swallowing)
    expect(table.rows[1]!.baseline).toBeNull()
  })

  it('keeps its bytes when an unrelated block is saved', () => {
    const table = buildBlockTable(source, swallowing)
    const plan = planSaveFromTable(table, [null, null, null], (block) => [block])
    expect(plan.changed).toBe(false)
    expect(plan.text).toBe(source)
  })

  it('does not treat an honestly empty block as one the engine ate', () => {
    const empty = buildBlockTable('a\n\n<div></div>\n', swallowing)
    // `<div></div>` has source text, so it is still not live — but a truly empty file is not a case at all.
    expect(buildBlockTable('\n\n', swallowing).rows.length).toBe(0)
    expect(empty.rows.length).toBe(2)
  })
})

describe('save when the block count changed', () => {
  /*
   * A bridge that says back what it was given, so a block's baseline is its own text. (The fake above is deliberately
   * worse than the real engine: it serializes every paragraph to `''`, which makes its rows "not live".)
   */
  const echo: BlockBridge = {
    parse(markdown) {
      if (markdown.startsWith('|')) return { content: [{ type: 'table' }] }
      if (markdown.startsWith('#')) return { content: [{ type: 'heading', text: markdown }] }
      return { content: [{ type: 'paragraph', text: markdown }] }
    },
    serialize(json) {
      const node = (json as { content: Array<{ type: string; text?: string }> }).content[0]!
      if (node.type === 'table') return '| a   | b   |\n| --- | --- |\n| 1   | 2   |'
      return node.text ?? ''
    },
  }

  const body = '# 标题\n\n甲\n\n乙\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'
  const table = buildBlockTable(body, echo)
  const rows = table.rows.map((row) => row.baseline ?? row.text)

  it('is idle when the document still says what the file says', () => {
    const plan = planSaveByDiff(table, rows, (block) => [block])
    expect(plan.changed).toBe(false)
    expect(plan.text).toBe(body)
  })

  it('writes both halves of a split, and keeps the table’s own bytes', () => {
    // 甲 became 甲 | 一.
    const plan = planSaveByDiff(table, [rows[0]!, '甲', '一', rows[2]!, rows[3]!], (block) => [block])
    expect(plan.changed).toBe(true)
    expect(plan.text).toBe(body.replace('甲\n', '甲\n\n一\n'))
    expect(plan.text).toContain('| a | b |') // the file's own alignment, not the serializer's padding
  })

  it('writes a merge once, without leaving the swallowed block behind', () => {
    // 甲 and 乙 became one paragraph.
    const plan = planSaveByDiff(table, [rows[0]!, '甲乙', rows[3]!], (block) => [block])
    expect(plan.written).toEqual([1, 2])
    expect(plan.text).toBe(body.replace('甲\n\n乙\n', '甲乙\n'))
  })

  it('appends when the document says more than the file did — nothing was replaced', () => {
    const plan = planSaveByDiff(table, [...rows, '新的一段。'], (block) => [block])
    expect(plan.written).toEqual([4])
    expect(plan.text).toBe(`${body}\n新的一段。\n`)
  })

  it('drops a block the person emptied', () => {
    const plan = planSaveByDiff(table, [rows[0]!, rows[1]!, rows[3]!], (block) => [block])
    expect(plan.text).not.toContain('乙')
    // The gap the block sat in stays with the file, so what is left is one blank line more than a tidy writer would
    // leave — the same as the per-row path does today.
    expect(plan.text).toContain('甲\n\n\n\n| a | b |')
  })
})

/**
 * The shortcut that keeps a keystroke cheap: the table after a save is the old one shifted, not a fresh read.
 *
 * `layoutMarkdown` on a 128-block document measured ~29 ms, and it ran on every keystroke to answer a question whose
 * answer is arithmetic. The claim the shortcut makes is exactly "same table as reading the file again", so that is
 * what these assert — and the two refusals where reading again is the only honest answer.
 */
describe('retable without reading the file again', () => {
  const body = '# 标题\n\n甲\n\n乙\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'
  // The offsets and the bytes are what the shortcut computes; the bridge only decides what a baseline says.
  const table = buildBlockTable(body, bridge)

  /** Replace `row` with `text`, as a save does: the file, and the row's own new bytes. */
  function written(row: number, text: string): { text: string; current: Array<string | null>; written: number[] } {
    const current: Array<string | null> = table.rows.map(() => null)
    current[row] = text
    return { text: spliceBlocks(table.layout, new Map([[row, text]])), current, written: [row] }
  }

  /** What the table has to look like: anything layoutMarkdown would say about the new text. */
  function fresh(text: string) {
    return buildBlockTable(text, bridge)
  }

  it('matches a fresh read after one block was rewritten', () => {
    const edit = written(1, '甲，改过，而且更长一些。')
    const shifted = retable(table, edit.text, edit.current, edit.written)!
    const reread = fresh(edit.text)
    expect(shifted.rows.map((row) => ({ from: row.from, to: row.to, source: row.source, text: row.text })))
      .toEqual(reread.rows.map((row) => ({ from: row.from, to: row.to, source: row.source, text: row.text })))
    expect(shifted.layout.chunks).toEqual(reread.layout.chunks)
  })

  it('matches a fresh read after two blocks were rewritten', () => {
    const current: Array<string | null> = table.rows.map(() => null)
    current[1] = '甲'
    current[2] = '乙，也长了。'
    const text = spliceBlocks(table.layout, new Map([[1, '甲'], [2, '乙，也长了。']]))
    const shifted = retable(table, text, current, [1, 2])!
    const reread = fresh(text)
    expect(shifted.rows.map((row) => row.text)).toEqual(reread.rows.map((row) => row.text))
    expect(shifted.layout.chunks).toEqual(reread.layout.chunks)
    // The untouched blocks kept their bytes; the table below them moved by exactly the difference above it.
    const delta = '乙，也长了。'.length - '乙'.length
    expect(shifted.rows[3]!.from).toBe(table.rows[3]!.from + delta)
  })

  it('matches a fresh read after the table itself was rewritten', () => {
    const edit = written(3, '| a | b |\n| --- | --- |\n| 1 | 3 |')
    const shifted = retable(table, edit.text, edit.current, edit.written)!
    expect(shifted.layout.chunks).toEqual(fresh(edit.text).layout.chunks)
  })

  it('reads the file again when the bytes do not add up to the claim', () => {
    // A row "written" with text that is not in the new source: the shortcut cannot be trusted, so it is not used.
    const shifted = retable(table, body, ['完全不对', null, null, null], [0])!
    expect(shifted.rows.map((row) => row.text)).toEqual(fresh(body).rows.map((row) => row.text))
  })

  it('refuses a row the edit emptied — that is a block disappearing, not an offset moving', () => {
    const text = spliceBlocks(table.layout, new Map([[1, '']]))
    expect(retable(table, text, ['', null, null, null], [1])).toBeNull()
  })

  it('refuses a block whose new text has surrounding whitespace', () => {
    const text = spliceBlocks(table.layout, new Map([[1, '  甲  ']]))
    // Falls back to a real layout, which trims — the row still says `甲`, not `  甲  `.
    const next = retable(table, text, ['  甲  ', null, null, null], [1])!
    expect(next.rows[1]!.text).toBe('甲')
  })
})
