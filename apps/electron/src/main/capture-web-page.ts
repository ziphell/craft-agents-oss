/**
 * An html file, drawn in a window nobody sees — one function, two callers.
 *
 * A poster wants it (the `html` branch of `captureSource`) and `html_tool shot` wants it: the same
 * picture, at the same sizes, with the same rule. The rule is why this file exists rather than a
 * third copy of the window code.
 *
 * **The page's scripts run.** They did not until 2026-11-02, and the reason they do now is that the
 * preview changed first: a page is served from its own folder at an origin of its own
 * (`html-origin.ts`), so a `html-preview` block and its full-screen reader are a page with an
 * address, its relative stylesheets resolved and its scripts running. A screenshot that still
 * refused them would photograph a skeleton no person ever sees — an ECharts chart, a Tailwind CDN
 * page or a `<script>-built table would be blank on the card and visible when opened. The window is
 * the same sandbox either way (`sandbox: true`, no node, no preload), so what the page can reach is
 * unchanged; what changes is that the picture is now the page.
 *
 * **So the wait is part of the job.** A scripted page is blank, then a skeleton, then content, and
 * `isPicture` accepts the skeleton (measured: a heading and a spinner are enough ink). Three waits
 * stack up, in this order: `document.readyState` + images + fonts (below), a quiet window for the
 * timers and fetches the load event does not wait for, and one confirmation sample a moment after
 * the first picture (`capture-surface.ts`).
 *
 * The window is also the picture: a page has no page size of its own, so the caller names one
 * (1000×625 is the card's shape; markdown is set on A4 proportions instead).
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureSurface } from './capture-surface'

export interface WebPageSize {
  width: number
  height: number
}

export interface WebPageCaptureOptions {
  /**
   * Run the page's own scripts. On for anything a person would open; the archive/`shot` copy of a
   * page is still this same picture, which is the point.
   */
  scripts?: boolean
  /**
   * How long the page is left alone after it says it has finished loading.
   *
   * The load event is not the end of a page that fetches: a chart library resolves its promise
   * after `load` and paints then, so the picture has to be taken after a quiet moment rather than
   * on the event. 700 ms is one or two frames plus a promise chain — measured against a CDN page,
   * not guessed.
   */
  quietMs?: number
  /** How long after the first picture to look again, when the scripts may still be drawing. */
  confirmAfterMs?: number
}

/**
 * Waits inside the page until it says it is done with its own resources.
 *
 * `readyState === 'complete'` alone is not enough: it fires when the document and its subresources
 * are done, and a page's *images* still report `complete` only after they have decoded. Fonts are the
 * third half — a page laid out in a webfont reflows the moment it arrives, and a picture taken in
 * the fallback face is a picture of a page nobody saw. Capped at 4 s so a page that never settles
 * (an image that 404s and retries, a font that hangs) is photographed anyway.
 */
const READY_PROBE = `(async () => {
  const started = Date.now();
  for (;;) {
    const loaded = document.readyState === 'complete';
    const images = Array.from(document.images).every((image) => image.complete);
    const fonts = !document.fonts || document.fonts.status === 'loaded';
    if (loaded && images && fonts) return true;
    if (Date.now() - started > 4000) return false;
    await new Promise((done) => setTimeout(done, 100));
  }
})()`

/** The page as a PNG, or `null` when nothing was drawn. */
export async function captureWebPage(
  url: string,
  size: WebPageSize = { width: 1000, height: 625 },
  timeoutMs = 20_000,
  options: WebPageCaptureOptions = {},
): Promise<Buffer | null> {
  const scripts = options.scripts === true
  const capture = await captureSurface({
    url,
    size,
    timeoutMs,
    javascript: scripts,
    ...(scripts ? { confirmAfterMs: options.confirmAfterMs ?? 600 } : {}),
    prepare: async (surface) => {
      if (scripts) {
        // The page's own load, then one quiet moment for the work it started and did not await.
        await surface.run(READY_PROBE).catch(() => false)
        await surface.settle(options.quietMs ?? 700)
      }
      // A page wider than the window paints a scrollbar into the picture, which is something to
      // drag rather than part of the document. The window is the photograph.
      await surface
        .run("document.documentElement.style.overflow='hidden';document.body.style.overflow='hidden';true")
        .catch(() => undefined)
      return null
    },
  })
  return capture?.png ?? null
}

/** The same picture, written into `outDir` — what `html_tool shot` asks the seam for. */
export async function writeWebPageShot(
  url: string,
  outDir: string,
  size: WebPageSize,
  stem: string,
): Promise<string[]> {
  const png = await captureWebPage(url, size, 20_000, { scripts: true })
  if (!png) return []
  await mkdir(outDir, { recursive: true })
  const file = join(outDir, `${stem}.png`)
  await writeFile(file, png)
  return [file]
}
