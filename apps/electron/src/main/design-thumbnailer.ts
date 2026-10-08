/**
 * Design thumbnail capture (Electron main).
 *
 * Renders a design in an offscreen, opaque-sandboxed window exactly like
 * DesignFrame (see design-thumbnail-host.ts), captures a poster with
 * `webContents.capturePage`, and writes designs/{slug}/thumbnail.jpg + stamps
 * `DesignConfig.thumbnail` via `recordDesignThumbnail`. Captures run one-at-a-time
 * through a queue that coalesces duplicate slugs; every failure is swallowed
 * (the design just stays posterless and the grid falls back to the placeholder).
 *
 * This is the only capture surface in the stack — it exists in Electron main
 * only. Headless/WebUI hosts never construct it; SessionManager's
 * `enqueueDesignThumbnail` becomes a no-op there and tiles fall back.
 */

import { BrowserWindow } from 'electron'
import { renameSync, writeFileSync } from 'node:fs'
import {
  computeDesignContentDigest,
  designPreviewUrl,
  getDesignPath,
  getDesignThumbnailPath,
  loadDesignConfig,
  loadDesignContent,
  readDesignDataSnapshot,
  recordDesignThumbnail,
} from '@craft-agent/shared/designs'
import {
  THUMB_JPEG_QUALITY,
  THUMB_LOGICAL_HEIGHT,
  THUMB_LOGICAL_WIDTH,
  THUMB_OUTPUT_HEIGHT,
  THUMB_OUTPUT_WIDTH,
  buildThumbnailHostHtml,
} from './design-thumbnail-host'

export interface ThumbnailRequest {
  workspaceId: string
  workspaceRootPath: string
  slug: string
}

export interface DesignThumbnailerOptions {
  /** Called after a poster is written + design.json stamped, so the host can broadcast designs:changed. */
  onCaptured?: (req: ThumbnailRequest) => void
  log?: (message: string) => void
}

/** How long to let the iframe load + paint + apply its snapshot before capturing. */
const RENDER_SETTLE_MS = 550
/** Capture retries when the first frame comes back empty (hidden-window paint race). */
const CAPTURE_RETRIES = 3
const CAPTURE_RETRY_DELAY_MS = 250
/** Hard ceiling on one capture so a hung design can't wedge the queue. */
const CAPTURE_TIMEOUT_MS = 15_000

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class DesignThumbnailer {
  private readonly queue: ThumbnailRequest[] = []
  private readonly pending = new Set<string>()
  private running = false

  constructor(private readonly options: DesignThumbnailerOptions = {}) {}

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
            `[design-thumbnailer] capture failed for ${req.slug}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    } finally {
      this.running = false
    }
  }

  private async capture(req: ThumbnailRequest): Promise<void> {
    const { workspaceRootPath, slug } = req
    const config = loadDesignConfig(workspaceRootPath, slug)
    if (!config) return // design deleted between enqueue and run

    const content = loadDesignContent(workspaceRootPath, slug)
    if (content === null || content.trim() === '') return // nothing to render

    const digest = config.contentDigest ?? computeDesignContentDigest(content)
    // Already have a fresh poster (e.g. duplicate enqueue) — skip the work.
    if (config.thumbnail?.digest === digest) return

    const snapshot = readDesignDataSnapshot(workspaceRootPath, slug)
    // Rendered from the design's address, so a design that keeps assets beside its
    // document (the reason it is a folder) is captured as it really looks.
    const previewUrl = designPreviewUrl(slug, getDesignPath(workspaceRootPath, slug))
    const html = buildThumbnailHostHtml({ content, slug, snapshot, previewUrl })

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
    // Ask for it again: a hidden window can be clamped by the platform, and the design
    // composes itself against whatever it is actually given (see renderAndCapture).
    win.setContentSize(THUMB_LOGICAL_WIDTH, THUMB_LOGICAL_HEIGHT)

    try {
      const buffer = await this.withTimeout(this.renderAndCapture(win, html, slug), CAPTURE_TIMEOUT_MS)
      if (!buffer) {
        this.options.log?.(`[design-thumbnailer] empty capture for ${slug}; leaving posterless`)
        return
      }

      const target = getDesignThumbnailPath(workspaceRootPath, slug)
      const tmp = `${target}.tmp`
      writeFileSync(tmp, buffer)
      renameSync(tmp, target)

      // Re-check the design still exists (could be deleted mid-capture) before stamping.
      if (!loadDesignConfig(workspaceRootPath, slug)) return
      recordDesignThumbnail(workspaceRootPath, slug, {
        digest,
        capturedAt: Date.now(),
        width: THUMB_OUTPUT_WIDTH,
        height: THUMB_OUTPUT_HEIGHT,
      })
      this.options.onCaptured?.(req)
      this.options.log?.(`[design-thumbnailer] captured poster for ${slug}`)
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }

  private async renderAndCapture(win: BrowserWindow, html: string, slug: string): Promise<Buffer | null> {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    // did-finish-load (awaited above) only covers the host doc; give the
    // sandboxed iframe + its scripts + the snapshot render time to settle.
    await delay(RENDER_SETTLE_MS)

    // What the design was actually rendered against. An iframe has its own default size
    // (300×150) before layout, so a design that composes itself on load can be looking at a
    // viewport that no longer exists — which is how a poster comes out off-centre or clipped.
    // Measured, not assumed, so the log settles it instead of a guess.
    const [contentWidth, contentHeight] = win.getContentSize()
    const frameSize: [number, number] | null = await win.webContents
      .executeJavaScript(
        '(() => { const f = document.getElementById("frame"); if (!f) return null; const r = f.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] })()',
        true,
      )
      .catch(() => null)
    this.options.log?.(
      `[design-thumbnailer] ${slug}: window content ${contentWidth}x${contentHeight}, frame ${frameSize ? frameSize.join('x') : '?'}`,
    )

    for (let attempt = 0; attempt < CAPTURE_RETRIES; attempt++) {
      if (win.isDestroyed()) return null
      // An explicit rect of the logical viewport: whatever size the platform gave the window,
      // the still is 16:10 and the resize below cannot stretch it.
      const image = await win.webContents.capturePage(
        { x: 0, y: 0, width: THUMB_LOGICAL_WIDTH, height: THUMB_LOGICAL_HEIGHT },
        { stayHidden: true, stayAwake: true },
      )
      if (!image.isEmpty()) {
        const size = image.getSize()
        this.options.log?.(
          `[design-thumbnailer] ${slug}: capture ${size.width}x${size.height} → ${THUMB_OUTPUT_WIDTH}x${THUMB_OUTPUT_HEIGHT}`,
        )
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
