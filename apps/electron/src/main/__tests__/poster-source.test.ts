import { describe, expect, it } from 'bun:test'
import { blendOnWhite, posterSourceFor } from '../creation-poster'

describe('how a format gets its picture', () => {
  it('prints a Word document and a deck, and draws page one of the PDF', () => {
    // Both editors are editing surfaces, not documents: Word's page view is not the document's
    // pagination and a deck's slideshow is a second program on top of the first, so photographing
    // them produced the ribbon, a black stage, or the page depending on the frame. The printed page
    // is the page.
    expect(posterSourceFor('docx')).toEqual({ kind: 'print', app: 'docs' })
    expect(posterSourceFor('pptx')).toEqual({ kind: 'print', app: 'slides' })
  })

  it('photographs a workbook, which has no pages to print', () => {
    expect(posterSourceFor('xlsx')).toEqual({ kind: 'office-page', app: 'sheets' })
  })

  it('draws a PDF with pdfium, which opens no window at all', () => {
    expect(posterSourceFor('pdf')).toEqual({ kind: 'pdfium' })
  })

  it('draws a diagram with the engine, not with the viewer a conversation embeds', () => {
    // The regression this pins: the poster once drove the viewer shell and posted its render
    // request as a JSON string, where the bridge reads `event.data.protocol`. The message was
    // delivered and ignored, the capture timed out after twenty seconds, and every diagram card
    // kept its format badge. `renderDrawio` is the path `drawio_tool` already renders through.
    expect(posterSourceFor('drawio')).toEqual({ kind: 'drawio-engine' })
  })

  it('draws a page and a markdown file on their own routes', () => {
    expect(posterSourceFor('html')).toEqual({ kind: 'web-page' })
    expect(posterSourceFor('md')).toEqual({ kind: 'markdown' })
    expect(posterSourceFor('image')).toEqual({ kind: 'image' })
  })

  it('has no picture for a data file', () => {
    for (const format of ['csv', 'json', 'text', 'exe', '']) {
      expect(posterSourceFor(format)).toBeNull()
    }
  })

  it('names a route for every format the library lists as a work', () => {
    // `WORK_FORMATS` in the shared package — kept here as a list rather than imported, so adding a
    // work format without a route fails in this file instead of in a card with no picture.
    for (const format of ['md', 'html', 'drawio', 'docx', 'xlsx', 'pptx', 'pdf']) {
      expect(posterSourceFor(format)).not.toBeNull()
    }
  })
})

describe('compositing a picture onto white', () => {
  const pixel = (bgra: [number, number, number, number]) => new Uint8Array(bgra)

  it('turns a transparent pixel white — a JPEG has no alpha and would encode it black', () => {
    const flat = blendOnWhite(pixel([0, 0, 0, 0]), 1, 1)
    expect([flat[0], flat[1], flat[2], flat[3]]).toEqual([255, 255, 255, 255])
  })

  it('leaves an opaque pixel alone', () => {
    const flat = blendOnWhite(pixel([10, 20, 30, 255]), 1, 1)
    expect([flat[0], flat[1], flat[2], flat[3]]).toEqual([10, 20, 30, 255])
  })

  it('blends a half-transparent pixel half way to white', () => {
    const flat = blendOnWhite(pixel([0, 0, 0, 128]), 1, 1)
    expect(flat[0]).toBeCloseTo(127, 0)
    expect(flat[1]).toBeCloseTo(127, 0)
    expect(flat[2]).toBeCloseTo(127, 0)
    expect(flat[3]).toBe(255)
  })

  it('gives every pixel an opaque alpha and keeps the size it was given', () => {
    const pixels = new Uint8Array([
      0, 0, 0, 0, 255, 0, 0, 255,
      0, 255, 0, 64, 0, 0, 255, 200,
    ])
    const flat = blendOnWhite(pixels, 2, 2)
    expect(flat.length).toBe(16)
    for (let i = 3; i < flat.length; i += 4) expect(flat[i]).toBe(255)
    // The two pixels that carried colour still do.
    expect(flat[4]).toBe(255)
  })

  it('does not read past the end of a short buffer', () => {
    const flat = blendOnWhite(new Uint8Array(0), 1, 1)
    expect([flat[0], flat[1], flat[2], flat[3]]).toEqual([255, 255, 255, 255])
  })
})
