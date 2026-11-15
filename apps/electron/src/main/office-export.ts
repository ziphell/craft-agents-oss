/**
 * A document, exported the way its own editor exports it.
 *
 * Four formats, one route: ask the editor for a **PDF**, and rasterise pages from that. No
 * screenshots, no per-page window captures.
 *
 * Why not capture: the window is not the document. A spreadsheet has no pages in the DOM (its
 * pages exist only inside its own print job), a deck draws one stage, and only the Word editor
 * and the pdf viewer render page boxes at all — so `.doc-page` captures worked for two formats,
 * failed for two, and photographed a scrolled viewport rather than a page for all four.
 *
 * Why PDF: every editor already knows how to produce one (its own print preview, its own print
 * job, its own slide pages), and `renderPagePng` turns a page into pixels with the pdfium that
 * ships beside the document engine — ~80–180 ms, no window. That is also what makes a poster
 * affordable: three seconds to open the document, then one page.
 *
 * `docx → html` and `docx → md` are the same mechanism with a different target: a serializer, not
 * a rendering job. GenOffice drives all of it through a headless mode every bundle implements
 * (`consumeHeadlessExport` → export → `headlessExportDone`), and the hidden window below answers
 * those calls over the office origin, since it has no host page to answer them.
 */

import { BrowserWindow, session } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pdfPageCount, renderPagePng } from '@craft-agent/office-host'
import {
  officeOriginUrl,
  registerExportFile,
  registerExportHost,
  registerHeadlessTarget,
  releaseExportFile,
  releaseExportHost,
  releaseHeadlessTarget,
} from './office-origin'
import { createExportHost, printHtmlToPdf, type PrintJobGeometry } from './office-export-host'
import { registerLocalOriginHandler } from './local-origin-router'
import { renderDrawio as renderDrawioFile } from './drawio-render'
import {
  RenderError,
  type DocumentPrintRequest,
  type DrawioRenderRequest,
  type PrintGeometry,
  type PrintSource,
  type Renderer,
} from '@craft-agent/office-host'

export type OfficeExportApp = 'docs' | 'sheets' | 'slides' | 'pdf'

export interface OfficeExportInput {
  app: OfficeExportApp
  /** Absolute path of the source document. Only used for the name and the shim's answer. */
  path: string
  /** The document itself. Read by the caller, which owns the file policy. */
  bytes: Uint8Array
  /** How long to wait for the editor to lay the document out. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A document exported by **its own editor**, in a hidden window.
 *
 * `docx → html` and `docx → md` are serializers, not rendering jobs: the Word editor parses the
 * file into blocks and writes them out. GenOffice drives that through a headless mode every
 * bundle implements (`consumeHeadlessExport` → export → `headlessExportDone`), and the window
 * below answers those three calls over this origin — a hidden window has no host page, so they
 * travel as URLs (`office-origin.ts`).
 *
 * `pdf` is the same mode used for what it is named after: the editor lays the pages out itself
 * and asks its host to write the file, which is the `exportPdf` door in `office-export-host.ts`.
 */
export async function exportThroughEditor(
  input: OfficeExportInput & { format: 'html' | 'md' | 'pdf'; outPath: string; firstPageOnly?: boolean },
): Promise<string> {
  // The scheme's router is installed **here**, not only by the app's startup. An export is the one
  // caller that can run without that startup (`--headless-export` deliberately skips it), and the
  // failure when it is missing is `ERR_FAILED (-2)` from Chromium — a sentence that names neither
  // the scheme nor the missing handler. The registration is idempotent per session, so a normal
  // run pays a WeakSet lookup.
  registerLocalOriginHandler(session.defaultSession)

  const origin = officeOriginUrl()
  if (!origin) {
    throw new Error('The GenOffice editors are not installed in this build (run: bun scripts/build-office-assets.ts)')
  }

  const fileToken = registerExportFile(input.path, input.bytes)
  const target = registerHeadlessTarget(input.outPath)
  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    // **Page-shaped**, not a window-shaped guess: a Word document lays its text out to the width it
    // is given, so a 1024 px window printed onto A4 (794 px at 96 dpi) is a page whose right-hand
    // third is cut — measured, and it is what a poster of "the first page" looked like.
    useContentSize: true,
    width: 794,
    height: 1123,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  // This window has no host page either, so it asks the same route an export window asks — under
  // its own token, which is the one the served shim is told about.
  registerExportHost(
    target.token,
    createExportHost({
      app: input.app,
      path: input.path,
      outPath: input.outPath,
      firstPageOnly: input.firstPageOnly,
      win,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }).answer,
  )

  try {
    const url =
      `${origin}/${input.app}/?__craftExport=${encodeURIComponent(fileToken)}` +
      `&__craftHeadless=${input.format}&__craftOut=${encodeURIComponent(target.token)}`
    await win.loadURL(url)

    // The editor reports when it has finished writing; the timeout is what stops a broken export
    // from holding a hidden window forever.
    const report = await Promise.race([
      target.done,
      sleep(input.timeoutMs ?? DEFAULT_TIMEOUT_MS).then(() => ({ timedOut: true })),
    ])
    const outcome = report as { ok?: boolean; error?: string; timedOut?: boolean }
    if (outcome?.timedOut) throw new Error('The editor did not finish the export in time.')
    if (outcome?.ok === false) throw new Error(outcome.error ?? 'The editor could not export this document.')
    if (!existsSync(input.outPath)) throw new Error('The export wrote no file.')
    return input.outPath
  } finally {
    releaseHeadlessTarget(target.token)
    releaseExportHost(target.token)
    releaseExportFile(fileToken)
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * The document as PDF **bytes**, without leaving a file behind.
 *
 * The editors hand their PDF over as a file (that is the shape of their own export), so the file
 * is written to the temp directory and read straight back. A poster is a picture, not a document;
 * nothing of it should appear on the person's disk.
 *
 * A `.pdf` is already the answer.
 */
export async function exportDocumentPdf(
  input: OfficeExportInput,
  options: { firstPageOnly?: boolean } = {},
): Promise<Uint8Array> {
  if (input.app === 'pdf') return input.bytes
  const scratch = join(tmpdir(), `craft-office-${randomUUID()}.pdf`)
  try {
    await exportThroughEditor({
      ...input,
      format: 'pdf',
      outPath: scratch,
      firstPageOnly: options.firstPageOnly,
    })
    const bytes = new Uint8Array(await readFile(scratch))
    return bytes
  } finally {
    await rm(scratch, { force: true }).catch(() => undefined)
  }
}

/**
 * One PNG per page, rendered from the PDF the document exports to.
 *
 * Every page, because this is the "export pages" answer rather than a poster; callers that want
 * one page ask for one (`exportDocumentPdf` with `firstPageOnly`).
 */
export async function exportOfficePages(
  input: OfficeExportInput & { scale?: number },
): Promise<Array<{ page: number; png: Uint8Array }>> {
  const pdf = await exportDocumentPdf(input)
  const count = await pdfPageCount(pdf)
  const out: Array<{ page: number; png: Uint8Array }> = []
  for (let index = 0; index < count; index += 1) {
    const png = await renderPagePng({ bytes: pdf, pageIndex: index, pxWidth: input.scale ? 1200 * input.scale : 1200 })
    out.push({ page: index + 1, png })
  }
  return out
}

/**
 * The document as a PDF, made the way each editor makes one.
 *
 * Not by photographing the window: only the Word editor has a print stylesheet of its own. The
 * spreadsheet and the deck hand their host a finished print job and one PDF pages instead, so
 * each is asked in its own words and the PDF is whatever it produced — which is also why a
 * `.pptx` keeps its vector slides instead of a picture of them.
 *
 * A `.pdf` is already the answer; there is nothing to make.
 */
export async function writeOfficePdf(input: OfficeExportInput, outPath: string): Promise<string> {
  await mkdir(join(outPath, '..'), { recursive: true })
  if (input.app === 'pdf') {
    await writeFile(outPath, input.bytes)
    return outPath
  }
  return exportThroughEditor({ ...input, format: 'pdf', outPath })
}

/** Write one PNG per page into `outDir`, answering the files written in page order. */
export async function writeOfficePages(
  input: OfficeExportInput & { scale?: number },
  outDir: string,
): Promise<string[]> {
  const pages = await exportOfficePages(input)
  await mkdir(outDir, { recursive: true })
  const stem = (input.path.split(/[\\/]/).pop() ?? 'document').replace(/\.[^.]+$/, '')
  const files: string[] = []
  for (const { page, png } of pages) {
    const file = join(outDir, `${stem}-${String(page).padStart(2, '0')}.png`)
    await writeFile(file, png)
    files.push(file)
  }
  return files
}

/**
 * The renderer seam, answered by this app.
 *
 * Everything below is an adapter and **nothing else**: `printDocument` is the export pipeline this
 * file already had, `renderDrawio` is `drawio-render.ts`'s engine, and `print` is the same hidden
 * window `printHtmlToPdf` has always opened. No call site changed when this appeared — that is the
 * point. The interface (`@craft-agent/office-host`) is what lets a hub answer the same four
 * questions with a headless Chromium, and a desktop that never imports `render-host` still names
 * exactly the same promise.
 *
 * Two things are deliberately *not* here:
 *
 * - **A browser of its own.** The app is already one; a second Chromium in the installer is the
 *   dependency this arrangement exists to avoid.
 * - **`http(s)` printing.** A document to print is a file on this machine — the hub's URLs are its
 *   own origin. A remote page is `browser_tool`'s subject, not this seam's, so it is refused rather
 *   than silently fetched.
 */
export function createElectronRenderer(): Renderer {
  return {
    kind: 'electron',

    info() {
      return { kind: 'electron', version: process.versions.chrome }
    },

    async print(source: PrintSource, geometry: PrintGeometry = {}) {
      const html = source.kind === 'html' ? source.html : await htmlOfLocalFile(source.url)
      const dir = await mkdtemp(join(tmpdir(), 'craft-render-'))
      const target = join(dir, 'page.pdf')
      try {
        await printHtmlToPdf(html, target, toJobGeometry(geometry), DEFAULT_TIMEOUT_MS)
        return new Uint8Array(await readFile(target))
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
    },

    async printDocument(request: DocumentPrintRequest) {
      // A `.pdf` is already the answer.
      if (request.app === 'pdf') return request.bytes
      const firstPageOnly = request.geometry?.pageRanges === '1'
      return exportDocumentPdf(
        { app: request.app, path: request.path, bytes: request.bytes },
        { ...(firstPageOnly ? { firstPageOnly } : {}) },
      )
    },

    async renderDrawio(request: DrawioRenderRequest) {
      const rendered = await renderDrawioFile({
        xml: request.xml,
        format: request.format,
        ...(request.page !== undefined ? { page: request.page } : {}),
        ...(request.scale !== undefined ? { scale: request.scale } : {}),
        ...(request.theme !== undefined ? { theme: request.theme } : {}),
      })
      return new Uint8Array(rendered.bytes)
    },

    // Every export opens its own window and closes it before answering; nothing is held between
    // calls, so there is nothing to release.
    async close() {},
  }
}

/** The seam's geometry (inches, Chromium's own shapes) as the print job this app hands a window. */
function toJobGeometry(geometry: PrintGeometry): PrintJobGeometry {
  return {
    ...(geometry.widthIn && geometry.heightIn
      ? { pageSize: { width: geometry.widthIn, height: geometry.heightIn } }
      : {}),
    ...(geometry.landscape === undefined ? {} : { landscape: geometry.landscape }),
    ...(geometry.marginsIn ? { margins: geometry.marginsIn } : {}),
    ...(geometry.scale && geometry.scale > 0 ? { scale: geometry.scale } : {}),
    ...(geometry.pageRanges === '1' ? { firstPageOnly: true } : {}),
  }
}

/** A `file:` URL's markup. Anything else is refused: see the note on the renderer above. */
async function htmlOfLocalFile(url: string): Promise<string> {
  if (!url.startsWith('file:')) {
    throw new RenderError('UNSUPPORTED_TARGET', `This host prints local files, not ${url}.`)
  }
  return readFile(new URL(url), 'utf8')
}
