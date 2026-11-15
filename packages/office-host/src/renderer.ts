/**
 * The renderer seam — **the interface only**, so both hosts can implement it.
 *
 * Three things in this product need a Chromium and nothing else: a document laid out as pages (the
 * editor's own print, which is how a `.docx` becomes a `.pdf`), a page printed as it really is, and
 * a `.drawio` file drawn into a picture.
 *
 * - The **desktop** answers with the app itself — a hidden `BrowserWindow` and
 *   `webContents.printToPDF` (`apps/electron/src/main/office-export.ts`).
 * - A **hub** answers with a headless Chromium over Playwright (`packages/render-host`).
 *
 * The types live here, in the package both of them already depend on, and **not** in
 * `render-host`: a desktop that had to import that package to name the interface would drag
 * `playwright-core` into an installer that can never use it. Implementation stays where the browser
 * is; the promise stays where both can see it.
 *
 * The one thing that must never travel through this seam is a page the *person* is signed in to:
 * that is `browser_tool`, and its answer is a bridge to their own browser, because "the user's
 * browser" is the whole point of it.
 */

/** A page or a document as pages, in the units Chromium's print API takes: inches. */
export interface PrintGeometry {
  /** Page width. Omitted with `heightIn`, the document's own `@page` size decides. */
  widthIn?: number
  heightIn?: number
  landscape?: boolean
  /** Omitted, Chromium's own default margins apply — a document's print CSS usually zeroes them. */
  marginsIn?: { top: number; bottom: number; left: number; right: number }
  scale?: number
  /** Chromium's own range syntax: `'1'`, `'1-3'`, `'1,3'`. A `{from,to}` object is refused there. */
  pageRanges?: string
  /** Background colours and images. A document that sets a fill needs this, and so does every deck. */
  printBackground?: boolean
}

/** What is printed: markup handed over, or a URL to load (a local file, or the office origin). */
export type PrintSource =
  | { kind: 'html'; html: string; baseHref?: string }
  | { kind: 'url'; url: string }

/** Which editor draws a document. The same four the office tool and the export window use. */
export type OfficeApp = 'docs' | 'sheets' | 'slides' | 'pdf'

export interface DocumentPrintRequest {
  app: OfficeApp
  /** The document itself. A `.pdf` is already the answer and needs no renderer. */
  bytes: Uint8Array
  /** Its path, for the name and for the editor's own "where am I" answers. */
  path: string
  /** Where the PDF goes. Omitted, a scratch path that lives as long as the renderer. */
  outPath?: string
  geometry?: PrintGeometry
}

export interface DrawioRenderRequest {
  /** The document: what a `.drawio` file holds. */
  xml: string
  /** What the engine can file a document as — `drawio_tool`'s own list, not a subset of it. */
  format: 'svg' | 'xmlsvg' | 'png' | 'html' | 'xml'
  /** By the name the document gives it; omitted, its first page. */
  page?: string
  scale?: number
  theme?: 'auto' | 'light' | 'dark'
}

/** The renderer a host has, or why it has none. Chosen once, at startup. */
export interface RendererInfo {
  kind: RendererKind
  /** Chromium's own version string, when there is one. */
  version?: string
  /** The binary that was launched, when the host launches one. */
  executable?: string
  /** Why there is no renderer — the sentence a caller can show a person. */
  reason?: string
}

export type RendererKind = 'electron' | 'chromium' | 'none'

/**
 * The whole surface a printing host answers.
 *
 * `printDocument` is the one that matters most and the one that cannot be faked: sheets and decks
 * hand their host a finished print job, but the Word editor prints **itself**, so it has to be the
 * top document — the same reason the desktop app opens an export window instead of capturing a
 * frame.
 */
export interface Renderer {
  readonly kind: RendererKind
  info(): RendererInfo
  print(source: PrintSource, geometry?: PrintGeometry): Promise<Uint8Array>
  printDocument(request: DocumentPrintRequest): Promise<Uint8Array>
  renderDrawio(request: DrawioRenderRequest): Promise<Uint8Array>
  close(): Promise<void>
}

export type RenderErrorCode =
  | 'RENDERER_UNAVAILABLE'
  | 'PRINT_FAILED'
  | 'EDITOR_NOT_SERVED'
  | 'DRAWIO_NOT_SERVED'
  | 'UNSUPPORTED_TARGET'
  | 'VIDEO_FAILED'
  | 'AUDIO_FAILED'

/** A refusal with a code, because every caller of this seam has to say something useful to a person. */
export class RenderError extends Error {
  readonly code: RenderErrorCode

  // Written out rather than declared in the signature: a parameter property is the one piece of
  // TypeScript that is not erasable, and this module has to run under a plain `node` too.
  constructor(code: RenderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RenderError'
    this.code = code
  }
}
