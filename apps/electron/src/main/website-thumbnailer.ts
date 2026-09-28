/**
 * Website thumbnail capture (Electron main).
 *
 * Renders a website in an offscreen, opaque-sandboxed window **at its own origin** —
 * the same address the browser window opens, `http://<label>.localhost/` — captures a
 * poster with `webContents.capturePage`, and writes websites/{slug}/thumbnail.jpg +
 * stamps `WebsiteConfig.thumbnail` via `recordWebsiteThumbnail`. Loading the address
 * (rather than a host document that frames it) is what makes the poster the site as it
 * really renders: its own files resolve by root-absolute path and its own scripts run.
 * Captures run one-at-a-time through a queue that coalesces duplicate slugs; every
 * failure is swallowed (the website just stays posterless and the grid falls back to
 * the placeholder).
 *
 * This is the only capture surface in the stack — it exists in Electron main
 * only. Headless/WebUI hosts never construct it; SessionManager's
 * `enqueueWebsiteThumbnail` becomes a no-op there and tiles fall back.
 */

import { BrowserWindow } from 'electron'
import { renameSync, writeFileSync } from 'node:fs'
import {
  computeWebsiteContentDigest,
  getWebsiteThumbnailPath,
  loadWebsiteConfig,
  loadWebsiteContent,
  recordWebsiteThumbnail,
} from '@craft-agent/shared/websites'
import { websiteOriginUrl } from './website-host'

export interface ThumbnailRequest {
  workspaceId: string
  workspaceRootPath: string
  slug: string
}

export interface WebsiteThumbnailerOptions {
  /** Called after a poster is written + website.json stamped, so the host can broadcast websites:changed. */
  onCaptured?: (req: ThumbnailRequest) => void
  log?: (message: string) => void
}

/** Logical render viewport (16:10) the offscreen window uses. */
const THUMB_LOGICAL_WIDTH = 1000
const THUMB_LOGICAL_HEIGHT = 625
/** Stored poster width (height derived 16:10); keeps some retina crispness. */
const THUMB_OUTPUT_WIDTH = 800
const THUMB_OUTPUT_HEIGHT = 500
/** JPEG quality for the stored poster. */
const THUMB_JPEG_QUALITY = 82

/** How long to let the page load + paint + run its scripts before capturing. */
const RENDER_SETTLE_MS = 550
/** Capture retries when the first frame comes back empty (hidden-window paint race). */
const CAPTURE_RETRIES = 3
const CAPTURE_RETRY_DELAY_MS = 250
/** Hard ceiling on one capture so a hung website can't wedge the queue. */
const CAPTURE_TIMEOUT_MS = 15_000

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class WebsiteThumbnailer {
  private readonly queue: ThumbnailRequest[] = []
  private readonly pending = new Set<string>()
  private running = false

  constructor(private readonly options: WebsiteThumbnailerOptions = {}) {}

  private key(req: ThumbnailRequest): string {
    return `${req.workspaceRootPath}::${req.slug}`
  }

  /** Queue a (re)capture. Coalesces duplicate slugs; the run reads latest from disk. */
  enqueue(req: ThumbnailRequest): void {
    const key = this.key(req)
    if (this.pending.has(key)) return
    this.pending.add(key)
    this.queue.push(req)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) {
        const req = this.queue.shift()!
        this.pending.delete(this.key(req))
        try {
          await this.capture(req)
        } catch (error) {
          this.options.log?.(
            `[website-thumbnailer] capture failed for ${req.slug}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    } finally {
      this.running = false
    }
  }

  private async capture(req: ThumbnailRequest): Promise<void> {
    const { workspaceRootPath, slug } = req
    const config = loadWebsiteConfig(workspaceRootPath, slug)
    if (!config) return // website deleted between enqueue and run

    // Registering is what makes the address answer, so a poster is only ever
    // captured for a site this run has been asked to show — and the origin it hands
    // back is what the offscreen window loads (an unregistered label would be
    // answered by Chromium, not by us). Null means the directory is gone.
    const origin = websiteOriginUrl(workspaceRootPath, slug)
    if (!origin) return

    const content = loadWebsiteContent(workspaceRootPath, slug)
    if (content === null || content.trim() === '') return // nothing to render

    const digest = config.contentDigest ?? computeWebsiteContentDigest(content)
    // Already have a fresh poster (e.g. duplicate enqueue) — skip the work.
    if (config.thumbnail?.digest === digest) return

    const win = new BrowserWindow({
      show: false,
      width: THUMB_LOGICAL_WIDTH,
      height: THUMB_LOGICAL_HEIGHT,
      useContentSize: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Keep the render deterministic regardless of the user's display.
        zoomFactor: 1,
      },
    })

    try {
      const buffer = await this.withTimeout(this.renderAndCapture(win, origin), CAPTURE_TIMEOUT_MS)
      if (!buffer) {
        this.options.log?.(`[website-thumbnailer] empty capture for ${slug}; leaving posterless`)
        return
      }

      const target = getWebsiteThumbnailPath(workspaceRootPath, slug)
      const tmp = `${target}.tmp`
      writeFileSync(tmp, buffer)
      renameSync(tmp, target)

      // Re-check the website still exists (could be deleted mid-capture) before stamping.
      if (!loadWebsiteConfig(workspaceRootPath, slug)) return
      recordWebsiteThumbnail(workspaceRootPath, slug, {
        digest,
        capturedAt: Date.now(),
        width: THUMB_OUTPUT_WIDTH,
        height: THUMB_OUTPUT_HEIGHT,
      })
      this.options.onCaptured?.(req)
      this.options.log?.(`[website-thumbnailer] captured poster for ${slug}`)
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }

  private async renderAndCapture(win: BrowserWindow, origin: string): Promise<Buffer | null> {
    await win.loadURL(origin)
    // did-finish-load (awaited above) covers the document; give its scripts and the
    // paint that follows time to settle before reading the frame.
    await delay(RENDER_SETTLE_MS)

    for (let attempt = 0; attempt < CAPTURE_RETRIES; attempt++) {
      if (win.isDestroyed()) return null
      const image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      if (!image.isEmpty()) {
        const resized = image.resize({
          width: THUMB_OUTPUT_WIDTH,
          height: THUMB_OUTPUT_HEIGHT,
          quality: 'best',
        })
        const jpeg = resized.toJPEG(THUMB_JPEG_QUALITY)
        if (jpeg && jpeg.length > 0) return jpeg
      }
      await delay(CAPTURE_RETRY_DELAY_MS)
    }
    return null
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    // Keep the losing branch handled: on timeout the caller's finally destroys
    // the window while renderAndCapture's loadURL is still pending, and that
    // later rejection (ERR_ABORTED) would surface as an unhandled rejection.
    promise.catch(() => {})
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`capture timed out after ${ms}ms`)), ms)),
    ])
  }
}
