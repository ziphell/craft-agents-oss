/**
 * How to find a document's page on screen — the part both hosts and the tools agree on.
 *
 * A page is not a file: it is what an editor drew. Three editors, three answers, and none of them
 * is "print the document and rasterise page one":
 *
 * - **Word** paginates on screen into `.pv-page` boxes. `window.__openPagePreview()` is its own
 *   paginated view — the same one a person opens with the ribbon's page-preview button — and the
 *   n-th `.pv-page` is the n-th page. (Print media would show *one* page of a document that never
 *   laid the rest out; that is the bug `render-host/src/chromium.ts` was fixed for.)
 * - **PowerPoint** draws a stage. `F5` is its slideshow, which is the slide and nothing else; its
 *   own handler reads `e.key` and does not care that the event was not typed, so a poster and a
 *   tool can take the same route a presenter does.
 * - **Excel** has no pages at all on screen — its pagination exists only inside a print job — so
 *   the picture is the grid, which is also the better one: column letters, row numbers and filter
 *   buttons are what make a workbook recognisable.
 *
 * What stays here is only that: *where in the page* a picture of page n is. Opening the editor,
 * giving it the document and taking the pixels belong to the host — Electron does it with a hidden
 * window, a hub with a Playwright page — and both answer the same two calls (`run`, `settle`), so
 * this file never mentions either.
 */

import type { OfficeApp } from './renderer'

/** The page, as this file sees it: run something in it, and let it paint. */
export interface PageSurface {
  run<T = unknown>(script: string): Promise<T>
  /** Let the page paint. The caller caused a change; the browser has not drawn it yet. */
  settle(ms?: number): Promise<void>
}

export interface PageClip {
  x: number
  y: number
  width: number
  height: number
}

/**
 * What a workbook's own chrome takes above its grid — ribbon, tabs, formula bar, in this build.
 *
 * Measured, not guessed: this much of the window is not table, and a window sized without it puts a
 * ribbon in a picture that is supposed to be a sheet.
 */
const SHEETS_CHROME_PX = 146

/**
 * The window shape each editor is asked to draw in.
 *
 * A deck is 16:9, so its slideshow fills the window exactly — no letterbox to crop out of the
 * picture. A Word page is A4 at 96 dpi (794×1123), which is why that window is portrait and a
 * thousand pixels wide: the page sits at its own size, centred, and the capture zooms it to fit a
 * screen that cannot hold a 1400 px window (`capture-surface.ts`).
 *
 * **A workbook is the one that does arithmetic**, because its picture is a *grid*: the card is 16:9,
 * so the grid area under the ribbon is what has to be 16:9 — not the window. 1250 px of width leaves
 * 703 px of grid once the chrome is out, which is exactly 16:9, and fits a 1440×960 desktop without
 * the OS shrinking the window. The capture then downsamples to the poster's 1600 px long edge — sharper than
 * photographing 800 px of window and enlarging it: an 800-wide window holds 306 px of grid, so that
 * poster is a blow-up with no room for the column letters.
 */
export const OFFICE_PAGE_WINDOW: Record<'docs' | 'sheets' | 'slides', { width: number; height: number }> = {
  docs: { width: 1000, height: 1400 },
  // Whole pixels: Electron quietly falls back to a 600-tall window for a fractional one (measured,
  // and it cost a round of "why is the grid only 505 px tall").
  sheets: { width: 1250, height: Math.round(1250 * (9 / 16)) + SHEETS_CHROME_PX },
  slides: { width: 1280, height: 720 },
}

/** How long an editor may take to open a document and draw the page asked for. */
export const PAGE_CAPTURE_TIMEOUT_MS = 20_000

/**
 * A grid canvas is the one tall enough to be the grid.
 *
 * The workbook's first canvas is its scrollbar (measured: 1355×27), so something has to tell them
 * apart and "big" is the difference. Two hundred rather than four: in a poster-sized window
 * (800×450) the grid is about 400 px tall with the ribbon up, and a threshold that only fits the
 * larger windows is how "the workbook editor never drew its grid" happened.
 */
const SHEETS_GRID_MIN_HEIGHT = 200

export interface PageCaptureRequest {
  /** Which editor draws it. A `.pdf` is not one of these: pdfium draws it with no window at all. */
  app: Exclude<OfficeApp, 'pdf'>
  /** 0-based page. Ignored by a workbook, which has no pages on screen. */
  page?: number
  /**
   * Where a **workbook** should be scrolled to before the picture is taken.
   *
   * A sheet has no page to fit a range into — the grid is unbounded — so this moves the window
   * rather than cropping to the range: the picture starts at `range`'s top-left. The editor's own
   * `goto` does that (activate the sheet, scroll to the cell) and is also what `genoffice open
   * --range` uses, so a picture and a person's "jump to B40" land in the same place.
   */
  target?: { sheet?: string; range?: string }
  timeoutMs?: number
}

/**
 * The driver: ask the editor for page `page`, and answer with the rectangle to photograph.
 *
 * Throws when the page never appeared — a document the editor refuses, a build without its
 * bundles, a page further in than the editor laid out. A caller with another route (printing)
 * catches this and takes it; a caller without one has a real error.
 */
/**
 * Wait until the editor has **opened the document**, not until it has drawn its chrome.
 *
 * This is the difference between a poster and a picture of an empty editor, and it cost an afternoon:
 * a `.pv-page` box, the Univer grid canvas and the deck's stage all exist *before* the file arrives,
 * so a driver that waits for those photographs "opening workbook", a black stage, or a blank page —
 * each of which looks like a rendering bug rather than a timing one.
 *
 * All three editors answer one question the same way: `__genofficeControl({ cmd: 'selection' })`
 * returns `not_ready` until the document is in and `ok` once it is (`handleDocsControl` wants its
 * editor *and* its document, `handleSheetsControl` wants `fileLoaded`, `handleSlidesControl` wants
 * slides). No per-format knowledge, no guessing from the DOM.
 */
function waitForDocument(app: string, timeoutMs: number): (surface: PageSurface) => Promise<void> {
  return async (surface) => {
    const probe = await surface.run<{ opened: boolean; why: string }>(`(async () => {
      const deadline = Date.now() + ${timeoutMs}
      let why = 'no control surface'
      while (Date.now() < deadline) {
        const control = window.__genofficeControl
        if (typeof control === 'function') {
          try {
            const answer = control({ cmd: 'selection' })
            if (answer?.status === 'ok') return { opened: true, why: '' }
            why = 'not_ready'
          } catch (error) {
            // The editor is mid-boot — or its control surface is broken; both are worth saying.
            why = 'threw: ' + (error && error.message ? error.message : String(error))
          }
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      return { opened: false, why }
    })()`)
    if (!probe.opened) throw new Error(`the ${app} editor never opened the document (${probe.why})`)
  }
}

export function officePageDriver(
  request: PageCaptureRequest,
): (surface: PageSurface) => Promise<PageClip | null> {
  const { app, target } = request
  const page = Math.max(0, Math.trunc(request.page ?? 0))
  const timeoutMs = request.timeoutMs ?? PAGE_CAPTURE_TIMEOUT_MS

  if (app === 'docs') {
    const documentIn = waitForDocument(app, timeoutMs)
    return async (surface) => {
      await documentIn(surface)
      const opened = await surface.run<boolean>(`(async () => {
        const deadline = Date.now() + ${timeoutMs}
        while (Date.now() < deadline) {
          if (typeof window.__openPagePreview === 'function') {
            window.__openPagePreview()
            return true
          }
          await new Promise((r) => setTimeout(r, 50))
        }
        return false
      })()`)
      if (!opened) throw new Error('the Word editor never offered its page view')
      // The font cache decides where the page breaks, and a page measured before it is measured
      // wrong — the boxes exist, they are just not the height they will end up.
      await surface.run(
        'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true',
      )
      // Bring page n into view — the picture is the window, and page 4 of a report is three screens
      // down. No rectangle is measured: the preview's pages live in a transformed container, so their
      // `getBoundingClientRect()` answers in that container's coordinates rather than the window's.
      const laidOut = await surface.run<boolean>(`(async () => {
        const deadline = Date.now() + ${timeoutMs}
        while (Date.now() < deadline) {
          const pages = document.querySelectorAll('.pv-page')
          const box = pages[${page}] || (${page} > 0 ? null : pages[0])
          if (box && box.getBoundingClientRect().width > 0) {
            box.scrollIntoView({ block: 'center', inline: 'center' })
            return true
          }
          await new Promise((r) => setTimeout(r, 100))
        }
        return false
      })()`)
      if (!laidOut) throw new Error(`the Word editor laid out no page ${page + 1}`)
      // Hide the editor's own chrome, the way the editor hides it for a print job: `.pv-exporting`
      // makes everything that is not the preview `content-visibility: hidden`. The preview is a fixed
      // overlay, so in principle it already covers the ribbon — and in practice a capture taken a
      // frame early came back as the ribbon over an empty page, which is a picture of the wrong thing
      // that nothing can detect afterwards. With the chrome hidden, the worst case is a white frame,
      // which the capture's own blank check turns into a retry.
      await surface.run(`(() => {
        const app = document.querySelector('.app')
        if (app && !app.classList.contains('pv-exporting')) app.classList.add('pv-exporting')
        return true
      })()`)
      await surface.run('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
      // Then wait for the page to actually *have* its text. The preview mounts before the document is
      // in it and shows a loading line meanwhile (`Opening…`, measured), which is ink enough to pass
      // a "not blank" test and useless as a picture.
      const filled = await surface.run<boolean>(`(async () => {
        const deadline = Date.now() + ${timeoutMs}
        const want = ${page}
        while (Date.now() < deadline) {
          const pages = document.querySelectorAll('.pagination-preview .pv-page')
          const box = pages[want] || pages[0]
          if (box && (box.textContent || '').trim().length > 0) return true
          await new Promise((r) => setTimeout(r, 100))
        }
        return false
      })()`)
      if (!filled) throw new Error(`the page preview of page ${page + 1} never filled in`)
      await surface.settle(150)
      // **The window, not a page box.** The preview lays its pages out inside a scaled container, so
      // every rect measured in it has been a number the window does not share: measured twice today,
      // the box reported {x: 244, y: 22, width: 794} for a page the screen draws at {x: 96, y: 70,
      // width: 601}, and a picture taken through it was the toolbar above the page. The content box is
      // no better — its rect starts left of the viewport and runs past the paper into the grey. The
      // window is unambiguous: with the chrome hidden and the page centred, the picture is the page.
      // A page-shaped image belongs to `render` printing the document, which asks nobody where
      // anything is on screen.
      return null
    }
  }

  if (app === 'slides') {
    /**
     * Not `waitForDocument` here, and the reason is worth keeping: the deck's control answers
     * `not_ready` until it knows a **path**, and a capture window hands it the bytes with no path at
     * all. So the two other editors can be asked, and this one has to be observed: the stage is
     * empty until the deck is in, and a slide is more than a handful of nodes.
     */
    return async (surface) => {
      const opened = await surface.run<boolean>(`(async () => {
        const deadline = Date.now() + ${timeoutMs}
        while (Date.now() < deadline) {
          // The stage exists before the deck does, and its subtree does not grow when the deck
          // lands (the slide is painted by the show, not into this box) — so this is the same
          // signal it always was. What follows is the real readiness check: the slideshow, which
          // cannot start before there is a slide to show.
          if (document.querySelector('[class*="stage-scale"]')) return true
          await new Promise((r) => setTimeout(r, 100))
        }
        return false
      })()`)
      if (!opened) throw new Error('the deck editor never drew its stage')
      await surface.run(
        'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true',
      )
      // The slideshow, then `page` steps forward — the same two keys a presenter uses. The show is
      // the whole window, so the picture is the window: no clip to name.
      const showing = await surface.run<boolean>(`(async () => {
        const press = (key) =>
          document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        press('F5')
        const deadline = Date.now() + ${timeoutMs}
        while (Date.now() < deadline) {
          if (document.querySelector('.slideshow, [class*="slideshow"]')) break
          await wait(50)
        }
        if (!document.querySelector('.slideshow, [class*="slideshow"]')) return false
        for (let step = 0; step < ${page}; step += 1) {
          press('ArrowRight')
          await wait(200)
        }
        await wait(250)
        return true
      })()`)
      if (!showing) throw new Error('the deck editor did not enter its slideshow')
      // The show drops a black curtain over the window before it mounts, and lifts it once the slide
      // is actually revealed (`body.show-curtain::after`, genoffice's `slide-show-view`). A capture
      // taken while it is down is a **black rectangle** — measured, and the reason a deck had no
      // poster. Waiting for the curtain to lift is the deck's own answer to "is there a slide to look
      // at", so nothing here has to guess at a delay.
      const revealed = await surface.run<boolean>(`(async () => {
        const deadline = Date.now() + ${timeoutMs}
        while (Date.now() < deadline) {
          if (!document.body.classList.contains('show-curtain')) return true
          await new Promise((r) => setTimeout(r, 50))
        }
        return false
      })()`)
      if (!revealed) throw new Error('the deck editor never revealed its slide')
      await surface.settle(200)
      return null
    }
  }

  const documentIn = waitForDocument(app, timeoutMs)
  return async (surface) => {
    await documentIn(surface)
    // The corner next: a picture of "the sheet from B40" is a scroll, not a crop.
    if (target && (target.sheet || target.range)) {
      const moved = await surface.run<{ status: string; message?: string; detail?: { sheets?: string[] } }>(`(async () => {
        const deadline = Date.now() + ${timeoutMs}
        const wanted = ${JSON.stringify({ sheet: target.sheet ?? null, range: target.range ?? null })}
        while (Date.now() < deadline) {
          const control = window.__genofficeControl
          if (typeof control !== 'function') {
            await new Promise((r) => setTimeout(r, 100))
            continue
          }
          const answer = control({
            cmd: 'goto',
            target: {
              kind: wanted.range ? 'range' : 'sheet',
              ...(wanted.sheet ? { sheet: wanted.sheet } : {}),
              ...(wanted.range ? { range: wanted.range } : {}),
            },
          })
          // not_ready is the workbook still booting: the shell asks again, and so do we.
          if (answer && answer.status !== 'not_ready') return answer
          await new Promise((r) => setTimeout(r, 150))
        }
        return { status: 'timeout', message: 'the workbook did not get there in time' }
      })()`)
      if (moved.status !== 'ok') {
        const names = moved.detail?.sheets
        throw new Error(
          [
            moved.message ??
              (target.sheet ? `there is no sheet named ${target.sheet}` : `could not scroll to ${target.range}`),
            names?.length ? `Its sheets are: ${names.join(', ')}.` : '',
          ]
            .filter(Boolean)
            .join(' '),
        )
      }
      await surface.settle(200)
    }

    // Its own loading screen first: `fileLoaded` can be true while `.workbook-opening-screen` is
    // still up (measured — that is the white frame with a single line of text on it, `Opening
    // workbook…`). Waiting for that element to go is waiting for the workbook the person would see.
    const opened = await surface.run<boolean>(`(async () => {
      const deadline = Date.now() + ${timeoutMs}
      while (Date.now() < deadline) {
        if (!document.querySelector('.workbook-opening-screen')) return true
        await new Promise((r) => setTimeout(r, 100))
      }
      return false
    })()`)
    if (!opened) throw new Error('the workbook editor never finished opening the workbook')

    await surface.settle(200)

    // Read mode is **not** asked for, and its class is not applied by hand either — both were measured
    // and both leave the grid unpainted in a capture window (4.6% and 6.2% ink, two runs each: what
    // came back was the ribbon's remains and grey). What works is leaving the editor alone and taking
    // the grid's own rectangle out of it, at the end.

    // A preview of a sheet starts at its own top-left — A1 — not wherever the workbook was last
    // scrolled to. Two things follow: the column letters and row numbers are in the picture, and the
    // table's first rows are, instead of the middle of it. Asked through the editor's own `goto` (the
    // command `genoffice open --range` uses); a host that cannot answer leaves the view where it is
    // rather than failing the picture.
    await surface.run(`(async () => {
      const deadline = Date.now() + ${timeoutMs}
      while (Date.now() < deadline) {
        const control = window.__genofficeControl
        if (typeof control !== 'function') {
          await new Promise((r) => setTimeout(r, 100))
          continue
        }
        try {
          const answer = control({ cmd: 'goto', target: { kind: 'range', range: 'A1' } })
          if (answer && answer.status === 'ok') return true
          if (answer && answer.status === 'error') return false
        } catch {
          return false
        }
        await new Promise((r) => setTimeout(r, 150))
      }
      return false
    })()`)
    await surface.settle(200)

    // Then the grid canvas — measured after read mode, because the chrome going away is what gives
    // the canvas its row.
    const ready = await surface.run<boolean>(`(async () => {
      const deadline = Date.now() + ${timeoutMs}
      while (Date.now() < deadline) {
        const grid = [...document.querySelectorAll('canvas')]
          .filter((c) => c.getBoundingClientRect().height > ${SHEETS_GRID_MIN_HEIGHT})
          .sort((a, b) => b.clientHeight - a.clientHeight)[0]
        if (grid) {
          // The grid paints its cells a frame or two after the canvas exists; that last stretch is
          // not observable in the page (this build's canvas has no 2d context to sample),
          // so the capture's own ink check with one short retry covers it — measured, 500 ms.
          await new Promise((r) => setTimeout(r, 300))
          return true
        }
        await new Promise((r) => setTimeout(r, 50))
      }
      return false
    })()`)
    if (!ready) throw new Error('the workbook editor never drew its grid')





    // The grid **and its headers**, framed 16:9 by construction.
    //
    // The canvas rect is the cells only: the column letters and row numbers are drawn beside it, and
    // the column-letter strip sits 28 px above the container (both measured). The workbook's tab strip
    // and status bar are *over* the grid's bottom 48 px, so they come off too — a picture of a table
    // should not end in "+ sheet". Height then comes from what the window has and width follows from
    // 16:9 — the card's own shape — so nothing is cropped afterwards, and since the grid is wider than
    // the window, narrowing costs nothing while dropping rows would.
    return surface.run<PageClip | null>(`(() => {
      const grid = [...document.querySelectorAll('canvas')]
        .filter((c) => c.getBoundingClientRect().height > ${SHEETS_GRID_MIN_HEIGHT})
        .sort((a, b) => b.clientHeight - a.clientHeight)[0]
      if (!grid) return null
      const box = (grid.parentElement ?? grid).getBoundingClientRect()
      const strip = 28
      const bottomChrome = 48
      const x = Math.max(0, box.x)
      const y = Math.max(0, box.y - strip)
      const available = window.innerHeight - y - bottomChrome
      const height = Math.max(1, Math.min(Math.round((box.width * 9) / 16), available))
      const width = Math.max(1, Math.min(box.width, Math.round((height * 16) / 9)))
      return { x, y, width, height }
    })()`)
  }
}

/**
 * Who can draw a page here, installed by the process that owns the renderer.
 *
 * The tools run in a session, and a session runs on a host — the app or a hub — that may or may not
 * be able to open an editor. Neither of them belongs in this package (`electron` cannot be imported
 * from a hub, and `playwright-core` from the app), so the same seam `setOfficePrint` uses is used
 * here: the owner installs a function, a host that has none answers "cannot", and the caller says
 * so rather than failing halfway.
 *
 * The answer is **files**, not bytes: the tool layer already reads pictures off disk, caps how many
 * ride a reply, and names the rest. A page that could not be drawn is an empty list, which the
 * command reports as the refusal it is.
 */
export interface PageCaptureInput {
  app: Exclude<OfficeApp, 'pdf'>
  /** Absolute path of the document. The capture reads it: it knows its own size limits. */
  path: string
  /** Bytes already in hand, when the caller has them — saves a second read of a large file. */
  bytes?: Uint8Array
  /** 0-based. */
  page: number
  /** Where the PNG goes. The capture writes `page-<n>.png` and answers its absolute path. */
  outDir: string
  /** See `PageCaptureRequest.target` — a workbook's corner, before the picture. */
  target?: { sheet?: string; range?: string }
}

export type PageCapture = (input: PageCaptureInput) => Promise<string[]>

let installed: PageCapture | null = null

/** Give the tools a way to draw a page, or take it away (`null`) on a host that cannot. */
export function setOfficePageCapture(capture: PageCapture | null): void {
  installed = capture
}

/** The capture in force, or null when this host cannot draw a page. */
export function officePageCapture(): PageCapture | null {
  return installed
}

/**
 * A **web page** as a picture — the same seam, for a file no editor owns.
 *
 * `html_tool shot` wants what a poster of an .html file already is: the page drawn in a window
 * nobody sees, with **scripting off**. That is not a shortcut around a sandbox; it is the app's own
 * rule for every view — the `html-preview` block and its full-screen reader both use a sandbox
 * without `allow-scripts`, and only the design editor (a page you are *changing*) runs scripts. A
 * picture that ran them would show a model something no person can see.
 *
 * The answer is files, like `PageCapture`: the tool layer reads pictures off disk, caps how many
 * ride a reply, and names the rest.
 */
export interface WebShotInput {
  /** Absolute path of the page. Each host turns it into the address its browser loads. */
  path: string
  /** The window, which is also the picture: an html page has no page size of its own. */
  width: number
  height: number
  outDir: string
}

export type WebShot = (input: WebShotInput) => Promise<string[]>

let webShot: WebShot | null = null

/** Give the tools a way to photograph a page, or take it away (`null`) on a host that cannot. */
export function setOfficeWebShot(shot: WebShot | null): void {
  webShot = shot
}

/** The page shot in force, or null when this host has no renderer. */
export function officeWebShot(): WebShot | null {
  return webShot
}

/**
 * A **markdown file** as a picture — the app's own renderer, not a parser of our own.
 *
 * A `.md` has no page and no editor either: what draws it is the React `<Markdown>` a reader sees,
 * which lives in the renderer process. So a picture of one is the *app's own bundle* opened in a
 * hidden window with `?mdPoster=1`, mounted as one `<Markdown>` at the requested width, and
 * photographed. Anything else (a second parser in main) is a second dialect — and the blocks that
 * name a file (`html-preview`, `image-preview`) would not be in it.
 *
 * The answer is files, like `PageCapture` and `WebShot`.
 */
export interface MarkdownShotInput {
  path: string
  /** The width the document is drawn at. A card draws at 800; a model asking to look may want more. */
  width: number
  /** How much of it to photograph, from the top. A markdown document is as tall as it is. */
  height: number
  outDir: string
}

export type MarkdownShot = (input: MarkdownShotInput) => Promise<string[]>

let markdownShot: MarkdownShot | null = null

/** Give the tools a way to photograph a markdown file, or take it away on a host that cannot. */
export function setOfficeMarkdownShot(shot: MarkdownShot | null): void {
  markdownShot = shot
}

/** The markdown shot in force, or null when this host has no renderer to draw one with. */
export function officeMarkdownShot(): MarkdownShot | null {
  return markdownShot
}
