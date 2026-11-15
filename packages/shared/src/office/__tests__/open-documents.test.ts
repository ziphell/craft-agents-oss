import { beforeEach, describe, expect, it } from 'bun:test'
import {
  clearOpenDocuments,
  closeDocument,
  dirtyDocuments,
  isDocumentDirty,
  isDocumentOpen,
  openDocument,
  openDocuments,
  setDocumentDirty,
} from '../open-documents'

beforeEach(() => clearOpenDocuments())

describe('open documents', () => {
  it('is open from the first editor until the last one goes away', () => {
    expect(isDocumentOpen('/a/report.docx')).toBe(false)
    openDocument('/a/report.docx')
    expect(isDocumentOpen('/a/report.docx')).toBe(true)
    // Two windows on one file: closing one is not closing the file.
    openDocument('/a/report.docx')
    closeDocument('/a/report.docx')
    expect(isDocumentOpen('/a/report.docx')).toBe(true)
    closeDocument('/a/report.docx')
    expect(isDocumentOpen('/a/report.docx')).toBe(false)
  })

  it('survives a close it never saw an open for', () => {
    closeDocument('/a/never-opened.docx')
    expect(isDocumentOpen('/a/never-opened.docx')).toBe(false)
    expect(openDocuments()).toEqual([])
  })

  it('ignores an empty path rather than counting it', () => {
    openDocument('')
    expect(openDocuments()).toEqual([])
  })

  it('matches the way the platform matches paths', () => {
    openDocument('C:\\Work\\Report.DOCX')
    const same = process.platform === 'win32'
    // A command line and an editor may disagree about case; on Windows that is the same file.
    expect(isDocumentOpen('c:\\work\\report.docx')).toBe(same)
  })

  it('tracks several documents at once', () => {
    openDocument('/a/one.md')
    openDocument('/a/two.html')
    expect(openDocuments().sort()).toEqual(['/a/one.md', '/a/two.html'])
  })

  // What the agent asks before it reads anything: which files are a moment behind their editors.
  it('lists exactly the documents holding work the disk does not have', () => {
    openDocument('/a/report.md')
    openDocument('/a/notes.docx')
    setDocumentDirty('/a/report.md', true)

    expect(dirtyDocuments()).toEqual(['/a/report.md'])

    // Saved: still open, nothing to flush.
    setDocumentDirty('/a/report.md', false)
    expect(dirtyDocuments()).toEqual([])

    // And a document nobody is showing cannot be dirty — the entry goes with the editor.
    setDocumentDirty('/a/notes.docx', true)
    closeDocument('/a/notes.docx')
    expect(dirtyDocuments()).toEqual([])
  })

  it('separates "open" from "has unsaved work"', () => {
    openDocument('/a/report.md')
    // Open and clean: a write here is a version bump the editor can reload.
    expect(isDocumentOpen('/a/report.md')).toBe(true)
    expect(isDocumentDirty('/a/report.md')).toBe(false)
    setDocumentDirty('/a/report.md', true)
    expect(isDocumentDirty('/a/report.md')).toBe(true)
    // Saved: still open, nothing at stake.
    setDocumentDirty('/a/report.md', false)
    expect(isDocumentDirty('/a/report.md')).toBe(false)
  })

  it('forgets the unsaved work when the editor closes', () => {
    openDocument('/a/report.md')
    setDocumentDirty('/a/report.md', true)
    closeDocument('/a/report.md')
    expect(isDocumentDirty('/a/report.md')).toBe(false)
  })
})
