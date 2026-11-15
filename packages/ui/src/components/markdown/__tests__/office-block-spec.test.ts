import { describe, it, expect } from 'bun:test'
import { officeAppForPath, normalizeOfficeSrc, parseOfficeSpec } from '../MarkdownOfficeBlock'

/**
 * What a path looks like when it reaches a fence.
 *
 * The failure this pins: a spec copied out of a transcript where the path had been rendered as a
 * link (`[C:\x\brief.docx](C:\x\brief.docx)`) parsed as a path that ends in `docx)` — no editor
 * matched, and the block fell back to a code block, which reads as "the fence is not supported"
 * rather than "this path is not a document".
 */
describe('office-preview > normalizeOfficeSrc', () => {
  it('takes the target of a markdown link', () => {
    expect(normalizeOfficeSrc('[/abs/path/brief.docx](/abs/path/brief.docx)')).toBe('/abs/path/brief.docx')
    expect(normalizeOfficeSrc('[the deck](C:\\work\\deck.pptx)')).toBe('C:\\work\\deck.pptx')
  })

  it('takes a path out of a file URL', () => {
    expect(normalizeOfficeSrc('file:///C:/work/brief.docx')).toBe('C:/work/brief.docx')
    expect(normalizeOfficeSrc('file:///home/ryan/brief.docx')).toBe('/home/ryan/brief.docx')
  })

  it('trims, unwraps angle brackets, and refuses nothing-strings', () => {
    expect(normalizeOfficeSrc('  C:\\work\\brief.docx  ')).toBe('C:\\work\\brief.docx')
    expect(normalizeOfficeSrc('<C:\\work\\brief.docx>')).toBe('C:\\work\\brief.docx')
    expect(normalizeOfficeSrc('')).toBeNull()
    expect(normalizeOfficeSrc(42)).toBeNull()
  })
})

describe('office-preview > parseOfficeSpec', () => {
  it('reads the documented JSON form', () => {
    expect(parseOfficeSpec('{"src": "C:\\\\w\\\\brief.docx", "title": "季度复盘"}')).toEqual({
      src: 'C:\\w\\brief.docx',
      title: '季度复盘',
    })
  })

  it('reads a bare path — what a person actually pastes', () => {
    expect(parseOfficeSpec('C:\\w\\brief.docx')).toEqual({ src: 'C:\\w\\brief.docx' })
  })

  it('reads a JSON spec whose src was linkified on the way here', () => {
    expect(parseOfficeSpec('{"src": "[/abs/brief.docx](/abs/brief.docx)"}')).toEqual({ src: '/abs/brief.docx' })
  })

  it('refuses a body that is neither', () => {
    expect(parseOfficeSpec('')).toBeNull()
    expect(parseOfficeSpec('{"title": "no src"}')).toBeNull()
  })
})

describe('office-preview > officeAppForPath', () => {
  it('names the editor by extension', () => {
    expect(officeAppForPath('/a/b.docx')).toBe('docs')
    expect(officeAppForPath('/a/b.xlsx')).toBe('sheets')
    expect(officeAppForPath('/a/b.pptx')).toBe('slides')
    expect(officeAppForPath('/a/b.pdf')).toBeNull()
    // The shape the old failure produced: the extension is `docx)`, so nothing matches.
    expect(officeAppForPath('[/a/b.docx](/a/b.docx)')).toBeNull()
  })
})
