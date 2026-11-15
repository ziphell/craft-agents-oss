/**
 * Page `n` of a document, as its **own editor** drew it — the app's half of the capture seam.
 *
 * One function, two callers, and they want the same thing: a poster wants page one (`page: 0`), and
 * `docx_tool render` wants whichever page a model asked to look at. Neither prints, and neither
 * opens the file in an editing window: the editor is loaded in a window nobody sees, driven to the
 * page, and the rectangle it names is photographed.
 *
 * The steps live in `@craft-agent/office-host` (`officePageDriver`) so the hub runs exactly the
 * same ones — "which element is page one" is not a host's business, and the two hosts disagreeing
 * about it is how a poster and a preview end up showing different pages.
 */

import { session } from 'electron'
import { mainLog } from './logger'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { OFFICE_PAGE_WINDOW, officePageDriver, type OfficeApp } from '@craft-agent/office-host'
import { captureSurface } from './capture-surface'
import { createExportHost } from './office-export-host'
import {
  officeOriginUrl,
  registerExportFile,
  registerExportHost,
  releaseExportFile,
  releaseExportHost,
} from './office-origin'
import { registerLocalOriginHandler } from './local-origin-router'

/** How long an editor may take to open a document and draw the page asked for. */
export const PAGE_CAPTURE_TIMEOUT_MS = 20_000

/**
 * The pixels, or `null` when this install cannot draw that page.
 *
 * `null` rather than a throw for the poster's sake: it has a second route (print) and a card
 * without a picture is worse than a slower one. A caller that has no second route treats `null` as
 * the refusal it is.
 */
export async function captureOfficePage(
  app: Exclude<OfficeApp, 'pdf'>,
  path: string,
  bytes: Uint8Array,
  page = 0,
  target?: { sheet?: string; range?: string },
): Promise<Buffer | null> {
  const origin = officeOriginUrl()
  if (!origin) return null
  // The scheme's router is installed by the app's startup, but a capture can be the first thing
  // that asks for the origin in a session (`--headless-export` deliberately skips that startup).
  registerLocalOriginHandler(session.defaultSession)

  const fileToken = registerExportFile(path, bytes)
  try {
    const capture = await captureSurface({
      // No `readonly=1` here, unlike a preview: that flag puts a "read-only snapshot" bar across
      // the top of the document, and a poster is supposed to be the page and nothing else. Nothing
      // types into this window and autosave is off (see `createExportHost`'s settings), so there is
      // nothing for the flag to protect.
      url: `${origin}/${app}/?__craftExport=${encodeURIComponent(fileToken)}`,
      size: OFFICE_PAGE_WINDOW[app],
      javascript: true,
      timeoutMs: PAGE_CAPTURE_TIMEOUT_MS,
      settleMs: 0,
      // A window cannot be wider or taller than the screen, so the page is zoomed to fit instead
      // (see `capture-surface.ts`): an A4 page at 100% does not fit a 1440×960 desktop, and the
      // clip then starts above the window — the capture is clamped to the top and the poster comes
      // back as the ribbon over an empty page. A workbook is left alone: its grid is measured, not
      // fitted, and the clip is the region of it that happens to be visible.
      ...(app === 'docs'
        ? { fit: { width: 794, height: 1123 } }
        : app === 'slides'
          ? { fit: { width: 1280, height: 720 } }
          : {}),
      // The editor has no host page here, so its questions go to the same export host a print
      // window uses — registered against the window this surface is about to create.
      onWindow: (win) => {
        registerExportHost(
          fileToken,
          createExportHost({ app, path, win, timeoutMs: PAGE_CAPTURE_TIMEOUT_MS }).answer,
        )
      },
      prepare: officePageDriver({ app, page, timeoutMs: PAGE_CAPTURE_TIMEOUT_MS, ...(target ? { target } : {}) }),
    })
    return capture?.png ?? null
  } catch (error) {
    // Swallowing this is what made "the poster is blank" a guess: the caller falls back to printing,
    // and printing a document whose editor never opened produces a blank page that looks like a
    // rendering bug. One line names the step that failed.
    mainLog.warn(`[office] page capture failed for ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    releaseExportHost(fileToken)
    releaseExportFile(fileToken)
  }
}

/**
 * Write page `page` into `outDir` and answer its path — what `docx_tool render` asks for.
 *
 * The name carries the page number because the tool's answer is a list of pictures and their paths
 * are what a model `Read`s when the reply only had room for a few.
 */
export async function writeOfficePagePng(
  app: Exclude<OfficeApp, 'pdf'>,
  path: string,
  outDir: string,
  page: number,
  target?: { sheet?: string; range?: string },
): Promise<string[]> {
  const bytes = new Uint8Array(await readFile(path))
  const png = await captureOfficePage(app, path, bytes, page, target)
  if (!png) return []
  await mkdir(outDir, { recursive: true })
  const stem = (path.split(/[\\/]/).pop() ?? 'document').replace(/\.[^.]+$/, '')
  const file = join(outDir, `${stem}-${String(page + 1).padStart(2, '0')}.png`)
  await writeFile(file, png)
  return [file]
}
