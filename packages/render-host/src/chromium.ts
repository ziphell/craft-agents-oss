/**
 * The Chromium implementation of the renderer seam — a hub's printing host.
 *
 * Playwright is the driver, not a convenience: the three things this file must get right are the
 * three it gives away. `route()` is the network policy (a document may name an image by URL, and
 * following it would both leak the hub's network and make the PDF depend on somebody else's
 * server); `fonts.ready` is the difference between paginating real text and paginating a fallback;
 * `emulateMedia({ media: 'print' })` is the only reason `@media print` rules apply at all. The CDP
 * underneath would need each of those written by hand, plus the lifecycle.
 *
 * That last one is for the markup we print ourselves, **not** for a document's editor: forcing
 * print media on the live editor makes it show its print layout instead of paginating the whole
 * document (measured: 7 pages laid out → 1 page printed). See `printDocument`.
 *
 * `page.pdf()` is *not* optional here the way it is in Electron: Chromium's CDP has
 * `Page.printToPDF` and Electron's does not (`apps/electron/spike/print-pdf.cjs` measured that),
 * so the desktop uses `webContents.printToPDF` and this uses `page.pdf()`. Same seam, two calls.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBundledAssetsDir } from '@craft-agent/shared/utils/paths'
import {
  describeDrawioPageProblem,
  findDrawioPage,
  projectDrawioPage,
} from '@craft-agent/shared/drawio/types'
import { DRAWIO_ENGINE_PATH } from '@craft-agent/shared/drawio/engine-shell'
import {
  buildSamplerScript,
  decodeSamplerReply,
  type SamplerReply,
  type SampledVideo,
  type VideoSampleOptions,
} from '@craft-agent/shared/recording/sampler-script'
import {
  AUDIO_CHUNK_BYTES,
  audioChunkExpression,
  buildAudioExtractScript,
  decodeAudioReply,
  wavBytes,
  type AudioExtractReply,
} from '@craft-agent/shared/recording/audio-script'
import { OFFICE_PAGE_WINDOW, officePageDriver } from '@craft-agent/office-host'
import { OfficeOrigin } from './office-origin.ts'
import { DrawioOrigin } from './drawio-origin.ts'
import { createDocumentAnswerer } from './document-answers.ts'
import {
  RenderError,
  type DrawioRenderRequest,
  type DocumentPrintRequest,
  type NetworkPolicy,
  type PrintGeometry,
  type PrintSource,
  type Renderer,
  type RendererInfo,
} from './types.ts'

/**
 * Flags that make a container behave like a machine.
 *
 * `--no-sandbox` because a hub runs as a non-root user without user namespaces; `--disable-dev-shm-usage`
 * because `/dev/shm` is 64 MB in Docker and a document with images will exhaust it; the last two
 * pin text rendering, which is the part a PDF is judged on.
 */
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--font-render-hinting=none',
  '--force-color-profile=srgb',
  /**
   * A recording's pixels and the page that reads them are both `file://`.
   *
   * Chromium treats a `file://` video as cross-origin for canvas read-back without this flag —
   * `toDataURL()` throws a SecurityError and the sampler gets no frames at all. The desktop does
   * not need it because its page runs with `webSecurity: false`; both doors are reading a file the
   * caller named, in a window nobody sees, with every other request answered by `#newContext`'s
   * route policy.
   */
  '--allow-file-access-from-files',
]

export interface ChromiumRendererOptions {
  /** What a printed page may reach. Defaults to nothing outside the document itself. */
  network?: NetworkPolicy
  /** An explicit browser binary. Falls back to `CRAFT_BROWSER_BIN`, then Playwright's own. */
  executablePath?: string
  /** A Playwright channel (`chrome`, `msedge`) — what a development machine already has. */
  channel?: string
  /** How many jobs may print at once. A document is memory-hungry; two is a hub's default. */
  concurrency?: number
  /** Where the editors live. Defaults to the bundled `office/` assets. */
  appsDir?: string
  /** How long an editor may take to lay a document out and print it. */
  timeoutMs?: number
  /** Where the vendored drawio webapp lives. Defaults to the bundled `drawio/` assets. */
  drawioDir?: string
}

/**
 * Whether a printed page may fetch a URL.
 *
 * `file:`, `data:`, `blob:` and `about:` are always allowed and are not really network: they are
 * how the document itself, and the bytes the editor was handed, arrive. Everything else has to be
 * named by the host — a hub has no reason to let a `.docx` call out, and every reason not to.
 */
export function isAllowedUrl(raw: string, policy: NetworkPolicy = {}): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return true
  }
  const scheme = url.protocol.replace(/:$/, '')
  if (scheme === 'file' || scheme === 'data' || scheme === 'blob' || scheme === 'about') return true
  if (scheme !== 'http' && scheme !== 'https') return false
  return (policy.allowedOrigins ?? []).includes(`${url.protocol}//${url.host}`)
}

/** A tiny counting gate. Printing is bounded because a browser page is the unit of memory here. */
class Gate {
  #active = 0
  #waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#active >= this.limit) await new Promise<void>((resolve) => this.#waiting.push(resolve))
    this.#active += 1
    try {
      return await work()
    } finally {
      this.#active -= 1
      this.#waiting.shift()?.()
    }
  }
}

/** Playwright's types, without taking a compile-time dependency on a package the desktop omits. */
type Browser = {
  isConnected(): boolean
  version(): string
  newContext(options?: Record<string, unknown>): Promise<BrowserContext>
  close(): Promise<void>
}
type BrowserContext = {
  route(pattern: string, handler: (route: Route) => Promise<void> | void): Promise<void>
  newPage(): Promise<Page>
  close(): Promise<void>
  addInitScript(script: string | (() => void)): Promise<void>
  exposeBinding(name: string, fn: (...args: unknown[]) => unknown): Promise<void>
}
type Route = {
  request(): { url(): string }
  continue(): Promise<void>
  abort(reason?: string): Promise<void>
  fulfill(options: Record<string, unknown>): Promise<void>
}
type Page = {
  /** Only used when `CRAFT_RENDER_DEBUG` is set: the editor's own words are the best diagram. */
  on(event: string, handler: (...args: unknown[]) => void): void
  evaluate<T>(fn: (arg?: unknown) => T, arg?: unknown): Promise<T>
  emulateMedia(options: { media?: 'print' | 'screen' }): Promise<void>
  setContent(html: string, options?: Record<string, unknown>): Promise<void>
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>
  evaluate<T>(fn: () => T): Promise<T>
  /** An expression, not a function: `officePageDriver` writes its steps as source. */
  evaluate<T>(expression: string): Promise<T>
  /** What a capture needs: the page's own clock, and the pixels of a rectangle. */
  waitForTimeout(ms: number): Promise<void>
  screenshot(options?: Record<string, unknown>): Promise<Uint8Array>
  pdf(options?: Record<string, unknown>): Promise<Uint8Array>
  close(): Promise<void>
}

export class ChromiumRenderer implements Renderer {
  readonly kind = 'chromium' as const

  #browser: Browser | null = null
  #launching: Promise<Browser> | null = null
  #office: OfficeOrigin | null = null
  #drawio: DrawioOrigin | null = null
  #info: RendererInfo = { kind: 'chromium' }
  #gate: Gate

  constructor(private readonly options: ChromiumRendererOptions = {}) {
    this.#gate = new Gate(options.concurrency ?? positiveInt(process.env.CRAFT_RENDER_CONCURRENCY) ?? 2)
  }

  info(): RendererInfo {
    return this.#info
  }

  /**
   * Start the browser and answer what it is — the probe a host runs at boot.
   *
   * Deliberately **functional**: asking Playwright whether a browser "exists" answers yes for a
   * binary that cannot print, and the price of finding out later is measured in minutes. Here the
   * browser is launched and asked its version, so a host that gets an answer can promise a PDF.
   */
  async probe(): Promise<RendererInfo> {
    try {
      const browser = await this.#ensureBrowser()
      this.#info = { ...this.#info, kind: 'chromium', version: browser.version() }
      return this.#info
    } catch (error) {
      this.#info = { kind: 'none', reason: messageOf(error) }
      throw error
    }
  }

  async print(source: PrintSource, geometry: PrintGeometry = {}): Promise<Uint8Array> {
    return this.#gate.run(async () => {
      const browser = await this.#ensureBrowser()
      const context = await this.#newContext(browser)
      try {
        return await this.#printInContext(context, source, geometry)
      } finally {
        await context.close().catch(() => undefined)
      }
    })
  }

  /**
   * A document printed by **its own editor**, the way the desktop's export window does it.
   *
   * The editor is opened as the top document on this host's own origin, told which file to open
   * and where the result goes, and answered over `/__craft/office-call/<token>` — the same five
   * routes the desktop serves, because it is the same shim inside the same bundle. What differs is
   * who holds the print call: the desktop's main process, or this class, on the page it is driving.
   */
  async printDocument(request: DocumentPrintRequest): Promise<Uint8Array> {
    // A `.pdf` is already the answer, and re-printing it would only lose its text layer.
    if (request.app === 'pdf') return request.bytes

    return this.#gate.run(async () => {
      const browser = await this.#ensureBrowser()
      const origin = await this.#ensureOffice()
      const output = origin.addOutput(request.outPath)
      const fileToken = origin.addDocument(request.path, request.bytes)
      const context = await this.#newContext(browser, { allowedOrigins: [origin.baseUrl] })
      let page: Page | null = null

      const answerer = createDocumentAnswerer({
        app: request.app,
        path: request.path,
        outPath: output.path,
        printOpenPage: async (geometry) => {
          // The docs editor's door: it is the page being driven, and it is waiting on this answer.
          // Measured before this was written: printing it here returns in ~160 ms, not a deadlock.
          if (!page) throw new Error('The editor asked to be printed before it opened.')
          return this.#printPage(page, geometry)
        },
        printMarkup: (html, geometry) => this.#printInContext(context, { kind: 'html', html }, geometry),
        write: async (path, bytes) => {
          await writeFile(path, bytes)
        },
      })
      // The shim's token for a window with a job is the job's: one export, one answer.
      origin.setAnswer(output.token, answerer)

      try {
        page = await context.newPage()
        this.#attachDebug(page, request.app)
        // **Not** `emulateMedia({ media: 'print' })` here, unlike `#printInContext`. `page.pdf()`
        // prints a page as print media by itself, so forcing the media on the live document buys
        // nothing — and costs everything: the Word editor lays its document out on screen, into
        // `.pv-page` boxes, and its print stylesheet shows the *current* page instead. Measured
        // on a 13k-character document: 7 pages laid out, 1 page printed. Removing this line gives
        // 7 of 7 again (and the pages were there all along — nothing was still loading).
        await page.goto(
          `${origin.baseUrl}/office/${request.app}/` +
            `?__craftExport=${encodeURIComponent(fileToken)}` +
            `&__craftHeadless=pdf&__craftOut=${encodeURIComponent(output.token)}`,
          { waitUntil: 'load' },
        )
        // The editor must be laying a document out the way a person sees it. Under print media it
        // shows its print layout instead — one page — and prints exactly that: measured, a 7-page
        // report came back as one page, with a success envelope and nothing else wrong. The call
        // that caused it is gone (see the note above `goto`), and this is what makes its return
        // loud rather than silent: `matchMedia('print')` is true exactly when the page is being
        // emulated as print, and `page.pdf()` below does not change what the page can observe.
        const underPrintMedia = await page.evaluate(() => {
          const matchMedia = (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia
          return matchMedia?.('print').matches === true
        })
        if (underPrintMedia) {
          throw new RenderError(
            'PRINT_FAILED',
            `The ${request.app} editor was opened under print media, so it would print one page of a paginated document instead of all of them.`,
          )
        }

        const timeoutMs = this.options.timeoutMs ?? 30_000
        const report = await Promise.race([output.done, sleep(timeoutMs).then(() => ({ timedOut: true as const }))])
        if ('timedOut' in report) {
          throw new RenderError(
            'PRINT_FAILED',
            `The ${request.app} editor did not finish printing in ${Math.round(timeoutMs / 1000)}s.`,
          )
        }
        if (report.ok === false) {
          throw new RenderError('PRINT_FAILED', report.error ?? `The ${request.app} editor could not print this document.`)
        }
        return new Uint8Array(await readFile(output.path))
      } catch (error) {
        if (error instanceof RenderError) throw error
        throw new RenderError('PRINT_FAILED', `Printing ${request.path} failed: ${messageOf(error)}`, { cause: error })
      } finally {
        origin.releaseDocument(fileToken)
        origin.releaseOutput(output.token)
        await context.close().catch(() => undefined)
      }
    })
  }

  /**
   * One page of a document, photographed in its own editor — the hub's half of the poster route.
   *
   * No PDF and no print: the editor is opened in a page nobody looks at, driven to the page asked
   * for (`officePageDriver`, shared with the desktop), and the rectangle it names is screenshotted.
   * That is 1.0 s for a slide and 1.6 s for a page of a report, against 1.2-4.0 s for printing the
   * file and rasterising one page of it — and it cannot disagree with the editor, because the
   * editor drew it.
   *
   * A `readonly` page: this is a photograph, not a place where a stray keystroke changes a file.
   */
  async captureDocumentPage(request: {
    app: 'docs' | 'sheets' | 'slides'
    path: string
    bytes: Uint8Array
    /** 0-based. A workbook has no pages on screen, so it is answered with its grid. */
    page?: number
    /** A workbook's corner: which sheet, and which cell at the top-left of the picture. */
    target?: { sheet?: string; range?: string }
  }): Promise<Uint8Array> {
    return this.#gate.run(async () => {
      const browser = await this.#ensureBrowser()
      const origin = await this.#ensureOffice()
      const fileToken = origin.addDocument(request.path, request.bytes)
      const output = origin.addOutput()
      // The window is the photograph, and a page is taller than the default 1280x720: a report's
      // page 3 measured 1123 px, so a short viewport clips the picture and the scroll it needs
      // pushes the page's top above zero. `OFFICE_PAGE_WINDOW` is the shape each editor is drawn in.
      const context = await this.#newContext(browser, { allowedOrigins: [origin.baseUrl] }, OFFICE_PAGE_WINDOW[request.app])
      const page = await context.newPage()
      try {
        origin.setAnswer(
          fileToken,
          createDocumentAnswerer({
            app: request.app,
            path: request.path,
            outPath: output.path,
            printOpenPage: async () => {
              throw new RenderError('PRINT_FAILED', 'A page capture does not print.')
            },
            printMarkup: async () => {
              throw new RenderError('PRINT_FAILED', 'A page capture does not print.')
            },
            write: async (path, bytes) => {
              await writeFile(path, bytes)
            },
          }),
        )
        await page.goto(
          // No `readonly=1`: that flag draws a "read-only snapshot" bar across the top, and the
          // picture is supposed to be the page. Nothing types into this page.
          `${origin.baseUrl}/office/${request.app}/?__craftExport=${encodeURIComponent(fileToken)}`,
          { waitUntil: 'load' },
        )
        const clip = await officePageDriver({
          app: request.app,
          page: request.page,
          ...(request.target ? { target: request.target } : {}),
        })({
          run: <T>(script: string) => page.evaluate<T>(script),
          settle: (ms?: number) => page.waitForTimeout(ms ?? 250),
        })
        const png = await page.screenshot({ type: 'png', ...(clip ? { clip } : {}) })
        return new Uint8Array(png)
      } catch (error) {
        if (error instanceof RenderError) throw error
        throw new RenderError('PRINT_FAILED', `Capturing ${request.path} failed: ${messageOf(error)}`, { cause: error })
      } finally {
        origin.releaseDocument(fileToken)
        origin.releaseOutput(output.token)
        await context.close().catch(() => undefined)
      }
    })
  }

  /**
   * An html file as a PNG — the hub's half of `html_tool shot`.
   *
   * **The page's scripts run**, because every picture of a page now does: the desktop serves a
   * previewed page from its own folder (`html-origin.ts`) and photographs it after its scripts
   * paint, so a hub that refused them would answer a different picture for the same file. The page
   * is loaded from the hub's disk (`file://`), where its relative references resolve as they do in
   * the app.
   *
   * **So the wait is part of the job.** The load event is not the end of a page that fetches: the
   * page's own resources come first (images decoded, fonts arrived), then a quiet window for the
   * timers and promises it started, then the network settling — and the picture is taken after all
   * three. Without this a script-built chart is photographed as the skeleton it replaced.
   */
  async captureUrl(request: { url: string; width: number; height: number }): Promise<Uint8Array> {
    return this.#gate.run(async () => {
      const browser = await this.#ensureBrowser()
      const context = await this.#newContext(
        browser,
        { allowedOrigins: [] },
        { width: request.width, height: request.height },
        { javaScriptEnabled: true },
      )
      const page = await context.newPage()
      try {
        await page.goto(request.url, { waitUntil: 'load' })
        await page
          .evaluate(async () => {
            const started = Date.now()
            for (;;) {
              const loaded = document.readyState === 'complete'
              const images = Array.from(document.images).every((image) => image.complete)
              const fonts = !document.fonts || document.fonts.status === 'loaded'
              if (loaded && images && fonts) return true
              if (Date.now() - started > 4000) return false
              await new Promise((done) => setTimeout(done, 100))
            }
          })
          .catch(() => false)
        // One paint after all of that: a capture taken in the same frame is a white rectangle.
        await page.waitForTimeout(700)
        // No `waitForLoadState` in this Playwright build, and `networkidle` would be wrong anyway
        // for a page that polls: two quiet frames are what "it stopped changing" means here.
        await page.waitForTimeout(600)
        return new Uint8Array(await page.screenshot({ type: 'png' }))
      } catch (error) {
        throw new RenderError('PRINT_FAILED', `Drawing ${request.url} failed: ${messageOf(error)}`, { cause: error })
      } finally {
        await context.close().catch(() => undefined)
      }
    })
  }

  /**
   * A `.drawio` drawn by drawio's own webapp — the same engine, on an origin this host serves.
   *
   * The pane used to answer this, which made drawing a diagram depend on a desktop being connected.
   * It does not: the engine is a vendored bundle, the document is a string, and the answer is bytes.
   */
  async renderDrawio(request: DrawioRenderRequest): Promise<Uint8Array> {
    return this.#gate.run(async () => {
      const browser = await this.#ensureBrowser()
      const origin = await this.#ensureDrawio()
      const context = await this.#newContext(browser, { allowedOrigins: [origin.baseUrl] })
      const page = await context.newPage()
      try {
        await page.goto(`${origin.baseUrl}${DRAWIO_ENGINE_PATH}`, { waitUntil: 'load' })
        // One expression, run to completion inside the engine document: `__craftDiagram.render`
        // resolves with the bytes (a `data:` URI) or the markup, and never with a partial drawing.
        const payload = await page.evaluate(
          (args) => {
            const surface = (globalThis as { __craftDiagram?: { render: (options: unknown) => Promise<string> } })
              .__craftDiagram
            if (!surface) return Promise.reject(new Error('The diagram engine did not load.'))
            return Promise.race([
              surface.render(args),
              new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error('The diagram engine did not answer in time.')), 60_000),
              ),
            ])
          },
          {
            xml: documentToDraw(request.xml, request.page),
            format: request.format,
            ...(request.scale !== undefined ? { scale: request.scale } : {}),
            theme: request.theme ?? 'auto',
          },
        )
        return decodeDrawioReply(payload)
      } catch (error) {
        if (error instanceof RenderError) throw error
        throw new RenderError('PRINT_FAILED', `Drawing this diagram failed: ${messageOf(error)}`, { cause: error })
      } finally {
        await page.close().catch(() => undefined)
        await context.close().catch(() => undefined)
      }
    })
  }

  /**
   * Frames out of a recording — `recording_tool` on a host with no window.
   *
   * The work is the shared sampler script, the same one the desktop runs in a hidden window
   * (`@craft-agent/shared/recording/sampler-script`); what differs is only which browser executes it.
   * A `file://` page is used rather than `setContent`, so the video's own scheme is the page's —
   * with `--allow-file-access-from-files` the canvas may read its pixels back.
   */
  async sampleVideo(request: VideoSampleOptions & { path: string }): Promise<SampledVideo> {
    return this.#gate.run(async () => {
      const browser = await this.#ensureBrowser()
      const context = await this.#newContext(browser)
      const scratch = await mkdtemp(join(tmpdir(), 'craft-video-page-'))
      const page = await context.newPage()
      try {
        const htmlPath = join(scratch, 'sampler.html')
        await writeFile(htmlPath, '<!doctype html><meta charset="utf-8"><body></body>')
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'domcontentloaded' })
        const raw = (await page.evaluate(
          buildSamplerScript(pathToFileURL(request.path).href, request),
        )) as SamplerReply
        return decodeSamplerReply(raw)
      } catch (error) {
        if (error instanceof RenderError) throw error
        throw new RenderError('VIDEO_FAILED', `Reading ${request.path} failed: ${messageOf(error)}`, {
          cause: error,
        })
      } finally {
        await page.close().catch(() => undefined)
        await context.close().catch(() => undefined)
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      }
    })
  }

  /**
   * A recording's sound, as a 16 kHz mono WAV — `recording_tool audio` on a host with no window.
   *
   * Same page, same script family as `sampleVideo`; only the answer differs. PCM comes back in
   * chunks because a long recording is tens of megabytes and one `evaluate` reply that size is
   * how a headless browser dies.
   */
  async extractAudio(request: { path: string; outPath: string }): Promise<{
    path: string
    durationMs: number
    sampleRate: number
    byteLength: number
  }> {
    return this.#gate.run(async () => {
      const browser = await this.#ensureBrowser()
      const context = await this.#newContext(browser)
      const scratch = await mkdtemp(join(tmpdir(), 'craft-audio-page-'))
      const page = await context.newPage()
      try {
        const htmlPath = join(scratch, 'audio.html')
        await writeFile(htmlPath, '<!doctype html><meta charset="utf-8"><body></body>')
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'domcontentloaded' })
        const raw = (await page.evaluate(
          buildAudioExtractScript(pathToFileURL(request.path).href),
        )) as AudioExtractReply
        const audio = decodeAudioReply(raw)

        const chunks: Buffer[] = []
        for (let offset = 0; offset < audio.byteLength; offset += AUDIO_CHUNK_BYTES) {
          const base64 = (await page.evaluate(audioChunkExpression(offset, AUDIO_CHUNK_BYTES))) as string
          chunks.push(Buffer.from(base64, 'base64'))
        }

        await mkdir(dirname(request.outPath), { recursive: true })
        await writeFile(request.outPath, wavBytes(Buffer.concat(chunks), audio.sampleRate))
        return { path: request.outPath, ...audio }
      } catch (error) {
        if (error instanceof RenderError) throw error
        throw new RenderError('AUDIO_FAILED', `Reading the sound of ${request.path} failed: ${messageOf(error)}`, {
          cause: error,
        })
      } finally {
        await page.close().catch(() => undefined)
        await context.close().catch(() => undefined)
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      }
    })
  }

  async close(): Promise<void> {
    const browser = this.#browser
    const office = this.#office
    const drawio = this.#drawio
    this.#browser = null
    this.#office = null
    this.#drawio = null
    if (browser) await browser.close().catch(() => undefined)
    if (office) await office.stop().catch(() => undefined)
    if (drawio) await drawio.stop().catch(() => undefined)
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────

  async #ensureBrowser(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser
    this.#launching ??= this.#launch().finally(() => {
      this.#launching = null
    })
    return this.#launching
  }

  async #launch(): Promise<Browser> {
    // Dynamic on purpose: the desktop bundle never needs Playwright, and a static import would put
    // it in a build that cannot use it and in an installer that should not carry it.
    const playwright = await import('playwright-core').catch((error: unknown) => {
      throw new RenderError(
        'RENDERER_UNAVAILABLE',
        'playwright-core is not installed on this host, so nothing can print.',
        { cause: error },
      )
    })

    const executablePath = this.options.executablePath ?? (process.env.CRAFT_BROWSER_BIN?.trim() || undefined)
    const channel = this.options.channel ?? (process.env.CRAFT_BROWSER_CHANNEL?.trim() || undefined)

    try {
      const browser = (await playwright.chromium.launch({
        headless: true,
        args: LAUNCH_ARGS,
        ...(executablePath ? { executablePath } : {}),
        ...(channel ? { channel } : {}),
      })) as unknown as Browser
      this.#browser = browser
      this.#info = {
        kind: 'chromium',
        version: browser.version(),
        ...(executablePath ? { executable: executablePath } : {}),
      }
      return browser
    } catch (error) {
      throw new RenderError(
        'RENDERER_UNAVAILABLE',
        [
          'No Chromium could be launched, so nothing on this host can print.',
          `Set CRAFT_BROWSER_BIN to a chromium binary (or CRAFT_BROWSER_CHANNEL to an installed channel).`,
          messageOf(error),
        ].join(' '),
        { cause: error },
      )
    }
  }

  async #newContext(
    browser: Browser,
    policy: NetworkPolicy = this.options.network ?? {},
    viewport?: { width: number; height: number },
    extra: Record<string, unknown> = {},
  ): Promise<BrowserContext> {
    const context = await browser.newContext({ ...(viewport ? { viewport } : {}), ...extra })
    await context.route('**/*', (route: Route) => {
      if (isAllowedUrl(route.request().url(), policy)) return route.continue()
      return route.abort('blockedbyclient')
    })
    return context
  }

  /**
   * The origin the editors are served from, started on first use.
   *
   * One per renderer, not one per export: the bundle is a few thousand files and a fresh server per
   * document would pay for the same reads every time.
   */
  async #ensureOffice(): Promise<OfficeOrigin> {
    if (this.#office) return this.#office
    const appsDir = this.options.appsDir ?? getBundledAssetsDir('office')
    if (!appsDir) {
      throw new RenderError(
        'EDITOR_NOT_SERVED',
        'The office editors are not installed in this build (run: bun scripts/build-office-assets.ts), so no document can be printed.',
      )
    }
    const origin = new OfficeOrigin({ appsDir, timeoutMs: this.options.timeoutMs })
    await origin.start()
    this.#office = origin
    return origin
  }

  /**
   * The editor's console, when somebody is looking.
   *
   * A printing failure is almost always one of two things — a request that did not arrive, or a
   * question the host answered with nothing — and neither is visible from the outside. Gated by
   * an env var because a working export should print nothing at all.
   */
  #attachDebug(page: Page, app: string): void {
    if (!process.env.CRAFT_RENDER_DEBUG) return
    page.on('console', (...args: unknown[]) => {
      const message = args[0] as { text?: () => string } | undefined
      process.stderr.write(`[editor:${app}] ${typeof message?.text === 'function' ? message.text() : String(args[0])}\n`)
    })
    page.on('requestfailed', (...args: unknown[]) => {
      const request = args[0] as { url?: () => string; failure?: () => { errorText?: string } | null } | undefined
      process.stderr.write(`[editor:${app}] request failed: ${request?.url?.() ?? '?'} ${request?.failure?.()?.errorText ?? ''}\n`)
    })
    page.on('pageerror', (...args: unknown[]) => {
      process.stderr.write(`[editor:${app}] page error: ${String(args[0])}\n`)
    })
    page.on('response', (...args: unknown[]) => {
      const response = args[0] as { status?: () => number; url?: () => string } | undefined
      const status = response?.status?.() ?? 0
      if (status >= 400) process.stderr.write(`[editor:${app}] ${status} ${response?.url?.() ?? '?'}\n`)
    })
  }

  /** The origin drawio's bundle and engine are served from, started on first use. */
  async #ensureDrawio(): Promise<DrawioOrigin> {
    if (this.#drawio) return this.#drawio
    const dir = this.options.drawioDir ?? getBundledAssetsDir('drawio')
    if (!dir) {
      throw new RenderError(
        'DRAWIO_NOT_SERVED',
        'The bundled drawio webapp is not installed, so no diagram can be drawn (run: bun scripts/fetch-drawio-assets.ts).',
      )
    }
    const origin = new DrawioOrigin({ dir })
    await origin.start()
    this.#drawio = origin
    return origin
  }

  /** Load a source into a page of this context, then print it. */
  async #printInContext(
    context: BrowserContext,
    source: PrintSource,
    geometry: PrintGeometry,
  ): Promise<Uint8Array> {
    const page = await context.newPage()
    try {
      // `@media print` is what a print stylesheet is *for*; without this the page prints as it
      // looks on screen, which is how a document comes out with its toolbar and no page boxes.
      await page.emulateMedia({ media: 'print' })
      if (source.kind === 'html') {
        await page.setContent(source.baseHref ? withBaseHref(source.html, source.baseHref) : source.html, {
          waitUntil: 'load',
        })
      } else {
        await page.goto(source.url, { waitUntil: 'load' })
      }
      return await this.#printPage(page, geometry)
    } catch (error) {
      throw new RenderError('PRINT_FAILED', `Printing failed: ${messageOf(error)}`, { cause: error })
    } finally {
      await page.close().catch(() => undefined)
    }
  }

  async #printPage(page: Page, geometry: PrintGeometry): Promise<Uint8Array> {
    // Fonts decide line breaks and therefore page breaks. Printing before they are ready does not
    // fail; it paginates the fallback face and says nothing.
    await page
      .evaluate(() => (globalThis as { document?: { fonts?: { ready?: Promise<unknown> } } }).document?.fonts?.ready)
      .catch(() => undefined)
    return new Uint8Array(await page.pdf(pdfOptions(geometry)))
  }
}

/** Chromium's print options, in the units it takes: inches, and a `'8.5in'`-style string. */
function pdfOptions(geometry: PrintGeometry): Record<string, unknown> {
  const sized = geometry.widthIn && geometry.heightIn
  return {
    printBackground: geometry.printBackground ?? true,
    // A document's own `@page` size is the honest default: every office editor sets one, and a
    // caller that knows better names both dimensions.
    ...(sized
      ? { width: `${geometry.widthIn}in`, height: `${geometry.heightIn}in` }
      : { preferCSSPageSize: true }),
    ...(geometry.landscape === undefined ? {} : { landscape: geometry.landscape }),
    ...(geometry.marginsIn
      ? {
          margin: {
            top: `${geometry.marginsIn.top}in`,
            bottom: `${geometry.marginsIn.bottom}in`,
            left: `${geometry.marginsIn.left}in`,
            right: `${geometry.marginsIn.right}in`,
          },
        }
      : {}),
    ...(geometry.scale && geometry.scale > 0 ? { scale: geometry.scale } : {}),
    ...(geometry.pageRanges ? { pageRanges: geometry.pageRanges } : {}),
  }
}

/**
 * The document the engine is given: the whole file, or only the page that was asked for.
 *
 * A page is cut out rather than pointed at because the editor's export takes a page id for a PNG
 * and for nothing else — an SVG, an editable SVG and an HTML page all come from whichever page is
 * *current*, which after a load is the first one.
 *
 * Throws when the name matches no page, or two: drawio's own answer to a page it cannot find is to
 * draw the first one and say nothing, and that is the one outcome this must not pass on.
 */
function documentToDraw(xml: string, page: string | undefined): string {
  if (!page) return xml
  const lookup = findDrawioPage(xml, page)
  if (!lookup.ok) throw new Error(describeDrawioPageProblem(page, lookup))
  const projected = projectDrawioPage(xml, lookup.page.id)
  if (projected === null) throw new Error(`The page "${page}" is not one this document can be drawn from on its own.`)
  return projected
}

/**
 * The engine hands its answer back the way its own host expects it: a `data:` URI for the formats
 * that are bytes, markup for the ones that are text.
 *
 * Both spellings of the URI are handled (`;base64,` and a URL-encoded payload) because which one
 * drawio uses differs by format — the SVG exports are URL-encoded, the PNGs are not — and getting
 * this wrong yields a file that looks plausible and opens as nothing.
 */
function decodeDrawioReply(data: string): Uint8Array {
  const uri = /^data:([^,]*),(.*)$/s.exec(data)
  if (!uri) return new TextEncoder().encode(data)
  const [, meta = '', payload = ''] = uri
  return meta.includes(';base64')
    ? new Uint8Array(Buffer.from(payload, 'base64'))
    : new TextEncoder().encode(decodeURIComponent(payload))
}

/** Relative URLs need a base when the markup is handed over rather than loaded from a URL. */
function withBaseHref(html: string, baseHref: string): string {
  if (/<base\s/i.test(html)) return html
  const tag = `<base href="${baseHref.replace(/"/g, '&quot;')}">`
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => `${head}${tag}`) : `${tag}${html}`
}

function positiveInt(value: string | undefined): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
