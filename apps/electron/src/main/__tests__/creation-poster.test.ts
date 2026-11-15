import { describe, expect, it } from 'bun:test'
import {
  isPosterFile,
  markdownPosterQuery,
  MAX_POSTER_TEXT,
  orphanPostersToDelete,
  posterFitScale,
  posterFileName,
  posterStem,
  posterStemOf,
  surfaceClipFrom,
  siblingPostersToDelete,
} from '../creation-poster'

describe('poster file names', () => {
  it('puts the document first and the version second', () => {
    const name = posterFileName('C:\\a\\b.md', 1000, 42)
    expect(name).toMatch(/^[0-9a-f]{10}-[0-9a-f]{10}\.jpg$/)
    expect(name.startsWith(posterStem('C:\\a\\b.md'))).toBe(true)
    expect(isPosterFile(name)).toBe(true)
    expect(posterStemOf(name)).toBe(posterStem('C:\\a\\b.md'))
  })

  it('gives two versions of one document the same stem and a different name', () => {
    const a = posterFileName('C:\\a\\b.md', 1000, 42)
    const b = posterFileName('C:\\a\\b.md', 2000, 42)
    expect(posterStemOf(a)).toBe(posterStemOf(b))
    expect(a).not.toBe(b)
  })

  it('ignores anything that is not a poster', () => {
    expect(isPosterFile('index.json')).toBe(false)
    expect(isPosterFile('abc.jpg')).toBe(false)
    expect(posterStemOf('notes.txt')).toBeNull()
  })
})

describe('keeping one poster per document', () => {
  const stem = posterStem('C:\\a\\b.md')
  const old = posterFileName('C:\\a\\b.md', 1000, 42)
  const fresh = posterFileName('C:\\a\\b.md', 2000, 42)
  const other = posterFileName('C:\\a\\c.md', 2000, 42)

  it('deletes an older version and leaves the new one', () => {
    expect(siblingPostersToDelete([old, fresh, other], stem, fresh)).toEqual([old])
  })

  it('deletes nothing when the document has only one version', () => {
    expect(siblingPostersToDelete([fresh, other], stem, fresh)).toEqual([])
  })

  it('collects a poster whose document is no longer known', () => {
    const live = new Set([stem])
    expect(orphanPostersToDelete([old, other], live)).toEqual([other])
  })

  it('leaves a hidden document alone: it is still a work, nobody is just filtering it out', () => {
    const live = new Set([stem, posterStem('C:\\a\\c.md')])
    expect(orphanPostersToDelete([old, other], live)).toEqual([])
  })

  it('never touches a file that is not a poster', () => {
    expect(orphanPostersToDelete(['notes.txt', 'index.json'], new Set())).toEqual([])
  })
})

describe('posterFitScale', () => {
  it('shrinks a drawing that is larger than the box', () => {
    // 2000-wide diagram in a 1000-wide window with an 18px margin: 964/2000.
    expect(posterFitScale({ width: 2000, height: 400 }, { width: 1000, height: 625 })).toBeCloseTo(0.482, 3)
  })

  it('never enlarges: a small diagram is centred, not blown up', () => {
    expect(posterFitScale({ width: 200, height: 120 }, { width: 1000, height: 625 })).toBe(1)
  })

  it('fits by the tighter of the two axes', () => {
    const scale = posterFitScale({ width: 400, height: 2000 }, { width: 1000, height: 625 })
    expect(scale).toBeCloseTo((625 - 36) / 2000, 3)
  })

  it('answers 1 for a drawing with no measurable size', () => {
    expect(posterFitScale({ width: 0, height: 0 }, { width: 1000, height: 625 })).toBe(1)
  })

  it('keeps a floor so a huge drawing is still a picture of the whole thing', () => {
    expect(posterFitScale({ width: 1e6, height: 1e6 }, { width: 1000, height: 625 })).toBeGreaterThan(0)
  })
})

describe('the markdown poster query', () => {
  it('carries the document, its width, and the flag the renderer looks for', () => {
    const source = ['# 标题', '', '一段话。'].join(String.fromCharCode(10))
    const query = markdownPosterQuery(source)
    expect(query.mdPoster).toBe('1')
    expect(query.width).toBe('800')
    // Base64url: no `+`, `/` or padding, which is what survives a URL built by two different loaders.
    expect(query.text).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Buffer.from(query.text!, 'base64url').toString('utf8')).toBe(source)
  })

  it('cuts the text at the card, not at the document', () => {
    const long = 'x'.repeat(MAX_POSTER_TEXT * 3)
    const query = markdownPosterQuery(long)
    expect(Buffer.from(query.text!, 'base64url').toString('utf8')).toHaveLength(MAX_POSTER_TEXT)
  })

  it('keeps the width it was given', () => {
    expect(markdownPosterQuery('a', 1200).width).toBe('1200')
  })

  it('carries the document folder, so a picture beside it can be resolved', () => {
    const query = markdownPosterQuery('![](logo.png)', 800, 'C:\notes\sea')
    expect(Buffer.from(query.base!, 'base64url').toString('utf8')).toBe('C:\notes\sea')
    // A document with no folder says so by leaving it out rather than sending an empty one.
    expect(markdownPosterQuery('a').base).toBeUndefined()
  })
})
