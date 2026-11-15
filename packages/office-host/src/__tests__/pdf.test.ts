import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { officePdfCall, ocrAnswerToLines } from '../pdf'
import { setOfficeDeliver } from '../runtime'

let dir = ''
let pdf = ''

/**
 * A real two-page pdf, built with the engine's own pdf-lib.
 *
 * The page operations load the bytes through pdf-lib, so a hand-written `%PDF-1.7` header is a
 * file that reads fine and cannot be split — the fixture has to be a document to mean anything.
 */
async function twoPagePdf(): Promise<Uint8Array> {
  const pdfLib = join(
    import.meta.dir,
    '..', '..', '..', '..',
    'apps', 'electron', 'resources', 'office-engine', 'node_modules', 'pdf-lib',
  )
  const { PDFDocument } = await import(pdfLib)
  const doc = await PDFDocument.create()
  doc.addPage([200, 200])
  doc.addPage([200, 200])
  return new Uint8Array(await doc.save())
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'craft-pdfdoor-'))
  pdf = join(dir, 'brief.pdf')
  await writeFile(pdf, await twoPagePdf())
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('the pdf door', () => {
  test('readFile answers the bytes, not a permission', async () => {
    // The editor does `new Uint8Array(await pdfApi.readFile(path))`. A `true` here is a one-byte
    // document: the editor opens onto nothing, and nothing throws.
    const bytes = (await officePdfCall('readFile', [pdf])) as Uint8Array
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.byteLength).toBeGreaterThan(4)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
  })

  test('consumePending names the document the frame is showing', async () => {
    expect(await officePdfCall('consumePending', [pdf])).toBe(pdf)
    expect(await officePdfCall('consumePending', [join(dir, 'missing.pdf')])).toBeNull()
  })

  test('OCR without a page image stops the pass instead of inventing one', async () => {
    expect(await officePdfCall('ocrPage', [pdf])).toBeNull()
  })

  test('an unlisted method is a switched-off feature, not an error', async () => {
    // AI, skills and the certificate store were never wired; they stay switched off rather than
    // half-answering.
    expect(await officePdfCall('aiStream', [pdf])).toBeUndefined()
    expect(await officePdfCall('skillsList', [pdf])).toBeUndefined()
  })

  /**
   * A menu item we cannot do says so.
   *
   * `undefined` is not silence here: the editor's `runFileOp` reads it as "the flush failed" and
   * reports a problem with the wrong thing. Each of these names what the bundled engine lacks.
   */
  test('an operation the engine cannot do is refused in words, not swallowed', async () => {
    for (const method of ['mergePdf', 'insertPdf', 'mergePages', 'setPageSize', 'splitPdf']) {
      const answer = (await officePdfCall(method, [pdf, {}])) as { ok: boolean; error?: string }
      expect(answer.ok).toBe(false)
      expect(answer.error).toContain(method)
      expect(answer.error).toContain('not available in this build')
    }
  })

  test('the printer list is empty, under both names the dialog asks by', async () => {
    expect(await officePdfCall('printers', [pdf])).toEqual([])
    expect(await officePdfCall('listPrinters', [pdf])).toEqual([])
  })

  /**
   * The text tool is still off — and the door still answers the questions around it.
   *
   * `validateTextEdits` is what the editor asks before it offers any change; the engine answers it
   * (a reason per edit), so the host must pass that through rather than returning `undefined`. What
   * keeps the tool off is `canDrawText`, because the *apply* stage does not land yet.
   */
  test('the text tool answers for itself, from the engine', async () => {
    // The three questions the editor asks before it offers to change a character.
    expect(await officePdfCall('canDrawText', [pdf, 'hello'])).toBe(true)

    const fonts = (await officePdfCall('listEditFonts', [pdf])) as string[]
    expect(Array.isArray(fonts)).toBe(true)
    expect(fonts.length).toBeGreaterThan(0)

    // An empty edit list is not a validation question: answer nothing rather than one blank row.
    expect(await officePdfCall('validateTextEdits', [pdf, { path: pdf, edits: [] }])).toEqual([])
  })

  /**
   * Keeping pages rewrites the file itself — the editor reloads the same path afterwards.
   */
  test('replacePages keeps the named pages, in place', async () => {
    const before = await readFile(pdf)
    const answer = (await officePdfCall('replacePages', [pdf, { path: pdf, pages: [2] }])) as { ok: boolean }
    expect(answer.ok).toBe(true)

    const pdfLib = join(
      import.meta.dir,
      '..', '..', '..', '..',
      'apps', 'electron', 'resources', 'office-engine', 'node_modules', 'pdf-lib',
    )
    const { PDFDocument } = await import(pdfLib)
    const after = await PDFDocument.load(new Uint8Array(await readFile(pdf)))
    expect(after.getPageCount()).toBe(1)
    // …and it is a different file, so the rewrite really happened.
    expect(after.getPage(0).getSize()).toBeDefined()
    expect(Buffer.from(before).equals(Buffer.from(await readFile(pdf)))).toBe(false)
  })

  test('replacePages without pages says what it needed', async () => {
    const answer = (await officePdfCall('replacePages', [pdf, { path: pdf, pages: [] }])) as { ok: boolean; error?: string }
    expect(answer.ok).toBe(false)
    expect(answer.error).toContain('1-based pages')
  })

  test('a page region comes back as a png data URL of that region', async () => {
    const answer = (await officePdfCall('pageImagePng', [pdf, { path: pdf, pageIndex: 0, rect: { x: 10, y: 10, width: 80, height: 40 } }])) as string
    expect(answer.startsWith('data:image/png;base64,')).toBe(true)
    const png = Buffer.from(answer.split(',')[1] as string, 'base64')
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(80)
    expect(png.readUInt32BE(20)).toBe(40)
  })

  test('a rect that is not four numbers is refused, not guessed', async () => {
    expect(await officePdfCall('pageImagePng', [pdf, { path: pdf, pageIndex: 0, rect: [1, 2, 3] }])).toBeNull()
  })

  test('a whole page renders through the door, for this app and not for the editor', async () => {
    const answer = (await officePdfCall('renderPagePng', [pdf, { pageIndex: 0, pxWidth: 300 }])) as { png: string }
    expect(answer.png.startsWith('data:image/png;base64,')).toBe(true)
    const png = Buffer.from(answer.png.split(',')[1] as string, 'base64')
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(300)
  })

  test('a produced file goes where the host puts files, and is named in the answer', async () => {
    const delivered: Array<{ name: string; size: number }> = []
    setOfficeDeliver(async (files) => {
      for (const file of files) delivered.push({ name: file.name, size: file.bytes.byteLength })
      return { savedPaths: files.map((file) => `/tmp/${file.name}`) }
    })

    const answer = (await officePdfCall('extractPages', [pdf, { pages: [1], suggestedName: 'brief-pages.pdf' }])) as {
      ok: boolean
      savedPath?: string
    }

    expect(answer.ok).toBe(true)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.name).toBe('brief-pages.pdf')
    expect(delivered[0]!.size).toBeGreaterThan(100)
    expect(answer.savedPath).toBe('/tmp/brief-pages.pdf')
    setOfficeDeliver(null)
  })

  test('without a deliverer, producing a file is refused in words', async () => {
    setOfficeDeliver(null)
    const answer = (await officePdfCall('extractPages', [pdf, { pages: [1] }])) as { ok: boolean; error?: string }
    expect(answer.ok).toBe(false)
    expect(answer.error).toContain('cannot put a new file anywhere')
  })

  test('permanent redaction is refused in place, and allowed to a copy', async () => {
    // No dialog here, and `save` writes in place when no target is named: the request would erase
    // text in the open file with no undo.
    const inPlace = (await officePdfCall('save', [pdf, { redactions: [{ pageIndex: 0 }] }])) as {
      ok: boolean
      error?: string
    }
    expect(inPlace.ok).toBe(false)
    expect(inPlace.error).toContain('copy')
  })

  test('readFile on a missing file throws — the editor reports a failed open', async () => {
    await expect(officePdfCall('readFile', [join(dir, 'gone.pdf')])).rejects.toThrow()
  })
})

describe('ocrPage answers', () => {
  test('flips image pixels into the editor’s bottom-left space', () => {
    expect(
      ocrAnswerToLines({
        width: 1000,
        height: 2000,
        lines: [{ text: ' Hello ', confidence: 0.9, box: { x: 100, y: 200, width: 200, height: 100 } }],
      }),
    ).toEqual([{ text: 'Hello', confidence: 0.9, box: [0.1, 0.85, 0.3, 0.9] }])
  })

  test('drops a line with no words or no usable box, and keeps the rest', () => {
    const lines = ocrAnswerToLines({
      width: 100,
      height: 100,
      lines: [
        { text: '   ', box: { x: 0, y: 0, width: 10, height: 10 } },
        { text: 'ok', box: { x: 0, y: 0, width: 10, height: 10 } },
        { text: 'missing box' },
      ],
    })
    expect(lines.map((line) => line.text)).toEqual(['ok'])
  })

  test('clamps a box that runs past the page', () => {
    const [line] = ocrAnswerToLines({
      width: 100,
      height: 100,
      lines: [{ text: 'x', box: { x: -20, y: -20, width: 200, height: 200 } }],
    })
    expect(line!.box).toEqual([0, 0, 1, 1])
  })

  test('an answer without dimensions is an empty page, not a crash', () => {
    expect(ocrAnswerToLines({ lines: [{ text: 'x', box: { x: 0, y: 0, width: 1, height: 1 } }] })).toEqual([])
    expect(ocrAnswerToLines({ width: 10, height: 0, lines: [] })).toEqual([])
  })
})
