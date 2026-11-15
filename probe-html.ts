/**
 * "HTML preview" for real: no PDF, no print.
 *   - pptx: intercept the export's slide payload (SVG per slide) and build a page from it
 *   - docx: use the editor's own headless `html` export
 *   CRAFT_BROWSER_CHANNEL=chrome node <bundle> <bench>
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { OfficeOrigin } from './packages/render-host/src/office-origin.ts'
import { createDocumentAnswerer } from './packages/render-host/src/document-answers.ts'
import { setOfficeRuntime, hostRuntime } from './packages/office-host/src/runtime.ts'
import { getBundledAssetsDir } from './packages/shared/src/utils/paths.ts'

setOfficeRuntime(hostRuntime())
const dir = process.argv[2] as string
const appsDir = getBundledAssetsDir('office')!
const BLOCKED = new Set([1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6665, 6666, 6667, 6668, 6669, 10080])
let origin = new OfficeOrigin({ appsDir })
await origin.start()
for (let i = 0; i < 40 && BLOCKED.has(Number(new URL(origin.baseUrl).port)); i += 1) {
  await origin.stop()
  origin = new OfficeOrigin({ appsDir })
  await origin.start()
}
const browser = await chromium.launch({ headless: true, channel: 'chrome' })

// ---------- pptx: the slide payload, as HTML ----------
{
  const file = join(dir, 'deck.pptx')
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const token = origin.addDocument(file, new Uint8Array(await readFile(file)))
  const output = origin.addOutput(join(dir, 'out', 'slides-unused.pdf'))
  let payload: { pages?: Array<{ svg?: string; png?: string }>; fontCss?: string; widthPx?: number; heightPx?: number } | null = null
  const base = createDocumentAnswerer({
    app: 'slides', path: file, outPath: output.path,
    printOpenPage: async () => { throw new Error('no print') },
    printMarkup: async () => { throw new Error('no print') },
    write: async () => undefined,
  })
  origin.setAnswer(token, Object.assign(async (method: string, args: unknown[]) => {
    if (method === 'printSlides' || method === 'exportPdf') {
      payload = (args[0] ?? {}) as typeof payload
      return { ok: true, path: output.path } // answered, but nothing is printed
    }
    return (base as unknown as (m: string, a: unknown[]) => Promise<unknown>)(method, args)
  }, { opened: () => base.opened() }))

  const start = performance.now()
  await page.goto(`${origin.baseUrl}/office/slides/?__craftExport=${encodeURIComponent(token)}&__craftHeadless=pdf&__craftOut=${encodeURIComponent(output.token)}`, { waitUntil: 'load' })
  const report = await Promise.race([output.done, new Promise((r) => setTimeout(() => r({ timedOut: true }), 60000))]) as { ok?: boolean; timedOut?: boolean }
  const at = performance.now() - start
  const got = payload as null | { pages?: Array<{ svg?: string }>; fontCss?: string; widthPx?: number; heightPx?: number }
  if (!got?.pages?.length) {
    console.log(`pptx payload: none (report ${JSON.stringify(report)})`)
  } else {
    const w = got.widthPx ?? 1280
    const h = got.heightPx ?? 720
    const fontCss = (got.fontCss ?? '').replace(/url\((['"]?)(\.?\/?)([^)'"]+)\1\)/g, (_m, q, _p, rest) => `url(${origin.baseUrl}/office/slides/${String(rest).replace(/^\.?\//, '')})`)
    const sheets = got.pages.map((p) => `<section>${p.svg ?? ''}</section>`).join('\n')
    const html = `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;background:#e9edf2;font-family:system-ui,sans-serif}
      section{width:${w}px;height:${h}px;margin:24px auto;background:#fff;box-shadow:0 1px 8px rgba(0,0,0,.18);overflow:hidden}
      section>svg{display:block;width:${w}px;height:${h}px}
      ${fontCss}
    </style>${sheets}`
    await writeFile(join(dir, 'out', 'slides.html'), html)
    console.log(`pptx payload at ${Math.round(at)}ms: ${got.pages.length} slides, ${Math.round(html.length / 1024)} KB html, svg=${got.pages.filter((p) => typeof p.svg === 'string').length}`)
    // What does it look like outside the editor?
    const view = await context.newPage()
    await view.setContent(html, { waitUntil: 'load' })
    await view.waitForTimeout(400)
    await view.screenshot({ path: join(dir, 'out', 'slides.html.png'), clip: { x: 0, y: 0, width: w, height: h } })
    const view2 = await browser.newContext({ viewport: { width: w, height: h } }).then((c) => c.newPage())
    await view2.setContent(html, { waitUntil: 'load' })
    await view2.waitForTimeout(400)
    await view2.setViewportSize({ width: w, height: h })
    await view2.screenshot({ path: join(dir, 'out', 'slides.html-first.png') })
  }
  await context.close()
}

// ---------- docx: the editor's own html export ----------
{
  const file = join(dir, 'long.docx')
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const token = origin.addDocument(file, new Uint8Array(await readFile(file)))
  const target = join(dir, 'out', 'docx-export.html')
  const output = origin.addOutput(target)
  origin.setAnswer(token, createDocumentAnswerer({
    app: 'docs', path: file, outPath: target,
    printOpenPage: async () => { throw new Error('no print') },
    printMarkup: async () => { throw new Error('no print') },
    write: async () => undefined,
  }))
  const start = performance.now()
  await page.goto(`${origin.baseUrl}/office/docs/?__craftExport=${encodeURIComponent(token)}&__craftHeadless=html&__craftOut=${encodeURIComponent(output.token)}`, { waitUntil: 'load' })
  const report = await Promise.race([output.done, new Promise((r) => setTimeout(() => r({ timedOut: true }), 60000))]) as { ok?: boolean; timedOut?: boolean; error?: string }
  const at = performance.now() - start
  const html = await readFile(target, 'utf8').catch(() => '')
  console.log(`docx html report ${JSON.stringify(report)} at ${Math.round(at)}ms · ${Math.round(html.length / 1024)} KB`)
  if (html) {
    const view = await context.newPage()
    await view.setContent(html, { waitUntil: 'load' })
    await view.waitForTimeout(400)
    await view.screenshot({ path: join(dir, 'out', 'docx-export.png'), clip: { x: 0, y: 0, width: 900, height: 1200 } })
  }
  await context.close()
}

await browser.close()
await origin.stop()
process.exit(0)
