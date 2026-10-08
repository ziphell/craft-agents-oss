/**
 * Design exporter (Electron main).
 *
 * Renders a design in a hidden `BrowserWindow` and produces the formats that
 * need a real engine: a PDF (`webContents.printToPDF`), one PNG per deck slide
 * (`capturePage`, driving the deck's own `.slide.active` contract via
 * `executeJavaScript`), an editable PPTX (the vendored `dom-to-pptx` bundle
 * injected into the same window, naming the format's real shapes/text), and a
 * motion composition as an MP4 (CDP screencast fed to the recording encoder —
 * see design-motion-capturer.ts). HTML and ZIP never come here — they are
 * written from the files by @craft-agent/shared/designs.
 *
 * Follows design-thumbnailer.ts: hidden window with `backgroundThrottling:
 * false`, the design loaded from its own address, a settle delay, and empty-frame
 * retries (Chromium can return a transparent frame before the compositor
 * paints). The renderer is the app's own Electron — no second engine.
 */

import { BrowserWindow } from 'electron'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import {
  COUNT_ARTBOARDS_SCRIPT,
  COUNT_DECK_SLIDES_SCRIPT,
  MAX_DECK_SLIDES,
  buildActivateDeckSlideScript,
  buildExportPptxScript,
  buildParkArtboardScript,
  buildShowAllArtboardsScript,
  buildShowAllDeckSlidesScript,
  deckPageSizeInches,
  deckSlideSize,
  designPreviewUrl,
  getDesignPath,
  loadDesignConfig,
  loadDesignContent,
  readDesignDataSnapshot,
} from '@craft-agent/shared/designs'
import { getBundledAssetsDir } from '@craft-agent/shared/utils'
import type { DesignRenderExportRequest } from '@craft-agent/shared/designs/types'
import { captureMotionToFile } from './design-motion-capturer.ts'

export interface DesignExporterOptions {
  log?: (message: string) => void
}

/** Let scripts run + paint + apply the snapshot before capturing/printing. */
const RENDER_SETTLE_MS = 550
/** Extra beat after switching a slide, so its reflow is painted. */
const SLIDE_SETTLE_MS = 120
/** Capture retries when a frame comes back empty (hidden-window paint race). */
const CAPTURE_RETRIES = 3
const CAPTURE_RETRY_DELAY_MS = 250
/** Hard ceiling on one export so a hung design cannot wedge the queue. */
const EXPORT_TIMEOUT_MS = 60_000

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * The vendored `dom-to-pptx` browser UMD bundle (MIT, pinned — see
 * resources/vendor/dom-to-pptx/README.md). It is read and gunzipped once, then
 * cached: `resources/` ships it via scripts/copy-assets.ts and
 * `getBundledAssetsDir` resolves it in both dev and the packaged app, so no
 * dependency (and none of the package's puppeteer path) is needed.
 */
let cachedPptxEngineSource: string | null = null

function loadPptxEngineSource(): string {
  if (cachedPptxEngineSource !== null) return cachedPptxEngineSource
  // getBundledAssetsDir covers the packaged app and a built dev tree
  // (<dist>/resources). The extra candidate is the checked-in source folder
  // next to the bundle (dev builds main to apps/electron/dist, so `../resources`
  // is apps/electron/resources) — it lets a dev run work without re-running the
  // asset copy.
  const dir = getBundledAssetsDir('vendor/dom-to-pptx')
    ?? [join(__dirname, '..', 'resources', 'vendor', 'dom-to-pptx'), join(__dirname, 'resources', 'vendor', 'dom-to-pptx')]
      .find((candidate) => existsSync(candidate))
    ?? null
  if (!dir) {
    throw new Error('The editable PPTX engine is missing from this build (resources/vendor/dom-to-pptx)')
  }
  const gzipped = join(dir, 'dom-to-pptx.bundle.js.gz')
  cachedPptxEngineSource = existsSync(gzipped)
    ? gunzipSync(readFileSync(gzipped)).toString('utf-8')
    : readFileSync(join(dir, 'dom-to-pptx.bundle.js'), 'utf-8')
  return cachedPptxEngineSource
}

export class DesignExporter {
  /** Serializes exports — one hidden window at a time. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: DesignExporterOptions = {}) {}

  /** Export one design. Concurrent calls wait their turn. */
  export(req: DesignRenderExportRequest): Promise<string[]> {
    const run = this.chain.then(() => this.withTimeout(this.run(req), EXPORT_TIMEOUT_MS))
    this.chain = run.catch(() => {})
    return run
  }

  private async run(req: DesignRenderExportRequest): Promise<string[]> {
    const content = loadDesignContent(req.workspaceRootPath, req.slug)
    if (content === null || content.trim() === '') {
      throw new Error(`Design has no content: ${req.slug}`)
    }

    // Render from the design's own address, exactly as the preview frame and the
    // thumbnailer do. A `data:` document has no base URL, so anything the design
    // references relatively — an image beside its index.html, a linked stylesheet —
    // could not be resolved and came out as a broken image; and past Chromium's
    // ~2MB limit a data URL does not load at all. Served, the browser resolves
    // every `src` itself, whatever the design points at.
    const previewUrl = designPreviewUrl(req.slug, getDesignPath(req.workspaceRootPath, req.slug))

    // A deck's slide size frames both the print page and the captured images.
    const size = deckSlideSize(req.aspect)
    const win = new BrowserWindow({
      show: false,
      width: size.width,
      height: size.height,
      useContentSize: true,
      webPreferences: {
        // `zoomFactor: 1` is already set below, and a capture still comes back at the display's
        // scale factor (measured: a 390×844 page → 585×1266, a 1280×720 deck slide → 1920×1080).
        // It is not fixed here: the size is normalised after the capture, in captureTo, where the
        // real scale of the image is known instead of assumed.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        zoomFactor: 1,
        // Keep rendering while hidden — a throttled renderer never paints.
        backgroundThrottling: false,
      },
    })

    try {
      // A design is data, not a navigable page: deny popups and navigation.
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('will-navigate', (event) => event.preventDefault())

      await win.loadURL(previewUrl)
      await this.deliverInit(win, req)
      await this.waitForFonts(win)

      // A motion composition drives its own timeline from load, so the capture
      // starts right after fonts are ready — the RENDER_SETTLE_MS below is for
      // the still formats and would eat the piece's opening beat (see
      // design-motion-capturer.ts).
      if (req.format === 'video') {
        if (!req.motion) throw new Error('Video export requires resolved motion settings')
        await captureMotionToFile(win, {
          settings: req.motion,
          width: size.width,
          height: size.height,
          destPath: req.destPath,
          log: this.options.log,
        })
        this.options.log?.(`[design-exporter] exported ${req.slug} as video`)
        return [req.destPath]
      }

      await delay(RENDER_SETTLE_MS)
      const paths = req.format === 'pdf'
        ? await this.printPdf(win, req)
        : req.format === 'pptx'
          ? await this.exportPptx(win, req)
          : await this.captureSlides(win, req)
      this.options.log?.(`[design-exporter] exported ${req.slug} as ${req.format}`)
      return paths
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }

  /** Write the design's PDF. A deck's aspect sets the paper so a slide fills a page. */
  private async printPdf(win: BrowserWindow, req: DesignRenderExportRequest): Promise<string[]> {
    // Electron takes a custom pageSize in inches; CSS px are 1/96 inch, so this
    // matches a deck's own `@page { size: Npx }` and prints one slide per page.
    const pageSize = req.aspect ? deckPageSizeInches(req.aspect) : undefined
    const data = await win.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'none' },
      ...(pageSize ? { pageSize } : {}),
    })
    mkdirSync(dirname(req.destPath), { recursive: true })
    writeFileSync(req.destPath, data)
    return [req.destPath]
  }

  /**
   * Write an editable PPTX from the rendered DOM.
   *
   * The vendored `dom-to-pptx` bundle is injected into the window that already
   * has the design loaded, then walks each slide's live layout into native
   * PowerPoint shapes/text (not a screenshot). A deck becomes one PPTX slide per
   * `.slide` in DOM order — all laid out at once first, since a deck normally
   * keeps only the active slide laid out; a plain design becomes one slide
   * holding the page body. The engine returns a Blob, read back as base64
   * because a string is all `executeJavaScript` can serialize — no filesystem
   * access happens inside the window.
   */
  private async exportPptx(win: BrowserWindow, req: DesignRenderExportRequest): Promise<string[]> {
    await win.webContents.executeJavaScript(loadPptxEngineSource(), true)
    const deckPages = Number(await win.webContents.executeJavaScript(buildShowAllDeckSlidesScript(), true)) || 0
    // A canvas has no deck to lay out: its artboards are all laid out already, so they only
    // have to be parked at 1:1 (a column) for the engine to measure each one.
    const slides = deckPages > 0
      ? deckPages
      : Number(await win.webContents.executeJavaScript(buildShowAllArtboardsScript(), true)) || 0
    // The engine maps the element's pixel box onto the slide, so the deck's own
    // aspect (or 16:9) is passed as the PPTX page size in inches.
    const inches = deckPageSizeInches(req.aspect)
    const result = (await win.webContents.executeJavaScript(
      buildExportPptxScript(inches.width, inches.height),
      true,
    )) as { b64?: string; slides?: number; error?: string } | null

    if (!result || result.error || !result.b64) {
      throw new Error(result?.error ?? 'PPTX export produced no output')
    }
    this.options.log?.(`[design-exporter] PPTX: ${slides} deck slide(s), ${result.slides ?? 1} exported`)
    mkdirSync(dirname(req.destPath), { recursive: true })
    writeFileSync(req.destPath, Buffer.from(result.b64, 'base64'))
    return [req.destPath]
  }

  /** One PNG per page: a deck's slides, a canvas's artboards, else the whole window. */
  private async captureSlides(win: BrowserWindow, req: DesignRenderExportRequest): Promise<string[]> {
    mkdirSync(req.destPath, { recursive: true })
    const count = Number(await win.webContents.executeJavaScript(COUNT_DECK_SLIDES_SCRIPT, true)) || 0

    if (count <= 0) {
      // Not a deck. A canvas is the other page convention: one image per artboard, and a
      // document with neither gets a single shot of the window, as before.
      const boards = Number(await win.webContents.executeJavaScript(COUNT_ARTBOARDS_SCRIPT, true)) || 0
      if (boards > 0) return this.captureArtboards(win, req, Math.min(boards, MAX_DECK_SLIDES))
      const file = join(req.destPath, `${req.slug}-1.png`)
      await this.captureTo(win, file)
      return [file]
    }

    const total = Math.min(count, MAX_DECK_SLIDES)
    const paths: string[] = []
    for (let i = 0; i < total; i++) {
      await win.webContents.executeJavaScript(buildActivateDeckSlideScript(i), true)
      await delay(SLIDE_SETTLE_MS)
      const file = join(req.destPath, `${req.slug}-${i + 1}.png`)
      await this.captureTo(win, file)
      paths.push(file)
    }
    return paths
  }

  /**
   * One PNG per artboard, each at its own pixel size and 1:1.
   *
   * A deck's page is the window (its `aspect` decides the size); a canvas frame is its own
   * size wherever its container happens to be, so the window is grown to contain it and the
   * capture rect is the frame itself — no scaling, and nothing of the canvas around it (the
   * design's rail and zoom live outside the artboards, so a crop never includes them).
   */
  private async captureArtboards(
    win: BrowserWindow,
    req: DesignRenderExportRequest,
    total: number,
  ): Promise<string[]> {
    const paths: string[] = []
    for (let i = 0; i < total; i++) {
      const parked = (await win.webContents
        .executeJavaScript(buildParkArtboardScript(i), true)
        .catch(() => null)) as [number, number, number, number] | null
      const x = Math.round(Number(parked?.[0])) || 0
      const y = Math.round(Number(parked?.[1])) || 0
      const width = Math.round(Number(parked?.[2])) || 0
      const height = Math.round(Number(parked?.[3])) || 0
      if (width < 1 || height < 1) break
      // The window has to contain the frame where it actually sits (its container may not be
      // at the document's origin), and the capture is exactly the frame's own rect.
      win.setContentSize(Math.max(1, x + width), Math.max(1, y + height))
      await delay(SLIDE_SETTLE_MS)
      const file = join(req.destPath, `${req.slug}-${i + 1}.png`)
      await this.captureTo(win, file, { x, y, width, height })
      paths.push(file)
    }
    if (paths.length === 0) {
      const file = join(req.destPath, `${req.slug}-1.png`)
      await this.captureTo(win, file)
      return [file]
    }
    this.options.log?.(`[design-exporter] PNG: ${paths.length} artboard(s) at their own size`)
    return paths
  }

  private async captureTo(
    win: BrowserWindow,
    file: string,
    rect?: { x: number; y: number; width: number; height: number },
  ): Promise<void> {
    for (let attempt = 0; attempt < CAPTURE_RETRIES; attempt++) {
      if (win.isDestroyed()) throw new Error('Export window closed')
      // Capture the **whole window** and crop afterwards, so the pixels are exactly the page's own.
      //
      // Measured on this machine (hidden windows, both times): `capturePage(undefined)` gives one
      // image pixel per CSS pixel — the thumbnailer's 1000×625 poster — while `capturePage(rect)`
      // multiplies by the display scale factor (a 390×844 frame came out 585×1266 = ×1.5, and a
      // deck's slides are scaled the same way). Cropping the whole capture avoids both the
      // resampling and any dependence on the machine's display settings, which is what "one image
      // per page, at the page's own size" has to mean.
      const whole = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      if (!whole.isEmpty()) {
        const [contentWidth, contentHeight] = win.getContentSize()
        const size = whole.getSize()
        // Whatever scale this capture came back at, the page's rectangle is in CSS pixels — so the
        // crop is taken at the same factor the image is bigger than the window by, and the result is
        // scaled to the page's own size. Self-calibrating on purpose: a wrong crop is worse than a
        // scaled one, and it is what turned an export into the top-left two thirds of a frame.
        const kx = contentWidth > 0 ? size.width / contentWidth : 1
        const ky = contentHeight > 0 ? size.height / contentHeight : 1
        const cropRect = rect
          ? {
              x: Math.round(rect.x * kx),
              y: Math.round(rect.y * ky),
              width: Math.round(rect.width * kx),
              height: Math.round(rect.height * ky),
            }
          : null
        const cropped = cropRect ? whole.crop(cropRect) : whole
        if (cropped.isEmpty()) {
          throw new Error(
            `The region to export (${rect?.width}×${rect?.height} at ${rect?.x},${rect?.y}) was outside the export window`,
          )
        }
        const targetWidth = rect ? rect.width : contentWidth
        const targetHeight = rect ? rect.height : contentHeight
        // Normalise to the page's own size, whatever the capture came back at. For a page with a
        // rect that is its declared size; for a deck's slide it is the window's content size (the
        // aspect it was authored for). Without this a "1280×720" slide exports as 1920×1080.
        const image =
          size.width !== targetWidth || size.height !== targetHeight
            ? cropped.resize({ width: targetWidth, height: targetHeight, quality: 'best' })
            : cropped
        writeFileSync(file, image.toPNG())
        return
      }
      await delay(CAPTURE_RETRY_DELAY_MS)
    }
    throw new Error('The design produced an empty frame')
  }

  /**
   * Deliver the `craft-designs/v1` init message the way the host does, by
   * posting it to the window itself — the design listens on `message` and must
   * not have its HTML rewritten for an export. Lets a live design paint its
   * snapshot into the PDF/PNG.
   */
  private async deliverInit(win: BrowserWindow, req: DesignRenderExportRequest): Promise<void> {
    const config = loadDesignConfig(req.workspaceRootPath, req.slug)
    const message = {
      protocol: 'craft-designs/v1',
      type: 'init',
      payload: {
        design: { slug: req.slug },
        nonce: 'export',
        // An export is a **still**, and that is what this flag says. A design that follows the
        // convention hides its own chrome for one (`body.poster`), because chrome is for the page
        // being used, not for a picture of it: without this, a deck exported its page dots into
        // every PNG and a canvas exported its rail, zoom control and the page's own background.
        poster: true,
        // …and it is the **page on its way out**, not the canvas. The cover is a picture OF the
        // canvas (frames drawn as cards, each named); an export is a picture of one screen, so a
        // frame's own drawing — corner radius, border, shadow, selection ring, name — must go with
        // it. A design says which one it is in `body.export` vs `body.poster`.
        export: true,
        snapshot: readDesignDataSnapshot(req.workspaceRootPath, req.slug),
      },
    }
    try {
      await win.webContents.executeJavaScript(
        `window.postMessage(${JSON.stringify(message)}, '*')`,
        true,
      )
    } catch (error) {
      // A design without a listener is fine; never fail an export over this.
      this.options.log?.(`[design-exporter] init delivery skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async waitForFonts(win: BrowserWindow): Promise<void> {
    try {
      await win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true', true)
    } catch {
      // Font visibility is best-effort.
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    // Keep the losing branch handled: on timeout the caller's finally destroys
    // the window while a pending load/capture rejects, and that later rejection
    // would otherwise surface as an unhandled one.
    promise.catch(() => {})
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`export timed out after ${ms}ms`)), ms)),
    ])
  }
}
