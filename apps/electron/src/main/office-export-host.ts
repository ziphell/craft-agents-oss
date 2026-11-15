/**
 * What an export window's editor asks, answered in the main process.
 *
 * A frame answers its editor through the page that embeds it. An export window is the top
 * document (its own `@media print` rules are the reason), so there is no page to answer — the shim
 * posts its questions to `/__craft/office-call/<token>` instead and this is what replies.
 *
 * Two families, and the split matters:
 *
 * | what the editor asks | who answers |
 * | --- | --- |
 * | what the document *is* (`reopenWorkbook`, `consumePendingOpen`) | the same hosts the frame uses |
 * | what to *write* (`exportPdf`) | here: a PDF, made from what the editor handed over |
 *
 * The second family is the point. None of these editors ever calls `printToPDF` on itself; each
 * one lays its pages out itself (a print preview for docs, an HTML print job for sheets, one SVG
 * or PNG per slide) and hands the result to its host to turn into a file. That door was missing,
 * which is why "export as pdf" did nothing at all — and why the poster pipeline had nothing to
 * photograph.
 *
 * Printing to a *printer* is refused in words rather than by throwing later: this build has no
 * printer list, and an editor that believes it queued a job would say it sent one.
 */

import { BrowserWindow } from 'electron'
import { rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { officeDeckCall, officePdfCall, officeWorkbookCall } from '@craft-agent/office-host'

/** The questions that are settings rather than facts about the document. */
const SETTINGS: Record<string, unknown> = {
  getLanguage: 'en',
  getSystemLocale: 'en',
  getTheme: 'light',
  getDocumentTheme: 'light',
  getAutoSaveDefault: false,
  getAuthorName: '',
  getAiPanelPrefs: { open: false },
  listPrinters: [],
}

/** Where a produced PDF goes when the editor named no path. */
function defaultPdfPath(sourcePath: string, fileName?: unknown): string {
  if (typeof fileName === 'string' && fileName.trim()) {
    const name = fileName.replace(/[\\/]/g, '-')
    return join(dirname(sourcePath), name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`)
  }
  return sourcePath.replace(/\.[^.]+$/, '.pdf')
}

/** Inches, from the twips a document's section is measured in (twentieths of a point). */
const twipsToInches = (twips: unknown): number | null => {
  const value = Number(twips)
  return Number.isFinite(value) && value > 0 ? value / 1440 : null
}

/**
 * A print job as this host states it: inches, and the margins the editor already applied.
 *
 * Deliberately not the seam's `PrintGeometry` (`@craft-agent/office-host`): that one is the
 * caller's request, this one is what the window is handed, and the two are converted in one place
 * (`createElectronRenderer` in `office-export.ts`) rather than being the same type by accident.
 */
export interface PrintJobGeometry {
  /** Page size in inches; null lets the document's own `@page` decide. */
  pageSize?: { width: number; height: number }
  landscape?: boolean
  margins?: { top: number; bottom: number; left: number; right: number }
  scale?: number
  /** Print only the first page — a poster needs one, and a 300-page document should not be 300. */
  firstPageOnly?: boolean
}

/**
 * An HTML job (the shape sheets and slides both hand over), printed by a window nobody sees.
 *
 * Written to a file rather than a `data:` URL: a spreadsheet's print HTML carries every sheet's
 * images inline and runs to megabytes, which a data URL turns into a URL a browser truncates.
 */
export async function printHtmlToPdf(
  html: string,
  outPath: string,
  geometry: PrintJobGeometry,
  timeoutMs: number,
): Promise<string> {
  const source = `${outPath}.html`
  await writeFile(source, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  try {
    await win.loadFile(source)
    await win.webContents
      .executeJavaScript('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true')
      .catch(() => undefined)
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: geometry.pageSize,
      landscape: geometry.landscape === true,
      margins: geometry.margins ?? { top: 0, bottom: 0, left: 0, right: 0 },
      ...(geometry.scale && geometry.scale > 0 ? { scale: geometry.scale } : {}),
      // Chromium's own range syntax, and a string: a `{from,to}` object is refused outright.
      ...(geometry.firstPageOnly ? { pageRanges: '1' } : {}),
    })
    await writeFile(outPath, pdf)
    return outPath
  } finally {
    if (!win.isDestroyed()) win.destroy()
    // The print job was a means, not a document: it lived beside the PDF for the length of one
    // print, and leaving it there would put a `.pdf.html` next to the person's file every time.
    await rm(source, { force: true }).catch(() => undefined)
  }
}

/** The slides editor's pages: an `<svg>` per slide, or a PNG when the slide could not be drawn. */
interface SlidePage {
  svg?: unknown
  png?: unknown
}

/**
 * Slides → one page per slide, keeping the vector output the editor produced.
 *
 * Deliberately not rasterised here: the editor already handed over a drawing, and a PDF built
 * from it stays sharp at any zoom and keeps its text selectable. The pages are laid out as sheets
 * so the print engine puts exactly one slide on each page.
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

/**
 * The one door an export window's editor knocks on.
 *
 * `win` is the window that asked, because the docs editor's export is a **print of itself**: it
 * switches to its print preview and asks the host to turn what is on screen into a file.
 */
export function createExportHost(options: {
  app: 'docs' | 'sheets' | 'slides' | 'pdf'
  path: string
  /** Where a headless export was told to write, when the caller named a file. */
  outPath?: string
  /** Print one page only: what a poster needs, and what a long document should not pay for. */
  firstPageOnly?: boolean
  win: BrowserWindow
  timeoutMs: number
}): { answer: (method: string, args: unknown[]) => Promise<unknown>; opened: () => boolean } {
  const { app, path, outPath, win, timeoutMs } = options
  const firstPageOnly = options.firstPageOnly === true

  /**
   * Whether this window has already asked for its document.
   *
   * Two of the four editors give no DOM sign of having a file open (a spreadsheet's canvases exist
   * before one loads, a deck draws its stage empty), but both must ask the host to open it — and
   * that question comes through here. Waiting for a page box instead is what made an open
   * spreadsheet "not laid out in time".
   */
  let opened = false
  const OPENS = new Set([
    'reopenWorkbook',
    'selectWorkbook',
    'openWorkbook',
    'consumePendingOpen',
    'openPptx',
    'openPptxPath',
  ])

  /** The document's own facts, asked of the same hosts a frame asks. */
  const documentCall = (method: string, args: unknown[]): Promise<unknown> => {
    if (app === 'slides') return officeDeckCall(method, [path, ...args]) as Promise<unknown>
    if (app === 'sheets') return officeWorkbookCall(method, [path, ...args]) as Promise<unknown>
    if (app === 'pdf') return officePdfCall(method, [path, ...args]) as Promise<unknown>
    return Promise.resolve(undefined)
  }

  async function answer(method: string, args: unknown[]): Promise<unknown> {
    if (OPENS.has(method)) opened = true
    if (Object.prototype.hasOwnProperty.call(SETTINGS, method)) return SETTINGS[method]

    /**
     * The spreadsheet's opening handshake.
     *
     * It does not pull a document; it asks whether one is queued and then "selects" it — in a
     * real window that is a file dialog, and here it is the file this window was opened on. Both
     * halves are needed: a window that answers `false` sits on an empty grid and reports that it
     * has nothing to print.
     */
    if (app === 'sheets' && method === 'hasQueuedWorkbook') return true
    if (app === 'sheets' && method === 'getUserDisplayName') return ''
    if (app === 'sheets' && method === 'getAiSettings') return { enabled: false }
    if (method === 'notifyPendingEdits' || method === 'aiGskStatus') return undefined

    switch (method) {
      // ---- the docs editor: "turn what is on screen into this PDF" ----
      // Three editors spell this door three ways: docs passes positional twips (it prints itself),
      // sheets passes an HTML print job, slides passes the pages it drew. Only the first is a print
      // of the calling window, so only the first is answered here.
      case 'exportPdf':
      case 'printToPdf': {
        if (app !== 'docs') break
        const width = twipsToInches(args[1])
        const height = twipsToInches(args[2])
        const asked = typeof args[3] === 'string' && args[3] ? (args[3] as string) : ''
        const target = outPath ?? (asked || defaultPdfPath(path))
        // The live editor is wider than the page inside it: its editing canvas is window-sized and the
        // A4 page sits in the middle of that. Printing the window onto an A4 sheet therefore cut the
        // right-hand quarter off every line — measured on a real brief, and what "the first page" of a
        // document looked like as a poster. Printing is a scale, so say it: the page's own width over
        // the width the document actually lays out in.
        const contentWidth = await win.webContents
          .executeJavaScript('Math.ceil(document.body.scrollWidth)')
          .catch(() => 0)
        const pageWidthPx = width ? width * 96 : 0
        // The editor may name a scale itself (`exportPdf(name, w, h, out, scale, links)`); its own
        // number wins, because it is the one that laid the pages out.
        const askedScale = typeof args[4] === 'number' && args[4] > 0 ? args[4] : undefined
        const scale =
          askedScale ??
          (pageWidthPx > 0 && contentWidth > pageWidthPx ? Math.max(0.25, pageWidthPx / contentWidth) : undefined)
        const pdf = await win.webContents.printToPDF({
          printBackground: true,
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          ...(width && height ? { pageSize: { width, height } } : { preferCSSPageSize: true }),
          ...(scale && scale < 1 ? { scale } : {}),
          ...(firstPageOnly ? { pageRanges: '1' } : {}),
        })
        await writeFile(target, pdf)
        return { ok: true, path: target }
      }

      // ---- printing to a printer is not something this build can do ----
      case 'print':
      case 'printWorkbook':
      case 'printSlides':
        return { ok: false, error: 'This build can export a PDF but has no printers to send it to.' }

      default:
        break
    }

    // The slides editor's one-object export: the pages it drew, made into a file.
    if (app === 'sheets' && method === 'selectWorkbook') return documentCall('selectWorkbook', [])

    if (app === 'slides' && (method === 'exportPdf' || method === 'printSlides')) {
      const request = (args[0] ?? {}) as {
        /** A path, or `{ format, outPath }` when the editor asked its own file dialog first. */
        filePath?: unknown
        pages?: unknown
        widthPx?: unknown
        heightPx?: unknown
        fontCss?: unknown
        pngsBase64?: unknown
      }
      const widthPx = Number(request.widthPx) || 1280
      const heightPx = Number(request.heightPx) || 720
      const pages: SlidePage[] = Array.isArray(request.pages)
        ? (request.pages as SlidePage[])
        : Array.isArray(request.pngsBase64)
          ? (request.pngsBase64 as unknown[]).map((png) => ({ png }))
          : []
      if (pages.length === 0) return { ok: false, error: 'There are no slides to export.' }
      const asked =
        typeof request.filePath === 'string'
          ? request.filePath
          : typeof (request.filePath as { outPath?: unknown } | undefined)?.outPath === 'string'
            ? String((request.filePath as { outPath: string }).outPath)
            : ''
      const target = outPath ?? (asked || defaultPdfPath(path))
      // A poster asks for one slide. The editor has already drawn them all by here (its own export
      // path renders every visible slide first), so this saves the print, not the drawing.
      const sheets = firstPageOnly ? pages.slice(0, 1) : pages
      const html = slidesToPrintHtml(sheets, { widthPx, heightPx }, typeof request.fontCss === 'string' ? request.fontCss : '')
      await printHtmlToPdf(
        html,
        target,
        { pageSize: { width: widthPx / 96, height: heightPx / 96 }, firstPageOnly },
        timeoutMs,
      )
      return { ok: true, path: target }
    }

    // The sheets editor's one-object export: a finished print job, as HTML.
    if (app === 'sheets' && (method === 'exportPdf' || method === 'printWorkbook')) {
      const request = (args[0] ?? {}) as {
        html?: unknown
        fileName?: unknown
        outPath?: unknown
        pageSize?: { width?: unknown; height?: unknown }
        landscape?: unknown
        margins?: unknown
        scale?: unknown
      }
      const html = typeof request.html === 'string' ? request.html : ''
      if (!html) return { ok: false, error: 'There is nothing to print.' }
      const target =
        outPath ??
        (typeof request.outPath === 'string' && request.outPath ? request.outPath : defaultPdfPath(path, request.fileName))
      const size = request.pageSize ?? {}
      const width = Number(size.width)
      const height = Number(size.height)
      const margins = request.margins as PrintJobGeometry['margins']
      await printHtmlToPdf(
        html,
        target,
        {
          ...(width > 0 && height > 0 ? { pageSize: { width, height } } : {}),
          landscape: request.landscape === true,
          ...(margins ? { margins } : {}),
          scale: Number(request.scale) || undefined,
          firstPageOnly,
        },
        timeoutMs,
      )
      return { ok: true, path: target }
    }

    return documentCall(method, args)
  }

  return { answer, opened: () => opened }
}
