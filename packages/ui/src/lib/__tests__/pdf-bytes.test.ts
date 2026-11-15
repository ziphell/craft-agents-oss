/**
 * The rule the pdf block's memory follows: a hard budget, least recently used first out, and the
 * holder told when its file goes.
 *
 * These are the parts that cannot be checked by looking at the app: eviction order, what happens to
 * a file bigger than the whole budget, and whether a listener actually hears about its own file
 * (a silent eviction leaves the `<Document>` — and its copy — mounted, which is the memory leak this
 * module exists to prevent).
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  PDF_CACHE_BUDGET,
  PDF_CACHE_MAX_FILES,
  clearPdfCache,
  getPdfBytes,
  pdfCacheUsage,
  pinPdfBytes,
  releasePdfBytes,
  retainPdfBytes,
  setPdfCacheBudget,
  subscribePdfBytes,
  touchPdfBytes,
  unpinPdfBytes,
} from '../pdf-bytes'

const kb = (n: number) => new Uint8Array(n * 1024)

beforeEach(() => {
  clearPdfCache()
})

describe('pdf bytes cache', () => {
  it('starts at a budget a conversation can live with', () => {
    expect(PDF_CACHE_BUDGET).toBeGreaterThan(8 * 1024 * 1024)
    expect(pdfCacheUsage().budgetBytes).toBe(PDF_CACHE_BUDGET)
  })

  it('hands back what was retained', () => {
    const bytes = kb(4)
    retainPdfBytes('/tmp/a.pdf', bytes)
    expect(getPdfBytes('/tmp/a.pdf')).toBe(bytes)
    expect(getPdfBytes('/tmp/missing.pdf')).toBeUndefined()
    expect(pdfCacheUsage().totalBytes).toBe(4 * 1024)
  })

  it('evicts the least recently used when the budget is passed', () => {
    setPdfCacheBudget(10 * 1024)
    retainPdfBytes('/a.pdf', kb(4))
    retainPdfBytes('/b.pdf', kb(4))
    expect(pdfCacheUsage().files.map((f) => f.src)).toEqual(['/b.pdf', '/a.pdf'])

    // Reading /a again moves it to the front: the eviction has to take /b instead.
    touchPdfBytes('/a.pdf')
    retainPdfBytes('/c.pdf', kb(4))

    expect(getPdfBytes('/c.pdf')).toBeDefined()
    expect(getPdfBytes('/a.pdf')).toBeDefined()
    expect(getPdfBytes('/b.pdf')).toBeUndefined()
  })

  it('keeps the file that was just retained, even if it is the oldest', () => {
    setPdfCacheBudget(8 * 1024)
    retainPdfBytes('/old.pdf', kb(4))
    retainPdfBytes('/new.pdf', kb(4))
    // /old is now the oldest, but it is what came into view; it stays and /new goes.
    retainPdfBytes('/old.pdf', kb(4))
    retainPdfBytes('/third.pdf', kb(4))
    expect(getPdfBytes('/third.pdf')).toBeDefined()
    expect(pdfCacheUsage().totalBytes).toBeLessThanOrEqual(8 * 1024)
  })

  it('stores a file larger than the whole budget, alone rather than not at all', () => {
    setPdfCacheBudget(4 * 1024)
    retainPdfBytes('/small.pdf', kb(1))
    retainPdfBytes('/scan.pdf', kb(16))

    expect(getPdfBytes('/scan.pdf')).toBeDefined()
    expect(getPdfBytes('/small.pdf')).toBeUndefined()
    // The one documented way usage passes the ceiling: there is nothing left to evict.
    expect(pdfCacheUsage().totalBytes).toBe(16 * 1024)
  })

  it('tells a subscriber when its own file is evicted, and nobody else', () => {
    setPdfCacheBudget(4 * 1024)
    const heard: string[] = []
    subscribePdfBytes('/a.pdf', () => heard.push('a'))
    subscribePdfBytes('/b.pdf', () => heard.push('b'))

    retainPdfBytes('/a.pdf', kb(2))
    retainPdfBytes('/b.pdf', kb(2))
    retainPdfBytes('/c.pdf', kb(2)) // pushes the oldest (/a) out

    expect(heard).toEqual(['a'])
  })

  it('stops telling a block that has gone away', () => {
    setPdfCacheBudget(4 * 1024)
    const heard: string[] = []
    const unsubscribe = subscribePdfBytes('/a.pdf', () => heard.push('a'))
    retainPdfBytes('/a.pdf', kb(2))
    unsubscribe()
    retainPdfBytes('/b.pdf', kb(2))
    retainPdfBytes('/c.pdf', kb(2))
    expect(heard).toEqual([])
  })

  it('gives the bytes back on release, and says so', () => {
    const heard: string[] = []
    subscribePdfBytes('/a.pdf', () => heard.push('a'))
    retainPdfBytes('/a.pdf', kb(2))
    releasePdfBytes('/a.pdf')

    expect(getPdfBytes('/a.pdf')).toBeUndefined()
    expect(heard).toEqual(['a'])
    expect(pdfCacheUsage().totalBytes).toBe(0)
  })

  /**
   * The rule that makes the ceiling terminate.
   *
   * Without it, a file on screen can be evicted, re-read, and in doing so evict the other file on
   * screen — two large documents would chase each other for as long as the view stayed open.
   */
  it('never evicts a file that is on screen', () => {
    setPdfCacheBudget(8 * 1024)
    pinPdfBytes('/visible.pdf')
    retainPdfBytes('/visible.pdf', kb(6))

    // Files asking for room the pinned one is holding: the unpinned ones go, it does not.
    retainPdfBytes('/a.pdf', kb(4))
    retainPdfBytes('/b.pdf', kb(4))

    expect(getPdfBytes('/visible.pdf')).toBeDefined()
    expect(getPdfBytes('/b.pdf')).toBeDefined()
    expect(getPdfBytes('/a.pdf')).toBeUndefined()
    // Over the budget by the pinned file, which is the documented cost of pinning: the ceiling is
    // "the budget, plus what is on screen".
    expect(pdfCacheUsage().totalBytes).toBe(10 * 1024)
  })

  it('pins by reference, so one block leaving does not unpin another’s file', () => {
    setPdfCacheBudget(4 * 1024)
    pinPdfBytes('/same.pdf')
    pinPdfBytes('/same.pdf')
    unpinPdfBytes('/same.pdf')
    retainPdfBytes('/same.pdf', kb(2))
    retainPdfBytes('/other.pdf', kb(4))
    expect(getPdfBytes('/same.pdf')).toBeDefined()

    unpinPdfBytes('/same.pdf')
    retainPdfBytes('/third.pdf', kb(4))
    expect(getPdfBytes('/same.pdf')).toBeUndefined()
  })

  /**
   * The case a byte budget misses: a dozen small invoices.
   *
   * Each held file also keeps a mounted `<Document>` — a pdf.js parse and a ~1.4 MB canvas — and
   * none of that is in `byteLength`. Counting only bytes would keep all twelve and call it nothing.
   */
  it('holds only a few files, however small they are', () => {
    setPdfCacheBudget(64 * 1024 * 1024, 3)
    for (const name of ['/1.pdf', '/2.pdf', '/3.pdf', '/4.pdf', '/5.pdf']) {
      retainPdfBytes(name, kb(50))
    }
    expect(pdfCacheUsage().files.length).toBe(3)
    // The oldest went.
    expect(getPdfBytes('/1.pdf')).toBeUndefined()
    expect(getPdfBytes('/2.pdf')).toBeUndefined()
    expect(getPdfBytes('/5.pdf')).toBeDefined()
  })

  it('never drops a pinned file to make a count', () => {
    setPdfCacheBudget(64 * 1024 * 1024, 2)
    pinPdfBytes('/visible.pdf')
    retainPdfBytes('/visible.pdf', kb(50))
    retainPdfBytes('/a.pdf', kb(50))
    retainPdfBytes('/b.pdf', kb(50))

    expect(getPdfBytes('/visible.pdf')).toBeDefined()
    expect(getPdfBytes('/b.pdf')).toBeDefined()
    expect(getPdfBytes('/a.pdf')).toBeUndefined()
    expect(pdfCacheUsage().files.length).toBe(2)
  })

  it('ships with a count small enough for the fixed cost of a document', () => {
    expect(PDF_CACHE_MAX_FILES).toBeGreaterThan(1)
    expect(PDF_CACHE_MAX_FILES).toBeLessThanOrEqual(10)
    expect(pdfCacheUsage().maxFiles).toBe(PDF_CACHE_MAX_FILES)
  })

  it('keeps the first copy when the same file is read again', () => {
    const first = kb(2)
    retainPdfBytes('/a.pdf', first)
    retainPdfBytes('/a.pdf', kb(2))
    expect(getPdfBytes('/a.pdf')).toBe(first)
    expect(pdfCacheUsage().files.length).toBe(1)
  })
})
