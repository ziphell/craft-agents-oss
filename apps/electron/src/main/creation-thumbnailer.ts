/**
 * Posters for the works library — one small image per file, captured once per version.
 *
 * The library's job is recognition, so the question this answers is "which of these is the report
 * I made yesterday". Every format gets its poster from the cheapest thing that actually resembles
 * it:
 *
 * | format | where the picture comes from |
 * | --- | --- |
 * | image | the file itself, resized (not shown for now — see `WORK_FORMATS`) |
 * | docx / xlsx / pptx | page one as the document's **own editor** lays it out, photographed |
 * | pdf | its own page one, drawn by pdfium — no window at all |
 * | html | the page, **served from its own folder with its scripts run**, photographed after they paint |
 * | drawio | the bundled viewer draws it on the app's own origin, then the window is captured |
 * | md | the source's own first lines, set as a page (see `creation-poster.ts`: a poster, not a |
 * | | rendering — the app's markdown renderer lives in the renderer process) |
 *
 * The office formats used to be printed: a hidden window ran the editor's export, a PDF was written,
 * and pdfium drew its first page. Two things were wrong with that. It paid for the whole document
 * (4.0 s for seven pages, of which the poster wants one) and it went through `printToPDF`, which is
 * the step that can silently lose pages. They are photographed now — 2.1 s for a document, 1.0 s for
 * a deck — and the print route stays behind them as the fallback, because a poster is worth having
 * even when its editor refuses to draw.
 *
 * Only the PDF itself escapes a window, and it should: pdfium draws its page one in 60 ms.
 *
 * Three rules it will not break:
 *
 * - **Nothing is stored in the user's workspace.** Posters live under the app's own data folder,
 *   keyed by the workspace — the library owns no directory of yours, which is the whole point.
 * - **A failure is not an error.** A file that cannot be drawn simply has no poster, and the card
 *   falls back to its format badge. One unreadable document must not empty the grid. It is also
 *   not asked for again for a while: nothing is written when a capture fails, so the only record
 *   of it is in memory (`poster-queue.ts`), and without one every visit paid for the same window.
 * - **Two lanes, not one.** A capture that opens a window costs 1–2 s; pdfium drawing a page costs
 *   60 ms. They used to share one queue, so forty PDFs waited behind whatever office document was
 *   being photographed — the grid filled in the order of the list, not the order of the cost. Now
 *   windows run two at a time, and the in-process work runs beside them. Either lane coalesces by
 *   key, so a re-render asks for the same poster once.
 */

import { app, nativeImage, type NativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  THUMB_HEIGHT,
  THUMB_WIDTH,
  orphanPostersToDelete,
  blendOnWhite,
  posterFileName,
  posterFitScale,
  posterSourceFor,
  posterStem,
  siblingPostersToDelete,
} from './creation-poster'
import { createFailureGate, createLane, type Lane } from './poster-queue'
import { mainLog } from './logger'
import { exportDocumentPdf } from './office-export'
import { captureSurface } from './capture-surface'
import { captureWebPage } from './capture-web-page'
import { captureMarkdownPoster } from './markdown-poster'
import { captureOfficePage } from './office-page-capture'
import { renderPagePng } from '@craft-agent/office-host'
import { renderDrawio } from './drawio-render'

const JPEG_QUALITY = 82
/**
 * The page is drawn rather wider than the card so the picture survives a large window and a
 * high-density screen. Measured: ~130 ms at this width, against ~90 ms at 600.
 */
const POSTER_PX_WIDTH = 1000
/** A document too large to open for a picture is not worth a picture. */
const MAX_SOURCE_BYTES = 48 * 1024 * 1024
const CAPTURE_TIMEOUT_MS = 20_000
/**
 * How long a document that refused to draw is left alone.
 *
 * Long enough that the ordinary case — a broken install, a document no editor will open — is paid
 * once per session instead of once per visit, short enough that a transient failure (a window
 * destroyed mid-capture, a bundle still building) is retried without a restart.
 */
const REFUSED_TTL_MS = 10 * 60_000

export interface CreationThumbInput {
  workspaceRootPath: string
  /** Absolute path of the file. */
  path: string
  /** What kind of document it is (see `CreationFormat`), which decides how it is drawn. */
  format: string
  mtimeMs: number
  bytes: number
}

/**
 * Where posters live: the app's data folder, one directory per workspace.
 *
 * Not the workspace itself — a cache is not a document, and the library's reason for existing is
 * that a work is a file rather than a folder we invented.
 */
export function thumbnailDir(workspaceRootPath: string): string {
  const workspace = createHash('sha1').update(workspaceRootPath).digest('hex').slice(0, 12)
  return join(app.getPath('userData'), 'creation-thumbs', workspace)
}


/** An html file, or markdown set on a page: the layout engine, photographed. */
async function captureDocument(
  url: string,
  size: { width: number; height: number } = { width: 1000, height: 625 },
  scripts = false,
): Promise<Buffer | null> {
  return captureWebPage(url, size, CAPTURE_TIMEOUT_MS, { scripts })
}

/**
 * A `.drawio` document, drawn by the engine this app already trusts.
 *
 * Not the viewer shell and its `postMessage` handshake — that is what a *frame in a conversation*
 * uses, and it is a protocol with two ends: a poster that spoke it wrong (a stringified payload
 * where the bridge reads `event.data.protocol`) waited out a twenty-second timeout and reported
 * "the viewer drew nothing", which is how five diagrams came to have no picture at all. `renderDrawio`
 * is the path `drawio_tool` renders through: one hidden window on the engine document, one
 * expression that runs to completion, PNG bytes back. A picture is the only thing a poster wants,
 * and this is the app's own answer to that question.
 */
async function captureDrawio(xml: string): Promise<Buffer | null> {
  const rendered = await renderDrawio({ xml, format: 'png' })
  return rendered.bytes.length > 0 ? Buffer.from(rendered.bytes) : null
}

/**
 * The source image for one file, or null when this format has no picture worth taking.
 *
 * Which route a format takes is a table (`posterSourceFor`), not a chain of conditions: the choice is
 * what has gone wrong before, and a wrong choice here is an empty picture rather than an error.
 */
async function captureSource(input: CreationThumbInput): Promise<Buffer | null> {
  if (input.bytes > MAX_SOURCE_BYTES) return null
  const source = posterSourceFor(input.format)
  if (!source) return null

  switch (source.kind) {
    // A picture is already a picture. Unreachable while the library excludes images (`WORK_FORMATS`).
    case 'image':
      return readFile(input.path)

    case 'pdfium': {
      // Its own page, drawn by pdfium in 60 ms — asking an editor to open the file first would be a
      // second of work for a worse answer.
      const bytes = new Uint8Array(await readFile(input.path))
      const png = await renderPagePng({ bytes, pageIndex: 0, pxWidth: POSTER_PX_WIDTH })
      return Buffer.from(png)
    }

    case 'print': {
      // The document's first page as the exporter lays it out: print to PDF, then pdfium draws page
      // one. Slower than photographing the editor and steadier — an editing surface is not a document
      // (its page view is not the document's pagination, and a deck's slideshow is a second program
      // on top of the first), so a photograph of it was sometimes the ribbon, sometimes a black
      // stage, sometimes the page.
      const bytes = new Uint8Array(await readFile(input.path))
      const pdf = await exportDocumentPdf(
        { app: source.app, path: input.path, bytes, timeoutMs: CAPTURE_TIMEOUT_MS },
        { firstPageOnly: true },
      )
      const png = await renderPagePng({ bytes: pdf, pageIndex: 0, pxWidth: POSTER_PX_WIDTH })
      return Buffer.from(png)
    }

    case 'office-page': {
      const bytes = new Uint8Array(await readFile(input.path))
      const page = await captureOfficePage(source.app, input.path, bytes)
      if (page) return page

      // The grid did not draw — an install without its bundles, or a workbook it refuses. Print it
      // instead: a poster that took longer is better than a card with no picture. Logged, because
      // "printed" and "drawn" are different pictures and a blank card should say which.
      mainLog.warn(`[creations] ${input.path}: the grid did not draw, printing page one instead`)
      const pdf = await exportDocumentPdf(
        { app: source.app, path: input.path, bytes, timeoutMs: CAPTURE_TIMEOUT_MS },
        { firstPageOnly: true },
      )
      const png = await renderPagePng({ bytes: pdf, pageIndex: 0, pxWidth: POSTER_PX_WIDTH })
      return Buffer.from(png)
    }

    case 'web-page':
      // The file itself, which is also the address its preview frames — so the card is that page
      // photographed: its stylesheets resolved against its folder, its scripts run.
      return captureDocument(pathToFileURL(input.path).href, undefined, true)

    case 'markdown':
      // The app's **reading face**, at the card's width — not a second markdown dialect in main. See
      // `markdown-poster.ts`: the window loads this bundle with `?mdPoster=1` and mounts the same
      // `TiptapMarkdownEditor` a `.md` file is read with (`presentation`).
      return captureMarkdownPoster(await readFile(input.path, 'utf8'), undefined, input.path)

    case 'drawio-engine':
      return captureDrawio(await readFile(input.path, 'utf8'))
  }
}

/**
 * Fit a capture into the card's shape: a drawing whole, everything else from its top edge.
 *
 * `nativeImage`, not sharp. This runs in the Electron main process, which already produced the
 * capture in the first place (`capturePage()`, pdfium's `renderPagePng`) and carries a scaler and a
 * JPEG encoder of its own — while `sharp` is not in the packaged app at all: electron-builder's
 * `files` excludes `node_modules` and the extraResources list never carried it, so this function
 * threw MODULE_NOT_FOUND in every packaged build and the library silently drew format badges
 * instead of posters. Using what the process already has is also the smaller answer: 20 MB of
 * libvips for one resize.
 */
async function toPosterJpeg(source: Buffer, whole: boolean): Promise<Buffer> {
  const decoded = nativeImage.createFromBuffer(source)
  if (decoded.isEmpty()) throw new Error('the capture could not be decoded')
  // A JPEG has no alpha, and a transparent pixel encodes as black. A window capture is opaque, but
  // the diagram engine's PNG is not (measured: `colorType 6`, a 782×237 drawing on nothing), and a
  // flowchart's poster came out as white boxes on a black page. Flattened here, once, so the
  // geometry below can keep treating a capture as opaque.
  const image = flattenOnWhite(decoded)
  const { width, height } = image.getSize()
  if (!width || !height) throw new Error('the capture has no size')
  const fitted = whole ? containOnWhite(image, width, height) : coverFromTop(image, width, height)
  return fitted.toJPEG(JPEG_QUALITY)
}

/** Composite a capture onto white, so nothing transparent reaches the JPEG encoder. */
function flattenOnWhite(image: NativeImage): NativeImage {
  const { width, height } = image.getSize()
  return nativeImage.createFromBitmap(blendOnWhite(image.toBitmap(), width, height), { width, height })
}

/** The whole picture, centred on white — sharp's `fit: 'contain'` with a background. */
function containOnWhite(image: NativeImage, width: number, height: number): NativeImage {
  const scale = Math.min(THUMB_WIDTH / width, THUMB_HEIGHT / height)
  const scaled = image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'best',
  })
  const size = scaled.getSize()
  const left = Math.round((THUMB_WIDTH - size.width) / 2)
  const top = Math.round((THUMB_HEIGHT - size.height) / 2)
  // nativeImage has no compositor, so the white page is a bitmap the picture is blitted onto. `0xff`
  // throughout is opaque white in BGRA. A straight copy, because `toPosterJpeg` has already flattened
  // the picture onto that same white — this only has to place it.
  const canvas = Buffer.alloc(THUMB_WIDTH * THUMB_HEIGHT * 4, 0xff)
  const pixels = scaled.toBitmap()
  const rowBytes = size.width * 4
  for (let y = 0; y < size.height; y++) {
    pixels.copy(canvas, ((top + y) * THUMB_WIDTH + left) * 4, y * rowBytes, y * rowBytes + rowBytes)
  }
  return nativeImage.createFromBitmap(canvas, { width: THUMB_WIDTH, height: THUMB_HEIGHT })
}

/** The picture filled to the card, cut from the top — sharp's `fit: 'cover', position: 'top'`. */
function coverFromTop(image: NativeImage, width: number, height: number): NativeImage {
  const scale = Math.max(THUMB_WIDTH / width, THUMB_HEIGHT / height)
  const scaled = image.resize({
    width: Math.max(THUMB_WIDTH, Math.round(width * scale)),
    height: Math.max(THUMB_HEIGHT, Math.round(height * scale)),
    quality: 'best',
  })
  const size = scaled.getSize()
  return scaled.crop({
    x: Math.max(0, Math.round((size.width - THUMB_WIDTH) / 2)),
    y: 0,
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
  })
}

export interface CreationThumbnailer {
  /** Poster path for this version of the file; null when there is none (and none can be made). */
  ensure(input: CreationThumbInput): Promise<string | null>
  /**
   * Drop every poster whose document the library no longer knows about.
   *
   * `livePaths` is the index's own list — including works a view is filtering out, so a hidden one
   * never loses its picture. Editing a document already cleans itself up (`ensure` deletes the
   * previous version); this is the other half: documents that were deleted, moved or renamed.
   */
  prune(workspaceRootPath: string, livePaths: readonly string[]): void
}

export function createCreationThumbnailer(log: (message: string) => void): CreationThumbnailer {
  const inFlight = new Map<string, Promise<string | null>>()
  /**
   * Captures that create a hidden window, **by what they cost** rather than one line for all.
   *
   * Measured on this machine, four documents at once: one lane 18.5 s, two 11.0 s, three 9.4 s,
   * four 9.8 s — so three is where an office document stops waiting and starts fitting, and a fourth
   * window buys nothing (the work is one GPU and one bundle). Two lanes was the old limit, when every
   * format shared them.
   *
   * **Why two window lanes.** An office document is 2.6 s and an html page is 0.45 s, and they used
   * to queue in one line — so filtering the library to `md`, or scrolling past a row of screenshots,
   * waited for whatever Word documents happened to be ahead of it. Office documents get their own
   * lane; the formats that draw in under a second and a half get another. A filter is now answered by
   * the formats it selected, never by the ones it hid.
   */
  const officeLane = createLane(3)
  const lightLane = createLane(3)
  /** pdfium, in this process, no window — cheap enough to overlap with itself too. */
  const plainLane = createLane(3)
  /** Posters this run tried to make and could not (see `createFailureGate`). */
  const refused = createFailureGate(REFUSED_TTL_MS)

  /** Does drawing this format need a window? Everything but a PDF and a raw image does. */
  function opensWindow(format: string): boolean {
    return format !== 'pdf' && format !== 'image'
  }

  function laneFor(format: string): Lane {
    if (!opensWindow(format)) return plainLane
    // The editors are the expensive half; a page, a diagram and a markdown sheet are the cheap one.
    return format === 'docx' || format === 'xlsx' || format === 'pptx' ? officeLane : lightLane
  }

  async function produce(input: CreationThumbInput, name: string, dir: string): Promise<string | null> {
    const file = join(dir, name)
    if (existsSync(file)) return file
    const source = await captureSource(input)
    if (!source) return null
    // Everything fills the card from the top: a page laid on the card at its width, a slide that is
    // already 16:9 (so it fits exactly), a screenshot cut at the fold. The one exception is a
    // diagram, which is shown whole — its shape is its content, and a drawing cut down the middle
    // is not a smaller diagram, it is a wrong one.
    const jpeg = await toPosterJpeg(source, input.format === 'drawio')
    await mkdir(dir, { recursive: true })
    await writeFile(file, jpeg)
    // One document, one picture: the version this replaces is garbage the moment this exists.
    try {
      for (const stale of siblingPostersToDelete(readdirSync(dir), posterStem(input.path), name)) {
        unlinkSync(join(dir, stale))
      }
    } catch {
      // A cache that could not be tidied is still a working cache.
    }
    return file
  }

  return {
    ensure(input) {
      const name = posterFileName(input.path, input.mtimeMs, input.bytes)
      const existing = inFlight.get(name)
      if (existing) return existing
      // Something this file already refused: answer at once, so the card keeps its badge instead of
      // waiting in a queue for a picture that is not coming.
      if (refused.blocked(name)) return Promise.resolve(null)

      const dir = thumbnailDir(input.workspaceRootPath)
      // **A picture that already exists is a file, not a job.** This check used to live inside
      // `produce`, i.e. *after* a lane slot was taken — so a card whose poster was already on disk
      // waited behind whatever captures were in flight (two windows, 1–4 s each). That is what made
      // switching a filter look like the posters were being generated again: the grid was asking for
      // pictures it had, and the queue answered them in turn.
      const cached = join(dir, name)
      if (existsSync(cached)) return Promise.resolve(cached)

      const work = laneFor(input.format)
        .run(() => produce(input, name, dir))
        .then((file) => {
          if (file) refused.clear(name)
          // A window that drew nothing is a failure too, and the one worth remembering: it is the
          // expensive kind, and the next visit would pay for it again.
          else if (opensWindow(input.format)) {
            refused.fail(name)
            // Said out loud, because "this card has no picture" is otherwise invisible: a null is
            // the answer for a window that painted nothing, and nothing anywhere used to record it.
            log(`[creations] no poster for ${input.path}: the window drew nothing`)
          }
          return file
        })
        .catch((error: unknown) => {
          // A poster is a convenience. Its failure is logged, never surfaced: the card simply
          // keeps its format badge.
          refused.fail(name)
          log(`[creations] no poster for ${input.path}: ${error instanceof Error ? error.message : String(error)}`)
          return null
        })
        .finally(() => {
          inFlight.delete(name)
        })

      inFlight.set(name, work)
      return work
    },

    prune(workspaceRootPath, livePaths) {
      refused.sweep()
      const dir = thumbnailDir(workspaceRootPath)
      try {
        if (!existsSync(dir)) return
        const live = new Set(livePaths.map(posterStem))
        for (const stale of orphanPostersToDelete(readdirSync(dir), live)) {
          unlinkSync(join(dir, stale))
        }
      } catch {
        // Same rule as everywhere here: the cache is a convenience, never a thing to fail on.
      }
    },
  }
}
