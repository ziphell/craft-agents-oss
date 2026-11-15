import { describe, expect, it } from 'bun:test'
import { canExportTo, defaultExportName, exportTargetsFor, extensionOf } from '../creation-export'

describe('exportTargetsFor', () => {
  it('offers pdf and Word from a document that is prose', () => {
    // `html` is the one-file copy: the page as it is *sent*, with its assets inlined.
    expect(exportTargetsFor('C:\\a\\report.md')).toEqual(['pdf', 'docx', 'html'])
    expect(exportTargetsFor('/a/page.html')).toEqual(['pdf', 'docx', 'html'])
  })

  it('offers pdf and markdown from a Word file', () => {
    expect(exportTargetsFor('/a/report.docx')).toEqual(['pdf', 'md'])
  })

  it('offers only pdf from a workbook or a deck', () => {
    expect(exportTargetsFor('/a/book.xlsx')).toEqual(['pdf'])
    expect(exportTargetsFor('/a/deck.pptx')).toEqual(['pdf'])
  })

  it('offers nothing from a pdf: it is where documents go, not where they come from', () => {
    expect(exportTargetsFor('/a/report.pdf')).toEqual([])
    expect(exportTargetsFor('/a/diagram.drawio')).toEqual([])
  })

  it('is case-insensitive about the extension', () => {
    expect(exportTargetsFor('/a/REPORT.MD')).toEqual(['pdf', 'docx', 'html'])
  })
})

describe('canExportTo', () => {
  it('accepts a pair the table has and refuses one it does not', () => {
    expect(canExportTo('/a/report.md', 'docx')).toBe(true)
    expect(canExportTo('/a/report.md', 'md')).toBe(false)
    expect(canExportTo('/a/report.pdf', 'pdf')).toBe(false)
  })
})

describe('defaultExportName', () => {
  it('keeps the name and swaps the extension', () => {
    expect(defaultExportName('/a/季度报告.md', 'docx')).toBe('季度报告.docx')
  })

  it('copes with a name that has no extension', () => {
    expect(defaultExportName('/a/notes', 'pdf')).toBe('notes.pdf')
  })
})

describe('extensionOf', () => {
  it('reads the last segment', () => {
    expect(extensionOf('C:\\a\\b.MD')).toBe('md')
    // A dotfile is a *name*, not an extension: `.hidden` has none.
    expect(extensionOf('/a/.hidden')).toBe('')
    expect(extensionOf('/a/noext')).toBe('')
  })
})
