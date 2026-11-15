/**
 * Build the document engines this app hosts, from the vendored source.
 *
 * Two things are bundled, and the second is the reason this is a script rather than a dependency:
 *
 * - **The engine proper** (`@genoffice/pptx-engine`, `@genoffice/pptx-ops`) — parse, edit, write.
 * - **The render projection** (`buildAllRenderSlides` in the slides app's `session-state.ts`) — the
 *   shape the editor's *view* expects. It lives in the app's main process, not in a package, so a
 *   host that wants to show a deck has to take it from there. That file imports `electron` for
 *   window lookups on paths we never touch; `electron-stub` below answers them so the module can be
 *   evaluated without an Electron process.
 *
 * Output is an artifact, not source: `resources/office-engine/pptx.cjs` (+ a stamp naming the
 * vendored commit). Same arrangement as `resources/drawio/` — the repository holds the recipe, and
 * what it produces is disposable.
 *
 *   bun scripts/build-office-engine.ts
 *
 * Node dependencies stay **external**: `jszip` detects its platform by requiring `readable-stream`,
 * and a bundled copy reports "nodestream is not supported by this platform" the first time a deck is
 * saved (measured). `opentype.js`, `utif2` and `pngjs` ride along with it for the same reason.
 */

import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const SOURCE = resolve(process.env.GENOFFICE_SOURCE ?? join(ROOT, 'vendor', 'genoffice'))
const OUT_DIR = join(ROOT, 'apps', 'electron', 'resources', 'office-engine')
const STAMP = join(ROOT, 'vendor', 'genoffice', '.genoffice-source.json')

if (!existsSync(join(SOURCE, 'packages', 'pptx-engine'))) {
  console.error(`No GenOffice source at ${SOURCE}.`)
  console.error('Run: bun scripts/fetch-genoffice-source.ts')
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })

/**
 * The entry the host imports.
 *
 * The surface a deck host needs: open, transact, save, the projection the renderer reads — and the
 * **parts of a deck the editor displays**, which are document facts rather than app features.
 *
 * That last group is not optional. The editor asks for notes, comments, sections and links while
 * it mounts; a host that answers `undefined` is not "a smaller app", it is a mount that throws
 * (notes are read as strings, links as lists) and a notes pane that accepts typing and then drops
 * it. The engine has had all of it all along — `notes.ts`, `sections.ts`, `comments.ts`,
 * `hyperlink.ts` — it was simply not listed here.
 */
const ENTRY = `
export { openPptx, savePptxToFile } from '@genoffice/pptx-engine'
export { runTxn, mapScriptOps } from '@genoffice/pptx-ops'
export {
  getSlideNotes,
  setSlideNotes,
  getSlideComments,
  addSlideComment,
  deleteSlideComment,
  getSections,
  setSections,
  getSlideLinks,
  getRunLinks,
  getSlideAnimations,
  setSlideAnimations,
  getSlideTransition,
  setSlideTransition,
  getSlideAdvanceTime,
  setSlideAdvanceTime,
  elementSpid,
  listEmbeddedFonts,
  narrationSpids,
  readHeaderFooter,
  getElementLink,
  copyElementData,
  getChartElementData,
  parseTheme,
  materializeSlide,
  collectSlideBundle,
  listSlideLayouts,
  builtinLayoutInfos,
  shouldOfferBuiltinLayouts,
  listMasterParts,
  parseMasterPart,
} from '@genoffice/pptx-engine'
export {
  buildAllRenderSlides,
  pushHistory,
  takeSnapshot,
  restoreSnapshot,
  settleStaleHistoryBatch,
  makeMediaResolver,
  getFontMetrics,
} from '${SOURCE.replace(/\\/g, '/')}/apps/slides/src/main/session-state.ts'
// A master/layout part is a slide-shaped object, so it is rendered by the same projection as one
// page of a deck.
export { buildRenderSlide } from '${SOURCE.replace(/\\/g, '/')}/packages/pptx-render/src/build-slide.ts'
`

const entryPath = join(SOURCE, '.office-engine-entry.ts')
writeFileSync(entryPath, ENTRY)

/** `import guide from './x.md?raw'` — the op guides are markdown imported as text. */
const rawText: Record<string, string> = {
  name: 'raw-text',
  setup(b: import('esbuild').PluginBuild) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw-text',
    }))
    b.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => ({
      contents: readFileSync(args.path, 'utf8'),
      loader: 'text',
    }))
  },
}

/**
 * `?asset` — electron-vite's asset import.
 *
 * At build time the file is copied beside the bundle (`fonts/`) and the import becomes that path,
 * computed at runtime against `__dirname`: a bundled absolute path would point into the vendored
 * checkout, which a packaged app does not ship.
 */
const assetFiles: string[] = []
const assetPath: Record<string, string> = {
  name: 'asset-path',
  setup(b: import('esbuild').PluginBuild) {
    b.onResolve({ filter: /\?asset$/ }, (args) => {
      const raw = args.path.replace(/\?asset$/, '')
      // A relative import resolves against the importer; a workspace specifier has to be mapped
      // (the package's own `exports` does not expose its font files).
      const file = raw.startsWith('.')
        ? resolve(args.resolveDir, raw)
        : raw.startsWith('@genoffice/ui/fonts/')
          ? join(SOURCE, 'packages', 'ui', 'src', 'fonts', basename(raw))
          : resolve(SOURCE, raw)
      return { path: file, namespace: 'asset-path' }
    })
    b.onLoad({ filter: /.*/, namespace: 'asset-path' }, (args) => {
      assetFiles.push(args.path)
      const name = basename(args.path)
      return {
        contents: "module.exports = require('node:path').join(__dirname, 'fonts', " + JSON.stringify(name) + ')',
        loader: 'js',
      }
    })
  },
}

/** `electron` on the paths this bundle never takes: window lookups answer "no window". */
const electronStub: Record<string, string> = {
  name: 'electron-stub',
  setup(b: import('esbuild').PluginBuild) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
      contents: `
        export const app = { getPath: () => '', getLocale: () => 'en', isPackaged: false }
        export const BrowserWindow = { fromWebContents: () => null, getFocusedWindow: () => null, getAllWindows: () => [] }
        export const webContents = { fromId: () => null }
        export const screen = { getPrimaryDisplay: () => ({ scaleFactor: 1, size: { width: 0, height: 0 } }) }
        export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }) }
        export const shell = { openExternal: async () => {} }
        export const dialog = { showSaveDialog: async () => ({ canceled: true }) }
        export const ipcMain = { handle: () => {}, on: () => {} }
        export default { app, BrowserWindow, webContents, screen, nativeImage, shell, dialog, ipcMain }
      `,
      loader: 'js',
    }))
  },
}

/**
 * `bun scripts/build-office-engine.ts pptx` builds **one** bundle.
 *
 * A full run compiles all four from the vendored checkout, and that checkout is not always clean:
 * a renderer file someone is editing locally would be baked into an artifact nobody reviews. One
 * name means "this engine only, from these sources, and nothing else moves".
 */
const only = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith('-')))
const wants = (bundle: string) => only.size === 0 || only.has(bundle)

const started = Date.now()
if (wants('pptx')) {
await build({
  entryPoints: [entryPath],
  outfile: join(OUT_DIR, 'pptx.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  absWorkingDir: SOURCE,
  plugins: [rawText, assetPath, electronStub],
  // see the header: jszip must load its real node build, so it (and its own tree) ships beside
  // the bundle; everything else is pure JavaScript and rides inside it.
  external: ['jszip'],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})
}

// The workbook engine is one client class: the parse/save work happens in the sidecar process.
const XLSX_ENTRY =
  "export { XlsxSidecarClient } from '" +
  SOURCE.replace(/\\/g, '/') +
  "/apps/sheets/src/main/xlsx-sidecar-client.ts'"
const xlsxEntryPath = join(SOURCE, '.office-engine-xlsx-entry.ts')
writeFileSync(xlsxEntryPath, XLSX_ENTRY)
if (wants('xlsx')) {
await build({
  entryPoints: [xlsxEntryPath],
  outfile: join(OUT_DIR, 'xlsx.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  absWorkingDir: SOURCE,
  logLevel: 'warning',
})
}
writeFileSync(
  join(OUT_DIR, 'xlsx.d.ts'),
  `/** The workbook sidecar client (see office-workbook.ts). */
export declare class XlsxSidecarClient {
  constructor(binaryPath: string)
  start(): void
  stop(): void
  onProcessExit(listener: () => void): () => void
  open(path: string, locale?: string): Promise<any>
  readRange(input: { sessionId: string; sheetId: string; range: { startRow: number; endRow: number; startColumn: number; endColumn: number } }): Promise<any>
  readRowOutline(input: { sessionId: string; sheetId: string }): Promise<any>
  close(sessionId: string): Promise<void>
}`,
)

writeFileSync(
  join(OUT_DIR, 'pptx.d.ts'),
  `/**
 * The deck engine, as this app uses it (generated shape, hand-kept types).
 *
 * Only what \`apps/electron/src/main/office-deck.ts\` calls: the engine's own types are dozens of
 * pages long and none of them are ours to promise. If a call needs a new name, add it here with the
 * module it came from.
 */
export declare function openPptx(bytes: Uint8Array): Promise<any>
export declare function savePptxToFile(opened: any, filePath: string): Promise<void>
export declare function runTxn(opened: any, request: { ops: unknown[]; dryRun?: boolean; isolation?: 'atomic' | 'per_op'; parts?: Map<string, unknown> }): { applied?: boolean; records?: unknown[]; failures?: unknown[] }
/** The editor’s edit script → ops (the same mapper its own main uses). */
export declare function mapScriptOps(opened: any, request: Record<string, unknown>): Array<Record<string, unknown>>
export declare function buildAllRenderSlides(opened: any, fitWidthPx: number): unknown[]
/** Speaker notes: read by slide path, written by slide index (creates the notes part if missing). */
export declare function getSlideNotes(archive: any, slidePath: string): string
export declare function setSlideNotes(opened: any, slideIndex: number, text: string): boolean
/** Comments, authored in the deck's own author table. */
export declare function getSlideComments(archive: any, slidePath: string): Array<{ authorId: number; author: string; initials: string; dt: string; idx: number; text: string }>
export declare function addSlideComment(opened: any, slideIndex: number, opts: { author: string; initials?: string; text: string }): { authorId: number; author: string; initials: string; dt: string; idx: number; text: string } | null
export declare function deleteSlideComment(opened: any, slideIndex: number, ref: { authorId: number; idx: number }): boolean
/** Sections (the sectionLst extension), as the app's own sidebar model. */
export declare function getSections(opened: any): Array<{ id: string; name: string; slideIndices: number[] }>
export declare function setSections(opened: any, sections: Array<{ id: string; name: string; slideIndices: number[] }>): void
/** Hyperlinks, for the show's click-through. The app reads them as sourceId. */
export declare function getSlideLinks(opened: any, slideIndex: number): Array<{ elementId: string; target: unknown }>
export declare function getRunLinks(opened: any, slideIndex: number): Array<{ elementId: string; paraIndex: number; runIndex: number; target: unknown }>
/** Animations and transitions: the editor's Animations tab and the show's transitions, both ways. */
export declare function getSlideAnimations(slide: any): Array<Record<string, unknown>>
export declare function setSlideAnimations(slide: any, anims: Array<Record<string, unknown>>): void
export declare function getSlideTransition(slide: any): string
export declare function setSlideTransition(slide: any, kind: string): void
/** Auto-advance time (advTm), for a rehearsed show. */
export declare function getSlideAdvanceTime(slide: any): number | null
export declare function setSlideAdvanceTime(slide: any, ms: number | null): void
/** A shape's p:spTgt spid: animations address elements by this number, the editor by id. */
export declare function elementSpid(element: any): number | null
/** The fonts the deck itself embeds, unwrapped to single-face sfnt bytes. */
export declare function listEmbeddedFonts(archive: any): Array<{ typeface: string; style: string; sfnt: Uint8Array }>
/** The spids of shapes carrying recorded narration (the presenter highlights them). */
export declare function narrationSpids(slide: any): number[]
export declare function makeMediaResolver(opened: any): (ref: string) => unknown
export declare function getFontMetrics(): unknown
export declare function buildRenderSlide(slide: any, size: any, opts: Record<string, unknown>): any
/** The footer / slide-number / date settings a slide carries. */
export declare function readHeaderFooter(slide: any): { footer: string | null; slideNum: boolean; date: string | null }
export declare function getElementLink(opened: any, slideIndex: number, elementId: string): unknown
export declare function copyElementData(opened: any, slide: any, element: any): Record<string, unknown>
export declare function getChartElementData(slide: any, elementId: string): unknown
export declare function parseTheme(themeXml: string): { colors?: Record<string, string> }
export declare function materializeSlide(opened: any, slideIndex: number): any | null
export declare function collectSlideBundle(archive: any, slidePath: string, slideXml: string): Record<string, unknown>
/** The deck's own slide layouts, plus the standard set when it has none. */
/** The deck’s layout and master parts, and one of them parsed into a slide. */
export declare function listMasterParts(archive: any): Array<{ partPath: string; kind: string; name: string }>
export declare function parseMasterPart(archive: any, partPath: string): any | null
export declare function listSlideLayouts(archive: any): Array<{ name: string; path: string; [k: string]: unknown }>
export declare function builtinLayoutInfos(size: { cx: number; cy: number }, taken: Set<string>): Array<{ name: string; path: string; [k: string]: unknown }>
export declare function shouldOfferBuiltinLayouts(layouts: unknown[]): boolean
/** The app's own history: call \`pushHistory\` before an edit, then restore a snapshot to undo. */
export declare function pushHistory(session: any): void
export declare function takeSnapshot(session: any): unknown
export declare function restoreSnapshot(session: any, snapshot: unknown): void
export declare function settleStaleHistoryBatch(session: any): void
`,
)

const source = existsSync(STAMP) ? JSON.parse(readFileSync(STAMP, 'utf8')) : null

/**
 * The pdf save path, **with pdfium**.
 *
 * `save-pdf.ts` applies markups and page operations with `pdf-lib`, and it reaches pdfium twice:
 * **redaction** (permanent removal) and **in-place text surgery** (`text-edit.ts`). Both are real
 * here — the wasm and its loader travel beside the bundle — so a host that offers “erase this”
 * actually erases it.
 */
const pdfSaveEntry = join(SOURCE, '.office-engine-pdf-entry.ts')
writeFileSync(
  pdfSaveEntry,
  "export { savePdfToPath, splitPagesBytes, extractPagesBytes, cropPagesBytes } from '" +
    SOURCE.replace(/\\/g, '/') +
    "/apps/pdf/src/main/save-pdf.ts'\n" +
    "export { loadPdfium } from '" +
    SOURCE.replace(/\\/g, '/') +
    "/apps/pdf/src/main/text-edit.ts'\n" +
    // Text editing is only usable with these three: the editor asks whether the app can draw a
    // string (`canDrawText`), which fonts it may offer (`listEditFonts`), and — for every proposed
    // change — whether that one edit is safe (`validateTextEdits`). Without the last one the tool
    // stays off, which is what this host was doing while the engine could do the work all along.
    "export { validateTextEdits, canDrawText, listEditFonts } from '" +
    SOURCE.replace(/\\/g, '/') +
    "/apps/pdf/src/main/text-edit.ts'",
)

if (wants('pdf')) {
await build({
  entryPoints: [pdfSaveEntry],
  outfile: join(OUT_DIR, 'pdf.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  absWorkingDir: SOURCE,
  plugins: [electronStub],
  // pdf-lib and the pdfium loader stay real packages: the wasm is read at runtime, and a bundled
  // loader would look for it inside the bundle.
  external: ['pdf-lib', '@embedpdf/pdfium'],
  // `text-edit.ts` finds the wasm with `createRequire(import.meta.url)`, and a CJS bundle has no
  // `import.meta` — the loader would be handed `undefined` and fail before reading anything.
  // Spelling it out against `__filename` makes it resolve against the directory the bundle ships
  // in, which is where `@embedpdf/pdfium` sits beside it.
  define: { 'import.meta.url': '__craftBundleUrl' },
  banner: { js: "const __craftBundleUrl = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'warning',
})
}
writeFileSync(
  join(OUT_DIR, 'pdf.d.ts'),
  "/** The pdf engine: its save path and page operations (see office-host/src/pdf.ts). */\n" +
    "export declare function savePdfToPath(sourcePath: string, targetPath: string, request: unknown): Promise<unknown>\n" +
    "export declare function splitPagesBytes(bytes: Uint8Array, perPage: 2 | 4 | 9): Promise<Uint8Array>\n" +
    "export declare function extractPagesBytes(bytes: Uint8Array, pages: number[]): Promise<Uint8Array>\n" +
    "export declare function cropPagesBytes(bytes: Uint8Array, pages: number[], rect: unknown): Promise<Uint8Array>\n" +
    "export declare function validateTextEdits(bytes: Uint8Array, edits: unknown[]): Promise<Array<{ reason: string | null }>>\n" +
    "export declare function canDrawText(text: string, font?: string, bold?: boolean, italic?: boolean): boolean\n" +
    "export declare function listEditFonts(): string[]\n" +
    "export declare function loadPdfium(): Promise<unknown>\n",
)

/**
 * `html2docx` with its **Electron** driver.
 *
 * The converter needs a browser to lay a page out and measure it, and this app already is one —
 * the package ships `ElectronBrowserDriver` beside its Playwright driver for exactly this case.
 * So `electron` is the only external: the bundle runs in the main process and requires the real
 * thing, and nothing has to start somebody else's app to turn a page into a .docx.
 */
const html2docxEntry = join(SOURCE, '.office-engine-html2docx-entry.ts')
writeFileSync(
  html2docxEntry,
  "export { convertHtmlToDocx } from '" +
    SOURCE.replace(/\\/g, '/') +
    "/packages/html2docx/src/index.ts'\n" +
    "export { ElectronBrowserDriver } from '" +
    SOURCE.replace(/\\/g, '/') +
    "/packages/html2docx/src/drivers/electron.ts'",
)
if (wants('html2docx')) {
await build({
  entryPoints: [html2docxEntry],
  outfile: join(OUT_DIR, 'html2docx.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  absWorkingDir: SOURCE,
  plugins: [rawText],
  external: ['electron'],
  logLevel: 'warning',
})
}
writeFileSync(
  join(OUT_DIR, 'html2docx.d.ts'),
  "export declare function convertHtmlToDocx(input: { url: string }, driver: unknown, options?: Record<string, unknown>): Promise<{ docx: Uint8Array; warnings: unknown[] }>\n" +
    "export declare class ElectronBrowserDriver {\n  static create(viewport: { width: number; height: number; deviceScaleFactor: number }): Promise<ElectronBrowserDriver>\n  close(): Promise<void>\n}\n",
)

/**
 * What of each package is actually loaded, by top-level entry.
 *
 * Copying the whole directory is what made this folder 41 MB. `pdf-lib` ships the same code four
 * times — `cjs/` (what `main` points at), `es/`, a UMD `dist/`, `ts3.4/` — and a `.map` beside each
 * file; the maps alone are 12.3 MB here, and nothing in this host reads one. Only the shape the
 * engine `require`s is kept, so the duplicates never reach the disk.
 */
const RUNTIME_ENTRIES: Record<string, readonly string[]> = {
  'pdf-lib': ['package.json', 'cjs', 'node_modules'],
}

function keepPackageFile(name: string, relativePath: string): boolean {
  if (relativePath.endsWith('.map')) return false
  const allowed = RUNTIME_ENTRIES[name]
  if (!allowed) return true
  return allowed.includes(relativePath.split('/')[0] ?? '')
}

/**
 * Copy jszip and whatever it requires into `office-engine/node_modules`.
 *
 * A bundled jszip reports "nodestream is not supported by this platform" on the first save — it
 * decides by requiring `readable-stream` — so the real package travels beside the bundle, exactly
 * as GenOffice ships it beside its own CLI. Only the subtree it actually needs is copied.
 */
function copyJszipTree(): string[] {
  const requireFromSource = createRequire(join(SOURCE, 'package.json'))
  const copied: string[] = []
  const seen = new Set<string>()

  const walk = (name: string) => {
    let pkgPath: string
    try {
      pkgPath = requireFromSource.resolve(`${name}/package.json`)
    } catch {
      return
    }
    const dir = dirname(pkgPath)
    if (seen.has(dir)) return
    seen.add(dir)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const dest = join(OUT_DIR, 'node_modules', name)
    // Start clean. `cpSync` merges into an existing directory and never deletes, so a filter alone
    // leaves whatever a previous (fuller) copy put there — which is how 22 MB of pdf-lib survived the
    // first attempt at trimming it.
    rmSync(dest, { recursive: true, force: true })
    cpSync(dir, dest, {
      recursive: true,
      filter: (src) => {
        const inside = relative(dir, src).split(sep).join('/')
        return inside === '' || keepPackageFile(name, inside)
      },
    })
    copied.push(name)
    for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep)
  }

  walk('jszip')
  walk('pdf-lib')
  walk('@embedpdf/pdfium')
  /**
   * Font subsetting for **in-place text edits** (`hb-subset.wasm`).
   *
   * Omission here is silent and confusing: without it the engine's font path resolves to
   * `undefined`, and the edit is skipped with Node's own `The "path" argument must be of type
   * string. Received undefined` — which reads like a coordinate or API bug, not a missing file.
   */
  walk('harfbuzzjs')
  return copied
}

const shipped = copyJszipTree()

/** The faces the deck measures text with: copied beside the bundle, where the import points. */
const FONT_DIR = join(OUT_DIR, 'fonts')
if (assetFiles.length) {
  mkdirSync(FONT_DIR, { recursive: true })
  for (const file of new Set(assetFiles)) {
    cpSync(file, join(FONT_DIR, basename(file)))
  }
}
writeFileSync(
  join(OUT_DIR, '.office-engine.json'),
  JSON.stringify({ engine: 'pptx', commit: source?.commit ?? null, builtAt: new Date().toISOString() }, null, 2) + '\n',
)

console.log(`✓ pptx engine → ${join(OUT_DIR, 'pptx.cjs')} (${Date.now() - started} ms)`)
console.log(`  beside it: ${shipped.join(', ') || 'nothing'}`)
console.log(`  fonts: ${assetFiles.length} copied`)
console.log(`  history: pushHistory / takeSnapshot / restoreSnapshot exported`)
console.log(`  source: ${SOURCE}${source?.commit ? ` @ ${String(source.commit).slice(0, 8)}` : ''}`)
