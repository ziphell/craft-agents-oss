/**
 * `office_tool pdf …` — the page-and-mark operations on a PDF.
 *
 * The Python `pdf-tool` did twenty-two things; this is the part an agent actually asks for, and it
 * is built on what the app **already ships**: the PDF engine bundle (`office-engine/pdf.cjs`, pdfium
 * for byte-level page work) and the `pdf-lib` that bundle carries for everything drawn or written.
 * No new dependency, no Python, no `uv`.
 *
 * What is here: `info`, `split`, `reorder`, `duplicate`, `crop`, `nup`, `merge`, `rotate`,
 * `watermark`, `header-footer`, `from-image`, `fill-form`. Reading the text layer is `pdf read`
 * (the engine's own command line), and `pdf → docx/xlsx/pptx/md` is `convert`.
 *
 * What is deliberately not here, each for a reason a caller can act on:
 *
 * - **`encrypt` / `decrypt`** — `pdf-lib` has no encryption writer, and pdfium reads an encrypted
 *   document but does not write one. A password-protected file can be opened in the app.
 * - **`redact`** — removing text means re-drawing the page; pdfium can render it, but a redaction
 *   that is not verified is worse than none, and this tool will not guess.
 * - **`compress`** — `pdf-lib` already writes compressed streams on save; a "compress" button that
 *   promises more would be a lie about what happened.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { resolveLocalPath, tokenizeCommand, type BrowserCommandResult } from './command-cli.ts'

const say = (output: string): BrowserCommandResult => ({ output, appendReleaseHint: false })

/** The verbs this file answers. `office_tool pdf read` stays the engine's own command. */
export const PDF_VERBS = [
  'info',
  'split',
  'reorder',
  'duplicate',
  'crop',
  'nup',
  'merge',
  'rotate',
  'watermark',
  'header-footer',
  'from-image',
  'fill-form',
] as const
export type PdfVerb = (typeof PDF_VERBS)[number]

interface PdfEngine {
  /** The engine's own pdfium, initialized — the same wasm it draws pages with. */
  loadPdfium(): Promise<PdfiumModule>
  extractPagesBytes(bytes: Uint8Array, pages: number[]): Promise<Uint8Array>
  cropPagesBytes(bytes: Uint8Array, pages: number[], rect: { l: number; t: number; r: number; b: number }): Promise<Uint8Array>
  splitPagesBytes(bytes: Uint8Array, perPage: 2 | 4 | 9): Promise<Uint8Array>
}

/** The engine bundle and the `pdf-lib` beside it — the app's own copies, in every host. */
function assetsDir(): string | null {
  const candidates = [
    typeof process.resourcesPath === 'string' ? join(process.resourcesPath, 'office-engine') : null,
    process.env.CRAFT_RESOURCES_BASE ? join(process.env.CRAFT_RESOURCES_BASE, 'resources', 'office-engine') : null,
    join(process.cwd(), 'apps', 'electron', 'resources', 'office-engine'),
  ].filter((path): path is string => !!path)
  return candidates.find((dir) => existsSync(join(dir, 'pdf.cjs'))) ?? null
}

function loadPdfEngine(): PdfEngine | null {
  const dir = assetsDir()
  if (!dir) return null
  const require = createRequire(join(dir, 'pdf.cjs'))
  return require(join(dir, 'pdf.cjs')) as PdfEngine
}

/**
 * The wasm module behind the engine bundle: pdfium's raw C exports plus the heap they write into.
 *
 * Named by the engine's own loader (`loadPdfium`) rather than loaded here, so this file never
 * guesses where the wasm sits in a packaged app — and so the library is initialized exactly once.
 */
interface PdfiumModule {
  HEAPU8: Uint8Array
  _malloc(size: number): number
  _free(pointer: number): void
  [rawExport: string]: unknown
}

/** `PDF_PAGEOBJ_IMAGE` — the one object type whose area answers "is this page a picture". */
const FPDF_PAGEOBJ_IMAGE = 3

/**
 * A page with more text than this already has an answer; OCR would only say it again, worse.
 *
 * The line is drawn above a watermark and a letterhead, not between them: a watermark is a line or
 * two, a letterhead is a line, and either can reach fifty characters once a company name, a date and
 * a document label are on it. Missing a scanned body costs the caller the whole page; reading a
 * sparse page again costs a few hundred milliseconds — so the threshold errs towards reading.
 */
export const PDF_OCR_MIN_TEXT_CHARS = 100

/** A single picture covering this much of the page is a scan, whatever text rides on top of it. */
export const PDF_OCR_SCAN_COVERAGE = 0.7

/** What one page says about itself before a single pixel is recognised. */
export interface PdfPageStats {
  /** Characters the page's own text layer holds. */
  chars: number
  /** The largest single image's share of the page, 0–1. */
  imageCoverage: number
  /** The page's text layer, as the reader would get it. */
  text: string
  width: number
  height: number
}

/**
 * Whether a page still needs OCR.
 *
 * Two kinds of page do: one with (almost) no text of its own, which is a scan, and one where a
 * single picture covers most of the page — the scan whose letterhead is the only real text. A page
 * that already carries prose and no page-sized picture does not: its own text layer is the answer.
 */
export function pageNeedsOcr(stats: PdfPageStats): boolean {
  return stats.chars < PDF_OCR_MIN_TEXT_CHARS || stats.imageCoverage >= PDF_OCR_SCAN_COVERAGE
}

/**
 * What one page holds: its text layer, and how much of it is one image.
 *
 * Read with the pdfium the engine already ships, in this process — no renderer, no second parser.
 * `null` means the question could not be asked here (no engine, an encrypted file, a page out of
 * range), and every caller treats that as "OCR it anyway" rather than as an empty page.
 *
 * **Coverage is the largest single image, not the sum.** A scan is one picture of a sheet; summing
 * overlapping ones (a scan plus a watermark image, a logo repeated in a form) would call a normal
 * page a scan twice over. Bounds are in page points and are clipped to the page before measuring.
 */
export async function pdfPageStats(file: string, page: number): Promise<PdfPageStats | null> {
  const engine = loadPdfEngine()
  if (!engine?.loadPdfium) return null
  try {
    const bytes = read(file)
    const pdfium = await engine.loadPdfium()
    const call = (name: string, ...args: number[]): number =>
      (pdfium[name] as (...a: number[]) => number)(...args)

    const docPointer = pdfium._malloc(bytes.length)
    pdfium.HEAPU8.set(bytes, docPointer)
    let doc = 0
    try {
      doc = call('_FPDF_LoadMemDocument', docPointer, bytes.length, 0)
      if (!doc) return null
      const index = page - 1
      if (index < 0 || index >= call('_FPDF_GetPageCount', doc)) return null

      const handle = call('_FPDF_LoadPage', doc, index)
      if (!handle) return null
      try {
        const width = call('_FPDF_GetPageWidthF', handle)
        const height = call('_FPDF_GetPageHeightF', handle)

        let chars = 0
        let text = ''
        const textPage = call('_FPDFText_LoadPage', handle)
        if (textPage) {
          try {
            chars = Math.max(0, call('_FPDFText_CountChars', textPage))
            if (chars > 0) {
              // UTF-16LE: FPDFText_GetText writes code units and returns how many it wrote.
              const buffer = pdfium._malloc((chars + 1) * 2)
              try {
                const copied = call('_FPDFText_GetText', textPage, 0, chars, buffer)
                const units = new Uint16Array(pdfium.HEAPU8.buffer, buffer, Math.max(0, copied - 1))
                for (const unit of units) text += String.fromCharCode(unit)
              } finally {
                pdfium._free(buffer)
              }
            }
          } finally {
            call('_FPDFText_ClosePage', textPage)
          }
        }

        let largest = 0
        const count = call('_FPDFPage_CountObjects', handle)
        const rect = pdfium._malloc(16)
        try {
          for (let index = 0; index < count; index += 1) {
            const object = call('_FPDFPage_GetObject', handle, index)
            if (!object || call('_FPDFPageObj_GetType', object) !== FPDF_PAGEOBJ_IMAGE) continue
            // Five arguments: the object, then one pointer each for left / bottom / right / top.
            const bounded = call('_FPDFPageObj_GetBounds', object, rect, rect + 4, rect + 8, rect + 12)
            if (!bounded) continue
            const [left, bottom, right, top] = new Float32Array(pdfium.HEAPU8.buffer, rect, 4)
            const drawnWidth = Math.max(0, Math.min(width, right!) - Math.max(0, left!))
            const drawnHeight = Math.max(0, Math.min(height, top!) - Math.max(0, bottom!))
            largest = Math.max(largest, drawnWidth * drawnHeight)
          }
        } finally {
          pdfium._free(rect)
        }

        const pageArea = width * height
        return {
          chars,
          imageCoverage: pageArea > 0 ? Math.min(1, largest / pageArea) : 0,
          text: text.split(String.fromCharCode(13)).join(''),
          width,
          height,
        }
      } finally {
        call('_FPDF_ClosePage', handle)
      }
    } finally {
      if (doc) call('_FPDF_CloseDocument', doc)
      pdfium._free(docPointer)
    }
  } catch {
    // No engine, a file pdfium will not open, a build without the wasm: the caller still has OCR.
    return null
  }
}

/**
 * `pdf-lib`'s shape, written here rather than imported: the package lives beside the PDF engine
 * bundle in the app's resources, not in this package's dependencies, so there are no types to
 * import — and a `require` of a package that is not a dependency is exactly what a type would lie
 * about. The members below are the ones this file uses.
 */
interface PdfColor {
  readonly __pdfColor?: never
}
interface PdfFont {
  widthOfTextAtSize(text: string, size: number): number
}
interface PdfImage {
  width: number
  height: number
}
interface PdfPage {
  getSize(): { width: number; height: number }
  getWidth(): number
  getHeight(): number
  getRotation(): { angle: number }
  setRotation(angle: unknown): void
  drawText(text: string, options: Record<string, unknown>): void
  drawImage(image: PdfImage, options: Record<string, unknown>): void
}
interface PdfField {
  getName(): string
}
interface PdfForm {
  getFields(): PdfField[]
}
interface PdfDoc {
  getPages(): PdfPage[]
  getPageIndices(): number[]
  copyPages(source: PdfDoc, indices: number[]): Promise<PdfPage[]>
  addPage(pageOrSize?: PdfPage | [number, number]): PdfPage
  save(): Promise<Uint8Array>
  embedFont(name: string): Promise<PdfFont>
  embedPng(bytes: Uint8Array): Promise<PdfImage>
  embedJpg(bytes: Uint8Array): Promise<PdfImage>
  getForm(): PdfForm
  getTitle(): string | undefined
  setTitle(title: string): void
  getAuthor(): string | undefined
  getSubject(): string | undefined
  getCreator(): string | undefined
  getProducer(): string | undefined
  getCreationDate(): Date | undefined
}

interface PdfLib {
  PDFDocument: {
    create(): Promise<PdfDoc>
    load(bytes: Uint8Array, options?: Record<string, unknown>): Promise<PdfDoc>
  }
  rgb(red: number, green: number, blue: number): PdfColor
  StandardFonts: { Helvetica: string }
  degrees(value: number): unknown
}

function loadPdfLib(): PdfLib | null {
  const dir = assetsDir()
  if (!dir) return null
  const libDir = join(dir, 'node_modules', 'pdf-lib')
  if (!existsSync(libDir)) return null
  const require = createRequire(join(libDir, 'package.json'))
  return require(libDir) as PdfLib
}

/** A verb that cannot run says which piece is missing, not that something went wrong. */
function requireEngine(): PdfEngine {
  const engine = loadPdfEngine()
  if (!engine) throw new Error('This build has no PDF engine, so it cannot change a PDF.')
  return engine
}

function requirePdfLib(): PdfLib {
  const lib = loadPdfLib()
  if (!lib) throw new Error('This build cannot draw on a PDF (its PDF library is missing).')
  return lib
}

// ── reading a command ───────────────────────────────────────────────────────────────────────────

interface Args {
  positional: string[]
  flags: Record<string, string | true>
}

const BOOLEAN_FLAGS = new Set(['force', 'help'])

function parse(argv: string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i += 1
    } else {
      flags[key] = true
    }
  }
  return { positional, flags }
}

const str = (args: Args, name: string): string | undefined => {
  const value = args.flags[name]
  return typeof value === 'string' ? value : undefined
}

const num = (args: Args, name: string): number | undefined => {
  const value = str(args, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`--${name} takes a number, not "${value}".`)
  return parsed
}

/**
 * `1-3,5` → `[0,1,2,4]`, 0-based.
 *
 * One place converts pages, so every verb speaks the same language: **the caller counts from 1**,
 * the way a person reads a page number, and nothing else in this file counts from 0.
 */
function pagesOf(spec: string, pageCount: number, label = '--pages'): number[] {
  const pages: number[] = []
  for (const part of spec.split(',').map((piece) => piece.trim()).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from < 1 || to < from) throw new Error(`${label}: "${part}" is not a page range.`)
      for (let page = from; page <= to; page += 1) pages.push(page - 1)
      continue
    }
    const single = Number(part)
    if (!Number.isInteger(single) || single < 1) throw new Error(`${label}: "${part}" is not a page number.`)
    pages.push(single - 1)
  }
  if (!pages.length) throw new Error(`${label} named no pages.`)
  for (const page of pages) {
    if (page >= pageCount) throw new Error(`${label} names page ${page + 1}, but the file has ${pageCount}.`)
  }
  return pages
}

function outPath(args: Args, cwd: string): string {
  const out = str(args, 'out')
  if (!out) throw new Error('This needs `--out <file.pdf>`.')
  const path = resolveLocalPath(out, cwd)
  if (existsSync(path) && args.flags.force === undefined) {
    throw new Error(`${path} already exists — pass --force to replace it.`)
  }
  mkdirSync(dirname(path), { recursive: true })
  return path
}

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

function written(path: string, bytes: Uint8Array, detail: Record<string, unknown> = {}): BrowserCommandResult {
  writeFileSync(path, bytes)
  return say(JSON.stringify({ output: path, bytes: bytes.length, ...detail }))
}

/** The document as `pdf-lib` sees it, or a sentence about why it cannot be opened. */
async function openDocument(lib: PdfLib, path: string): Promise<PdfDoc> {
  try {
    return await lib.PDFDocument.load(read(path), { updateMetadata: false })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/encrypt/i.test(message)) {
      throw new Error(`${path} is password-protected: open it in the app, or decrypt it first.`)
    }
    throw new Error(`${path} is not a PDF this build can open: ${message}`)
  }
}

// ── the verbs ───────────────────────────────────────────────────────────────────────────────────

/**
 * Run one `pdf` verb.
 *
 * `argv` is the command line after the word `pdf` (`["merge", "a.pdf", "b.pdf", "--out", "ab.pdf"]`),
 * and `cwd` is the session's directory, so a relative path means what the caller meant.
 */
export async function runPdfCommand(
  argv: string | string[],
  cwd: string,
): Promise<BrowserCommandResult> {
  const parts = Array.isArray(argv) ? argv : tokenizeCommand(argv)
  const verb = (parts[0] ?? '').toLowerCase() as PdfVerb
  const args = parse(parts.slice(1))
  const file = args.positional[0]

  try {
    switch (verb) {
      case 'info': {
        if (!file) return say('pdf info needs a file.')
        const lib = requirePdfLib()
        const doc = await openDocument(lib, resolveLocalPath(file, cwd))
        const pages = doc.getPages()
        return say(
          JSON.stringify(
            {
              path: resolveLocalPath(file, cwd),
              pages: pages.length,
              sizes: pages.slice(0, 5).map((page) => {
                const { width, height } = page.getSize()
                return { width: Math.round(width), height: Math.round(height) }
              }),
              title: doc.getTitle() ?? null,
              author: doc.getAuthor() ?? null,
              subject: doc.getSubject() ?? null,
              creator: doc.getCreator() ?? null,
              producer: doc.getProducer() ?? null,
              createdAt: doc.getCreationDate()?.toISOString() ?? null,
              formFields: doc.getForm().getFields().length,
            },
            null,
            2,
          ),
        )
      }

      case 'split':
      case 'reorder': {
        // One verb's job is a subset, the other's is an order: `extractPagesBytes` is both, because
        // it takes the pages already in the order they should appear.
        if (!file) return say(`pdf ${verb} needs a file.`)
        const lib = requirePdfLib()
        const source = resolveLocalPath(file, cwd)
        const doc = await openDocument(lib, source)
        const pageCount = doc.getPages().length
        const spec = verb === 'split' ? str(args, 'pages') : str(args, 'order')
        if (!spec) return say(verb === 'split' ? 'pdf split needs `--pages "1-3,5"`.' : 'pdf reorder needs `--order "3,1,2"`.')
        const pages = pagesOf(spec, pageCount, verb === 'split' ? '--pages' : '--order')
        const target = outPath(args, cwd)
        const engine = requireEngine()
        const bytes = await engine.extractPagesBytes(read(source), pages)
        return written(target, bytes, { pages: pages.length, from: pageCount })
      }

      case 'duplicate': {
        if (!file) return say('pdf duplicate needs a file.')
        const source = resolveLocalPath(file, cwd)
        const lib = requirePdfLib()
        const pageCount = (await openDocument(lib, source)).getPages().length
        const page = num(args, 'page')
        const times = num(args, 'times') ?? 2
        if (!page || page < 1) return say('pdf duplicate needs `--page <n>` (1-based).')
        if (page > pageCount) return say(`--page ${page}: the file has ${pageCount}.`)
        if (times < 1 || times > 50) return say('--times takes 1-50.')
        const target = outPath(args, cwd)
        const engine = requireEngine()
        const pages = Array.from({ length: Math.round(times) }, () => page - 1)
        return written(target, await engine.extractPagesBytes(read(source), pages), { page, times: Math.round(times) })
      }

      case 'crop': {
        if (!file) return say('pdf crop needs a file.')
        const source = resolveLocalPath(file, cwd)
        const rect = str(args, 'rect')
        if (!rect) return say('pdf crop needs `--rect "left,top,right,bottom"` as fractions of the page (0-1).')
        const [l, t, r, b] = rect.split(',').map((piece) => Number(piece.trim()))
        if ([l, t, r, b].some((value) => value === undefined || Number.isNaN(value))) {
          return say('--rect takes four numbers, e.g. "0.1,0.1,0.9,0.9".')
        }
        const lib = requirePdfLib()
        const pageCount = (await openDocument(lib, source)).getPages().length
        const pages = str(args, 'pages') ? pagesOf(str(args, 'pages')!, pageCount) : Array.from({ length: pageCount }, (_, index) => index)
        const target = outPath(args, cwd)
        const engine = requireEngine()
        const bytes = await engine.cropPagesBytes(read(source), pages, { l: l!, t: t!, r: r!, b: b! })
        return written(target, bytes, { pages: pages.length })
      }

      case 'nup': {
        if (!file) return say('pdf nup needs a file.')
        const perPage = num(args, 'per-page') ?? 2
        if (![2, 4, 9].includes(perPage)) return say('--per-page takes 2, 4 or 9.')
        const source = resolveLocalPath(file, cwd)
        const target = outPath(args, cwd)
        const engine = requireEngine()
        return written(target, await engine.splitPagesBytes(read(source), perPage as 2 | 4 | 9), { perPage })
      }

      case 'merge': {
        const sources = args.positional.map((path) => resolveLocalPath(path, cwd))
        if (sources.length < 2) return say('pdf merge needs two or more files, then `--out <file.pdf>`.')
        for (const source of sources) if (!existsSync(source)) return say(`No such file: ${source}`)
        const lib = requirePdfLib()
        const merged = await lib.PDFDocument.create()
        let pages = 0
        for (const source of sources) {
          const doc = await openDocument(lib, source)
          const copied = await merged.copyPages(doc, doc.getPageIndices())
          for (const page of copied) merged.addPage(page)
          pages += copied.length
        }
        if (!merged.getTitle() && sources.length) {
          const first = await openDocument(lib, sources[0]!)
          const title = first.getTitle()
          if (title) merged.setTitle(title)
        }
        const target = outPath(args, cwd)
        return written(target, await merged.save(), { pages, sources: sources.length })
      }

      case 'rotate': {
        if (!file) return say('pdf rotate needs a file.')
        const angle = num(args, 'angle')
        if (angle === undefined) return say('pdf rotate needs `--angle <90|180|270>`.')
        if (angle % 90 !== 0) return say('--angle takes a multiple of 90.')
        const lib = requirePdfLib()
        const source = resolveLocalPath(file, cwd)
        const doc = await openDocument(lib, source)
        const all = doc.getPages()
        const targets = str(args, 'pages') ? pagesOf(str(args, 'pages')!, all.length) : all.map((_, index) => index)
        for (const index of targets) {
          const page = all[index]!
          page.setRotation(lib.degrees(((page.getRotation().angle + angle) % 360 + 360) % 360))
        }
        const target = outPath(args, cwd)
        return written(target, await doc.save(), { pages: targets.length, angle })
      }

      case 'watermark': {
        if (!file) return say('pdf watermark needs a file.')
        const text = str(args, 'text')
        if (!text) return say('pdf watermark needs `--text "…"`.')
        const lib = requirePdfLib()
        const source = resolveLocalPath(file, cwd)
        const doc = await openDocument(lib, source)
        const font = await doc.embedFont(lib.StandardFonts.Helvetica)
        const opacity = Math.min(Math.max(num(args, 'opacity') ?? 0.15, 0.01), 1)
        const color = colourOf(lib, str(args, 'color') ?? '#808080')
        const all = doc.getPages()
        const targets = str(args, 'pages') ? pagesOf(str(args, 'pages')!, all.length) : all.map((_, index) => index)
        for (const index of targets) {
          const page = all[index]!
          const { width, height } = page.getSize()
          // Latin-1 only: a standard PDF font has no CJK glyphs, and a watermark in boxes would be
          // worse than one in English. The reply says so rather than drawing `????`.
          const latin = toLatin1(text)
          const size = Math.max(8, Math.min(num(args, 'font-size') ?? Math.round(width / 14), width / Math.max(1, latin.length) * 1.4))
          const textWidth = font.widthOfTextAtSize(latin, size)
          page.drawText(latin, {
            x: (width - textWidth * Math.cos(Math.PI / 4)) / 2,
            y: (height - textWidth * Math.sin(Math.PI / 4)) / 2,
            size,
            font,
            color,
            opacity,
            rotate: lib.degrees(45),
          })
        }
        const target = outPath(args, cwd)
        const honoured = text === toLatin1(text)
        return written(target, await doc.save(), { pages: targets.length, textHonoured: honoured })
      }

      case 'header-footer': {
        if (!file) return say('pdf header-footer needs a file.')
        const text = str(args, 'text')
        if (!text) return say('pdf header-footer needs `--text "…"` (a `{page}` token becomes the page number).')
        const lib = requirePdfLib()
        const source = resolveLocalPath(file, cwd)
        const doc = await openDocument(lib, source)
        const font = await doc.embedFont(lib.StandardFonts.Helvetica)
        const size = num(args, 'font-size') ?? 9
        const where = (str(args, 'position') ?? 'both').toLowerCase()
        if (!['top', 'bottom', 'both'].includes(where)) return say('--position takes top, bottom or both.')
        const colour = colourOf(lib, str(args, 'color') ?? '#555555')
        const all = doc.getPages()
        const targets = str(args, 'pages') ? pagesOf(str(args, 'pages')!, all.length) : all.map((_, index) => index)
        for (const index of targets) {
          const page = all[index]!
          const { width, height } = page.getSize()
          const label = toLatin1(text.replace(/\{page\}/gi, String(index + 1)))
          const textWidth = font.widthOfTextAtSize(label, size)
          const margin = Math.round(size * 1.6)
          if (where === 'top' || where === 'both') {
            page.drawText(label, { x: (width - textWidth) / 2, y: height - margin, size, font, color: colour })
          }
          if (where === 'bottom' || where === 'both') {
            page.drawText(label, { x: (width - textWidth) / 2, y: margin, size, font, color: colour })
          }
        }
        const target = outPath(args, cwd)
        return written(target, await doc.save(), { pages: targets.length, position: where })
      }

      case 'from-image': {
        const sources = args.positional.map((path) => resolveLocalPath(path, cwd))
        if (!sources.length) return say('pdf from-image needs one or more images.')
        for (const source of sources) if (!existsSync(source)) return say(`No such file: ${source}`)
        const lib = requirePdfLib()
        const doc = await lib.PDFDocument.create()
        for (const source of sources) {
          const bytes = read(source)
          const isJpeg = /^\xff\xd8/.test(String.fromCharCode(...bytes.slice(0, 2)))
          const image = isJpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes)
          // A page the size of the picture at 96 dpi: what a screenshot is assumed to be.
          const page = doc.addPage([Math.round(image.width * 0.75), Math.round(image.height * 0.75)])
          page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() })
        }
        const target = outPath(args, cwd)
        return written(target, await doc.save(), { pages: sources.length })
      }

      case 'fill-form': {
        if (!file) return say('pdf fill-form needs a file.')
        const data = str(args, 'data')
        if (!data) return say('pdf fill-form needs `--data <json|file>`: field name → value.')
        const source = resolveLocalPath(file, cwd)
        const values = JSON.parse(/^\s*[{[]/.test(data) ? data : readFileSync(resolveLocalPath(data, cwd), 'utf-8')) as Record<string, unknown>
        const lib = requirePdfLib()
        const doc = await openDocument(lib, source)
        const form = doc.getForm()
        const filled: string[] = []
        const missing: string[] = []
        const failed: Array<{ field: string; reason: string }> = []
        for (const [name, value] of Object.entries(values)) {
          const field = form.getFields().find((candidate) => candidate.getName() === name)
          if (!field) {
            missing.push(name)
            continue
          }
          type TextLike = { setText: (text: string) => void }
          type CheckLike = { check: () => void; uncheck: () => void }
          type SelectLike = { select: (option: string) => void }
          const asText = String(value)
          // Checked before the call, not caught after it: pdf-lib throws the encoding error during
          // `save()`, where the field it belonged to is no longer known — and by then the whole file
          // is lost instead of one value.
          if (!latin1Safe(asText) && typeof (field as unknown as TextLike).setText === 'function') {
            failed.push({
              field: name,
              reason: 'the field uses a Latin-only font, so this value needs a font the app embeds',
            })
            continue
          }
          try {
            if (typeof (field as unknown as TextLike).setText === 'function') {
              ;(field as unknown as TextLike).setText(asText)
            } else if (typeof (field as unknown as CheckLike).check === 'function') {
              const check = field as unknown as CheckLike
              value === false || value === 'false' ? check.uncheck() : check.check()
            } else if (typeof (field as unknown as SelectLike).select === 'function') {
              ;(field as unknown as SelectLike).select(String(value))
            } else {
              missing.push(name)
              continue
            }
            filled.push(name)
          } catch (error) {
            // One field that cannot take its value is not a reason to lose the other nine. The
            // usual cause is the field's own font: a standard PDF font is Latin-only, so a Chinese
            // value needs an embedded font — which the app's editor has and this tool does not.
            const message = error instanceof Error ? error.message : String(error)
            failed.push({
              field: name,
              reason: /encode|WinAnsi/i.test(message)
                ? 'the field uses a Latin-only font, so this value needs a font the app embeds'
                : message,
            })
          }
        }
        const target = outPath(args, cwd)
        return written(target, await doc.save(), {
          filled,
          failed,
          unknownFields: missing,
          formFields: form.getFields().length,
        })
      }

      default:
        return say(`No such pdf command: ${verb || '(none)'}.\n\n${pdfHelp()}`)
    }
  } catch (error) {
    return say(error instanceof Error ? error.message : String(error))
  }
}

/** `#rrggbb` → a colour pdf-lib understands. A name it cannot read is the default grey. */
function colourOf(lib: PdfLib, value: string): PdfColor {
  const hex = /^#?([0-9a-f]{6})$/i.exec(value.trim())
  if (!hex) return lib.rgb(0.5, 0.5, 0.5)
  const int = parseInt(hex[1]!, 16)
  return lib.rgb(((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255)
}

/**
 * A standard PDF font is Latin-1, and there is no embedded CJK font in this bundle.
 *
 * Rather than draw boxes, anything outside Latin-1 becomes `?` at the call site and the answer
 * carries `textHonoured: false` — the caller can see that the mark is not the one it asked for.
 */
/** True when every character has a Latin-1 code point — what a standard PDF font can draw. */
function latin1Safe(value: string): boolean {
  for (const char of value) if (char.codePointAt(0)! > 0xff) return false
  return true
}

function toLatin1(value: string): string {
  let out = ''
  for (const char of value) out += char.codePointAt(0)! <= 0xff ? char : '?'
  return out
}

export function pdfHelp(): string {
  return [
    'pdf <file> [--page n | --range a-b] [--password <pw>] [--full]   the text layer',
    'pdf info <file>                                                  pages, sizes, metadata, form fields',
    'pdf split <file> --pages "1-3,5" --out <file.pdf>                keep those pages',
    'pdf reorder <file> --order "3,1,2" --out <file.pdf>              same pages, that order',
    'pdf duplicate <file> --page 1 [--times 2] --out <file.pdf>       repeat one page',
    'pdf crop <file> --rect "0.1,0.1,0.9,0.9" [--pages "…"] --out …   shrink the page box (fractions)',
    'pdf nup <file> --per-page 2|4|9 --out <file.pdf>                 several pages on each sheet',
    'pdf merge <a.pdf> <b.pdf> … --out <file.pdf>                     one file, in that order',
    'pdf rotate <file> --angle 90 [--pages "…"] --out <file.pdf>      turn pages (multiples of 90)',
    'pdf watermark <file> --text "…" [--opacity 0.15] [--font-size n] [--color #808080] --out …',
    'pdf header-footer <file> --text "… {page}" [--position top|bottom|both] --out …',
    'pdf from-image <a.png> <b.jpg> … --out <file.pdf>                one page per image',
    'pdf fill-form <file> --data <json|file> --out <file.pdf>         set form field values',
    'pdf ocr <file> --page n [--max-side 1600] [--json] [--out <file>] [--force]  read one page locally (no upload)',
    '    A page that already carries its own text is answered with that text; --force reads the pixels anyway.',
    '',
    'Pages are 1-based. Every command answers one JSON object. No encryption writing and no',
    'redaction: open the file in the app for those.',
  ].join('\n')
}
