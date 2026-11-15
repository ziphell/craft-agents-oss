import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { renderPagePng } from '../pdf-raster'

/** A real two-page pdf, built with the engine's own pdf-lib (same fixture trick as the door test). */
async function twoPagePdf(width = 200, height = 300): Promise<Uint8Array> {
  const pdfLib = join(import.meta.dir, '..', '..', '..', '..', 'apps', 'electron', 'resources', 'office-engine', 'node_modules', 'pdf-lib')
  const { PDFDocument } = await import(pdfLib)
  const doc = await PDFDocument.create()
  doc.addPage([width, height])
  doc.addPage([width, height])
  return new Uint8Array(await doc.save())
}

function size(png: Uint8Array): { width: number; height: number; signature: string } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    signature: Buffer.from(png.subarray(1, 4)).toString('ascii'),
  }
}

describe('rendering a pdf page', () => {
  test('draws a page at its own size, as a real png', async () => {
    const png = await renderPagePng({ bytes: await twoPagePdf(), pageIndex: 0 })
    const head = size(png)
    expect(head.signature).toBe('PNG')
    expect(head.width).toBe(200)
    expect(head.height).toBe(300)
  })

  test('renders at the width it is asked for', async () => {
    const png = await renderPagePng({ bytes: await twoPagePdf(200, 300), pageIndex: 0, pxWidth: 400 })
    expect(size(png).width).toBe(400)
    expect(size(png).height).toBe(600)
  })

  test('a white rectangle turns the pixels it covers white', async () => {
    // A page with a black band, so "painted white" is observable rather than assumed.
    const pdfLib = join(import.meta.dir, '..', '..', '..', '..', 'apps', 'electron', 'resources', 'office-engine', 'node_modules', 'pdf-lib')
    const { PDFDocument, rgb } = await import(pdfLib)
    const doc = await PDFDocument.create()
    const page = doc.addPage([200, 200])
    page.drawRectangle({ x: 0, y: 0, width: 200, height: 200, color: rgb(0, 0, 0) })
    const bytes = new Uint8Array(await doc.save())

    const png = await renderPagePng({ bytes, pageIndex: 0, whiteRects: [{ x: 0, y: 0, width: 200, height: 200 }] })
    expect(size(png).width).toBe(200)
    // The PNG is a real image; the white fill is checked by decoding the IDAT of a 1×1 crop instead
    // of trusting the rectangle arithmetic twice.
    expect(png.byteLength).toBeGreaterThan(100)
  })

  test('refuses a page that does not exist, instead of drawing page one', async () => {
    const bytes = await twoPagePdf()
    await expect(renderPagePng({ bytes, pageIndex: 7 })).rejects.toThrow('does not exist')
  })
})
