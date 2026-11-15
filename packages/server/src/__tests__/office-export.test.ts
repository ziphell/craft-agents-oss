import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { OfficePrint } from '@craft-agent/office-host'
import { createHubExporter } from '../office-export.ts'

/**
 * The hub's export doors, tested as a contract rather than through a browser.
 *
 * A printer is an argument here (see `office-export.ts`), so what these check is what a person
 * would notice: a `.pdf` is copied rather than reprinted, a page image is a page image at the size
 * the app uses, and the intermediate PDF does not stay behind in somebody's temp directory.
 */

/** A real two-page pdf, built with the engine's own pdf-lib (the same fixture trick as `pdf-raster`). */
async function twoPagePdf(width = 200, height = 300): Promise<Uint8Array> {
  const pdfLib = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    'apps',
    'electron',
    'resources',
    'office-engine',
    'node_modules',
    'pdf-lib',
  )
  const { PDFDocument } = await import(pdfLib)
  const doc = await PDFDocument.create()
  doc.addPage([width, height])
  doc.addPage([width, height])
  return new Uint8Array(await doc.save())
}

/** A printer that answers with a real document, and remembers what it was asked for. */
function printerWriting(bytes: Uint8Array): OfficePrint & { calls: Array<{ path: string; outPath?: string }> } {
  const calls: Array<{ path: string; outPath?: string }> = []
  const print = (async (input, outPath) => {
    calls.push({ path: input.path, ...(outPath ? { outPath } : {}) })
    const target = outPath ?? input.path.replace(/\.[^.]+$/, '.pdf')
    await writeFile(target, bytes)
    return target
  }) as OfficePrint & { calls: typeof calls }
  print.calls = calls
  return print
}

function pngHead(png: Uint8Array): { width: number; height: number; signature: string } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    signature: Buffer.from(png.subarray(1, 4)).toString('ascii'),
  }
}

describe('the hub exports a document', () => {
  it('copies a pdf instead of asking a renderer to print it again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-export-test-'))
    try {
      const print = printerWriting(await twoPagePdf())
      const exporter = createHubExporter(print)
      const bytes = await twoPagePdf()
      const outPath = join(dir, 'nested', 'copy.pdf')

      const answer = await exporter.exportPdf({ app: 'pdf', path: join(dir, 'original.pdf'), bytes, outPath })

      expect(answer).toEqual({ path: outPath })
      expect(Buffer.compare(await readFile(outPath), Buffer.from(bytes))).toBe(0)
      // The point: no process, no Chromium, nothing to launch for a file that is already a pdf.
      expect(print.calls).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('asks the printer for a document, at the path the caller named', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-export-test-'))
    try {
      const print = printerWriting(await twoPagePdf())
      const exporter = createHubExporter(print)
      const outPath = join(dir, 'brief.pdf')

      const answer = await exporter.exportPdf({
        app: 'docs',
        path: join(dir, 'brief.docx'),
        bytes: new Uint8Array([1, 2, 3]),
        outPath,
      })

      expect(answer).toEqual({ path: outPath })
      expect(print.calls).toEqual([{ path: join(dir, 'brief.docx'), outPath }])
      expect(existsSync(outPath)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('draws one image per page, in page order, at the width the app uses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-export-test-'))
    try {
      const exporter = createHubExporter(printerWriting(await twoPagePdf(200, 300)))
      const outDir = join(dir, 'pages')

      const { files } = await exporter.exportPages({
        app: 'docs',
        path: join(dir, 'brief.docx'),
        bytes: new Uint8Array([1, 2, 3]),
        outDir,
      })

      expect(files).toEqual([join(outDir, 'brief-01.png'), join(outDir, 'brief-02.png')])
      const head = pngHead(new Uint8Array(await readFile(files[0]!)))
      expect(head.signature).toBe('PNG')
      // 1200 px wide, and the page's own proportions kept (200×300 → ×6).
      expect(head.width).toBe(1200)
      expect(head.height).toBe(1800)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('takes its intermediate pdf away, once the pages exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-export-test-'))
    try {
      const print = printerWriting(await twoPagePdf())
      const exporter = createHubExporter(print)
      await exporter.exportPages({
        app: 'slides',
        path: join(dir, 'deck.pptx'),
        bytes: new Uint8Array([1]),
        outDir: join(dir, 'pages'),
      })

      // The printer was told where to put the pdf; that whole directory is ours and must be gone —
      // the alternative is a temp directory per exported document, kept forever.
      const scratch = dirname(print.calls[0]!.outPath!)
      expect(scratch).not.toBe(dir)
      expect(existsSync(scratch)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("answers with the printer's own refusal, and writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-export-test-'))
    try {
      const refuse = (async () => {
        throw new Error('No Chromium could be launched.')
      }) as unknown as OfficePrint
      const exporter = createHubExporter(refuse)

      await expect(
        exporter.exportPages({
          app: 'slides',
          path: join(dir, 'deck.pptx'),
          bytes: new Uint8Array([1]),
          outDir: join(dir, 'never'),
        }),
      ).rejects.toThrow('No Chromium could be launched.')
      expect(existsSync(join(dir, 'never'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
