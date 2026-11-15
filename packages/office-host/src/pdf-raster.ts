/**
 * Rasterising a PDF page, with the pdfium that already ships beside the document engine.
 *
 * Why here and not in the renderer: the editor asks for page images **while it edits** — a
 * redaction preview draws the page as it would look with those areas gone — and the answer has to
 * come from wherever the document actually lives. A hidden Electron window would work on a desktop
 * and not on a hub; `@embedpdf/pdfium` is a wasm build sitting in `resources/office-engine`, so the
 * same code answers in both, headless, with no window and no extra install.
 *
 * **Coordinates.** Everything a caller passes is in PDF user-space **points**, with the origin at
 * the bottom-left — the convention pdf.js hands out (`getPDFRect`), which is what the editor works
 * in. The bitmap is top-left, so y is flipped once, here, rather than at every call site.
 *
 * Two details of this pdfium build are worth knowing, both found by trying:
 *
 * - **`FPDF_InitLibrary` must be called**, or `FPDF_LoadPage` walks off the end of memory instead of
 *   failing. Page counts and page sizes answer without it, which is what makes the omission look
 *   like a coordinates bug.
 * - The functions to call are the **underscore-prefixed wasm exports** (`_FPDF_LoadPage`), the same
 *   ones the engine bundle uses. The wrapped names resolve for some calls and not others.
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { getBundledAssetsDir } from '@craft-agent/shared/utils'

/** A rectangle in PDF points: `x`/`y` are bottom-left, `width`/`height` positive. */
export interface PdfRect {
  x: number
  y: number
  width: number
  height: number
}

export interface RenderPageInput {
  /** The document's bytes. */
  bytes: Uint8Array
  /** 0-based page index. */
  pageIndex: number
  /** Output width in pixels. Omitted, the page renders at its own size (1 point = 1 px). */
  pxWidth?: number
  /** Painted white before encoding — what a redaction would remove. */
  whiteRects?: PdfRect[]
  /** Kept only: the rest of the page is cropped away. */
  crop?: PdfRect
  /** Clockwise, in degrees: 0, 90, 180 or 270. */
  rotate?: number
}

/**
 * The Emscripten module itself: the underscore-prefixed wasm exports live here, and so do the heap
 * and the allocator. The package also returns *wrapped* names at the top level, which resolve for
 * some calls and not others — this file uses only the raw ones, as the engine bundle does.
 */
interface Pdfium {
  HEAPU8: Uint8Array
  _malloc(size: number): number
  _free(pointer: number): void
  [raw: string]: unknown
}

let pdfium: Pdfium | null = null

/** Load the wasm once per process: it is ~4 MB and takes ~60 ms to instantiate. */
async function loadPdfium(): Promise<Pdfium> {
  if (pdfium) return pdfium
  const engineRoot = getBundledAssetsDir('office-engine')
  if (!engineRoot) throw new Error('The document engine is not installed here.')
  const packageRoot = join(engineRoot, 'node_modules', '@embedpdf', 'pdfium')
  const wasm = readFileSync(join(packageRoot, 'dist', 'pdfium.wasm'))
  // The package is ESM; a dynamic import keeps it out of the host's startup path.
  // A file URL, not a path: on Windows a drive letter reads as a URL scheme, and the ESM loader
  // answers ERR_UNSUPPORTED_ESM_URL_SCHEME for `C:\...` — which is how this rendered nothing at
  // all inside the bundled (CommonJS) main process while working under Bun.
  const entry = await import(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href)
  const loaded = await entry.init({ wasmBinary: wasm })
  const module = loaded.pdfium as unknown as Pdfium
  // Without this the page loader reads past the heap instead of returning null.
  ;(module._FPDF_InitLibrary as (() => void) | undefined)?.()
  pdfium = module
  return pdfium
}

/**
 * Every page's text, in page order.
 *
 * pdfium's text API — not a rasteriser and not a second parser: the pdf editor's Compare diff needs
 * the **same engine** on both sides, or pdf.js and pdfium break lines differently and an identical
 * pair reports phantom changes. An empty page comes back as an empty string, so index = page − 1.
 */
export async function extractPageTexts(bytes: Uint8Array): Promise<string[]> {
  const module = await loadPdfium()
  const call = (name: string, ...args: number[]): number => (module[name] as (...a: number[]) => number)(...args)
  const docPointer = module._malloc(bytes.length)
  module.HEAPU8.set(bytes, docPointer)
  let doc = 0
  const out: string[] = []
  try {
    doc = call('_FPDF_LoadMemDocument', docPointer, bytes.length, 0)
    if (!doc) throw new Error(`This PDF could not be opened (pdfium error ${call('_FPDF_GetLastError')}).`)
    const pageCount = call('_FPDF_GetPageCount', doc)
    for (let index = 0; index < pageCount; index += 1) {
      const page = call('_FPDF_LoadPage', doc, index)
      if (!page) {
        out.push('')
        continue
      }
      let textPage = 0
      let pageText = ''
      try {
        textPage = call('_FPDFText_LoadPage', page)
        const count = textPage ? call('_FPDFText_CountChars', textPage) : 0
        if (textPage && count > 0) {
          // UTF-16LE: FPDFText_GetText writes code units and returns how many it wrote.
          const buffer = module._malloc((count + 1) * 2)
          try {
            const copied = call('_FPDFText_GetText', textPage, 0, count, buffer)
            const units = new Uint16Array(module.HEAPU8.buffer, buffer, Math.max(0, copied - 1))
            for (const unit of units) pageText += String.fromCharCode(unit)
          } finally {
            module._free(buffer)
          }
        }
      } finally {
        if (textPage) call('_FPDFText_ClosePage', textPage)
        call('_FPDF_ClosePage', page)
      }
      out.push(pageText.split(String.fromCharCode(13)).join(''))
    }
    return out
  } finally {
    if (doc) call('_FPDF_CloseDocument', doc)
    module._free(docPointer)
  }
}

/** Render one page to a PNG. */
/**
 * How many pages a PDF has.
 *
 * A separate question from rendering one, because a caller that wants *every* page (one PNG each)
 * needs the count before it starts, and an out-of-range render is an error, not a stop signal.
 */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const module = await loadPdfium()
  const call = (name: string, ...args: number[]): number => (module[name] as (...a: number[]) => number)(...args)
  const docPointer = module._malloc(bytes.length)
  module.HEAPU8.set(bytes, docPointer)
  let doc = 0
  try {
    doc = call('_FPDF_LoadMemDocument', docPointer, bytes.length, 0)
    if (!doc) throw new Error(`This PDF could not be opened (pdfium error ${call('_FPDF_GetLastError')}).`)
    return call('_FPDF_GetPageCount', doc)
  } finally {
    if (doc) call('_FPDF_CloseDocument', doc)
    module._free(docPointer)
  }
}

export async function renderPagePng(input: RenderPageInput): Promise<Uint8Array> {
  const module = await loadPdfium()
  const call = (name: string, ...args: number[]): number => (module[name] as (...a: number[]) => number)(...args)
  const bytes = input.bytes
  const docPointer = module._malloc(bytes.length)
  module.HEAPU8.set(bytes, docPointer)

  let doc = 0
  let page = 0
  let bitmap = 0
  let pixels = 0
  try {
    doc = call('_FPDF_LoadMemDocument', docPointer, bytes.length, 0)
    if (!doc) throw new Error(`This PDF could not be opened (pdfium error ${call('_FPDF_GetLastError')}).`)

    const pageCount = call('_FPDF_GetPageCount', doc)
    if (input.pageIndex < 0 || input.pageIndex >= pageCount) {
      throw new Error(`Page ${input.pageIndex + 1} does not exist: the document has ${pageCount}.`)
    }
    page = call('_FPDF_LoadPage', doc, input.pageIndex)
    if (!page) throw new Error(`Page ${input.pageIndex + 1} could not be loaded.`)

    const pageWidth = call('_FPDF_GetPageWidthF', page)
    const pageHeight = call('_FPDF_GetPageHeightF', page)
    const scale = input.pxWidth ? input.pxWidth / pageWidth : 1
    const fullWidth = Math.max(1, Math.round(pageWidth * scale))
    const fullHeight = Math.max(1, Math.round(pageHeight * scale))

    // The whole page renders first: cropping by moving the bitmap origin would clip strokes at the
    // edge, and a redaction preview has to show exactly what is there.
    pixels = module._malloc(fullWidth * fullHeight * 4)
    bitmap = call('_FPDFBitmap_CreateEx', fullWidth, fullHeight, 4, pixels, fullWidth * 4)
    if (!bitmap) throw new Error('pdfium could not allocate a bitmap for this page.')
    call('_FPDFBitmap_FillRect', bitmap, 0, 0, fullWidth, fullHeight, 0xffffffff)
    call('_FPDF_RenderPageBitmap', bitmap, page, 0, 0, fullWidth, fullHeight, 0, 0)

    const buffer = call('_FPDFBitmap_GetBuffer', bitmap)
    // pdfium writes BGRA; a PNG is RGBA.
    const rgba = new Uint8Array(fullWidth * fullHeight * 4)
    rgba.set(module.HEAPU8.subarray(buffer, buffer + rgba.length))
    for (let i = 0; i < rgba.length; i += 4) {
      const blue = rgba[i]!
      rgba[i] = rgba[i + 2]!
      rgba[i + 2] = blue
    }

    if (input.whiteRects?.length) paintWhite(rgba, fullWidth, fullHeight, scale, pageHeight, input.whiteRects)

    const region = input.crop
      ? cropRgba(rgba, fullWidth, fullHeight, scale, pageHeight, input.crop)
      : { rgba, width: fullWidth, height: fullHeight }
    return encodePng(rotateRgba(region, input.rotate ?? 0))
  } finally {
    if (bitmap) call('_FPDFBitmap_Destroy', bitmap)
    if (page) call('_FPDF_ClosePage', page)
    if (doc) call('_FPDF_CloseDocument', doc)
    if (pixels) module._free(pixels)
    module._free(docPointer)
  }
}

/** Turn PDF-space points into bitmap pixels. */
function toPixels(rect: PdfRect, scale: number, pageHeight: number) {
  const left = rect.x * scale
  const top = (pageHeight - rect.y - rect.height) * scale
  return { left, top, width: rect.width * scale, height: rect.height * scale }
}

function paintWhite(rgba: Uint8Array, width: number, height: number, scale: number, pageHeight: number, rects: PdfRect[]) {
  for (const rect of rects) {
    const { left, top, width: w, height: h } = toPixels(rect, scale, pageHeight)
    const x0 = Math.max(0, Math.floor(left))
    const y0 = Math.max(0, Math.floor(top))
    const x1 = Math.min(width, Math.ceil(left + w))
    const y1 = Math.min(height, Math.ceil(top + h))
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const at = (y * width + x) * 4
        rgba[at] = 255
        rgba[at + 1] = 255
        rgba[at + 2] = 255
        rgba[at + 3] = 255
      }
    }
  }
}

function cropRgba(rgba: Uint8Array, width: number, height: number, scale: number, pageHeight: number, rect: PdfRect) {
  const { left, top, width: w, height: h } = toPixels(rect, scale, pageHeight)
  const x0 = Math.max(0, Math.round(left))
  const y0 = Math.max(0, Math.round(top))
  const outWidth = Math.max(1, Math.min(width - x0, Math.round(w)))
  const outHeight = Math.max(1, Math.min(height - y0, Math.round(h)))
  const out = new Uint8Array(outWidth * outHeight * 4)
  for (let y = 0; y < outHeight; y += 1) {
    const from = ((y0 + y) * width + x0) * 4
    out.set(rgba.subarray(from, from + outWidth * 4), y * outWidth * 4)
  }
  return { rgba: out, width: outWidth, height: outHeight }
}

function rotateRgba(region: { rgba: Uint8Array; width: number; height: number }, degrees: number) {
  const turn = ((degrees % 360) + 360) % 360
  if (turn !== 90 && turn !== 180 && turn !== 270) return region
  const { rgba, width, height } = region
  const outWidth = turn === 180 ? width : height
  const outHeight = turn === 180 ? height : width
  const out = new Uint8Array(rgba.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4
      const [toX, toY] =
        turn === 90 ? [height - 1 - y, x] : turn === 180 ? [width - 1 - x, height - 1 - y] : [y, width - 1 - x]
      const to = (toY * outWidth + toX) * 4
      out[to] = rgba[from]!
      out[to + 1] = rgba[from + 1]!
      out[to + 2] = rgba[from + 2]!
      out[to + 3] = rgba[from + 3]!
    }
  }
  return { rgba: out, width: outWidth, height: outHeight }
}

/**
 * A PNG from raw RGBA.
 *
 * Hand-rolled rather than `EPDF_PNG_EncodeRGBA`, whose buffer length this build does not report —
 * a decoder left to guess where the stream ends is a decoder that eventually finds the wrong end.
 * A PNG is four chunks and `zlib`, and the filter byte per row is the whole of the format's
 * compression story at colour type 6.
 */
export function encodePng(region: { rgba: Uint8Array; width: number; height: number }): Uint8Array {
  const { rgba, width, height } = region
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1)
  }

  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0
  header[11] = 0
  header[12] = 0

  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunks = [signature, chunk('IHDR', header), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))]
  const total = chunks.reduce((sum, part) => sum + part.length, 0)
  const png = new Uint8Array(total)
  let at = 0
  for (const part of chunks) {
    png.set(part, at)
    at += part.length
  }
  return png
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
