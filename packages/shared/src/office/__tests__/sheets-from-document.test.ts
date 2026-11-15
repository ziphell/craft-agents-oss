import { describe, expect, it } from 'bun:test'
import {
  cellValue,
  gridFromTable,
  plainInline,
  sheetName,
  splitTableRow,
  tablesFromHtml,
  tablesFromMarkdown,
  workbookFromDocument,
} from '../sheets-from-document'

describe('cellValue', () => {
  it('takes a number only when it is unambiguous', () => {
    expect(cellValue('42')).toBe(42)
    expect(cellValue('-3.5')).toBe(-3.5)
    expect(cellValue('0')).toBe(0)
  })

  it('leaves everything a locale could change as text', () => {
    expect(cellValue('1,200')).toBe('1,200')
    expect(cellValue('12%')).toBe('12%')
    expect(cellValue('2026-10-30')).toBe('2026-10-30')
    expect(cellValue('¥120')).toBe('¥120')
    expect(cellValue('1e5')).toBe('1e5')
  })

  it('turns an empty cell into null, not into an empty string', () => {
    expect(cellValue('   ')).toBeNull()
  })
})

describe('plainInline', () => {
  it('strips the markers a reader reads through', () => {
    expect(plainInline('**bold** and *it* and `code`')).toBe('bold and it and code')
    expect(plainInline('see [the doc](https://x.y)')).toBe('see the doc')
    expect(plainInline('![chart](a.png)')).toBe('chart')
  })
})

describe('splitTableRow', () => {
  it('honours an escaped pipe and ignores the outer ones', () => {
    expect(splitTableRow('| a | b \\| c | d |')).toEqual(['a', 'b | c', 'd'])
  })
})

describe('sheetName', () => {
  it('falls back to a numbered name', () => {
    expect(sheetName(null, 3, new Set())).toBe('Sheet3')
  })

  it('strips what Excel refuses and truncates to 31', () => {
    const name = sheetName('a/b:c*d?e[f]g\\h ' + 'x'.repeat(40), 1, new Set())
    expect(name).not.toMatch(/[[\]:*?/\\]/)
    expect(name.length).toBeLessThanOrEqual(31)
  })

  it('never lets two tables share a name', () => {
    const taken = new Set<string>()
    expect(sheetName('汇总', 1, taken)).toBe('汇总')
    expect(sheetName('汇总', 2, taken)).toBe('汇总 (2)')
    expect(sheetName('hUIZONG', 3, taken)).toBe('hUIZONG')
  })
})

describe('tablesFromMarkdown', () => {
  const doc = [
    '# 季度报告',
    '',
    '正文。',
    '',
    '| 月份 | 收入 |',
    '| --- | ---: |',
    '| 7月 | 120 |',
    '| 8月 | 150 |',
    '',
    '## 人员',
    '',
    '| 姓名 | 角色 |',
    '| --- | --- |',
    '| 张三 | **负责人** |',
  ].join('\n')

  it('takes every table, naming each after the heading above it', () => {
    const tables = tablesFromMarkdown(doc)
    expect(tables.map((table) => table.sheetName)).toEqual(['季度报告', '人员'])
    expect(tables[0]!.rows[0]).toEqual(['月份', '收入'])
    expect(tables[0]!.rows[1]).toEqual(['7月', 120])
    expect(tables[1]!.rows[1]).toEqual(['张三', '负责人'])
  })

  it('ignores a table inside a fence — that is an example of one', () => {
    const fenced = ['# 说明', '', '```md', '| a | b |', '| --- | --- |', '| 1 | 2 |', '```'].join('\n')
    expect(tablesFromMarkdown(fenced)).toEqual([])
  })

  it('finds nothing in a document with no tables', () => {
    expect(tablesFromMarkdown('# 标题\n\n只是正文。')).toEqual([])
  })

  it('drops an all-empty row and an all-empty column', () => {
    const padded = ['| a |  | b |', '| --- | --- | --- |', '| 1 |  | 2 |', '|  |  |  |'].join('\n')
    const table = tablesFromMarkdown(padded)[0]!
    expect(table.rows).toEqual([
      ['a', 'b'],
      [1, 2],
    ])
  })
})

describe('tablesFromHtml', () => {
  it('fills a colspan across the columns it covers', () => {
    const html = '<table><tr><td colspan="3">合计</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>'
    const table = tablesFromHtml(html)[0]!
    expect(table.rows[0]).toEqual(['合计', '合计', '合计'])
    expect(table.rows[1]).toEqual([1, 2, 3])
  })

  it('carries a rowspan down the rows it covers', () => {
    const html = [
      '<table>',
      '<tr><td rowspan="2">华北</td><td>一月</td><td>10</td></tr>',
      '<tr><td>二月</td><td>20</td></tr>',
      '</table>',
    ].join('')
    const table = tablesFromHtml(html)[0]!
    expect(table.rows).toEqual([
      ['华北', '一月', 10],
      ['华北', '二月', 20],
    ])
  })

  it('names the sheet by caption before heading, and by heading before a number', () => {
    const html = [
      '<h2>人员</h2>',
      '<table><caption>花名册</caption><tr><td>a</td></tr></table>',
      '<table><tr><td>b</td></tr></table>',
    ].join('')
    const tables = tablesFromHtml(html)
    expect(tables.map((table) => table.sheetName)).toEqual(['花名册', '人员'])
  })

  it('takes the outer table only, and says what it left behind', () => {
    const html = '<table><tr><td>outer<table><tr><td>inner</td></tr></table></td></tr></table>'
    const tables = tablesFromHtml(html)
    expect(tables).toHaveLength(1)
    expect(tables[0]!.rows[0]![0]).toBe('outerinner')
    expect(tables[0]!.note).toContain('nested')
  })
})

describe('workbookFromDocument', () => {
  it('produces the shape the engine reads', () => {
    const spec = workbookFromDocument('| a | b |\n| --- | --- |\n| 1 | 2 |', 'md')!
    // `headerRow` is what becomes a frozen header + AutoFilter, and a GFM table always has one.
    expect(spec).toEqual({ sheets: [{ name: 'Sheet1', rows: [['a', 'b'], [1, 2]], headerRow: true }] })
  })

  it('answers null when the document has no tables', () => {
    expect(workbookFromDocument('# 没有表', 'md')).toBeNull()
    expect(workbookFromDocument('<p>没有表</p>', 'html')).toBeNull()
  })
})

describe('gridFromTable', () => {
  it('is reachable on its own, for a caller that already has a table node', () => {
    const { document } = require('linkedom').parseHTML('<table><tr><td>1</td></tr></table>')
    expect(gridFromTable(document.querySelector('table'))).toEqual([[1]])
  })
})
