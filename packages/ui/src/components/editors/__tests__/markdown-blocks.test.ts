import { describe, expect, it } from 'bun:test'
import {
  blockTexts,
  commonAffixes,
  insertBlocks,
  landingTarget,
  layoutMarkdown,
  planLanding,
  spliceBlocks,
  spliceRange,
} from '../markdown-blocks'

const doc = [
  '---',
  'title: 笔记',
  '---',
  '',
  '# 标题',
  '',
  '第一段，带 `code` 与 **粗体**。',
  '',
  '- a',
  '- b',
  '',
  '| 甲 | 乙 |',
  '| -- | -- |',
  '| 1  | 2  |',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  '<details><summary>藏起来</summary>正文</details>',
  '',
].join('\n')

describe('block layout', () => {
  it('chunks tile the file exactly', () => {
    const layout = layoutMarkdown(doc)
    expect(layout.problem).toBeUndefined()
    expect(layout.chunks.map((c) => c.text).join('')).toBe(doc)
  })

  it('finds the top-level blocks, frontmatter included', () => {
    const blocks = blockTexts(layoutMarkdown(doc))
    expect(blocks[0]).toBe('---\ntitle: 笔记\n---')
    expect(blocks[1]).toBe('# 标题')
    expect(blocks[2]).toContain('第一段')
    // a list is one block, a table one, a fence one, raw HTML one
    expect(blocks.some((b) => b.startsWith('- a\n- b'))).toBe(true)
    expect(blocks.some((b) => b.startsWith('| 甲 |'))).toBe(true)
    expect(blocks.some((b) => b.startsWith('```ts'))).toBe(true)
    expect(blocks.some((b) => b.startsWith('<details>'))).toBe(true)
  })

  it('replaces one block and leaves every other byte alone', () => {
    const layout = layoutMarkdown(doc)
    const blocks = blockTexts(layout)
    const heading = blocks.indexOf('# 标题')
    const out = spliceBlocks(layout, new Map([[heading, '## 新标题']]))
    expect(out).toBe(doc.replace('# 标题', '## 新标题'))
    // everything outside the replaced block is identical, character for character
    expect(out.length).toBe(doc.length + ('## 新标题'.length - '# 标题'.length))
  })

  it('collapses a run of blocks into one', () => {
    const source = 'a\n\nb\n\nc\n'
    const layout = layoutMarkdown(source)
    expect(blockTexts(layout)).toEqual(['a', 'b', 'c'])
    expect(spliceRange(layout, 0, 2, 'x')).toBe('x\n\nc\n')
  })

  it('keeps CRLF and trailing newlines as they were', () => {
    const crlf = 'a\r\n\r\nb\r\n'
    const layout = layoutMarkdown(crlf)
    const out = spliceBlocks(layout, new Map([[1, 'B']]))
    expect(out).toBe('a\r\n\r\nB\r\n')
  })

  it('falls back to one text when the parser has nothing to give', () => {
    const layout = layoutMarkdown('')
    expect(layout.chunks.length).toBe(1)
    expect(blockTexts(layout)).toEqual([])
    expect(spliceBlocks(layout, new Map())).toBe('')
  })
})

describe('common affixes', () => {
  it('keeps both ends', () => {
    expect(commonAffixes(['a', 'b', 'c', 'd'], ['a', 'b', 'X', 'd'])).toEqual({ prefix: 2, suffix: 1 })
  })
  it('never counts a block twice', () => {
    expect(commonAffixes(['a', 'b'], ['a', 'b'])).toEqual({ prefix: 2, suffix: 0 })
    expect(commonAffixes(['a'], ['a', 'a'])).toEqual({ prefix: 1, suffix: 0 })
  })
})

describe('landing plan', () => {
  const before = ['# 标题', 'a', 'b', 'c']

  it('is idle when the file says what the document says', () => {
    const plan = planLanding(before, '# 标题\n\na\n\nb\n\nc\n')
    expect(plan.idle).toBe(true)
    expect(plan.blocks).toEqual([])
  })

  it('replaces only the block that changed', () => {
    const plan = planLanding(before, '# 标题\n\na\n\nB!\n\nc\n')
    expect(plan).toMatchObject({ prefix: 2, suffix: 1, idle: false })
    expect(plan.blocks).toEqual(['B!'])
  })

  it('keeps a common suffix, so an edit near the top costs one block', () => {
    const plan = planLanding(before, '# 新标题\n\na\n\nb\n\nc\n')
    expect(plan).toMatchObject({ prefix: 0, suffix: 3 })
    expect(plan.blocks).toEqual(['# 新标题'])
  })

  it('appends and deletes without touching the rest', () => {
    expect(planLanding(before, '# 标题\n\na\n\nb\n\nc\n\nd\n')).toMatchObject({ prefix: 4, suffix: 0 })
    expect(planLanding(before, '# 标题\n\na\n\nc\n')).toMatchObject({ prefix: 2, suffix: 1 })
  })
})

describe('landing target', () => {
  // Three blocks, sizes as ProseMirror counts them (the node's own start + content + end).
  const sizes = [6, 4, 8]

  it('points at the span between the two ends', () => {
    expect(landingTarget(sizes, 1, 1)).toEqual({ from: 6, to: 10 })
  })
  it('handles the edges', () => {
    expect(landingTarget(sizes, 0, 0)).toEqual({ from: 0, to: 18 })
    expect(landingTarget(sizes, 3, 0)).toEqual({ from: 18, to: 18 })
    expect(landingTarget(sizes, 0, 3)).toEqual({ from: 0, to: 0 })
  })
  it('refuses a span that does not exist', () => {
    expect(landingTarget(sizes, 2, 2)).toBeNull()
    expect(landingTarget(sizes, -1, 0)).toBeNull()
  })
})

describe('inserting a block', () => {
  const source = '# 标题\n\n甲\n\n乙\n'

  it('puts the new text between the blocks around it', () => {
    const layout = layoutMarkdown(source)
    expect(insertBlocks(layout, 2, '新')).toBe('# 标题\n\n甲\n\n新\n\n乙\n')
  })

  it('adds at the front when the block index is zero', () => {
    const layout = layoutMarkdown(source)
    expect(insertBlocks(layout, 0, '新')).toBe('新\n\n# 标题\n\n甲\n\n乙\n')
  })

  it('appends after the last block when the index is past the end', () => {
    const layout = layoutMarkdown(source)
    expect(insertBlocks(layout, 3, '新')).toBe('# 标题\n\n甲\n\n乙\n\n新\n')
  })
})
