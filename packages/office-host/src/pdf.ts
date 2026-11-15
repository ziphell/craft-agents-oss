/**
 * The pdf host: a document the renderer edits and this process writes.
 *
 * The fourth editor, and the one with the fewest moving parts on this side: the pdf app reads the
 * file itself (pdf.js), applies every change to the source bytes itself (pdf-lib), and asks the
 * host for exactly two things — the bytes of the file it was told to open, and somewhere to write
 * the result. So what lives here is a **path**, and the write path.
 *
 * Both pdfium capabilities **are real in the engine** — this comment used to say they were stubbed
 * out, and that was wrong; measured, not assumed:
 *
 * - **Redaction** works: a copy of a page with `redactions` comes back with the text gone from the
 *   content stream, not merely covered (`pdf read` shows the line missing). The only rule this host
 *   adds is that it writes a **copy**, never the open file — redaction has no undo.
 * - **In-place text surgery** also exists (`text-edit.ts`), but nothing reaches it: the editor gates
 *   its text tool on `validateTextEdits` and `canDrawText`, and **the engine bundle does not export
 *   `validateTextEdits`** (see `scripts/build-office-engine.ts` — the entry lists five names). So
 *   the tool stays off because it cannot be validated, not because the engine cannot do it.
 *
 * Read-only previews work as they do everywhere in the office host: the frame is served with a shim
 * that refuses writes, so a conversation block shows a pdf that cannot be changed by accident.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { extractPageTexts } from './pdf-raster'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { getBundledAssetsDir } from '@craft-agent/shared/utils'
import { runCliTool } from '@craft-agent/shared/utils/cli-tool'
import { checkDocument, conflictMessage, recordFromDisk } from './guard'
import { noteUnwired } from './deck'
import { renderPagePng, type PdfRect } from './pdf-raster'
import { officeDeliver, officeRuntime } from './runtime'

interface PdfEngine {
  savePdfToPath(sourcePath: string, targetPath: string, request: unknown): Promise<unknown>
  /** Per proposed text change: `{reason}` when it cannot be made safely, `{reason: null}` when it can. */
  validateTextEdits(bytes: Uint8Array, edits: unknown[]): Promise<Array<{ reason: string | null }>>
  /** Whether this app has a font that covers `text` (its own, or a bundled fallback). */
  canDrawText(text: string, font?: string, bold?: boolean, italic?: boolean): boolean
  /** The fonts the text tool may offer. */
  listEditFonts(): string[]
  /** Group `perPage` pages onto one sheet (a 2x1 / 2x2 / 3x3 layout), as bytes. */
  splitPagesBytes(bytes: Uint8Array, perPage: 2 | 4 | 9): Promise<Uint8Array>
  /** A new pdf holding only `pages` (1-based). */
  extractPagesBytes(bytes: Uint8Array, pages: number[]): Promise<Uint8Array>
  /** Set the crop box on `pages`. */
  cropPagesBytes(bytes: Uint8Array, pages: number[], rect: unknown): Promise<Uint8Array>
}

let engine: PdfEngine | null = null

function loadEngine(): PdfEngine {
  if (engine) return engine
  const root = getBundledAssetsDir('office-engine')
  if (!root) throw new Error('The pdf engine is not installed. Run: bun scripts/build-office-engine.ts')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  engine = require(join(root, 'pdf.cjs')) as PdfEngine
  return engine
}

/** The file a frame was opened on, per path — the pdf app asks for it without naming it. */
const opened = new Map<string, string>()

/** Where the command line lives — the same three answers the document tool uses. */
function genofficeCli(): string | null {
  const configured = process.env.GENOFFICE_CLI
  if (configured && existsSync(configured)) return configured
  const candidates = [
    // `resourcesPath` is Electron's addition to `process`; absent on a hub, which finds the CLI
    // through `getBundledAssetsDir` above (CRAFT_BUNDLED_ASSETS_ROOT) instead.
    typeof (process as { resourcesPath?: string }).resourcesPath === 'string'
      ? join((process as { resourcesPath?: string }).resourcesPath!, 'cli', 'genoffice.cjs')
      : null,
    join(process.cwd(), 'apps', 'electron', 'resources', 'cli', 'genoffice.cjs'),
    join(process.cwd(), '..', 'genoffice', 'packages', 'cli', 'dist', 'genoffice.cjs'),
  ].filter((path): path is string => !!path)
  return candidates.find((path) => existsSync(path)) ?? null
}

/** The pdfium wasm the command line needs for PDF work; it ships beside the engine bundle. */
function pdfiumWasm(): string | null {
  const engineRoot = getBundledAssetsDir('office-engine')
  const wasm = engineRoot ? join(engineRoot, 'node_modules', '@embedpdf', 'pdfium', 'dist', 'pdfium.wasm') : null
  return wasm && existsSync(wasm) ? wasm : null
}

function runCli(cliPath: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // Same rule as the workbook host: the runtime is chosen by whoever owns the process.
    const runtime = officeRuntime()
    const env: NodeJS.ProcessEnv = { ...process.env, ...runtime.env }
    const wasm = pdfiumWasm()
    if (wasm) env.GENOFFICE_PDFIUM_WASM = wasm
    const child = spawn(runtime.command, [cliPath, ...args], { cwd, env })
    let out = ''
    child.stdout?.on('data', (chunk) => (out += String(chunk)))
    child.stderr?.on('data', (chunk) => (out += String(chunk)))
    child.on('error', (error) => resolve({ code: -1, out: error.message }))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

export function pdfRememberOpen(path: string): void {
  opened.set(path, path)
}

/** The pixels the recogniser gets for one page — the same page-sized default `pdf ocr` uses. */
const PAGE_OCR_MAX_SIDE = 1600

interface OcrLineAnswer {
  text?: unknown
  confidence?: unknown
  box?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
}

/** A line the editor can index: [left, bottom, right, top], 0–1, counted from the bottom-left. */
export interface OcrPageLine {
  text: string
  confidence: number
  box: [number, number, number, number]
}

/**
 * The bundled OCR's answer, in the space the editor reads.
 *
 * The OCR tool counts pixels from the top-left; the editor's `boxToDisp` counts normalized units
 * from the bottom-left. The flip is here, once, rather than in a caller that would have to remember
 * it. A line without text or with an unusable box is dropped (the editor would discard it anyway);
 * a malformed answer is an empty page, not a crash.
 */
export function ocrAnswerToLines(answer: {
  width?: unknown
  height?: unknown
  lines?: unknown
}): OcrPageLine[] {
  const width = typeof answer.width === 'number' ? answer.width : 0
  const height = typeof answer.height === 'number' ? answer.height : 0
  if (width <= 0 || height <= 0 || !Array.isArray(answer.lines)) return []

  const clamp = (value: number): number => Math.max(0, Math.min(1, value))
  const lines: OcrPageLine[] = []
  for (const raw of answer.lines) {
    if (!raw || typeof raw !== 'object') continue
    const line = raw as OcrLineAnswer
    const text = typeof line.text === 'string' ? line.text.trim() : ''
    const box = line.box
    if (!text || !box) continue
    const x = Number(box.x)
    const y = Number(box.y)
    const w = Number(box.width)
    const h = Number(box.height)
    if (![x, y, w, h].every(Number.isFinite)) continue
    lines.push({
      text,
      confidence: typeof line.confidence === 'number' ? line.confidence : 0,
      box: [clamp(x / width), clamp(1 - (y + h) / height), clamp((x + w) / width), clamp(1 - y / height)],
    })
  }
  return lines
}

/**
 * One rendered page, as the lines the editor indexes and draws.
 *
 * The editor hands over the page it rendered — a bare base64 PNG with the page's rotation already
 * applied — and expects boxes **normalized 0–1 with the origin at the bottom-left** (`boxToDisp`
 * flips y). The bundled OCR answers in image pixels with the origin at the top-left, so the flip
 * happens here, once, for every line.
 *
 * The two answers the caller distinguishes are kept: `null` means "no engine" and stops the pass;
 * an empty array means "this page had no words" and the caller moves on. A transient failure on one
 * page is the second, because a page that cannot be read is not a reason to abandon the document.
 */
async function ocrPageLines(png: string): Promise<OcrPageLine[] | null> {
  const dir = mkdtempSync(join(tmpdir(), 'craft-ocr-'))
  try {
    const file = join(dir, 'page.png')
    writeFileSync(file, Buffer.from(png, 'base64'))

    const run = await runCliTool('img-tool', ['text', file, '--max-side', String(PAGE_OCR_MAX_SIDE)], {
      timeoutMs: 120_000,
    })
    if (!run.ok) {
      const reason = `${run.message ?? ''}\n${run.stderr}`.trim()
      // No models / no tool is "no engine": stop the pass instead of asking again for every page.
      if (/OCR models are not installed|not built|could not start/i.test(reason)) return null
      return []
    }

    try {
      const answer = JSON.parse(run.stdout) as { width?: unknown; height?: unknown; lines?: unknown }
      return ocrAnswerToLines(answer)
    } catch {
      return []
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The editor's method table, as one door — same arrangement as the deck and workbook hosts.
 *
 * `OfficeFrame` forwards with the document's path in front (`[path, ...args]`).
 */
export async function officePdfCall(method: string, args: unknown[]): Promise<unknown> {
  const path = typeof args[0] === 'string' ? args[0] : ''
  const rest = args.slice(1)

  switch (method) {
    case 'consumePending':
      // The app asks "which file am I showing?" with no argument; the frame knows.
      return existsSync(path) ? path : null

    case 'openSourcePath':
    case 'open':
      pdfRememberOpen(path)
      return path

    case 'readFile':
      /**
       * **The bytes, not a permission.**
       *
       * The editor does `new Uint8Array(await pdfApi.readFile(path))` and hands that straight to
       * pdf.js — so this is a file read, the same one the app's own `pdf:readFile` performs over
       * IPC. Answering `true` here reads as a one-byte document and the editor opens onto nothing,
       * which is a failure with no error in it: worth stating, because the shape of this answer is
       * the difference between a working editor and a blank window.
       */
      return new Uint8Array(await readFile(path))

    /**
     * One image out of a page, as a data URL.
     *
     * The rect is in PDF points (pdfium's own space), which is what `listPageImages` hands out — so
     * this one needs no guesswork. It is reachable only when that list has something in it, and
     * this build lists nothing; the door is here so a future build that does is not a crash.
     */
    case 'pageImagePng': {
      const request = (rest[0] ?? {}) as { path?: string; pageIndex?: number; rect?: PdfRect }
      const source = typeof request.path === 'string' && request.path ? request.path : path
      const rect = normaliseRect(request.rect)
      if (!source || !rect) return null
      try {
        const png = await renderPagePng({
          bytes: new Uint8Array(await readFile(source)),
          pageIndex: Number(request.pageIndex ?? 0),
          crop: rect,
          pxWidth: undefined,
        })
        return `data:image/png;base64,${Buffer.from(png).toString('base64')}`
      } catch {
        return null
      }
    }

    /**
     * A page as a PNG data URL — not an editor method, a door for this app's own UI.
     *
     * It exists because of what a redaction cannot show on its own: the editor keeps its pending
     * marks to itself (they leave it only in a `save` request), so nothing outside can draw "this is
     * what it will look like". What *can* be shown is the copy that was just written — which is the
     * thing a person actually needs to check: that the text is gone, not that a box was drawn.
     */
    case 'renderPagePng': {
      const request = (rest[0] ?? {}) as { pageIndex?: number; pxWidth?: number }
      const source = path
      if (!source) return null
      try {
        const png = await renderPagePng({
          bytes: new Uint8Array(await readFile(source)),
          pageIndex: Number(request.pageIndex ?? 0),
          pxWidth: request.pxWidth ? Number(request.pxWidth) : undefined,
        })
        return { png: `data:image/png;base64,${Buffer.from(png).toString('base64')}` }
      } catch {
        return null
      }
    }

    case 'printers':
      // The window that shows the document prints it (`OfficeFrame` answers `print` itself), so a
      // printer list would be a list this host cannot use. Empty is the honest answer, and the
      // editor falls back to the system dialog.
      return []

    /**
     * A new file from the open one: grouped pages, extracted pages, a crop, page images.
     *
     * All four are the engine's own byte operations — the same code the desktop app runs — so the
     * only thing this host decides is **where the bytes land** (`officeDeliver`): beside the
     * document on the desktop, or a download on a hub, where the person's filesystem is not this
     * machine's. A host with no deliverer refuses in words rather than writing somewhere nobody
     * will look.
     */
    case 'splitPages': {
      const request = (rest[0] ?? {}) as { perPage?: 2 | 4 | 9; suggestedName?: string }
      const perPage = request.perPage === 4 || request.perPage === 9 ? request.perPage : 2
      const bytes = await loadEngine().splitPagesBytes(await readFile(path), perPage)
      return deliverOne(path, request.suggestedName || `${baseNameOf(path)}-split.pdf`, bytes)
    }

    case 'extractPages': {
      const request = (rest[0] ?? {}) as { pages?: number[]; suggestedName?: string }
      const pages = Array.isArray(request.pages) ? request.pages.filter((n) => Number.isFinite(n)) : []
      if (!pages.length) return { ok: false, error: 'No pages were named to extract.' }
      const bytes = await loadEngine().extractPagesBytes(await readFile(path), pages)
      return deliverOne(path, request.suggestedName || `${baseNameOf(path)}-pages.pdf`, bytes)
    }

    case 'cropPages': {
      const request = (rest[0] ?? {}) as { pages?: number[]; rect?: unknown; suggestedName?: string }
      const pages = Array.isArray(request.pages) ? request.pages.filter((n) => Number.isFinite(n)) : []
      if (!pages.length || !request.rect) return { ok: false, error: 'Cropping needs pages and a rectangle.' }
      const bytes = await loadEngine().cropPagesBytes(await readFile(path), pages, request.rect)
      return deliverOne(path, request.suggestedName || `${baseNameOf(path)}-cropped.pdf`, bytes)
    }

    case 'exportImages': {
      // The renderer already rasterized the pages; this side only writes them, as upstream does.
      const request = (rest[0] ?? {}) as { images?: string[]; pageNumbers?: number[]; baseName?: string }
      const images = Array.isArray(request.images) ? request.images : []
      if (!images.length) return { ok: false, error: 'No images were produced to export.' }
      const pages = Array.isArray(request.pageNumbers) ? request.pageNumbers : images.map((_, i) => i + 1)
      const stem = sanitizeName(request.baseName || baseNameOf(path))
      const files = images.map((base64, index) => ({
        name: `${stem}-p${pages[index] ?? index + 1}.png`,
        bytes: new Uint8Array(Buffer.from(base64, 'base64')),
        mime: 'image/png',
      }))
      return deliverAll(path, files)
    }

    case 'getUsername':
      return ''

    case 'isUntitled':
      return false

    /**
     * One page of the editor's OCR pass.
     *
     * The pass is automatic: opening a scanned document asks for each page that has almost no text
     * layer, up to 40 per pass, starting from the page the person is looking at. That loop belongs
     * to the vendored editor; this host answers **one page at a time**, in the order it is asked.
     *
     * `null` means "no engine" and stops the pass (`ocr-layer.tsx` finishes with `noEngine`); `[]`
     * means this page had nothing to read and the caller moves on. The words feed search, selection
     * and the assistant panel, and a save bakes them into an invisible text layer.
     */
    case 'ocrPage': {
      const png = typeof rest[0] === 'string' ? rest[0] : ''
      // No image (an old caller, or a page the editor could not draw): the pass stops rather than
      // inventing an empty page.
      if (!png) return null
      return ocrPageLines(png)
    }

    /**
     * The editor's "PDF → Word / Excel / PowerPoint" button.
     *
     * The conversion is `pdf2docx` — the same engine the command line runs headlessly — so rather
     * than bundling a second copy into this host, the work is done by `genoffice convert`, exactly
     * as the workbook save delegates to `sheet apply`. One implementation, two doors.
     *
     * A scanned page has no text layer to rebuild: the answer carries the engine's warning rather
     * than a docx full of pictures passed off as a conversion.
     */
    case 'convertOffice': {
      const format = typeof rest[0] === 'string' ? rest[0] : 'docx'
      const allowed = ['docx', 'xlsx', 'pptx', 'md', 'html']
      if (!allowed.includes(format)) return { ok: false, error: `Unknown target ${format}.` }
      const cliPath = genofficeCli()
      if (!cliPath) return { ok: false, error: 'The document engine is not installed (resources/cli).' }

      // Never over an existing file: the target is derived from the pdf's name, so it may well be
      // somebody's document already. A conversion lands beside it, under a name that says so.
      const stem = path.replace(/\.pdf$/i, '')
      let target = `${stem}.${format}`
      if (existsSync(target)) target = `${stem}-converted.${format}`
      for (let n = 2; existsSync(target); n += 1) target = `${stem}-converted-${n}.${format}`

      const result = await runCli(cliPath, ['convert', path, '--to', format, '--out', target], join(path, '..'))
      if (result.code !== 0) {
        // `html` is the one target the command line cannot do headlessly: it starts a GenOffice
        // process for its own renderer. Saying that is more useful than the spawn's exit code.
        if (result.out.includes('starting GenOffice')) {
          return {
            ok: false,
            error: `PDF → ${format} needs an editor process to render it, and this host does not run one. PDF → Word / Excel / PowerPoint / Markdown work here.`,
          }
        }
        return { ok: false, error: result.out.trim().slice(0, 600) || `The engine declined (exit ${result.code}).` }
      }
      return { ok: true, path: target, detail: result.out.trim().slice(0, 200) }
    }

    /**
     * Keep only these pages, in place.
     *
     * The editor calls this after pages are deleted and then reloads the same path, so the file on
     * disk has to *become* the shortened document. `extractPagesBytes` is the engine's own page
     * surgery — the same one Extract uses — so this is a rewrite, not a second implementation.
     *
     * The save guard applies as it does to `save`: if the file changed under the editor (the agent
     * wrote it), the rewrite is refused rather than quietly discarding that version.
     */
    case 'replacePages': {
      const request = (rest[0] ?? {}) as { path?: string; pages?: unknown }
      const source = typeof request.path === 'string' && request.path ? request.path : path
      const pages = Array.isArray(request.pages)
        ? request.pages.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1)
        : []
      if (!source || pages.length === 0) {
        return { ok: false, error: 'Nothing to keep: replacePages needs the 1-based pages.' }
      }
      if ((await checkDocument(source)) === 'conflict') {
        return { ok: false, error: conflictMessage(source), conflict: true }
      }
      try {
        const kept = await loadEngine().extractPagesBytes(await readFile(source), pages)
        await writeFile(source, kept)
        await recordFromDisk(source)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    /**
     * Operations the bundled engine cannot perform, named one by one.
     *
     * These are menu items, and an `undefined` answer is not silence: the editor's `runFileOp` reads
     * it as "the flush failed" and reports a problem with the wrong thing. What is actually missing
     * is a **merger** (`mergePdf`, `insertPdf`), a **page resizer** (`setPageSize`), the layout
     * options of multi-up (`mergePages` — direction and separator, which `splitPagesBytes` does not
     * take), and a **page count** for `splitPdf` (the editor sends only a chunk size).
     */
    case 'mergePdf':
    case 'insertPdf':
    case 'mergePages':
    case 'setPageSize':
    case 'splitPdf':
      return {
        ok: false,
        error: `${method} is not available in this build: the bundled PDF engine has no ${METHOD_NEEDS[method]}.`,
      }

    /**
     * Text editing, answered by the engine rather than guessed here.
     *
     * All three exist for one reason: the editor will not offer to change a character until the app
     * has said whether that particular change is safe — the new glyphs have to be in the document's
     * font (a subset often lacks them) and the string has to fit its old box. `undefined` here used
     * to mean the tool stayed off, which read as "this build cannot edit text"; the engine could, and
     * the bundle simply did not export the question.
     */
    /**
     * Whether this app can draw `text` — the question the editor asks before it offers the text
     * tool or lets a new string be committed.
     *
     * It stayed `false` for a while because the *apply* half was quietly broken: the engine's font
     * path came back `undefined` (the vendored `harfbuzzjs` was never copied next to the engine),
     * and every edit was skipped with Node's own `The "path" argument must be of type string`.
     * Fixed in `scripts/build-office-engine.ts`; with it in place an edit lands and the text layer
     * shows the new string — so the answer is the engine's again.
     */
    case 'canDrawText': {
      const text = typeof rest[0] === 'string' ? rest[0] : ''
      if (!text) return false
      return loadEngine().canDrawText(text)
    }

    case 'listEditFonts':
      return loadEngine().listEditFonts()

    case 'validateTextEdits': {
      const request = (rest[0] ?? {}) as { path?: string; edits?: unknown[] }
      const source = typeof request.path === 'string' && request.path ? request.path : path
      const edits = Array.isArray(request.edits) ? request.edits : []
      if (!source || edits.length === 0) return []
      try {
        return await loadEngine().validateTextEdits(new Uint8Array(await readFile(source)), edits)
      } catch (error) {
        // One row per edit, or the editor's `([v]) => …` destructure gets nothing to read.
        const reason = error instanceof Error ? error.message : String(error)
        return edits.map(() => ({ reason }))
      }
    }

    /** The same empty list, under the name the printer dialog asks by. */
    /**
     * Compare mode: per-page text of the picked document and of the open one.
     *
     * Both sides go through **pdfium** (`extractPageTexts`), which is the point: pdf.js and pdfium
     * break lines differently, so a diff across engines reports changes on files that are identical.
     * The picked path travels as the second argument; the first is the open document.
     */
    case 'compareReadPdf': {
      const picked = typeof rest[0] === 'string' ? (rest[0] as string) : ''
      if (!picked) return { ok: false, reason: 'no document was picked' }
      try {
        const pages = await extractPageTexts(new Uint8Array(await readFile(picked)))
        return { ok: true, name: picked.split(/[\/]/).pop() ?? picked, pageCount: pages.length, pages }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }

    case 'compareReadOpen': {
      try {
        const pages = await extractPageTexts(new Uint8Array(await readFile(path)))
        return { ok: true, name: path.split(/[\/]/).pop() ?? path, pageCount: pages.length, pages }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }

    case 'listPrinters':
    case 'listPageImages':
    case 'listStaticFormFills':
    case 'listDigitalSignatures':
    case 'listSystemCertificates':
    case 'listSavedSignatures':
      return []

    /**
     * Signing is the platform's certificate store and a trust model this host does not have.
     * Listed explicitly so the panel knows there is nothing to list — and so the answer is a
     * sentence rather than `undefined` if a build ever calls one of them anyway.
     */
    case 'signWithCertificate':
    case 'pickCertificate':
    case 'inspectCertificate':
    case 'releaseCertificate':
    case 'addSavedSignature':
    case 'removeSavedSignature':
      return { ok: false, error: `${method} is not available in this build: there is no certificate store here.` }

    /**
     * Writing: the renderer has already applied its edits to the source bytes, so this is
     * `savePdfToPath` with the request it built. Redaction and text surgery throw from the stub
     * inside the engine, with a sentence rather than a silent no-op.
     */
    case 'save': {
      const request = (rest[0] ?? {}) as {
        path?: string
        targetPath?: string
        overwrite?: boolean
        redactions?: unknown[]
      }
      const source = typeof request.path === 'string' && request.path ? request.path : path
      const target = typeof request.targetPath === 'string' && request.targetPath ? request.targetPath : source

      /**
       * Permanent redaction only ever writes a **copy**.
       *
       * The engine's own rule is that redactions are "accepted only for an explicitly authorized
       * Save As copy" — upstream ties that to a save dialog. This host has no dialog, and its
       * `save` writes in place when no `targetPath` is given, so the same request would permanently
       * destroy text in the file the person is looking at, with no undo. Refused in words instead.
       */
      if (Array.isArray(request.redactions) && request.redactions.length > 0) {
        if (target === source) {
          return {
            ok: false,
            error: 'Permanent redaction writes a copy, not the open file — use Save As to a new path for it.',
          }
        }
      }
      // Checked on the **target**: a save-as writes a file nobody opened, and an in-place save
      // writes the one that was. Either way a refusal names the file a person would recognise.
      if (!request.overwrite && (await checkDocument(target)) === 'conflict') {
        return { ok: false, error: conflictMessage(target), conflict: true }
      }
      try {
        const skips = await loadEngine().savePdfToPath(source, target, request)
        await recordFromDisk(target)
        return { ok: true, path: target, skips }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    default:
      noteUnwired('pdf', method)
      return undefined
  }
}

/** A rect the editor sent, or null when it is not four finite numbers. */
function normaliseRect(value: unknown): PdfRect | null {
  if (!value || typeof value !== 'object') return null
  const rect = value as Record<string, unknown>
  const numbers = ['x', 'y', 'width', 'height'].map((key) => Number(rect[key]))
  if (!numbers.every((n) => Number.isFinite(n))) return null
  const [x, y, width, height] = numbers as [number, number, number, number]
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

/** What each unavailable menu operation is missing, for the refusal it names. */
const METHOD_NEEDS: Record<string, string> = {
  mergePdf: 'way to combine documents',
  insertPdf: 'way to combine documents',
  mergePages: 'multi-up layout options',
  setPageSize: 'way to resize pages',
  splitPdf: 'count of pages (it is told only a chunk size)',
}

/** A file's name without its directory or extension. */
function baseNameOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? 'document'
  return name.replace(/\.[^.]+$/, '') || 'document'
}

/** A name that is safe on every platform and cannot climb out of a directory. */
function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '').slice(0, 120) || 'document'
}

/** Put one produced file wherever this host puts files. */
async function deliverOne(source: string, name: string, bytes: Uint8Array) {
  return deliverAll(source, [{ name: sanitizeName(name), bytes, mime: 'application/pdf' }])
}

/**
 * Hand the files to the host's deliverer, and shape the answer the editor expects.
 *
 * The editor's contract is `{ ok, savedPath }` — it shows that path to a person — so a download is
 * named there too: on a hub the file is *about to be* in their downloads, and naming it is the
 * truthful answer. `download`/`savedPaths` travel alongside for the frame, which is what actually
 * performs the download (`OfficeFrame`).
 */
async function deliverAll(source: string, files: Array<{ name: string; bytes: Uint8Array; mime: string }>) {
  const deliver = officeDeliver()
  if (!deliver) {
    return {
      ok: false,
      error: 'This host cannot put a new file anywhere — no delivery is configured for documents.',
    }
  }
  const delivery = await deliver(files, source)
  const first = delivery.savedPaths?.[0] ?? delivery.downloads?.[0]?.name
  return { ok: true, savedPath: first, ...delivery }
}
