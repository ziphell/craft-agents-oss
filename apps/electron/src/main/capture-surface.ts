/**
 * One hidden window, one picture — the flow every poster shares.
 *
 * Four kinds of poster are not a PDF page: markdown set on a page, an html file, a diagram drawn by
 * the app's own viewer, and — since the office formats stopped being printed — a document's first
 * page as its editor lays it out. They differ in what they load and in what has to happen to the
 * page before it is worth photographing; in nothing else. A window nobody sees, one paint, one
 * `capturePage()`.
 *
 * Keeping that in one place is not tidiness. Each of these used to be its own function, and each
 * learned the same two lessons separately:
 *
 * - **A capture taken in the same frame as `did-finish-load` is a white rectangle.** Hence the
 *   settle delay below — 250 ms, measured against the pages this app draws, not guessed.
 * - **The window is the photograph.** Anything that would paint a scrollbar, a toolbar or a
 *   letterbox bar into the picture has to be dealt with *in the page*: the window has no chrome to
 *   trim and nothing outside it knows where the content is. So the page answers with the rectangle
 *   it wants photographed, and the thing that asks it is a `prepare` the caller writes — in Node,
 *   where the rules live (which element is the page, how a drawing is fitted into its box).
 *
 * JavaScript is off unless a caller says otherwise. A poster needs layout, and a page somebody
 * else wrote should not be executed to make a thumbnail of it. The two callers that need it are
 * the ones whose picture is drawn by script — drawio's viewer, and an office editor — and for
 * those the safety comes from the origin instead: both are pages this app serves.
 */

import { BrowserWindow, type NativeImage, type WebPreferences } from 'electron'
import { surfaceClipFrom } from './creation-poster'

export interface SurfaceSize {
  width: number
  height: number
}

/** What was photographed, in CSS pixels — the page decides, because it knows where its content is. */
export interface SurfaceClip {
  x: number
  y: number
  width: number
  height: number
}

/** The page, as the caller's `prepare` sees it. */
export interface SurfaceDriver {
  /** Run an expression in the page and answer with its value. Promises are awaited. */
  run<T = unknown>(script: string): Promise<T>
  /** Let the page paint once more — for a reflow the caller caused (a transform, a resize). */
  settle(ms?: number): Promise<void>
}

export interface SurfaceRequest {
  /** What the window loads. `craft-local://` for the things this app serves. */
  url?: string
  /**
   * Or how it loads, for a page that cannot be named as a URL.
   *
   * The markdown poster opens the app's **own bundle** with a query, and in a packaged build that
   * is `loadFile(__dirname/renderer/index.html, { query })` — the path exists only at runtime.
   */
  load?: (win: BrowserWindow) => Promise<void>
  /** The window's own size. It is also the picture's size when `prepare` names no clip. */
  size?: SurfaceSize
  /** `false` (the default) keeps the page from executing anything of its own. */
  javascript?: boolean
  /**
   * Do whatever this page needs before it is photographed, and answer with the clip to take.
   *
   * Throwing means "this page never became worth a picture": the caller that wanted the picture
   * says so, and a caller with a second route (printing, for a document) takes it. Returning
   * nothing photographs the whole window.
   */
  prepare?: (surface: SurfaceDriver) => Promise<SurfaceClip | null | void>
  /** A paint after `prepare` finishes. Defaults to 250 ms; a caller that already waited passes 0. */
  settleMs?: number
  /**
   * Take the picture again after this long, keeping whichever frame carries more ink.
   *
   * A page whose scripts paint *after* its own skeleton is a picture taken too early: the skeleton
   * is already enough ink to pass `isPicture`, so the retry loop below stops before the content
   * arrives. One confirmation sample is what "wait for the page's scripts" costs.
   */
  confirmAfterMs?: number
  timeoutMs?: number
  /**
   * A preload for a page that needs one verb from the app.
   *
   * The markdown poster is the only caller: it draws the real `<Markdown>`, whose file-naming blocks
   * read through the platform, and a window with no preload has no platform to read with.
   */
  preload?: string
  /**
   * The window itself, for a caller that must register something against it before it loads.
   */
  onWindow?: (win: BrowserWindow) => void
  /**
   * How much page this window has to hold, in CSS pixels — zoomed out to fit when it does not.
   *
   * A window cannot be larger than the screen: asked for 1000×1400 on a 1440×960 desktop, Windows
   * hands back 987×851, and an A4 page (794×1123) then starts above the window. The measured box
   * begins at a negative `y`, the capture is clamped to the window's top, and the poster comes back
   * as the editor's ribbon over an empty pagef — a picture of the wrong thing that no caller can
   * detect. Zooming the page to fit makes the box lie inside the window at any screen size, which is
   * what a poster wants anyway: a card is a 16:9 slot and the poster keeps up to 1600 px on its
   * long edge, so a page drawn at 70% is still more than it can show.
   */
  fit?: SurfaceSize
  /**
   * The page's own zoom — 1 unless the caller wants logical and physical pixels to be independent.
   *
   * The markdown poster asks for 2 raster px per CSS px (`2 / displayScale`, lowered only when the
   * screen cannot hold the window) and sizes its window to match, so an 800 CSS px layout is
   * captured as 1600 raster px on a 1× screen as well as on a Retina one.
   */
  zoom?: number
}

/**
 * Is this picture something a card could show, or a window that has not drawn yet?
 *
 * A capture taken before the editor painted is not an error, and it does not look like one: it is a
 * white rectangle, a black slideshow stage, or — measured, and the reason this exists — an editor
 * with one word on it ("Opening…"). All three used to be written as a poster and kept for ever,
 * which is why "this never renders" was true of a card whose file never changed again.
 *
 * `ink` is the share of sampled pixels that differ from the corner pixel, which separates "a page
 * with words on it" from "a window with a status line above the word Opening". The floor is
 * deliberately low — a title page is mostly white — and a genuinely blank document ends up with no
 * poster, which is the honest answer.
 */
const MIN_INK = 0.008

function inkFraction(image: NativeImage): number {
  const { width, height } = image.getSize()
  if (!width || !height) return 0
  const pixels = image.toBitmap() // BGRA
  const [r, g, b] = [pixels[0] ?? 0, pixels[1] ?? 0, pixels[2] ?? 0]
  // Every fourth pixel: more than enough samples on a 1974×1702 capture to tell text from an empty
  // window, and one pass over memory rather than a full scan.
  let total = 0
  let inked = 0
  for (let i = 0; i < pixels.length; i += 16) {
    total++
    if (Math.abs(pixels[i]! - r) > 8 || Math.abs(pixels[i + 1]! - g) > 8 || Math.abs(pixels[i + 2]! - b) > 8) {
      inked++
    }
  }
  return total === 0 ? 0 : inked / total
}

/** A picture worth keeping: not empty, not one colour, and with more on it than a loading label. */
function isPicture(image: NativeImage): boolean {
  if (image.isEmpty()) return false
  return inkFraction(image) >= MIN_INK
}

export interface SurfaceCapture {
  png: Buffer
  /** What was photographed, in CSS px; `null` when it was the whole window. */
  clip: SurfaceClip | null
}

const DEFAULT_SIZE: SurfaceSize = { width: 1000, height: 625 }
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_SETTLE_MS = 250
/**
 * The waits before each retry of a capture that came back too empty to be a poster.
 *
 * An editor that is still opening the document shows its own loading line, which is enough ink to
 * pass a "not blank" test and not enough to be a picture of anything. Measured on a two-page brief:
 * the first frame worth photographing arrives about 2 s after the preview opens.
 */
const RETRY_WAITS_MS = [500, 1200, 2200]

/** A window that draws a page and hands back one image, or `null` when there was nothing to see. */
export async function captureSurface(request: SurfaceRequest): Promise<SurfaceCapture | null> {
  const size = request.size ?? DEFAULT_SIZE
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const webPreferences: WebPreferences = {
    sandbox: true,
    nodeIntegration: false,
    contextIsolation: true,
    javascript: request.javascript === true,
    ...(request.preload ? { preload: request.preload } : {}),
  }

  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    // The size is the **page's**, not the window frame's. Without this, a request for 1250×849
    // arrives as 1237×788 — the frame eats 13 px across and 61 down at this scale — and a caller that
    // did arithmetic on those numbers (a workbook, whose grid has to be 16:9 under its ribbon) is 8%
    // short without anything saying so.
    useContentSize: true,
    width: size.width,
    height: size.height,
    webPreferences,
  })

  try {
    request.onWindow?.(win)

    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the page did not finish loading')), timeoutMs)
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve()
      })
      win.webContents.once('did-fail-load', (_event, code, description) => {
        clearTimeout(timer)
        reject(new Error(`load failed (${code}) ${description}`))
      })
    })
    if (request.load) await request.load(win)
    else if (request.url) await win.loadURL(request.url)
    else throw new Error('a surface needs a url or a load')
    await loaded

    // A capture window runs at the caller's zoom — 1 unless it asked for a pixel ratio (the markdown
    // poster does, so 800 logical px can be 1600 physical on any display). Chromium remembers a zoom
    // **per origin**, so an editor somebody zoomed out once left `craft-local://office` at 78% for
    // every window after it — and the page's own idea of its width then disagreed with the window the
    // picture is taken from. Setting it explicitly is what keeps those two in the same units.
    const baseZoom = request.zoom ?? 1
    win.webContents.setZoomFactor(baseZoom)
    if (Math.abs(baseZoom - 1) > 0.001) await new Promise((resolve) => setTimeout(resolve, 200))

    // A window is never bigger than the screen; the page may be. Fit it before anything is measured.
    if (request.fit) {
      const content = win.getContentBounds()
      // CSS pixels, not DIP: the window's own zoom decides how many DIP one CSS pixel takes.
      const cssWidth = content.width / baseZoom
      const cssHeight = content.height / baseZoom
      const fitZoom = Math.min(1, cssWidth / request.fit.width, cssHeight / request.fit.height)
      if (fitZoom < 0.999) {
        win.webContents.setZoomFactor(baseZoom * fitZoom)
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }

    const driver: SurfaceDriver = {
      run: <T>(script: string) => win.webContents.executeJavaScript(script) as Promise<T>,
      settle: (ms = DEFAULT_SETTLE_MS) => new Promise((resolve) => setTimeout(resolve, ms)),
    }

    const clip = surfaceClipFrom(await request.prepare?.(driver))
    await driver.settle(request.settleMs ?? DEFAULT_SETTLE_MS)

    // A picture taken before the page painted is retried rather than stored: the only cost of a
    // retry is a second or two of a lane, and the cost of not retrying is a white card for ever.
    let image = clip
      ? await win.webContents.capturePage(clip)
      : await win.webContents.capturePage()
    for (const wait of RETRY_WAITS_MS) {
      if (isPicture(image)) break
      if (process.env.CRAFT_CAPTURE_PROBE === '1') {
        console.log(`[capture] not a picture yet, retry in ${wait} ms`)
      }
      await driver.settle(wait)
      image = clip ? await win.webContents.capturePage(clip) : await win.webContents.capturePage()
    }

    if (process.env.CRAFT_CAPTURE_PROBE === '1') {
      const bounds = win.getContentBounds()
      const size = image.getSize()
      console.log(
        `[capture] window ${bounds.width}x${bounds.height} clip ${JSON.stringify(clip)} ` +
          `image ${size.width}x${size.height} ink ${(inkFraction(image) * 100).toFixed(1)}%${isPicture(image) ? '' : ' NOT A PICTURE'}`,
      )
    }
    // A picture that was still being drawn: look one more time, and keep the fuller frame. Only the
    // caller that knows its page may still be painting asks for this (a document editor has its own
    // readiness signals above).
    if (request.confirmAfterMs && isPicture(image)) {
      await driver.settle(request.confirmAfterMs)
      const later = clip ? await win.webContents.capturePage(clip) : await win.webContents.capturePage()
      if (inkFraction(later) >= inkFraction(image)) image = later
    }

    if (!isPicture(image)) return null
    return { png: image.toPNG(), clip }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
