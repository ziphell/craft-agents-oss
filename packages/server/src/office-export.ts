/**
 * The hub's export doors: a document as a PDF, and a document as one image per page.
 *
 * Two callers ask for these from the UI rather than from the tool layer —
 * `office:exportPdf` (the editor's "Export as PDF" button, and what a preview asks for before it
 * has pages to draw) and `office:exportPages` (page images). On the desktop both are answered by
 * `apps/electron/src/main/office-export.ts`, which owns a hidden `BrowserWindow`; here the same two
 * contracts are answered without an Electron.
 *
 * The division in this file is the whole point, so it is stated once:
 *
 * - **Printing is not done here.** A hub cannot launch a browser in its own process — measured,
 *   `playwright-core` imports under Bun and then hangs on `chromium.launch()`, which is why
 *   `office-print.ts` spawns a launcher instead. So the PDF arrives from `createCliPrint`, one
 *   process per export, and this file never imports `playwright`.
 * - **Rasterising is done here.** `pdf-raster` is pdfium as wasm, in-process and windowless — the
 *   very code the desktop runs for the same job — so page images need no browser of their own.
 *
 * The printer is an **argument** rather than a command line: a test hands it one that answers
 * immediately, and a hub that has no Chromium never builds the exporter at all. Absence of the
 * dependency is how this codebase says "this host cannot do that", and the RPC handler says so in
 * words rather than failing halfway through a save.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  pdfPageCount,
  renderPagePng,
  type OfficePrint,
  type OfficePrintInput,
} from '@craft-agent/office-host'

/** The document a caller asked about: the same four formats the RPC handler classifies. */
export type HubExportDocument = OfficePrintInput

/**
 * How wide a page image is drawn, in pixels.
 *
 * The desktop asks for the same number (`writeOfficePages` in `office-export.ts`), and the two are
 * deliberately equal: a preview drawn on the hub and one drawn in the app are then the same
 * picture, which is what makes a cached page image safe to reuse from either host.
 */
const PAGE_WIDTH_PX = 1200

export interface HubExporter {
  exportPdf(input: HubExportDocument & { outPath: string }): Promise<{ path: string }>
  exportPages(input: HubExportDocument & { outDir: string }): Promise<{ files: string[] }>
}

export function createHubExporter(print: OfficePrint): HubExporter {
  return {
    async exportPdf(input) {
      await mkdir(dirname(input.outPath), { recursive: true })
      // A `.pdf` is already the answer: copying it is the whole export, and a renderer asked to
      // print one would only re-encode it. The launcher makes the same call for the same reason.
      if (input.app === 'pdf') {
        await writeFile(input.outPath, input.bytes)
        return { path: input.outPath }
      }
      // The printer answers with the file it *verified*, not with a path it believes — so the
      // caller can hand this straight back to a person without checking anything itself.
      return { path: await print(input, input.outPath) }
    },

    async exportPages(input) {
      // The intermediate PDF lives in a directory of ours and leaves with us: the caller asked for
      // pictures, and a stray `<name>.pdf` beside somebody's document is litter nobody asked for.
      const scratch = await mkdtemp(join(tmpdir(), 'craft-pages-'))
      try {
        const pdfPath = await print(input, join(scratch, 'document.pdf'))
        const bytes = new Uint8Array(await readFile(pdfPath))
        const count = await pdfPageCount(bytes)
        const stem = (input.path.split(/[\\/]/).pop() ?? 'document').replace(/\.[^.]+$/, '')
        await mkdir(input.outDir, { recursive: true })

        const files: string[] = []
        for (let index = 0; index < count; index += 1) {
          // One page at a time, written as it is drawn: a long deck is then bounded by one page's
          // bitmap rather than by all of them.
          const png = await renderPagePng({ bytes, pageIndex: index, pxWidth: PAGE_WIDTH_PX })
          const file = join(input.outDir, `${stem}-${String(index + 1).padStart(2, '0')}.png`)
          await writeFile(file, png)
          files.push(file)
        }
        return { files }
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    },
  }
}
