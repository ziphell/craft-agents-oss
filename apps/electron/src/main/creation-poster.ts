/**
 * The pure half of a poster: the cache key and the markdown page.
 *
 * No `electron` import anywhere in this file: the decisions worth testing are decisions, not
 * windows. What is left in `creation-thumbnailer.ts` is the part that needs a browser.
 */

import { createHash } from 'node:crypto'

/**
 * The white page a **diagram** is shown whole on — logical pixels, 1×.
 *
 * A page keeps its own shape and the card crops it with CSS; a diagram does not — its shape is
 * its content, and a flowchart cut down the middle is not a smaller diagram, it is a wrong one.
 * So the one `contain` route gets a 1600×900 page to sit on, at the engine's own 1× size: this
 * route has no density step, and the drawing is only shrunk when it is larger than the page.
 */
export const DIAGRAM_CANVAS_WIDTH = 1600
export const DIAGRAM_CANVAS_HEIGHT = 900

/**
 * Bumped whenever a poster would come out looking different: geometry, the markdown page, the
 * rendering route.
 *
 * It is part of the file name, so a change here retires every picture already on disk instead of
 * showing last week's crop beside this week's. `siblingPostersToDelete` then removes the old one
 * as soon as the new one exists — no migration, no orphan.
 */
/**
 * `page-16x9/5` — every card drawn while the poster window had scripting off, which is every card
 * whose picture is white: a React component does not mount without its script.
 *
 * `/2` retired the printed office posters, `/3` the markdown ones drawn as a sheet of paper, `/4`
 * the office ones made before the capture waited for the document, `/5` the white ones, `/6` the
 * ones taken in a window smaller than the page, `/7` the two printed documents (a Word page and a
 * slide, drawn from the PDF instead of photographed in an editor), `/8` every html poster made
 * while a page's scripts were refused (a script-built page photographed as its skeleton), `/9` the
 * 800 px ones that were stretched on a high-density display, `/10` the 16:9-cropped ones whose
 * crop belongs to the card (CSS), not to the stored picture, `/11` the diagrams drawn at 2× (this
 * route is 1× on a 1600×900 logical page). The string is part of the file name, so a bump retires
 * them in place — no migration, no orphan.
 */
const POSTER_RECIPE = 'poster/11'

/**
 * A poster belongs to a **document**, and its name says so.
 *
 * `<document hash>-<version hash>.jpg` — the first half is what the file is, the second half is
 * which version of it the picture shows. Splitting them is what makes the cache maintainable: a
 * new version can delete its siblings without a manifest, and a poster whose document is gone can
 * be found by a prefix it shares with nothing else.
 */
export function posterStem(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 10)
}

export function posterFileName(path: string, mtimeMs: number, bytes: number): string {
  const version = createHash('sha1').update(`${mtimeMs}|${bytes}|${POSTER_RECIPE}`).digest('hex').slice(0, 10)
  return `${posterStem(path)}-${version}.jpg`
}

/** Every poster's name matches this: two hashes and the poster suffix. */
const POSTER_NAME = /^[0-9a-f]{10}-[0-9a-f]{10}\.jpg$/

export function isPosterFile(name: string): boolean {
  return POSTER_NAME.test(name)
}

/** The document a poster file belongs to, or null when the name is not a poster's. */
export function posterStemOf(name: string): string | null {
  return isPosterFile(name) ? name.slice(0, 10) : null
}

/**
 * The posters to unlink so that one document keeps exactly one picture.
 *
 * `keep` is the file just written (or about to be): everything else with the same document stem is
 * a previous version and is garbage the moment the new one exists.
 */
export function siblingPostersToDelete(names: readonly string[], stem: string, keep: string): string[] {
  return names.filter((name) => isPosterFile(name) && name !== keep && posterStemOf(name) === stem)
}

/**
 * The posters to unlink because the document they show is no longer known to the library.
 *
 * `liveStems` is every document the index still has a record of — including the ones a view is
 * filtering out, so a hidden work never loses its picture to a filter.
 */
export function orphanPostersToDelete(names: readonly string[], liveStems: ReadonlySet<string>): string[] {
  return names.filter((name) => {
    const stem = posterStemOf(name)
    return stem !== null && !liveStems.has(stem)
  })
}

/**
 * How much to shrink a drawing so it fits the poster, with a margin around it.
 *
 * The viewer draws a diagram at its **own** size — it does not fit the box it is given — so a large
 * diagram used to overflow the hidden window and the capture came back with scrollbars down the
 * side. This is the number that fixes it: never more than 1 (a small diagram is not blown up; it is
 * centred in white space instead), and never zero, so a huge drawing is still a picture of the whole
 * thing rather than a dot.
 */
export function posterFitScale(
  inner: { width: number; height: number },
  outer: { width: number; height: number },
  margin = 18,
): number {
  const availableWidth = Math.max(1, outer.width - margin * 2)
  const availableHeight = Math.max(1, outer.height - margin * 2)
  if (!(inner.width > 0) || !(inner.height > 0)) return 1
  const scale = Math.min(availableWidth / inner.width, availableHeight / inner.height)
  return Math.max(0.02, Math.min(1, scale))
}

/**
 * The rectangle a capture should photograph, or null for "the whole window".
 *
 * A page decides where its content is, and what comes back is whatever that page said — so this is
 * the boundary between "the page knows" and "a number the capture can use". A box with no area is
 * not a clip it would be right to take: `capturePage` turns it into an empty image, and an empty
 * image is a card with no picture at all. A negative origin is clamped, because a page scrolled to
 * its own edge answers in page coordinates and the window starts at zero.
 */
export function surfaceClipFrom(
  value: unknown,
): { x: number; y: number; width: number; height: number } | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<{ x: number; y: number; width: number; height: number }>
  const numbers = [candidate.x, candidate.y, candidate.width, candidate.height]
  if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const width = Math.round(candidate.width as number)
  const height = Math.round(candidate.height as number)
  if (width <= 0 || height <= 0) return null
  return {
    x: Math.max(0, Math.round(candidate.x as number)),
    y: Math.max(0, Math.round(candidate.y as number)),
    width,
    height,
  }
}


/**
 * The query the markdown poster window is loaded with — and the cap that keeps it a query.
 *
 * The poster is the app's own renderer now (`apps/electron/src/renderer/markdown-poster.tsx`), so
 * the document travels to it in the window's own URL: `?mdPoster=1&width=800&text=<base64url>`.
 * Base64url because a document is full of characters a URL may re-encode, and the window is loaded
 * through two different paths (dev server, packaged file).
 *
 * **The cap is the card's, not the document's.** A card shows the first 450 px at 800 wide, which
 * is roughly a page of text; 12 KB is several times that even for dense prose. Truncating there
 * costs the picture nothing and keeps a 2 MB document out of a query string.
 */
export const MAX_POSTER_TEXT = 12 * 1024

/**
 * How each format gets its picture.
 *
 * A table rather than an if-chain because the *choice* is where the bugs have been: a format routed
 * to a window it cannot draw in, or to a handshake the other end does not speak, produces an empty
 * picture rather than an error — a card with no image and nothing in the log about why. Written down
 * as data, it can be asserted.
 *
 * `drawio-engine` says in one word that a diagram is drawn by `renderDrawio` — the path
 * `drawio_tool` renders through — and **not** by the viewer shell a conversation embeds. Those are
 * two different programs with two different protocols, and the poster once spoke the second one
 * wrong for a whole release: it posted a JSON string where the bridge reads `event.data.protocol`,
 * waited out a twenty-second timeout, and answered "the viewer drew nothing".
 *
 * `print` is a document whose picture is its **first printed page**: the exporter lays it out and
 * pdfium draws page one. It replaced photographing those two editors, and the reason is not speed:
 * what a Word or PowerPoint *editor* shows is an editing surface — its page view is not the
 * document's pagination, and a deck's slideshow is a second program on top of the first — so a
 * photograph of it was sometimes the ribbon, sometimes a black stage, sometimes the page.
 */
export type PosterSource =
  /** A document printed to PDF, then page one rasterised. */
  | { kind: 'print'; app: 'docs' | 'slides' }
  /** A workbook's own grid, photographed in a hidden window — it has no pages to print. */
  | { kind: 'office-page'; app: 'sheets' }
  /** pdfium drawing the page — no window at all, 60 ms. */
  | { kind: 'pdfium' }
  /** The app's own markdown renderer, set on a page. */
  | { kind: 'markdown' }
  /** An html file, drawn in a hidden window with the page's own scripts off. */
  | { kind: 'web-page' }
  /** drawio's engine document — the same one a `drawio_tool` render uses. */
  | { kind: 'drawio-engine' }
  /**
   * The file is already a picture. Unreachable while the library excludes images; kept as the other
   * half of that switch, so a format that comes back needs no new pipeline.
   */
  | { kind: 'image' }
  | null

export function posterSourceFor(format: string): PosterSource {
  switch (format) {
    case 'docx':
      return { kind: 'print', app: 'docs' }
    case 'xlsx':
      return { kind: 'office-page', app: 'sheets' }
    case 'pptx':
      return { kind: 'print', app: 'slides' }
    case 'pdf':
      return { kind: 'pdfium' }
    case 'html':
      return { kind: 'web-page' }
    case 'md':
      return { kind: 'markdown' }
    case 'drawio':
      return { kind: 'drawio-engine' }
    case 'image':
      return { kind: 'image' }
    default:
      // `csv`, `json`, `text`: data files, not works. A card for one keeps its format badge.
      return null
  }
}

/**
 * A picture composited onto white, from BGRA pixels.
 *
 * A JPEG has no alpha, and a transparent pixel encodes as **black** — so a diagram engine's PNG
 * (RGBA, colour type 6 — measured on the real export) became white boxes on a black page. Pure,
 * because this is arithmetic: it belongs beside the geometry, not in the process that owns a window.
 */
export function blendOnWhite(pixels: Uint8Array, width: number, height: number): Buffer {
  const flat = Buffer.alloc(width * height * 4, 0xff)
  for (let i = 0; i < flat.length; i += 4) {
    // A buffer that ends early has nothing to composite there: the rest stays white rather than
    // turning into opaque black, which is what reading past its end would produce.
    if (i >= pixels.length) break
    const alpha = (pixels[i + 3] ?? 255) / 255
    if (alpha === 1) {
      flat[i] = pixels[i]!
      flat[i + 1] = pixels[i + 1]!
      flat[i + 2] = pixels[i + 2]!
      continue
    }
    flat[i] = Math.round((pixels[i] ?? 0) * alpha + 255 * (1 - alpha))
    flat[i + 1] = Math.round((pixels[i + 1] ?? 0) * alpha + 255 * (1 - alpha))
    flat[i + 2] = Math.round((pixels[i + 2] ?? 0) * alpha + 255 * (1 - alpha))
  }
  return flat
}

/** The card's logical width: the poster is laid out at 800 CSS px and captured at 2× (1600). */
export const MARKDOWN_POSTER_WIDTH = 800

/** The window a poster is captured in: its content size in DIP, and the page zoom to match. */
export interface PosterCaptureWindow {
  width: number
  height: number
  zoom: number
}

/**
 * A window whose CSS viewport is `logical` and whose capture is `logical × pixelRatio`, on any
 * display.
 *
 * Electron has **no per-window device scale factor** — only the app-wide
 * `--force-device-scale-factor`, which would change every window in the app. So the density stays
 * whatever the screen reports, and the two numbers that *are* ours are solved instead:
 *
 *   physical = DIP × displayScale     CSS = DIP ÷ zoom
 *
 * → `DIP = logical × pixelRatio ÷ displayScale`, `zoom = pixelRatio ÷ displayScale`.
 *
 * On a 1× screen that is literally "density 1 + zoom 2" (a 1600×900 window); on a 2× screen the
 * density already supplies the extra pixels, so it is "density 2 + zoom 1" (an 800×450 window) —
 * forcing zoom 2 there would photograph 3200 px only to throw half of them away.
 *
 * A window cannot exceed the screen: when it does, the zoom is lowered so the whole logical width
 * stays visible and the poster settles for fewer physical pixels instead of a cropped layout.
 */
export function posterCaptureWindow(
  logical: { width: number; height: number },
  pixelRatio: number,
  displayScale: number,
  area: { width: number; height: number },
  margin = 40,
): PosterCaptureWindow {
  const density = displayScale > 0 ? displayScale : 1
  const wanted = {
    width: (logical.width * pixelRatio) / density,
    height: (logical.height * pixelRatio) / density,
  }
  const width = Math.max(1, Math.min(Math.round(wanted.width), area.width - margin))
  const height = Math.max(1, Math.min(Math.round(wanted.height), area.height - margin))
  const zoom = Math.min(
    pixelRatio / density,
    width / Math.max(1, logical.width),
    height / Math.max(1, logical.height),
  )
  return { width, height, zoom }
}

/** Base64url of a UTF-8 string, which is what `decodePosterText` in the renderer reads back. */
export function encodeBase64Url(source: string): string {
  return Buffer.from(source, 'utf8').toString('base64url')
}

/**
 * The values `main.tsx` reads when it mounts the poster instead of the app.
 *
 * `base` is the document's own folder, and it is there for one reason: a picture or a table the
 * document names **beside it** (`![](shots/cart.png)`, `"src": "data.csv"`) is resolved against
 * that folder, exactly as `resolveDocumentPath` does for the app. Without it the renderer has no
 * document-relative notion at all, and every relative destination would be read against the
 * renderer's own origin.
 */
export function markdownPosterQuery(
  source: string,
  width = MARKDOWN_POSTER_WIDTH,
  base?: string,
): Record<string, string> {
  const text = source.length > MAX_POSTER_TEXT ? source.slice(0, MAX_POSTER_TEXT) : source
  return {
    mdPoster: '1',
    width: String(width),
    text: encodeBase64Url(text),
    ...(base ? { base: encodeBase64Url(base) } : {}),
  }
}
