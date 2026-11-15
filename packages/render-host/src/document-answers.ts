/**
 * What an editor asks its export host — the host-agnostic half of printing a document.
 *
 * The desktop answers these from the main process (`apps/electron/src/main/office-export-host.ts`);
 * a hub answers them from the process driving the browser. The questions are the editor's, though,
 * and they are the same everywhere: this module is that list, so the two hosts cannot drift into
 * printing different things.
 *
 * The three formats print three different things, and that is the whole reason this file exists:
 *
 * - **docs** prints *itself* — the page becomes its own print preview and asks the host to turn
 *   what is on screen into a file. That is why it must be the top document, and why the host has to
 *   be able to print the page it is talking to.
 * - **sheets** hands over a finished HTML print job (its pagination exists only inside that job).
 * - **slides** hands over one drawing per slide, kept as vectors rather than rasterised.
 */

import { officeDeckCall, officePdfCall, officeWorkbookCall } from '@craft-agent/office-host'
import type { OfficeAnswer } from './office-origin.ts'
import type { OfficeApp, PrintGeometry } from './types.ts'

/** The settings the editors ask before they draw anything. */
const SETTINGS: Record<string, unknown> = {
  getLanguage: 'en',
  getSystemLocale: 'en',
  getTheme: 'light',
  getDocumentTheme: 'light',
  getAutoSaveDefault: false,
  getAuthorName: '',
  getAiSettings: { enabled: false },
  aiGskStatus: undefined,
  notifyPendingEdits: undefined,
  // No printers, and said so rather than throwing later: the editor's own print dialog reads this
  // and a build that invented a printer would show a job that went nowhere.
  listPrinters: [],
  getUserDisplayName: '',
  // A workbook in an export window is always the one it was opened on.
  hasQueuedWorkbook: true,
}

/** The two editors that have no DOM sign of an open document; the open call is the sign. */
const OPENS = new Set([
  'reopenWorkbook',
  'selectWorkbook',
  'openWorkbook',
  'consumePendingOpen',
  'openPptx',
  'openPptxPath',
])

export interface DocumentAnswerContext {
  app: OfficeApp
  /** The file being printed — what the deck/workbook/pdf hosts are asked about. */
  path: string
  /** Where the PDF goes. */
  outPath: string
  /** Print the page the editor is running in (the docs editor's own door). */
  printOpenPage: (geometry: PrintGeometry) => Promise<Uint8Array>
  /** Print markup the editor produced on a page of its own (sheets and slides). */
  printMarkup: (html: string, geometry: PrintGeometry) => Promise<Uint8Array>
  write: (path: string, bytes: Uint8Array) => Promise<void>
}

/** `twips` is what the docs editor measures its page in: 1440 of them to the inch. */
const TWIPS_PER_INCH = 1440
const twipsToInches = (value: unknown): number => (Number(value) > 0 ? Number(value) / TWIPS_PER_INCH : 0)

interface DocumentAnswerer extends OfficeAnswer {
  /** Whether the editor ever asked for its document — the honest "did it open" signal. */
  opened: () => boolean
}

export function createDocumentAnswerer(context: DocumentAnswerContext): DocumentAnswerer {
  const { app, path, outPath } = context
  const firstPageOnly = false
  let opened = false

  const deckCall = (method: string, args: unknown[]): Promise<unknown> => {
    if (app === 'slides') return officeDeckCall(method, [path, ...args]) as Promise<unknown>
    if (app === 'sheets') return officeWorkbookCall(method, [path, ...args]) as Promise<unknown>
    if (app === 'pdf') return officePdfCall(method, [path, ...args]) as Promise<unknown>
    // The docs editor keeps its document in the page; the shim hands it over, so nothing is asked.
    return Promise.resolve(undefined)
  }

  const answer: OfficeAnswer = async (method, args) => {
    if (OPENS.has(method)) opened = true
    if (Object.prototype.hasOwnProperty.call(SETTINGS, method)) return SETTINGS[method]

    // A printer, as opposed to a PDF. Refused by name: this host has a renderer and no printer.
    if (method === 'print' || method === 'printWorkbook' || method === 'printSlides') {
      return { ok: false, error: 'This host can export a PDF but has no printers to send it to.' }
    }

    if (app === 'docs' && (method === 'exportPdf' || method === 'printToPdf')) {
      const widthIn = twipsToInches(args[1])
      const heightIn = twipsToInches(args[2])
      const geometry: PrintGeometry = {
        ...(widthIn > 0 && heightIn > 0 ? { widthIn, heightIn } : {}),
        // The editor has already laid the page out to its own size; any margin here would be a
        // second, invisible one.
        marginsIn: { top: 0, bottom: 0, left: 0, right: 0 },
        printBackground: true,
        ...(firstPageOnly ? { pageRanges: '1' } : {}),
      }
      const pdf = await context.printOpenPage(geometry)
      const target = outPath
      await context.write(target, pdf)
      return { ok: true, path: target }
    }

    if (app === 'slides' && (method === 'exportPdf' || method === 'printSlides')) {
      const request = (args[0] ?? {}) as { pages?: unknown; pngsBase64?: unknown; widthPx?: unknown; heightPx?: unknown; fontCss?: unknown }
      const widthPx = Number(request.widthPx) || 1280
      const heightPx = Number(request.heightPx) || 720
      const pages: SlidePage[] = Array.isArray(request.pages)
        ? (request.pages as SlidePage[])
        : Array.isArray(request.pngsBase64)
          ? (request.pngsBase64 as unknown[]).map((png) => ({ png }))
          : []
      if (pages.length === 0) return { ok: false, error: 'There are no slides to export.' }
      const html = slidesToPrintHtml(pages, { widthPx, heightPx }, typeof request.fontCss === 'string' ? request.fontCss : '')
      const pdf = await context.printMarkup(html, {
        widthIn: widthPx / 96,
        heightIn: heightPx / 96,
        marginsIn: { top: 0, bottom: 0, left: 0, right: 0 },
        printBackground: true,
      })
      await context.write(outPath, pdf)
      return { ok: true, path: outPath }
    }

    if (app === 'sheets' && (method === 'exportPdf' || method === 'printWorkbook')) {
      const request = (args[0] ?? {}) as {
        html?: unknown
        pageSize?: { width?: unknown; height?: unknown }
        landscape?: unknown
        margins?: unknown
        scale?: unknown
      }
      const html = typeof request.html === 'string' ? request.html : ''
      if (!html) return { ok: false, error: 'There is nothing to print.' }
      const width = Number(request.pageSize?.width)
      const height = Number(request.pageSize?.height)
      const margins = request.margins as PrintGeometry['marginsIn'] | undefined
      const pdf = await context.printMarkup(html, {
        ...(width > 0 && height > 0 ? { widthIn: width, heightIn: height } : {}),
        ...(request.landscape === true ? { landscape: true } : {}),
        ...(margins ? { marginsIn: margins } : {}),
        ...(Number(request.scale) > 0 ? { scale: Number(request.scale) } : {}),
        printBackground: true,
      })
      await context.write(outPath, pdf)
      return { ok: true, path: outPath }
    }

    return deckCall(method, args)
  }

  return Object.assign(answer, { opened: () => opened })
}

/** The slides editor's pages: an `<svg>` per slide, or a PNG when the slide could not be drawn. */
interface SlidePage {
  svg?: unknown
  png?: unknown
}

/**
 * One page per slide, keeping the vector output the editor produced.
 *
 * Deliberately not rasterised: the editor already handed over a drawing, and a PDF built from it
 * stays sharp at any zoom and keeps its text selectable.
 */
function slidesToPrintHtml(
  pages: SlidePage[],
  size: { widthPx: number; heightPx: number },
  fontCss: string,
): string {
  const width = Math.max(1, Math.round(size.widthPx))
  const height = Math.max(1, Math.round(size.heightPx))
  const sheets = pages
    .map((page) => {
      const body =
        typeof page.svg === 'string'
          ? page.svg
          : typeof page.png === 'string' && page.png
            ? `<img src="data:image/png;base64,${page.png}" style="width:100%;height:100%">`
            : ''
      return `<section class="sheet">${body}</section>`
    })
    .join('')
  return `<!doctype html><meta charset="utf-8"><title>slides</title>
<style>
  @page { size: ${width}px ${height}px; margin: 0 }
  html, body { margin: 0; padding: 0; background: #fff }
  .sheet { width: ${width}px; height: ${height}px; overflow: hidden; break-after: page; page-break-after: always; page-break-inside: avoid; position: relative }
  .sheet:last-child { break-after: auto; page-break-after: auto }
  .sheet > svg, .sheet > img { display: block; width: ${width}px; height: ${height}px }
  ${fontCss}
</style>${sheets}`
}
