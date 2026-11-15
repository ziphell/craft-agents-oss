/**
 * The deck host: a `.pptx` opened, edited and saved in the main process.
 *
 * The slides editor is the one of the four whose document **lives on the host side**. Its renderer
 * is a view: `consumePendingOpen` answers a render tree, not bytes, every edit arrives as an op
 * journal, and `save` carries no data at all — main holds the deck (`apps/slides/src/main` in the
 * GenOffice checkout, whose session model this mirrors in miniature). So hosting it means running
 * the engine here, which is exactly what `scripts/build-office-engine.ts` prepares: the vendored
 * `pptx-engine` + `pptx-ops` + the app's own render projection, as one CommonJS bundle.
 *
 * Three rules keep it small:
 *
 * - **One session per path.** A deck opened twice is the same deck; a second window showing the
 *   same file edits the same model, which is what "the file is the document" means.
 * - **The engine is loaded lazily and once.** It is 4.4 MB of JavaScript plus a jszip tree; a
 *   session that never opens a deck pays nothing.
 * - **The renderer's API is answered as a table, not as 120 handlers.** The editor knows about
 *   fonts, charts, recordings and export; a host that answers `undefined` for those leaves the
 *   features switched off and the document editable, which is the honest state of this slice.
 *
 * What is *not* here yet, and says so by answering `undefined`: undo/redo (the app's history is a
 * snapshot stack in its own main process), fonts beyond the deck's embedded ones, and every export.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getBundledAssetsDir } from '@craft-agent/shared/utils'
import { checkDocument, conflictMessage, recordFromDisk } from './guard'
import { officePrint } from './runtime'

/** The slice of the engine bundle this host uses (see `resources/office-engine/pptx.d.ts`). */
interface DeckEngine {
  openPptx(bytes: Uint8Array): Promise<unknown>
  savePptxToFile(opened: unknown, filePath: string): Promise<void>
  runTxn(
    opened: unknown,
    request: { ops: unknown[]; dryRun?: boolean; isolation?: 'atomic' | 'per_op'; parts?: Map<string, unknown> },
  ): { applied?: boolean; records?: unknown[]; failures?: unknown[] }
  buildAllRenderSlides(opened: unknown, fitWidthPx: number): unknown[]
  pushHistory(session: unknown): void
  takeSnapshot(session: unknown): unknown
  restoreSnapshot(session: unknown, snapshot: unknown): void
  settleStaleHistoryBatch(session: unknown): void
  /**
   * The parts of a deck the editor *displays*, which are document facts rather than features.
   *
   * They were missing from this bundle until the deck's mount was traced: the editor collects
   * notes, comments, sections and links while it mounts and reads `length` on each answer, so an
   * absent function is not a hidden panel — it is a throw, and a notes pane that swallows typing.
   */
  getSlideNotes(archive: unknown, slidePath: string): string
  setSlideNotes(opened: unknown, slideIndex: number, text: string): boolean
  getSlideComments(archive: unknown, slidePath: string): SlideComment[]
  addSlideComment(
    opened: unknown,
    slideIndex: number,
    opts: { author: string; initials?: string; text: string },
  ): SlideComment | null
  deleteSlideComment(opened: unknown, slideIndex: number, ref: { authorId: number; idx: number }): boolean
  getSections(opened: unknown): SectionInfo[]
  setSections(opened: unknown, sections: SectionInfo[]): void
  getSlideLinks(opened: unknown, slideIndex: number): Array<{ elementId: string; target: unknown }>
  getRunLinks(
    opened: unknown,
    slideIndex: number,
  ): Array<{ elementId: string; paraIndex: number; runIndex: number; target: unknown }>
  /** Animations and transitions live on the slide's own XML, which the engine reads and rewrites. */
  getSlideAnimations(slide: unknown): SlideAnimation[]
  setSlideAnimations(slide: unknown, anims: SlideAnimation[]): void
  getSlideTransition(slide: unknown): string
  setSlideTransition(slide: unknown, kind: string): void
  getSlideAdvanceTime(slide: unknown): number | null
  setSlideAdvanceTime(slide: unknown, ms: number | null): void
  /** The shape's `<p:spTgt spid>`: animations address elements by this number, the app by id. */
  elementSpid(element: unknown): number | null
  /** The fonts the deck embeds, already unwrapped to single-face sfnt bytes. */
  listEmbeddedFonts(archive: unknown): Array<{ typeface: string; style: string; sfnt: Uint8Array }>
  /** The spids of shapes that carry recorded narration, which the presenter highlights. */
  narrationSpids(slide: unknown): number[]
  readHeaderFooter(slide: unknown): { footer: string | null; slideNum: boolean; date: string | null }
  getElementLink(opened: unknown, slideIndex: number, elementId: string): unknown
  /** A shape as clipboard data: its XML plus every part it references. */
  copyElementData(opened: unknown, slide: { path: string }, element: { id?: string }): Record<string, unknown>
  /** The numbers behind a chart shape, projected exactly as the render tree sees them. */
  getChartElementData(slide: unknown, elementId: string): unknown
  /** The deck's layout and master parts; one parsed into a slide. */
  listMasterParts(archive: unknown): Array<{ partPath: string; kind: string; name: string }>
  parseMasterPart(archive: unknown, partPath: string): unknown | null
  /** Render one slide-shaped object (a master part is one) with the slide projection. */
  buildRenderSlide(slide: unknown, size: unknown, opts: Record<string, unknown>): unknown
  /** The text metrics the projection uses — the same one a whole-deck build uses. */
  getFontMetrics(): unknown
  /** The archive-backed media resolver a render needs to draw pictures. */
  makeMediaResolver(opened: unknown): (ref: string) => unknown
  /** The editor's edit script → ops, with the engine's own mapper. */
  mapScriptOps(opened: unknown, request: Record<string, unknown>): Array<Record<string, unknown>>
  /** A theme part's colour scheme, by name (`accent1` … `accent6`). */
  parseTheme(themeXml: string): { colors?: Record<string, string> }
  /** Re-parse one page from its XML — what a chart edit needs before it renders again. */
  materializeSlide(opened: unknown, slideIndex: number): unknown | null
  /** A slide as clipboard data: its XML plus its layout/master/media graph. */
  collectSlideBundle(archive: unknown, slidePath: string, slideXml: string): Record<string, unknown>
  listSlideLayouts(archive: unknown): Array<{ name: string; path: string; [extra: string]: unknown }>
  builtinLayoutInfos(
    size: { cx: number; cy: number },
    taken: Set<string>,
  ): Array<{ name: string; path: string; [extra: string]: unknown }>
  shouldOfferBuiltinLayouts(layouts: unknown[]): boolean
}

/**
 * One animation, in the engine's own vocabulary.
 *
 * Written verbatim into the slide's `<p:timing>` tree; `presetXml` keeps effects the model cannot
 * re-emit untouched, which is why editing one animation never downgrades another.
 */
interface SlideAnimation {
  spid: number
  effect: string
  trigger: string
  durationMs: number
  delayMs: number
  [extra: string]: unknown
}

/** A deck's comment, as the editor shows it (author looked up from the deck's own table). */
interface SlideComment {
  authorId: number
  author: string
  initials: string
  dt: string
  idx: number
  text: string
}

/** A section of the deck, in the app's own sidebar shape. */
interface SectionInfo {
  id: string
  name: string
  slideIndices: number[]
}

interface DeckSession {
  /** The engine's parsed deck — the whole document, in memory. */
  opened: unknown
  path: string
  fitWidthPx: number
  dirty: boolean
  /**
   * The editor's own history, as the engine keeps it: a snapshot is the slide model plus the
   * archive's entries, which is what makes an undo a *restore* rather than a reverse op. Held
   * here because the document is here — the renderer only ever sees the tree.
   */
  undoStack: unknown[]
  redoStack: unknown[]
  metaDirty?: boolean
  /** The layout or master part open in the master view, and its live slide object. */
  masterEdit?: { partPath: string; slide: unknown }
  /** A drag in progress: its snapshot is pushed once, and the frames after it ride on it. */
  transformPreview?: boolean
  /** The redo stack set aside for the length of a drag (an undo mid-drag must not lose it). */
  previewRedo?: unknown[]
  /** The deck's own fonts, read from its package on first ask (see `privateFontFacesFor`). */
  fonts?: Array<{ id: string; family: string; bold: boolean; italic: boolean; sfnt: Uint8Array }>
}

const sessions = new Map<string, DeckSession>()

/**
 * The clipboard, as a value.
 *
 * One per process, like GenOffice's own: copying in one deck and pasting into another is the
 * behaviour people expect, and the payload is already self-contained (element XML with its parts,
 * or a slide bundle).
 */
const deckClipboard: {
  elements?: Array<Record<string, unknown>>
  slides?: Array<Record<string, unknown>>
  /** Pictures of the copied slides, for "paste as picture". */
  slidePngs?: string[]
} = {}
let engine: DeckEngine | null = null

/**
 * Load the engine, once.
 *
 * The bundle is CommonJS with `jszip` beside it (see the build script: a bundled jszip reports
 * "nodestream is not supported" the first time a deck is saved), so it is required by path rather
 * than imported — and only when a deck is actually opened.
 */
function loadEngine(): DeckEngine {
  if (engine) return engine
  const root = getBundledAssetsDir('office-engine')
  if (!root) {
    throw new Error('The deck engine is not installed. Run: bun scripts/build-office-engine.ts')
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  engine = require(join(root, 'pptx.cjs')) as DeckEngine
  return engine
}

/**
 * A change that lives **beside** the slides: notes, comments, sections.
 *
 * GenOffice's own main marks these separately (`markMetaDirty`) because its save path may re-emit
 * only the slides it knows changed. Our save writes the whole package, so `dirty` would be enough —
 * but this second flag is what `deckIsDirty` and the close prompt read, and a deck whose notes
 * changed must look changed to both.
 */
function markMetaDirty(path: string): void {
  const session = sessions.get(path)
  if (session) session.metaDirty = true
}

/**
 * A deck's embedded fonts, read once and kept with its session.
 *
 * `id` is `family::style`: stable across reads (the editor caches by it) and unambiguous when a
 * family ships regular and bold as two faces.
 */
function privateFontFacesFor(
  session: DeckSession,
): Array<{ id: string; family: string; bold: boolean; italic: boolean; sfnt: Uint8Array }> {
  if (session.fonts) return session.fonts
  const faces = loadEngine()
    .listEmbeddedFonts(archiveOf(session))
    .map((face) => ({
      id: `${face.typeface}::${face.style}`,
      family: face.typeface,
      bold: face.style === 'bold' || face.style === 'boldItalic',
      italic: face.style === 'italic' || face.style === 'boldItalic',
      sfnt: face.sfnt,
    }))
  session.fonts = faces
  return faces
}

/**
 * The deck's slides, as the engine keeps them — each with the part path the editor's questions are
 * answered by (notes and comments are parts of the package, addressed by their slide).
 */
function slidesOf(session: DeckSession | undefined): Array<{ path: string }> {
  const deck = (session?.opened as { deck?: { slides?: Array<{ path: string }> } } | undefined)?.deck
  return deck?.slides ?? []
}

/** Each slide's elements, in slide order — what animations address by spid. */
function elementsOf(session: DeckSession): Array<Array<Record<string, unknown>>> {
  const deck = (session.opened as { deck?: { slides?: Array<{ elements?: Array<Record<string, unknown>> }> } })
    ?.deck
  return (deck?.slides ?? []).map((slide) => slide.elements ?? [])
}

/** A part's text, for the bundle a slide copy carries (its XML plus what it points at). */
function archiveTextOf(session: DeckSession, partPath: string): string {
  const archive = archiveOf(session) as { readText?: (path: string) => string | null } | undefined
  return archive?.readText?.(partPath) ?? ''
}

/** The package (its parts, relationships and bytes) — what notes and comments are read from. */
function archiveOf(session: DeckSession): unknown {
  return (session.opened as { archive?: unknown }).archive
}


// ---- the editing surface -------------------------------------------------------------
//
// The editor's direct manipulation (drag, type, fill, reorder) arrives as one method per
// gesture, and GenOffice's own main turns each into **one op** through the same transaction
// pipeline everything else uses. That translation is what this block is: a method name, the op
// it becomes, and the units it arrives in. Anything that is not a plain pass-through is named —
// pixels to EMU, points to EMU, a gradient's angle in degrees to sixtieths.

/** English Metric Units: 914400 to the inch, and the editor works in CSS pixels (96 dpi). */
const EMU_PER_PX = 9525
/** A point is 12700 EMU. */
const EMU_PER_PT = 12700

/** The deck's width in CSS pixels, which is what a `fitWidthPx` payload is measured against. */
function deckWidthPx(session: DeckSession): number {
  const size = (session.opened as { deck?: { size?: { cx?: number } } }).deck?.size
  return (size?.cx ?? 12192000) / EMU_PER_PX
}

/**
 * Payload pixels → EMU, undoing the renderer's fit.
 *
 * The editor lays the slide out at `fitWidthPx` and reports drags in *those* pixels; the document
 * is authored at its own width. Dividing by the fit scale is what keeps a shape the size the
 * person drew it at any window width.
 */
function pxToEmu(px: unknown, fitWidthPx: unknown, session: DeckSession): number {
  const value = Number(px)
  if (!Number.isFinite(value)) return 0
  const fit = Number(fitWidthPx)
  const scale = Number.isFinite(fit) && fit > 0 ? fit / deckWidthPx(session) : 1
  return Math.round((value / scale) * EMU_PER_PX)
}

/**
 * The deck's six accent colours, read from its own theme.
 *
 * `slide → layout → master → theme` is the chain PowerPoint resolves; the engine exposes it as
 * `resolveSlideChain`, and the theme parser returns the scheme by name. A deck without a readable
 * theme falls back to the Office defaults, which is what the gallery shows for a blank deck.
 */
function deckAccentColors(session: DeckSession): string[] {
  const fallback = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47']
  const slide = slidesOf(session)[0]
  const archive = archiveOf(session) as
    | { resolveSlideChain?: (path: string) => { themePath?: string | null }; readText?: (path: string) => string | null }
    | undefined
  if (!slide || !archive?.resolveSlideChain || !archive.readText) return fallback
  try {
    const chain = archive.resolveSlideChain(slide.path)
    const xml = chain.themePath ? archive.readText(chain.themePath) : null
    const colors = xml ? loadEngine().parseTheme(xml).colors : undefined
    const accents = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
      .map((key) => colors?.[key])
      .filter((color): color is string => typeof color === 'string' && color.length > 0)
    return accents.length >= 3 ? accents : fallback
  } catch {
    return fallback
  }
}

/** Mix a hex colour toward black (`to = 0`) or white (`to = 255`) by `amount` (0..1). */
function mixHex(hex: string, to: number, amount: number): string {
  const clean = hex.replace('#', '')
  const value = clean.length === 8 ? clean.slice(0, 6) : clean
  const channels = [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16))
  if (channels.some((channel) => Number.isNaN(channel))) return hex
  return channels
    .map((channel) => Math.round(channel + (to - channel) * amount).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

/**
 * The `setTransform` op behind one drag frame, in EMU.
 *
 * The editor reports the box in fit-scaled pixels; the document stores EMU at its own width. Table
 * shapes also need their grid redistributed (`resizeTableGrid`), or the cells keep the old columns
 * while the frame shows new ones.
 */
function transformOpFor(
  session: DeckSession,
  index: number,
  request: Record<string, unknown>,
): Record<string, unknown> | null {
  const sourceId = typeof request.sourceId === 'string' ? request.sourceId : ''
  if (!sourceId) return null
  return {
    op: 'setTransform',
    target: { slide: index, el: sourceId },
    box: {
      x: pxToEmu(request.xPx, request.fitWidthPx, session),
      y: pxToEmu(request.yPx, request.fitWidthPx, session),
      cx: Math.max(1, pxToEmu(request.wPx, request.fitWidthPx, session)),
      cy: Math.max(1, pxToEmu(request.hPx, request.fitWidthPx, session)),
    },
    rotDeg: request.rotationDeg,
    ...(typeof request.groupId === 'string' && request.groupId
      ? { group: request.groupId }
      : { resizeTableGrid: true }),
  }
}

/** A master/layout part, rendered with the same projection as a slide. */
function masterRender(session: DeckSession): unknown {
  const master = session.masterEdit
  if (!master) return null
  const deckEngine = loadEngine()
  const size = (session.opened as { deck?: { size?: unknown } }).deck?.size
  return deckEngine.buildRenderSlide(master.slide, size, {
    fitWidthPx: session.fitWidthPx,
    media: deckEngine.makeMediaResolver(session.opened),
  })
}

/**
 * One master-view gesture → one op addressed to the **part**.
 *
 * The payloads are the slide ones with `slideIndex` taken out; what changes is the address, and the
 * pixel→EMU conversion, which still measures against the deck (a master is authored at the deck's
 * width).
 */
function masterOpFor(
  method: string,
  partPath: string,
  request: Record<string, unknown>,
  session: DeckSession,
): Record<string, unknown> | null {
  const el = (target: unknown) => ({ part: partPath, el: target })
  switch (method) {
    case 'masterEditText':
      return { op: 'setText', target: el(request.sourceId), paragraphs: request.paragraphs }
    case 'masterEditFill': {
      const fill = request.fill as { gradient?: { stops?: unknown; angleDeg?: unknown } } | string | undefined
      const translated =
        typeof fill === 'string' || fill === undefined
          ? fill
          : fill.gradient
            ? { stops: fill.gradient.stops ?? [], angle: Math.round((Number(fill.gradient.angleDeg) || 0) * 60_000) }
            : fill
      return { op: 'setFill', target: el(request.sourceId), fill: translated }
    }
    case 'masterEditStroke': {
      const stroke = request.stroke as { widthPt?: unknown; gradient?: { stops?: unknown; angleDeg?: unknown } } | null
      return {
        op: 'setStroke',
        target: el(request.sourceId),
        stroke: stroke
          ? {
              ...stroke,
              widthEmu: Math.round((Number(stroke.widthPt) || 0) * EMU_PER_PT),
              ...(stroke.gradient
                ? {
                    gradient: {
                      stops: stroke.gradient.stops ?? [],
                      angle: Math.round((Number(stroke.gradient.angleDeg) || 0) * 60_000),
                    },
                  }
                : {}),
            }
          : null,
      }
    }
    case 'masterEditTransform':
      return {
        op: 'setTransform',
        target: el(request.sourceId),
        box: {
          x: pxToEmu(request.xPx, request.fitWidthPx, session),
          y: pxToEmu(request.yPx, request.fitWidthPx, session),
          cx: Math.max(1, pxToEmu(request.wPx, request.fitWidthPx, session)),
          cy: Math.max(1, pxToEmu(request.hPx, request.fitWidthPx, session)),
        },
        rotDeg: request.rotationDeg,
      }
    case 'masterAddElement': {
      const paragraphs =
        Array.isArray(request.paragraphs) && request.paragraphs.length > 0
          ? request.paragraphs
          : typeof request.text === 'string' && request.text
            ? String(request.text).split('\n').map((line) => ({ runs: [{ text: line }] }))
            : undefined
      return {
        op: 'addElement',
        target: { part: partPath },
        kind: request.kind,
        offset: {
          x: pxToEmu(request.xPx, request.fitWidthPx, session),
          y: pxToEmu(request.yPx, request.fitWidthPx, session),
          cx: Math.max(1, pxToEmu(request.wPx, request.fitWidthPx, session)),
          cy: Math.max(1, pxToEmu(request.hPx, request.fitWidthPx, session)),
        },
        ...(paragraphs ? { paragraphs } : {}),
        ...(request.fillColor ? { fill: request.fillColor } : {}),
      }
    }
    case 'masterDeleteElement':
      return { op: 'deleteElement', target: el(request.sourceId) }
    default:
      return null
  }
}

/**
 * Apply a part-addressed op.
 *
 * `parts` is what makes this work: the executor mutates the **given** slide object (so the
 * renderer's ids stay stable across a gesture) and flushes it back into the package entry. A fresh
 * parse per edit would re-mint every id and drop the selection.
 */
function masterApply(
  session: DeckSession,
  master: { partPath: string; slide: unknown },
  op: Record<string, unknown>,
): boolean {
  const deckEngine = loadEngine()
  deckEngine.settleStaleHistoryBatch(session)
  deckEngine.pushHistory(session)
  const result = deckEngine.runTxn(session.opened, {
    ops: [op],
    parts: new Map([[master.partPath, master.slide]]),
  })
  if (result.applied !== true) {
    session.undoStack.pop()
    const error = (result as { failures?: Array<{ error?: string }> }).failures?.[0]?.error
    if (error && !refusals.has(error)) {
      refusals.add(error)
      console.warn(`[office] deck refused an edit: ${error.split('\n')[0]}`)
    }
    return false
  }
  session.dirty = true
  session.metaDirty = true
  return true
}

/**
 * The slide tree for one page, as the editor's own answer carries it.
 *
 * **One page, not the deck.** `buildAllRenderSlides` is what a full refresh needs, but every gesture
 * answers with a single rebuilt page; building all of them made a drag cost O(pages) — fine on four
 * slides, visible on fifty. The projection is the same one (`buildRenderSlide`), fed the same media
 * resolver and font metrics, so a page built alone and a page built in a batch are the same tree.
 */
function renderSlideAt(session: DeckSession, index: number): unknown {
  const slide = slidesOf(session)[index]
  if (!slide) return null
  const deckEngine = loadEngine()
  const size = (session.opened as { deck?: { size?: unknown } }).deck?.size
  return deckEngine.buildRenderSlide(slide, size, {
    fitWidthPx: session.fitWidthPx,
    media: deckEngine.makeMediaResolver(session.opened),
    metrics: deckEngine.getFontMetrics(),
    slideNo: index + 1,
  })
}

/** What an insert or a reorder answers: the new order, and the pages that changed. */
function slideUpdate(session: DeckSession): { order: string[]; slides: unknown[] } {
  return {
    order: slidesOf(session).map((slide) => slide.path),
    slides: loadEngine().buildAllRenderSlides(session.opened, session.fitWidthPx),
  }
}

/** One gesture: run its ops, and answer the rebuilt page (null when the ops were refused). */
function editSlide(path: string, index: number, ops: Array<Record<string, unknown>>): unknown {
  const session = sessions.get(path)
  if (!session) return null
  const result = deckApply(path, ops)
  if (result.applied !== true) return null
  return renderSlideAt(session, index)
}

/** What the editor's `consumePendingOpen` answers: the tree, the page size, the default font. */
function openResult(session: DeckSession) {
  const deckEngine = loadEngine()
  const slides = deckEngine.buildAllRenderSlides(session.opened, session.fitWidthPx)
  const deck = (session.opened as { deck?: { size?: { cx?: number; cy?: number }; defaultFont?: string } }).deck
  return {
    path: session.path,
    slides,
    size: { cx: deck?.size?.cx ?? 12192000, cy: deck?.size?.cy ?? 6858000 },
    defaultFont: deck?.defaultFont ?? 'Arial',
  }
}

/** Open (or reuse) the session for a path. Answers the render tree. */
export async function deckOpen(path: string, fitWidthPx = 1280) {
  const existing = sessions.get(path)
  if (existing) {
    existing.fitWidthPx = fitWidthPx
    return openResult(existing)
  }
  const deckEngine = loadEngine()
  const bytes = new Uint8Array(await readFile(path))
  const opened = await deckEngine.openPptx(bytes)
  const session: DeckSession = { opened, path, fitWidthPx, dirty: false, undoStack: [], redoStack: [] }
  sessions.set(path, session)
  return openResult(session)
}

/** Apply a transaction of ops; the answer is the editor's own result shape. */
export function deckApply(path: string, ops: unknown[], fitWidthPx?: number) {
  const session = sessions.get(path)
  if (!session) return { applied: false, failures: [{ index: 0, error: 'No deck is open for this file.' }] }
  const deckEngine = loadEngine()
  // `pushHistory` before the edit — the app's own call order (it also clears the redo stack, which
  // is what makes "edit after undo" behave like every other editor).
  deckEngine.settleStaleHistoryBatch(session)
  deckEngine.pushHistory(session)
  const result = deckEngine.runTxn(session.opened, { ops })
  if (result.applied) session.dirty = true
  /**
   * A refused edit says why, once.
   *
   * Every edit path answers `null`/`false` on a refusal, which is what the editor needs — and is
   * also how "I dragged a shape and it snapped back" becomes nobody's bug. One line per distinct
   * message puts the op layer's own guided error in the log that already gets read.
   */
  if (!result.applied) {
    const failure = result.failures?.[0] as { error?: string } | undefined
    const error = typeof failure?.error === 'string' ? failure.error : ''
    if (error && !refusals.has(error)) {
      refusals.add(error)
      console.warn(`[office] deck refused an edit: ${error.split('\n')[0]}`)
    }
  }
  if (fitWidthPx) session.fitWidthPx = fitWidthPx
  return { ...result, slides: result.applied ? openResult(session).slides : undefined }
}

const refusals = new Set<string>()

/** One step back: the snapshot goes on the redo stack, and the answer is the rebuilt tree. */
export function deckUndo(path: string) {
  const session = sessions.get(path)
  if (!session) return null
  const deckEngine = loadEngine()
  deckEngine.settleStaleHistoryBatch(session)
  if (session.undoStack.length === 0) return null
  session.redoStack.push(deckEngine.takeSnapshot(session))
  deckEngine.restoreSnapshot(session, session.undoStack.pop())
  session.dirty = true
  return openResult(session).slides
}

/** One step forward, the mirror of `deckUndo`. */
export function deckRedo(path: string) {
  const session = sessions.get(path)
  if (!session) return null
  const deckEngine = loadEngine()
  deckEngine.settleStaleHistoryBatch(session)
  if (session.redoStack.length === 0) return null
  session.undoStack.push(deckEngine.takeSnapshot(session))
  deckEngine.restoreSnapshot(session, session.redoStack.pop())
  session.dirty = true
  return openResult(session).slides
}

/**
 * Write the deck back to its own path (atomic inside the engine: a temp file renamed over it).
 *
 * The file is checked first, because the deck's model outlives every look at the file: an agent
 * edit through a document tool changes the `.pptx` on disk and this session would still hold the
 * older deck. Saving then would write the session over it, which is why the refusal exists.
 */
export async function deckSave(path: string, options: { overwrite?: boolean } = {}) {
  const session = sessions.get(path)
  if (!session) return { ok: false, error: 'No deck is open for this file.' }
  if (!options.overwrite && (await checkDocument(path)) === 'conflict') {
    return { ok: false, error: conflictMessage(path), conflict: true }
  }
  const deckEngine = loadEngine()
  await deckEngine.savePptxToFile(session.opened, path)
  await recordFromDisk(path)
  session.dirty = false
  return { ok: true, path, slides: openResult(session).slides }
}

export function deckIsDirty(path: string): boolean {
  return sessions.get(path)?.dirty === true
}

export function deckRender(path: string, fitWidthPx: number) {
  const session = sessions.get(path)
  if (!session) return null
  session.fitWidthPx = fitWidthPx
  return openResult(session)
}

export function deckClose(path: string): void {
  sessions.delete(path)
}

/**
 * The editor's method table, as one door.
 *
 * `OfficeFrame` forwards what the slides bundle asks for, with the document's path in front
 * (`[path, ...args]`) — the frame knows which file it is showing, the renderer does not. A method
 * not listed here answers `undefined`, which the editor reads as a switched-off feature.
 */
export async function officeDeckCall(method: string, args: unknown[]): Promise<unknown> {
  const path = typeof args[0] === 'string' ? args[0] : ''
  const rest = args.slice(1)

  switch (method) {
    case 'consumePendingOpen':
    case 'openPptx':
      return deckOpen(path, Number(rest[0]) || 1280)

    case 'openPptxPath': {
      // The editor asked for another file: open it and answer the same shape.
      const next = typeof rest[0] === 'string' ? rest[0] : path
      return deckOpen(next, 1280)
    }

    case 'getRenderSlides':
      return deckRender(path, Number(rest[0]) || 1280)?.slides ?? null

    case 'applyTxn': {
      const request = (rest[0] ?? {}) as { ops?: unknown[]; fitWidthPx?: number }
      return deckApply(path, request.ops ?? [], request.fitWidthPx)
    }

    case 'save':
      return deckSave(path, (rest[0] ?? {}) as { overwrite?: boolean })

    case 'undo':
      return deckUndo(path)

    case 'redo':
      return deckRedo(path)

    case 'isDirty':
      return deckIsDirty(path) || sessions.get(path)?.metaDirty === true

    case 'close':
      deckClose(path)
      return null

    // The editor's own Export as PDF: save what is on screen first, then print the file with
    // the app's renderer (the same path as office:exportPdf).
    case 'exportPdf': {
      // Printing needs a renderer, which a hub does not have. The app injects one at startup
      // (`setOfficePrint`); without it this is refused in words rather than by throwing later.
      const print = officePrint()
      if (!print) {
        return { ok: false, error: 'This host has no renderer to print with, so Export as PDF is not available here.' }
      }
      const saved = await deckSave(path)
      if (!saved.ok) return { ok: false, error: saved.error }
      const target = path.replace(/.pptx$/i, '.pdf')
      const written = await print({ app: 'slides', path, bytes: new Uint8Array(0) }, target)
      return { ok: true, path: written }
    }

    case 'pickExportPdfPath':
      // No dialog in a hosted editor: the file lands beside the deck under its own name.
      return path.replace(/.pptx$/i, '.pdf')

    case 'getSlideSize': {
      const session = sessions.get(path)
      const deck = (session?.opened as { deck?: { size?: { cx?: number; cy?: number } } } | undefined)?.deck
      return { cx: deck?.size?.cx ?? 12192000, cy: deck?.size?.cy ?? 6858000 }
    }

    /**
     * Speaker notes: the editor's notes pane, read and written.
     *
     * This is the one place where a missing answer **lost work**: the pane accepts typing, `setNotes`
     * came back `undefined`, and the app's own `if (!ok) return` dropped the draft without a word —
     * not even a dirty mark, so nothing was ever saved. The engine has had both halves all along
     * (`notes.ts`: find the notes part through the slide's relationships, rewrite its body, create
     * the part when a slide has none).
     */
    case 'getNotes': {
      const session = sessions.get(path)
      const slide = slidesOf(session)[Number(rest[0]) || 0]
      if (!session || !slide) return ''
      return loadEngine().getSlideNotes(archiveOf(session), slide.path)
    }

    case 'setNotes': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; text?: unknown }
      if (!session) return false
      // Through the op pipeline, like every other edit: it validates the slide, names the failure
      // in words, and marks the deck dirty through the one place that decides that.
      const result = deckApply(path, [
        { op: 'setNotes', target: { slide: Number(request.slideIndex) || 0 }, text: String(request.text ?? '') },
      ])
      if (result.applied !== true) return false
      markMetaDirty(path)
      return true
    }

    /** Comments: authored into the deck's own author table, so they open in PowerPoint too. */
    case 'getComments': {
      const session = sessions.get(path)
      const slide = slidesOf(session)[Number(rest[0]) || 0]
      if (!session || !slide) return []
      return loadEngine().getSlideComments(archiveOf(session), slide.path)
    }

    case 'addComment': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; text?: unknown }
      if (!session) return []
      const index = Number(request.slideIndex) || 0
      const result = deckApply(path, [
        {
          op: 'addComment',
          target: { slide: index },
          // The deck's author table is the document's own; this host has no person to name, and a
          // comment attributed to nobody is worse than one attributed to the tool that wrote it.
          author: 'Craft',
          text: String(request.text ?? ''),
        },
      ])
      if (result.applied !== true) return []
      markMetaDirty(path)
      const slide = slidesOf(session)[index]
      return slide ? loadEngine().getSlideComments(archiveOf(session), slide.path) : []
    }

    case 'deleteComment': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; authorId?: unknown; idx?: unknown }
      if (!session) return []
      const index = Number(request.slideIndex) || 0
      const removed = deckApply(path, [
        {
          op: 'deleteComment',
          target: { slide: index },
          authorId: Number(request.authorId) || 0,
          idx: Number(request.idx) || 0,
        },
      ])
      if (removed.applied !== true) return []
      markMetaDirty(path)
      const slide = slidesOf(session)[index]
      return slide ? loadEngine().getSlideComments(archiveOf(session), slide.path) : []
    }

    /** Sections: the sidebar's own model, read and written as-is. */
    case 'getSections': {
      const session = sessions.get(path)
      return session ? loadEngine().getSections(session.opened) : []
    }

    case 'setSections': {
      const session = sessions.get(path)
      const sections = rest[0]
      if (!session || !Array.isArray(sections)) return []
      loadEngine().setSections(session.opened, sections as SectionInfo[])
      session.dirty = true
      markMetaDirty(path)
      return loadEngine().getSections(session.opened)
    }

    /**
     * Hyperlinks: the show follows them, so they are read per slide.
     *
     * The engine names the owner of a link `elementId`; the editor calls it `sourceId`. One rename
     * here rather than a second dialect in the app.
     */
    case 'getSlideLinks': {
      const session = sessions.get(path)
      if (!session) return []
      return loadEngine()
        .getSlideLinks(session.opened, Number(rest[0]) || 0)
        .map((link) => ({ sourceId: link.elementId, target: link.target }))
    }

    case 'getRunLinks': {
      const session = sessions.get(path)
      if (!session) return []
      return loadEngine()
        .getRunLinks(session.opened, Number(rest[0]) || 0)
        .map((link) => ({
          sourceId: link.elementId,
          paraIndex: link.paraIndex,
          runIndex: link.runIndex,
          target: link.target,
        }))
    }

    /**
     * Animations: the Animations tab, and what a show plays.
     *
     * The engine models these properly (`animation.ts`): each effect's id, trigger, duration, delay
     * and even the verbatim XML of presets it has no writer for — so a deck edited here does not
     * lose the effects the editor cannot name.
     */
    case 'getAnimations': {
      const session = sessions.get(path)
      const index = Number(rest[0]) || 0
      const slide = slidesOf(session)[index]
      if (!session || !slide) return []
      const deckEngine = loadEngine()
      /**
       * What the editor wants per animation: its element's **id**, a **label**, and the effect.
       *
       * GenOffice's own main builds exactly this (and skips animations whose shape was deleted, so
       * a leftover `<p:timing>` entry cannot put a ghost row in the list). Copying it here is not
       * imitation for its own sake: the pane renders `targetName`, and the write path strips it
       * again before the op — a list without labels is a list of blanks.
       */
      const bySpid = new Map<number, { id: string; name?: string; type?: string }>()
      for (const element of elementsOf(session)[index] ?? []) {
        const spid = deckEngine.elementSpid(element)
        const id = (element as { id?: unknown }).id
        if (spid != null && typeof id === 'string' && !bySpid.has(spid)) {
          bySpid.set(spid, {
            id,
            name: typeof (element as { name?: unknown }).name === 'string' ? (element as { name: string }).name : undefined,
            type: typeof (element as { type?: unknown }).type === 'string' ? (element as { type: string }).type : undefined,
          })
        }
      }
      const out: Array<Record<string, unknown>> = []
      for (const animation of deckEngine.getSlideAnimations(slide)) {
        const element = bySpid.get(Number(animation.spid))
        if (!element) continue
        out.push({
          sourceId: element.id,
          targetName: element.name || element.type || 'Object',
          effect: animation.effect,
          trigger: animation.trigger,
          durationMs: animation.durationMs,
          delayMs: animation.delayMs,
          ...(animation.direction != null ? { direction: animation.direction } : {}),
          ...(animation.motionPath != null ? { motionPath: animation.motionPath } : {}),
          ...(animation.paragraph != null ? { paragraph: animation.paragraph } : {}),
        })
      }
      return out
    }

    case 'setAnimations': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; items?: unknown }
      const index = Number(request.slideIndex) || 0
      if (!session || !Array.isArray(request.items)) return false
      // The op layer is what maps each item's `sourceId` to its spid, validates the effect names and
      // refuses a half-applied list — the same code path the editor's own main process uses.
      const result = deckApply(path, [{ op: 'setAnimations', target: { slide: index }, items: request.items }])
      return result.applied === true
    }

    /**
     * Transitions: one slide, or **every** slide when the index is -1 (the editor's "apply to all").
     */
    case 'getTransition': {
      const session = sessions.get(path)
      const slide = slidesOf(session)[Number(rest[0]) || 0]
      return session && slide ? loadEngine().getSlideTransition(slide) : 'none'
    }

    case 'setTransition': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; kind?: unknown }
      if (!session) return false
      const kind = String(request.kind ?? 'none')
      const index = Number(request.slideIndex)
      const targets = index < 0 ? slidesOf(session).map((_slide, at) => at) : [index]
      if (targets.length === 0) return false
      const result = deckApply(
        path,
        targets.map((slide) => ({ op: 'setTransition', target: { slide }, kind })),
      )
      return result.applied === true
    }

    /**
     * Auto-advance, which the presenter uses to move on by itself.
     *
     * The answer is an **object** (`{advanceMs, narrationIds}`), not the number the engine returns:
     * the presenter also highlights the shapes that carry recorded narration, and a bare number
     * there is a crash on `.narrationIds`, not a missing feature.
     */
    case 'getShowTiming': {
      const session = sessions.get(path)
      const slide = slidesOf(session)[Number(rest[0]) || 0]
      if (!session || !slide) return { advanceMs: null, narrationIds: [] }
      const deckEngine = loadEngine()
      const narration = new Set(deckEngine.narrationSpids(slide))
      return {
        advanceMs: deckEngine.getSlideAdvanceTime(slide),
        narrationIds: (elementsOf(session)[Number(rest[0]) || 0] ?? [])
          .filter((element) => narration.has(deckEngine.elementSpid(element) ?? -1))
          .map((element) => (element as { id?: string }).id)
          .filter((id): id is string => typeof id === 'string'),
      }
    }

    case 'setShowTiming': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; ms?: unknown }
      if (!session) return false
      const ms = request.ms === null || request.ms === undefined ? null : Number(request.ms)
      const result = deckApply(path, [
        {
          op: 'setAdvanceTime',
          target: { slide: Number(request.slideIndex) || 0 },
          ms: ms !== null && Number.isFinite(ms) ? Math.round(ms) : null,
        },
      ])
      return result.applied === true
    }

    /**
     * Fonts the deck embeds, in the shape the editor loads into `FontFace`.
     *
     * A deck that carries its own fonts must draw with them or it is not the same deck: the
     * fallback changes metrics, and every wrap in the poster would be the browser's guess. The
     * catalogue is built once per open deck, because the bytes are the file's own.
     */
    case 'privateFontFaces': {
      const session = sessions.get(path)
      if (!session) return null
      return privateFontFacesFor(session).map(({ id, family, bold, italic }) => ({ id, family, bold, italic }))
    }

    case 'privateFontData': {
      const session = sessions.get(path)
      const id = typeof rest[0] === 'string' ? (rest[0] as string) : ''
      if (!session || !id) return null
      return privateFontFacesFor(session).find((face) => face.id === id)?.sfnt ?? null
    }

    /**
     * Fonts the deck names but does not carry: an empty list, because this host has no font
     * inventory of the machine to compare against — saying "missing" would be a guess.
     */
    case 'fontMissing':
      return []

    // ---- editing: one gesture, one op ---------------------------------------------------
    //
    // Each of these is a translation, not an implementation: the op validates the payload, does
    // the XML surgery and records what changed. What these cases add is the two conversions the
    // editor's vocabulary needs and the shape of the answer it expects back.

    case 'editText': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; paragraphs?: unknown; groupId?: unknown }
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [
        {
          op: 'setText',
          target: { slide: index, el: request.sourceId },
          paragraphs: request.paragraphs,
          ...(request.groupId ? { group: request.groupId } : {}),
        },
      ])
    }

    case 'deleteElement': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown }
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [{ op: 'deleteElement', target: { slide: index, el: request.sourceId } }])
    }

    case 'deleteElements': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceIds?: unknown }
      const index = Number(request.slideIndex) || 0
      const ids = Array.isArray(request.sourceIds) ? request.sourceIds : []
      if (ids.length === 0) return null
      // `per_op`: an id that already vanished is skipped instead of aborting the rest.
      return editSlide(
        path,
        index,
        ids.map((id) => ({ op: 'deleteElement', target: { slide: index, el: id }, isolation: 'per_op' })),
      )
    }

    case 'addElement': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      const paragraphs =
        Array.isArray(request.paragraphs) && request.paragraphs.length > 0
          ? request.paragraphs
          : typeof request.text === 'string' && request.text
            ? String(request.text)
                .split('\n')
                .map((line) => ({ runs: [{ text: line }] }))
            : undefined
      const stroke = request.stroke as { color?: unknown; widthPt?: unknown } | undefined
      const result = deckApply(path, [
        {
          op: 'addElement',
          target: { slide: index },
          kind: request.kind,
          offset: {
            x: pxToEmu(request.xPx, request.fitWidthPx, session),
            y: pxToEmu(request.yPx, request.fitWidthPx, session),
            cx: pxToEmu(request.wPx, request.fitWidthPx, session),
            cy: pxToEmu(request.hPx, request.fitWidthPx, session),
          },
          ...(paragraphs ? { paragraphs } : {}),
          ...(request.fillColor ? { fill: request.fillColor } : {}),
          ...(stroke
            ? {
                stroke: {
                  color: stroke.color,
                  widthEmu: Math.round((Number(stroke.widthPt) || 0) * EMU_PER_PT),
                },
              }
            : {}),
          ...(request.bodyPr ? { bodyPr: request.bodyPr } : {}),
        },
      ])
      if (result.applied !== true) return null
      const created = ((result as { records?: unknown[] }).records?.[0] as { created?: unknown[] } | undefined)?.created?.[0]
      return { slide: renderSlideAt(session, index), sourceId: created ?? null }
    }

    case 'editFill': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; fill?: unknown; groupId?: unknown }
      const index = Number(request.slideIndex) || 0
      const fill = request.fill as { gradient?: { stops?: unknown; angleDeg?: unknown } } | string | undefined
      // A gradient arrives with its angle in degrees; the op stores sixtieths of one.
      const translated =
        typeof fill === 'string' || fill === undefined
          ? fill
          : fill.gradient
            ? {
                stops: fill.gradient.stops ?? [],
                angle: Math.round((Number(fill.gradient.angleDeg) || 0) * 60_000),
              }
            : fill
      return editSlide(path, index, [
        {
          op: 'setFill',
          target: { slide: index, el: request.sourceId },
          fill: translated,
          ...(request.groupId ? { group: request.groupId } : {}),
        },
      ])
    }

    case 'editStroke': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; stroke?: unknown; groupId?: unknown }
      const index = Number(request.slideIndex) || 0
      const stroke = request.stroke as
        | { widthPt?: unknown; gradient?: { stops?: unknown; angleDeg?: unknown } }
        | null
        | undefined
      return editSlide(path, index, [
        {
          op: 'setStroke',
          target: { slide: index, el: request.sourceId },
          stroke: stroke
            ? {
                ...stroke,
                widthEmu: Math.round((Number(stroke.widthPt) || 0) * EMU_PER_PT),
                ...(stroke.gradient
                  ? {
                      gradient: {
                        stops: stroke.gradient.stops ?? [],
                        angle: Math.round((Number(stroke.gradient.angleDeg) || 0) * 60_000),
                      },
                    }
                  : {}),
              }
            : null,
          ...(request.groupId ? { group: request.groupId } : {}),
        },
      ])
    }

    case 'setElementFont': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const index = Number(request.slideIndex) || 0
      const ids = Array.isArray(request.sourceIds) ? request.sourceIds : []
      if (ids.length === 0) return null
      const font = {
        fontFamily: request.fontFamily,
        fontSizePt: request.fontSizePt,
        fontSizeStep: request.fontSizeStep,
        strike: request.strike,
        bold: request.bold,
        italic: request.italic,
        underline: request.underline,
        color: request.color,
      }
      // `per_op` covers a whole selection: a non-text element fails its own op and is skipped.
      return editSlide(
        path,
        index,
        ids.map((id) => ({
          op: 'setFont',
          target: { slide: index, el: id },
          font,
          isolation: 'per_op',
          ...(request.groupId ? { group: request.groupId } : {}),
        })),
      )
    }

    case 'batchEditTransform': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; items?: unknown; fitWidthPx?: unknown }
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      const items = Array.isArray(request.items) ? (request.items as Array<Record<string, unknown>>) : []
      if (items.length === 0) return null
      return editSlide(
        path,
        index,
        items.map((item) => ({
          op: 'setTransform',
          target: { slide: index, el: item.sourceId },
          box: {
            x: pxToEmu(item.xPx, request.fitWidthPx, session),
            y: pxToEmu(item.yPx, request.fitWidthPx, session),
            cx: pxToEmu(item.wPx, request.fitWidthPx, session),
            cy: pxToEmu(item.hPx, request.fitWidthPx, session),
          },
          rotDeg: item.rotationDeg,
        })),
      )
    }

    case 'flipElements': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceIds?: unknown; axis?: unknown; groupId?: unknown }
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [
        {
          op: 'flipElements',
          target: { slide: index },
          els: request.sourceIds,
          axis: request.axis,
          ...(request.groupId ? { group: request.groupId } : {}),
        },
      ])
    }

    case 'groupElements': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceIds?: unknown }
      const session = sessions.get(path)
      const index = Number(request.slideIndex) || 0
      if (!session) return null
      const result = deckApply(path, [{ op: 'groupElements', target: { slide: index }, els: request.sourceIds }])
      if (result.applied !== true) return null
      const created = ((result as { records?: unknown[] }).records?.[0] as { created?: unknown[] } | undefined)?.created?.[0]
      const slide = renderSlideAt(session, index)
      return slide ? { slide, groupId: created ?? null } : null
    }

    case 'ungroupElement': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown }
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [{ op: 'ungroupElement', target: { slide: index, el: request.sourceId } }])
    }

    case 'reorderElement': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; dir?: unknown }
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [
        { op: 'reorderElement', target: { slide: index, el: request.sourceId }, dir: request.dir },
      ])
    }

    case 'changeShape': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; prst?: unknown; groupId?: unknown }
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [
        {
          op: 'setShapeGeometry',
          target: { slide: index, el: request.sourceId },
          prst: request.prst,
          ...(request.groupId ? { group: request.groupId } : {}),
        },
      ])
    }

    case 'setLink': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; target?: unknown }
      const index = Number(request.slideIndex) || 0
      const link = request.target as { kind?: string; url?: string } | undefined
      // A `javascript:` or `file:` target must never be saved into the package.
      if (link?.kind === 'url' && typeof link.url === 'string' && !/^(https?|mailto):/i.test(link.url)) return null
      return editSlide(path, index, [
        { op: 'setLink', target: { slide: index, el: request.sourceId }, link: request.target },
      ])
    }

    case 'addBlankSlide': {
      const request = (rest[0] ?? {}) as { sourceIndex?: unknown; before?: unknown; fitWidthPx?: unknown }
      const session = sessions.get(path)
      if (!session) return null
      const source = Number(request.sourceIndex) || 0
      if (Number.isFinite(Number(request.fitWidthPx)) && Number(request.fitWidthPx) > 0) {
        session.fitWidthPx = Number(request.fitWidthPx)
      }
      const result = deckApply(path, [
        { op: 'addBlankSlide', target: { slide: source } },
        // Ops are validated against the pre-transaction deck, so the existing slide is moved down
        // past the new one rather than targeting the new index.
        ...(request.before ? [{ op: 'moveSlide', target: { slide: source }, to: source + 1 }] : []),
      ])
      if (result.applied !== true) return null
      markMetaDirty(path)
      return { ...slideUpdate(session), index: request.before ? source : source + 1 }
    }

    case 'deleteSlide': {
      const session = sessions.get(path)
      const index = Number(rest[0])
      if (!session || !Number.isFinite(index)) return null
      const result = deckApply(path, [{ op: 'deleteSlide', target: { slide: index } }])
      if (result.applied !== true) return null
      markMetaDirty(path)
      return slideUpdate(session)
    }

    case 'deleteSlides': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { slideIndexes?: unknown }
      const indexes = Array.isArray(request.slideIndexes) ? [...new Set(request.slideIndexes as number[])] : []
      if (!session || indexes.length === 0) return null
      if (indexes.length >= slidesOf(session).length) return null
      // Highest first: every op is validated against the pre-transaction deck.
      const ordered = indexes.sort((a, b) => b - a)
      const result = deckApply(
        path,
        ordered.map((i) => ({ op: 'deleteSlide', target: { slide: i } })),
      )
      if (result.applied !== true) return null
      markMetaDirty(path)
      return slideUpdate(session)
    }

    case 'moveSlide': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { fromIndex?: unknown; toIndex?: unknown }
      if (!session) return null
      const from = Number(request.fromIndex)
      const to = Number(request.toIndex)
      if (!Number.isFinite(from) || !Number.isFinite(to)) return null
      const result = deckApply(path, [{ op: 'moveSlide', target: { slide: from }, to }])
      if (result.applied !== true) return null
      markMetaDirty(path)
      return { ...slideUpdate(session), sections: loadEngine().getSections(session.opened) }
    }

    case 'setSlidesHidden': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { slideIndexes?: unknown; hidden?: unknown }
      const indexes = Array.isArray(request.slideIndexes) ? (request.slideIndexes as number[]) : []
      if (!session || indexes.length === 0) return null
      const result = deckApply(
        path,
        indexes.map((i) => ({ op: 'setHidden', target: { slide: i }, hidden: request.hidden === true })),
      )
      if (result.applied !== true) return null
      return slideUpdate(session)
    }

    case 'setSlideSize': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { cx?: unknown; cy?: unknown }
      if (!session) return null
      const result = deckApply(path, [{ op: 'setSlideSize', cx: Number(request.cx), cy: Number(request.cy) }])
      if (result.applied !== true) return null
      markMetaDirty(path)
      return loadEngine().buildAllRenderSlides(session.opened, session.fitWidthPx)
    }

    case 'setSlideLayout': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; layoutPath?: unknown }
      const index = Number(request.slideIndex) || 0
      const layoutPath = typeof request.layoutPath === 'string' && request.layoutPath ? request.layoutPath : undefined
      return editSlide(path, index, [
        { op: 'setSlideLayout', target: { slide: index }, ...(layoutPath ? { layoutPath } : {}) },
      ])
    }

    // ---- tables and effects -------------------------------------------------------------
    //
    // Same shape as the block above, with the two table measurements that arrive in pixels
    // (a row's height, a column's width) turned into EMU at the deck's own width.

    case 'editTableCell': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; row?: unknown; col?: unknown; paragraphs?: unknown }
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [
        {
          op: 'setTableCell',
          target: { slide: index, el: request.sourceId },
          row: request.row,
          col: request.col,
          paragraphs: request.paragraphs,
        },
      ])
    }

    case 'tableStructure': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; kind?: unknown; index?: unknown; before?: unknown }
      const session = sessions.get(path)
      const index = Number(request.slideIndex) || 0
      if (!session) return null
      const result = deckApply(path, [
        {
          op: 'tableStructure',
          target: { slide: index, el: request.sourceId },
          kind: request.kind,
          index: request.index,
          ...(request.before ? { before: true } : {}),
        },
      ])
      if (result.applied !== true) return null
      const after = ((result as { records?: unknown[] }).records?.[0] as { after?: { elementId?: string } } | undefined)?.after
      const slide = renderSlideAt(session, index)
      return slide ? { slide, sourceId: after?.elementId ?? request.sourceId } : null
    }

    case 'tableMerge': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; kind?: unknown; row?: unknown; col?: unknown }
      const session = sessions.get(path)
      const index = Number(request.slideIndex) || 0
      if (!session) return null
      const result = deckApply(path, [
        {
          op: 'tableMerge',
          target: { slide: index, el: request.sourceId },
          kind: request.kind,
          row: request.row,
          col: request.col,
        },
      ])
      if (result.applied !== true) return null
      const after = ((result as { records?: unknown[] }).records?.[0] as { after?: { elementId?: string } } | undefined)?.after
      const slide = renderSlideAt(session, index)
      return slide ? { slide, sourceId: after?.elementId ?? request.sourceId } : null
    }

    case 'setTableRowHeight': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; row?: unknown; hPx?: unknown; fitWidthPx?: unknown }
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [
        {
          op: 'setTableRowHeight',
          target: { slide: index, el: request.sourceId },
          row: request.row,
          hEmu: pxToEmu(request.hPx, request.fitWidthPx, session),
        },
      ])
    }

    case 'setTableColWidth': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; col?: unknown; wPx?: unknown; fitWidthPx?: unknown }
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [
        {
          op: 'setTableColWidth',
          target: { slide: index, el: request.sourceId },
          col: request.col,
          wEmu: pxToEmu(request.wPx, request.fitWidthPx, session),
        },
      ])
    }

    case 'setTableCellAnchor': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; row?: unknown; col?: unknown; anchor?: unknown }
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [
        {
          op: 'setTableCellAnchor',
          target: { slide: index, el: request.sourceId },
          row: request.row,
          col: request.col,
          anchor: request.anchor,
        },
      ])
    }

    case 'editTableStyle': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const index = Number(request.slideIndex) || 0
      const { slideIndex: _slide, sourceId, fitWidthPx: _fit, ...style } = request
      return editSlide(path, index, [
        { op: 'setTableStyle', target: { slide: index, el: sourceId }, ...style },
      ])
    }

    case 'setEffects': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; effects?: unknown }
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [
        { op: 'setEffects', target: { slide: index, el: request.sourceId }, effects: request.effects },
      ])
    }

    case 'setShapeAdjust': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; adjust?: unknown; groupId?: unknown }
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [
        {
          op: 'setShapeAdjust',
          target: { slide: index, el: request.sourceId },
          adjust: request.adjust,
          ...(request.groupId ? { group: request.groupId } : {}),
        },
      ])
    }

    case 'setTextAnchor': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; anchor?: unknown }
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [
        { op: 'setTextAnchor', target: { slide: index, el: request.sourceId }, anchor: request.anchor },
      ])
    }

    case 'setTextBodyProps': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; props?: unknown }
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [
        { op: 'setTextBodyProps', target: { slide: index, el: request.sourceId }, props: request.props },
      ])
    }

    case 'setElementParagraphFormat': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const index = Number(request.slideIndex) || 0
      const ids = Array.isArray(request.sourceIds) ? request.sourceIds : []
      if (ids.length === 0) return null
      const format = {
        align: request.align,
        bullet: request.bullet,
        indentStep: request.indentStep,
        lineSpacing: request.lineSpacing,
        spaceBeforePt: request.spaceBeforePt,
        spaceAfterPt: request.spaceAfterPt,
        direction: request.direction,
      }
      return editSlide(
        path,
        index,
        ids.map((id) => ({
          op: 'setParagraphFormat',
          target: { slide: index, el: id },
          format,
          isolation: 'per_op',
          ...(request.groupId ? { group: request.groupId } : {}),
        })),
      )
    }

    // ---- inserting things, and deck-wide settings ---------------------------------------
    //
    // The Insert menu and the Design tab. Same translation as above: pixels to EMU at the deck's
    // own width, one op per gesture, and the answer the editor expects (a rebuilt page, or every
    // page for a change that touches all of them).

    case 'addTable': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      const rowHeight = Number(request.rowHeightEmu)
      const result = deckApply(path, [
        {
          op: 'addTable',
          target: { slide: index },
          rows: request.rows,
          cols: request.cols,
          offset: {
            x: pxToEmu(request.xPx, request.fitWidthPx, session),
            y: pxToEmu(request.yPx, request.fitWidthPx, session),
            cx: pxToEmu(request.wPx, request.fitWidthPx, session),
            cy: Number.isFinite(rowHeight) && rowHeight > 0
              ? rowHeight * (Number(request.rows) || 1)
              : pxToEmu(request.hPx, request.fitWidthPx, session),
          },
        },
      ])
      if (result.applied !== true) return null
      const created = ((result as { records?: unknown[] }).records?.[0] as { created?: unknown[] } | undefined)?.created?.[0]
      const slide = renderSlideAt(session, index)
      return slide ? { slide, sourceId: created ?? null } : null
    }

    case 'addChart': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      const kind = request.kind === 'barH' ? 'bar' : request.kind
      const result = deckApply(path, [
        {
          op: 'addChart',
          target: { slide: index },
          kind,
          ...(request.kind === 'barH' ? { barDir: 'bar' } : {}),
          ...(request.title ? { title: request.title } : {}),
          categories: request.categories,
          series: request.series,
          offset: {
            x: pxToEmu(request.xPx, request.fitWidthPx, session),
            y: pxToEmu(request.yPx, request.fitWidthPx, session),
            cx: pxToEmu(request.wPx, request.fitWidthPx, session),
            cy: pxToEmu(request.hPx, request.fitWidthPx, session),
          },
        },
      ])
      if (result.applied !== true) return null
      const created = ((result as { records?: unknown[] }).records?.[0] as { created?: unknown[] } | undefined)?.created?.[0]
      const slide = renderSlideAt(session, index)
      return slide ? { slide, sourceId: created ?? null } : null
    }

    case 'addSmartArt': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      if (Number(request.fitWidthPx) > 0) session.fitWidthPx = Number(request.fitWidthPx)
      const result = deckApply(path, [
        {
          op: 'addSmartArt',
          target: { slide: index },
          layout: request.layout,
          items: request.items,
          offset: {
            x: pxToEmu(request.xPx, request.fitWidthPx, session),
            y: pxToEmu(request.yPx, request.fitWidthPx, session),
            cx: pxToEmu(request.wPx, request.fitWidthPx, session),
            cy: pxToEmu(request.hPx, request.fitWidthPx, session),
          },
        },
      ])
      if (result.applied !== true) return null
      const created = ((result as { records?: unknown[] }).records?.[0] as { created?: unknown[] } | undefined)?.created?.[0]
      const slide = renderSlideAt(session, index)
      return slide ? { slide, sourceId: created ?? null } : null
    }

    case 'addSlideWithLayout': {
      const request = (rest[0] ?? {}) as { sourceIndex?: unknown; layoutPath?: unknown; fitWidthPx?: unknown }
      const session = sessions.get(path)
      if (!session) return null
      const source = Number(request.sourceIndex) || 0
      const layoutPath = typeof request.layoutPath === 'string' && request.layoutPath ? request.layoutPath : undefined
      if (Number(request.fitWidthPx) > 0) session.fitWidthPx = Number(request.fitWidthPx)
      const result = deckApply(path, [
        { op: 'addSlideWithLayout', target: { slide: source }, ...(layoutPath ? { layoutPath } : {}) },
      ])
      if (result.applied !== true) return null
      markMetaDirty(path)
      return { ...slideUpdate(session), index: source + 1 }
    }

    case 'applyHeaderFooter': {
      const request = (rest[0] ?? {}) as {
        footer?: unknown
        slideNum?: unknown
        date?: unknown
        dateAuto?: unknown
        fitWidthPx?: unknown
      }
      const session = sessions.get(path)
      if (!session) return null
      if (Number(request.fitWidthPx) > 0) session.fitWidthPx = Number(request.fitWidthPx)
      const result = deckApply(path, [
        {
          op: 'applyHeaderFooter',
          settings: {
            footer: request.footer ?? null,
            slideNum: request.slideNum === true,
            date: request.date ?? null,
            ...(request.dateAuto ? { dateAuto: true } : {}),
          },
        },
      ])
      if (result.applied !== true) return null
      return loadEngine().buildAllRenderSlides(session.opened, session.fitWidthPx)
    }

    case 'getHeaderFooter': {
      const session = sessions.get(path)
      const slide = slidesOf(session)[Number(rest[0]) || 0]
      if (!session || !slide) return { footer: null, slideNum: false, date: null }
      return loadEngine().readHeaderFooter(slide)
    }

    case 'applyTheme': {
      const request = (rest[0] ?? {}) as { name?: unknown; colors?: unknown; majorFont?: unknown; minorFont?: unknown }
      const session = sessions.get(path)
      if (!session) return null
      const result = deckApply(path, [
        {
          op: 'applyTheme',
          name: request.name,
          colors: request.colors,
          ...(request.majorFont ? { majorFont: request.majorFont } : {}),
          ...(request.minorFont ? { minorFont: request.minorFont } : {}),
        },
      ])
      const failure = (result as { failures?: Array<{ error?: string }> }).failures?.[0]
      if (result.applied !== true) return { error: failure?.error ?? 'applyTheme failed' }
      return { slides: loadEngine().buildAllRenderSlides(session.opened, session.fitWidthPx) }
    }

    /** Rehearsed timings: one `setAdvanceTime` per slide the presenter measured. */
    case 'setAdvanceTimes': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { times?: unknown }
      const times = Array.isArray(request.times) ? (request.times as Array<{ slideIndex?: unknown; ms?: unknown }>) : []
      if (!session) return false
      const slides = slidesOf(session)
      const targets = times.filter((entry) => slides[Number(entry.slideIndex)])
      if (targets.length === 0) return false
      const result = deckApply(
        path,
        targets.map((entry) => ({
          op: 'setAdvanceTime',
          target: { slide: Number(entry.slideIndex) },
          ms: entry.ms == null ? null : Math.round(Number(entry.ms)),
        })),
      )
      return result.applied === true
    }

    /** Recording ink that was never saved: drop the narration shapes from the named slides. */
    case 'clearNarration': {
      const session = sessions.get(path)
      const indexes = Array.isArray(rest[0]) ? (rest[0] as unknown[]) : []
      if (!session) return null
      const deckEngine = loadEngine()
      const slides = slidesOf(session)
      const targets = indexes
        .map((value) => Number(value))
        .filter((index) => slides[index] && deckEngine.narrationSpids(slides[index]!).length > 0)
      if (targets.length === 0) return null
      const result = deckApply(
        path,
        targets.map((index) => ({ op: 'clearNarration', target: { slide: index } })),
      )
      if (result.applied !== true) return null
      markMetaDirty(path)
      return slideUpdate(session)
    }

    case 'findReplace': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as Record<string, unknown>
      if (!session) return { count: 0, update: null }
      const result = deckApply(path, [
        {
          op: 'findReplace',
          find: request.find,
          replace: request.replace,
          matchCase: request.matchCase,
          firstOnly: request.firstOnly,
          slideIndex: request.slideIndex,
          elementId: request.elementId,
        },
      ])
      if (result.applied !== true) return { count: 0, update: null }
      const after = ((result as { records?: unknown[] }).records?.[0] as { after?: { count?: number } } | undefined)?.after
      return { count: after?.count ?? 0, update: slideUpdate(session) }
    }

    // ---- the rest of the surface the editor offers ----------------------------------------
    //
    // Sections, per-element links, and the multi-slide operations. The page operations run one
    // transaction per step: the op layer validates every op against the *pre-transaction* deck, so
    // a batch that inserts and then moves would be validating index 3 of a deck that no longer has
    // three slides in the order it thinks.

    case 'addSection': {
      const request = (rest[0] ?? {}) as { atSlideIndex?: unknown; name?: unknown }
      const session = sessions.get(path)
      if (!session) return null
      const result = deckApply(path, [
        { op: 'addSection', atSlideIndex: request.atSlideIndex, name: request.name },
      ])
      if (result.applied !== true) return null
      markMetaDirty(path)
      return loadEngine().getSections(session.opened)
    }

    case 'renameSection': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { id?: unknown; name?: unknown }
      if (!session) return null
      const result = deckApply(path, [{ op: 'renameSection', id: request.id, name: request.name }])
      if (result.applied !== true) return null
      markMetaDirty(path)
      return loadEngine().getSections(session.opened)
    }

    case 'removeSection': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { id?: unknown }
      if (!session) return null
      const result = deckApply(path, [{ op: 'removeSection', id: request.id }])
      if (result.applied !== true) return null
      markMetaDirty(path)
      return loadEngine().getSections(session.opened)
    }

    /** Removing a section and its slides: the slides first, then the section itself. */
    case 'removeSectionSlides': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { id?: unknown; slideIndexes?: unknown }
      if (!session) return null
      const indexes = Array.isArray(request.slideIndexes) ? [...new Set(request.slideIndexes as number[])] : []
      const ordered = indexes.sort((a, b) => b - a)
      for (const index of ordered) {
        deckApply(path, [{ op: 'deleteSlide', target: { slide: index } }])
      }
      const result = deckApply(path, [{ op: 'removeSection', id: request.id }])
      if (result.applied !== true) return null
      markMetaDirty(path)
      return slideUpdate(session)
    }

    case 'moveSection': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { id?: unknown; dir?: unknown }
      if (!session) return null
      const result = deckApply(path, [{ op: 'moveSection', id: request.id, dir: request.dir }])
      if (result.applied !== true) return null
      markMetaDirty(path)
      return { ...slideUpdate(session), sections: loadEngine().getSections(session.opened) }
    }

    /** One element's hyperlink (the Format pane reads it; the show follows it). */
    case 'getLink': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown }
      const index = Number(request.slideIndex) || 0
      const slide = slidesOf(session)[index]
      if (!session || !slide) return null
      return loadEngine().getElementLink(session.opened, index, String(request.sourceId ?? ''))
    }

    /** `setShapeGeometry` and `changeShape` are the same gesture under two names on the wire. */
    case 'setShapeGeometry': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; prst?: unknown; groupId?: unknown }
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [
        {
          op: 'setShapeGeometry',
          target: { slide: index, el: request.sourceId },
          prst: request.prst,
          ...(request.groupId ? { group: request.groupId } : {}),
        },
      ])
    }

    /**
     * Duplicating slides: one transaction per copy.
     *
     * A batch would be validated against the deck as it was before the batch, so the second copy's
     * index would point at a page that has already moved. Each copy goes in right after its source
     * and is then moved to the end, which is where the editor's own plan puts them.
     */
    case 'duplicateSlides': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { slideIndexes?: unknown; fitWidthPx?: unknown }
      const indexes = Array.isArray(request.slideIndexes) ? [...new Set(request.slideIndexes as number[])] : []
      if (!session || indexes.length === 0) return null
      if (Number(request.fitWidthPx) > 0) session.fitWidthPx = Number(request.fitWidthPx)
      for (const index of [...indexes].sort((a, b) => a - b)) {
        const duplicated = deckApply(path, [{ op: 'duplicateSlide', target: { slide: index } }])
        if (duplicated.applied !== true) return null
        const end = slidesOf(session).length - 1
        if (end > index + 1) deckApply(path, [{ op: 'moveSlide', target: { slide: index + 1 }, to: end }])
      }
      markMetaDirty(path)
      return { ...slideUpdate(session), index: Math.max(...indexes) + 1 }
    }

    /** Moving several slides to one place: each one lands, then the deck is read again. */
    case 'moveSlides': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { slideIndexes?: unknown; insertAt?: unknown }
      const indexes = Array.isArray(request.slideIndexes) ? [...new Set(request.slideIndexes as number[])] : []
      const insertAt = Number(request.insertAt)
      if (!session || indexes.length === 0 || !Number.isFinite(insertAt)) return null
      let target = insertAt
      for (const index of [...indexes].sort((a, b) => a - b)) {
        const result = deckApply(path, [{ op: 'moveSlide', target: { slide: index }, to: target }])
        if (result.applied !== true) return null
        // The slide now sits at `target`; the next one goes right after it.
        target += 1
      }
      markMetaDirty(path)
      return { ...slideUpdate(session), sections: loadEngine().getSections(session.opened) }
    }

    /**
     * History batches: accepted, and they do not group.
     *
     * GenOffice uses them to make one drag one undo step. This host pushes a snapshot per op, so a
     * drag is already several undo steps — answering `true` keeps the gesture working and the
     * coarse undo is the cost, which is visible in the undo button rather than hidden.
     */
    case 'beginHistoryBatch':
    case 'endHistoryBatch':
      return true

    /** Auto-save preference: the host saves when asked; there is nothing to switch on. */
    case 'setAutoSavePref':
      return true

    /** There is no OS clipboard bridge for deck objects; the host's own clipboard is next door. */
    case 'clipboardProbe':
      return false

    // ---- media: picture, ink, audio/video ------------------------------------------------
    //
    // The op carries the bytes, so nothing has to be landed in the package first: `addPicture`
    // and `addMedia` write the part themselves. The only translation is the rectangle, and the
    // editor sends it in the same fit-scaled pixels as everything else.

    case 'addImageBytes': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      const base64 = typeof request.base64 === 'string' ? request.base64 : ''
      if (!base64) return null
      const bytes = Uint8Array.from(Buffer.from(base64, 'base64'))
      const natural = request.naturalPx as { width?: unknown; height?: unknown } | undefined
      // An explicit rectangle is the drop-a-file case; `naturalPx` is the paste case, where the
      // picture keeps its own size, shrunk to fit the slide and centred where the person asked.
      const size = (session.opened as { deck?: { size?: { cx?: number; cy?: number } } }).deck?.size
      const slideCx = size?.cx ?? 12192000
      const slideCy = size?.cy ?? 6858000
      let offset: { x: number; y: number; cx: number; cy: number }
      if (natural && Number(natural.width) > 0 && Number(natural.height) > 0) {
        const ratio = Math.min(1, (slideCx * 0.8) / (Number(natural.width) * EMU_PER_PX), (slideCy * 0.8) / (Number(natural.height) * EMU_PER_PX))
        const cx = Math.max(1, Math.round(Number(natural.width) * ratio * EMU_PER_PX))
        const cy = Math.max(1, Math.round(Number(natural.height) * ratio * EMU_PER_PX))
        const center = request.centerPx as { x?: unknown; y?: unknown } | undefined
        const centreX = center ? pxToEmu(center.x, request.fitWidthPx, session) : Math.round(slideCx / 2)
        const centreY = center ? pxToEmu(center.y, request.fitWidthPx, session) : Math.round(slideCy / 2)
        offset = { x: centreX - Math.round(cx / 2), y: centreY - Math.round(cy / 2), cx, cy }
      } else {
        offset = {
          x: pxToEmu(request.xPx, request.fitWidthPx, session),
          y: pxToEmu(request.yPx, request.fitWidthPx, session),
          cx: Math.max(1, pxToEmu(request.wPx, request.fitWidthPx, session)),
          cy: Math.max(1, pxToEmu(request.hPx, request.fitWidthPx, session)),
        }
      }
      const ext = typeof request.ext === 'string' && request.ext ? request.ext : 'png'
      const result = deckApply(path, [
        { op: 'addPicture', target: { slide: index }, bytes, ext, offset },
      ])
      if (result.applied !== true) return null
      if (Number(request.fitWidthPx) > 0) session.fitWidthPx = Number(request.fitWidthPx)
      const created = ((result as { records?: unknown[] }).records?.[0] as { created?: unknown[] } | undefined)?.created?.[0]
      const slide = renderSlideAt(session, index)
      return slide ? { slide, sourceId: created ?? null } : null
    }

    case 'addInk': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      const base64 = typeof request.base64 === 'string' ? request.base64 : ''
      if (!base64) return null
      const result = deckApply(path, [
        {
          op: 'addPicture',
          target: { slide: index },
          bytes: Uint8Array.from(Buffer.from(base64, 'base64')),
          ext: 'png',
          offset: {
            x: pxToEmu(request.xPx, request.fitWidthPx, session),
            y: pxToEmu(request.yPx, request.fitWidthPx, session),
            cx: Math.max(1, pxToEmu(request.wPx, request.fitWidthPx, session)),
            cy: Math.max(1, pxToEmu(request.hPx, request.fitWidthPx, session)),
          },
          name: `aislides-ink ${Date.now().toString(36)}`,
          ...(typeof request.payload === 'string' ? { descr: request.payload } : {}),
        },
      ])
      if (result.applied !== true) return null
      if (Number(request.fitWidthPx) > 0) session.fitWidthPx = Number(request.fitWidthPx)
      const created = ((result as { records?: unknown[] }).records?.[0] as { created?: unknown[] } | undefined)?.created?.[0]
      const slide = renderSlideAt(session, index)
      return slide ? { slide, sourceId: created ?? null } : null
    }

    case 'replacePictureBytes': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const index = Number(request.slideIndex) || 0
      const base64 = typeof request.base64 === 'string' ? request.base64 : ''
      if (!base64) return null
      const ext = typeof request.ext === 'string' && request.ext ? request.ext : 'png'
      return editSlide(path, index, [
        {
          op: 'replacePicture',
          target: { slide: index, el: request.sourceId },
          bytes: Uint8Array.from(Buffer.from(base64, 'base64')),
          ext,
          ...(request.keepSrcRect ? { keepSrcRect: true } : {}),
        },
      ])
    }

    case 'addMediaBytes': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      let bytes: Uint8Array | null = null
      if (typeof request.base64 === 'string' && request.base64) {
        bytes = Uint8Array.from(Buffer.from(request.base64, 'base64'))
      } else if (typeof request.path === 'string' && request.path) {
        const { readFile } = await import('node:fs/promises')
        bytes = new Uint8Array(await readFile(request.path))
      }
      if (!bytes) return null
      const ext = typeof request.ext === 'string' && request.ext ? request.ext : 'mp4'
      const kind = request.kind === 'audio' ? 'audio' : 'video'
      const natural = request.natural as { width?: unknown; height?: unknown } | undefined
      const size = (session.opened as { deck?: { size?: { cx?: number; cy?: number } } }).deck?.size
      const cx = Math.max(1, Math.round(Number(natural?.width ?? 320) * EMU_PER_PX))
      const cy = Math.max(1, Math.round(Number(natural?.height ?? 180) * EMU_PER_PX))
      const result = deckApply(path, [
        {
          op: 'addMedia',
          target: { slide: index },
          kind,
          bytes,
          ext,
          ...(typeof request.name === 'string' && request.name ? { name: request.name } : {}),
          offset: {
            x: Math.round(((size?.cx ?? 12192000) - cx) / 2),
            y: Math.round(((size?.cy ?? 6858000) - cy) / 2),
            cx,
            cy,
          },
        },
      ])
      if (result.applied !== true) return null
      if (Number(request.fitWidthPx) > 0) session.fitWidthPx = Number(request.fitWidthPx)
      const created = ((result as { records?: unknown[] }).records?.[0] as { created?: unknown[] } | undefined)?.created?.[0]
      const slide = renderSlideAt(session, index)
      return slide ? { slide, sourceId: created ?? null } : null
    }

    // ---- the remaining single-op gestures ------------------------------------------------
    //
    // Picture crop / opacity / image fill, connector endpoints, charts and element duplicates. All
    // of them are one op with the same translation as everything above; charts are the one that
    // needs the page re-parsed afterwards, because the model caches the chart part.

    case 'editPictureSrcRect': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const index = Number(request.slideIndex) || 0
      const session = sessions.get(path)
      if (!session) return null
      const box = request.box as Record<string, unknown> | undefined
      return editSlide(path, index, [
        {
          op: 'setPictureSrcRect',
          target: { slide: index, el: request.sourceId },
          srcRect: request.srcRect,
          ...(box
            ? {
                box: {
                  x: pxToEmu(box.xPx, request.fitWidthPx, session),
                  y: pxToEmu(box.yPx, request.fitWidthPx, session),
                  cx: pxToEmu(box.wPx, request.fitWidthPx, session),
                  cy: pxToEmu(box.hPx, request.fitWidthPx, session),
                },
              }
            : {}),
        },
      ])
    }

    case 'editPictureOpacity': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; opacity?: unknown }
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [
        {
          op: 'setPictureOpacity',
          target: { slide: index, el: request.sourceId },
          opacity: request.opacity,
        },
      ])
    }

    case 'editImageFill': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      const base64 = typeof request.base64 === 'string' ? request.base64 : ''
      if (!base64) return null
      const ext = typeof request.ext === 'string' && request.ext ? request.ext : 'png'
      const sourceIds = Array.isArray(request.sourceIds)
        ? (request.sourceIds as unknown[])
        : request.sourceId
          ? [request.sourceId]
          : []
      if (sourceIds.length === 0) return null
      // One fill per target, all in one transaction: a fill that fails on one shape must not leave
      // the others half-painted.
      const result = deckApply(
        path,
        sourceIds.map((id) => ({
          op: 'setImageFill',
          target: { slide: index, el: id },
          source: { bytes: Uint8Array.from(Buffer.from(base64, 'base64')), ext },
          tile: request.mode === 'tile',
        })),
      )
      if (result.applied !== true) return null
      return renderSlideAt(session, index)
    }

    case 'editConnectorEndpoints': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      return editSlide(path, index, [
        {
          op: 'setConnectorEndpoints',
          target: { slide: index, el: request.sourceId },
          p1: {
            x: pxToEmu(request.x1Px, request.fitWidthPx, session),
            y: pxToEmu(request.y1Px, request.fitWidthPx, session),
          },
          p2: {
            x: pxToEmu(request.x2Px, request.fitWidthPx, session),
            y: pxToEmu(request.y2Px, request.fitWidthPx, session),
          },
          start: request.start,
          end: request.end,
        },
      ])
    }

    case 'editChart': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceId?: unknown; patch?: unknown }
      const session = sessions.get(path)
      const index = Number(request.slideIndex) || 0
      if (!session) return null
      // Which slot the chart occupies, before the edit: the re-parse below renumbers ids, and the
      // slot is the only thing that says which shape is still the same chart afterwards.
      const slot = (elementsOf(session)[index] ?? []).findIndex((element) => element.id === request.sourceId)
      const result = deckApply(path, [
        { op: 'setChart', target: { slide: index, el: request.sourceId }, patch: request.patch },
      ])
      if (result.applied !== true) return null
      // The chart part was rewritten and the model caches it, so the page is re-parsed before it
      // renders again — `rebuildSlideWithReparse` in GenOffice's own main does the same thing.
      const fresh = loadEngine().materializeSlide(session.opened, index)
      const slide = fresh
        ? loadEngine().buildAllRenderSlides(session.opened, session.fitWidthPx)[index] ?? null
        : null
      if (!slide) return null
      // The answer carries the id the chart has **now**: a caller that keeps the old one would be
      // addressing a shape that no longer answers.
      const newId = slot >= 0 ? (elementsOf(session)[index] ?? [])[slot]?.id ?? null : null
      return { slide, sourceId: newId ?? request.sourceId }
    }


    case 'copyElements': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; sourceIds?: unknown }
      const index = Number(request.slideIndex) || 0
      const ids = Array.isArray(request.sourceIds) ? (request.sourceIds as unknown[]) : []
      const slide = slidesOf(session)[index]
      if (!session || !slide || ids.length === 0) return false
      const items = (elementsOf(session)[index] ?? [])
        .filter((element) => ids.includes(element.id ?? ''))
        .map((element) => loadEngine().copyElementData(session.opened, slide, element))
      deckClipboard.elements = items
      // A **count**, not a boolean: the editor asks `if (n > 0)` before it says "copied".
      return items.length
    }

    /**
     * What is on the clipboard, as a value the client can carry.
     *
     * The host's clipboard lives only as long as this process, so a copy in one window is invisible
     * to another. The frame asks for this right after a copy, puts it on the **OS** clipboard as HTML
     * with a marker, and hands it back on paste — which is what makes copying across windows, and
     * across a reload, work at all.
     */
    case 'clipboardPayload':
      return {
        ...(deckClipboard.elements?.length ? { kind: 'elements', items: deckClipboard.elements } : {}),
        ...(deckClipboard.slides?.length
          ? { kind: 'slides', bundles: deckClipboard.slides, pngs: deckClipboard.slidePngs ?? [] }
          : {}),
      }

    case 'pasteElements': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as {
        slideIndex?: unknown
        dxPx?: unknown
        dyPx?: unknown
        fitWidthPx?: unknown
        items?: unknown
      }
      const index = Number(request.slideIndex) || 0
      // A payload from the caller wins: it came from another window's clipboard.
      const items = Array.isArray(request.items)
        ? (request.items as Array<Record<string, unknown>>)
        : deckClipboard.elements
      if (!session || !items || items.length === 0) return null
      const result = deckApply(path, [
        {
          op: 'pasteElements',
          target: { slide: index },
          items,
          dx: pxToEmu(request.dxPx, request.fitWidthPx, session),
          dy: pxToEmu(request.dyPx, request.fitWidthPx, session),
        },
      ])
      if (result.applied !== true) return null
      if (Number(request.fitWidthPx) > 0) session.fitWidthPx = Number(request.fitWidthPx)
      const created = ((result as { records?: unknown[] }).records?.[0] as { created?: unknown[] } | undefined)?.created
      const slide = renderSlideAt(session, index)
      return slide ? { slide, sourceIds: created ?? [] } : null
    }

    /** Copy inside one slide: the same `copyElementData` the clipboard uses, then one paste. */
    case 'duplicateElements': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      const ids = Array.isArray(request.sourceIds) ? (request.sourceIds as unknown[]) : []
      const slide = slidesOf(session)[index]
      if (!slide || ids.length === 0) return null
      const items = (elementsOf(session)[index] ?? [])
        .filter((element) => ids.includes(element.id ?? ''))
        .map((element) => loadEngine().copyElementData(session.opened, slide, element))
      if (items.length === 0) return null
      const result = deckApply(path, [
        {
          op: 'pasteElements',
          target: { slide: index },
          items,
          dx: pxToEmu(request.dxPx, request.fitWidthPx, session),
          dy: pxToEmu(request.dyPx, request.fitWidthPx, session),
        },
      ])
      if (result.applied !== true) return null
      if (Number(request.fitWidthPx) > 0) session.fitWidthPx = Number(request.fitWidthPx)
      const created = ((result as { records?: unknown[] }).records?.[0] as { created?: unknown[] } | undefined)?.created
      const rendered = renderSlideAt(session, index)
      return rendered ? { slide: rendered, sourceIds: created ?? [] } : null
    }

    case 'copySlides': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { slideIndexes?: unknown }
      const indexes = Array.isArray(request.slideIndexes) ? (request.slideIndexes as number[]) : []
      if (!session || indexes.length === 0) return false
      const slides = slidesOf(session)
      deckClipboard.slides = indexes
        .map((index) => slides[index])
        .filter((slide): slide is { path: string } => Boolean(slide))
        .map((slide) => loadEngine().collectSlideBundle(archiveOf(session), slide.path, archiveTextOf(session, slide.path)))
      // The editor renders a picture of each copied slide; "paste as picture" is that picture.
      const requestPngs = (rest[0] as { pngs?: unknown } | undefined)?.pngs
      deckClipboard.slidePngs = Array.isArray(requestPngs) ? (requestPngs as string[]) : []
      return deckClipboard.slides.length > 0
    }

    case 'pasteSlide': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as {
        afterIndex?: unknown
        mode?: unknown
        png?: unknown
        fitWidthPx?: unknown
        bundles?: unknown
      }
      if (!session) return null
      const after = Number(request.afterIndex)
      if (!Number.isFinite(after)) return null
      const fromCaller = Array.isArray(request.bundles) ? (request.bundles as Array<Record<string, unknown>>) : null
      const bundle = fromCaller?.[0] ?? deckClipboard.slides?.[0]
      const png = typeof request.png === 'string' ? request.png : ''
      if (!bundle && !png) return null
      const result = deckApply(path, [
        {
          op: 'pasteSlide',
          afterIndex: after,
          ...(png && request.mode === 'picture' ? { mode: 'picture', png } : { bundle }),
          ...(request.mode === 'source' ? { mode: 'source' } : {}),
        },
      ])
      if (result.applied !== true) return null
      if (Number(request.fitWidthPx) > 0) session.fitWidthPx = Number(request.fitWidthPx)
      markMetaDirty(path)
      return slideUpdate(session)
    }

    case 'hasSlideClipboard':
      return Boolean(deckClipboard.slides?.length || deckClipboard.elements?.length)

    // ---- charts: the data behind the shape ----------------------------------------------
    //
    // The chart dialog reads the numbers, the person edits them, `editChart` writes a patch. The
    // read is the engine's own projection of the chart element, so the dialog and the render tree
    // cannot disagree about what the chart holds.

    case 'getChartData': {
      const session = sessions.get(path)
      const index = Number(rest[0]) || 0
      const sourceId = typeof rest[1] === 'string' ? (rest[1] as string) : ''
      const slide = slidesOf(session)[index]
      if (!session || !slide || !sourceId) return null
      return loadEngine().getChartElementData(slide, sourceId)
    }

    /**
     * The chart "Change Colors" gallery: two colourful sets and one mono ramp per accent.
     *
     * Ported from GenOffice's own main because it is thirty lines of arithmetic over the **theme**
     * — the accents come from `theme1.xml` through the slide's layout→master chain. The labels are
     * ours (the app's are i18n keys this host does not have), the colours are the document's.
     */
    case 'getChartColorSchemes': {
      const session = sessions.get(path)
      if (!session) return null
      const accents = deckAccentColors(session)
      const rotated = [...accents.slice(3), ...accents.slice(0, 3)]
      const mono = (color: string) => [
        mixHex(color, 0, 0.25),
        color,
        mixHex(color, 255, 0.25),
        mixHex(color, 255, 0.45),
        mixHex(color, 255, 0.65),
      ]
      return [
        { key: 'default', label: 'Theme', colors: [] },
        { key: 'colorful', label: 'Colorful', colors: accents },
        { key: 'colorful2', label: 'Colorful (shifted)', colors: rotated },
        ...accents.map((color, at) => ({
          key: `mono-accent${at + 1}`,
          label: `Accent ${at + 1} shades`,
          colors: mono(color),
        })),
      ]
    }

    // ---- 3D models (`glb`) ---------------------------------------------------------------
    //
    // A model is a picture whose payload is the glb plus a poster frame; the viewer rotates it and
    // writes the new view back as a poster. The bytes are the document's own part, so the read is
    // an archive read — no engine projection needed.

    case 'addModel3d': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      const bytes = request.bytes
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null
      const size = (session.opened as { deck?: { size?: { cx?: number; cy?: number } } }).deck?.size
      const deckCx = size?.cx ?? 12192000
      const deckCy = size?.cy ?? 6858000
      const cy = Math.round(deckCy * 0.5)
      const cx = Math.round(cy * (Number(request.aspect) || 1))
      const poster = typeof request.posterBase64 === 'string' && request.posterBase64
        ? { bytes: Uint8Array.from(Buffer.from(request.posterBase64, 'base64')), ext: 'png' }
        : undefined
      const result = deckApply(path, [
        {
          op: 'addModel3d',
          target: { slide: index },
          bytes,
          ext: 'glb',
          ...(poster ? { poster } : {}),
          offset: { x: Math.round((deckCx - cx) / 2), y: Math.round((deckCy - cy) / 2), cx, cy },
          ...(typeof request.name === 'string' && request.name ? { name: request.name } : {}),
        },
      ])
      if (result.applied !== true) return null
      if (Number(request.fitWidthPx) > 0) session.fitWidthPx = Number(request.fitWidthPx)
      const created = ((result as { records?: unknown[] }).records?.[0] as { created?: unknown[] } | undefined)?.created?.[0]
      const slide = renderSlideAt(session, index)
      return slide ? { slide, sourceId: created ?? null } : null
    }

    /** The model's own bytes, so the viewer can rotate the real thing instead of a poster. */
    case 'getModel3dData': {
      const session = sessions.get(path)
      const index = Number(rest[0]) || 0
      const sourceId = typeof rest[1] === 'string' ? (rest[1] as string) : ''
      if (!session || !sourceId) return null
      const element = (elementsOf(session)[index] ?? []).find((candidate) => candidate.id === sourceId)
      const target = (element as { model3d?: { target?: string } } | undefined)?.model3d?.target
      if (!target) return null
      const archive = archiveOf(session) as { readBytes?: (path: string) => Uint8Array | null } | undefined
      const bytes = archive?.readBytes?.(target)
      return bytes ? new Uint8Array(bytes) : null
    }

    case 'setModel3dView': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const index = Number(request.slideIndex) || 0
      const rot = (request.rot ?? {}) as Record<string, unknown>
      return editSlide(path, index, [
        {
          op: 'setModel3dView',
          target: { slide: index, el: request.sourceId },
          ...rot,
          ...(typeof request.posterBase64 === 'string' && request.posterBase64
            ? { poster: request.posterBase64, posterExt: 'png' }
            : {}),
        },
      ])
    }

    // ---- dragging ------------------------------------------------------------------------
    //
    // A drag arrives as a stream of frames: the first says `preview: true`, the last one says
    // `preview: false` and is the committed position. Undo has to be **one step per gesture**, not
    // one per frame, so the snapshot is pushed on the first preview and the frames after it ride on
    // that snapshot. `cancelTransformPreview` (Escape mid-drag) puts the snapshot back.

    case 'editTransform': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      const payload = transformOpFor(session, index, request)
      if (!payload) return null
      const deckEngine = loadEngine()
      // Validate before the bookkeeping: a failed first frame must not arm the preview flag, or the
      // committed frame would skip its snapshot and the gesture would have no undo at all.
      if (deckEngine.runTxn(session.opened, { ops: [payload], dryRun: true }).failures?.length) return null
      let pushed = false
      const preview = request.preview === true
      if (preview) {
        if (!session.transformPreview) {
          session.previewRedo = [...session.redoStack]
          deckEngine.pushHistory(session)
          pushed = true
          session.transformPreview = true
        }
      } else if (session.transformPreview) {
        session.transformPreview = false
        session.previewRedo = undefined
      } else {
        deckEngine.pushHistory(session)
        pushed = true
      }
      const result = deckEngine.runTxn(session.opened, { ops: [payload] })
      if (result.applied !== true) {
        // Unwind everything this call did, including the flag: a stuck flag would cost the *next*
        // gesture its undo step.
        if (pushed) {
          session.undoStack.pop()
          if (preview) {
            session.transformPreview = false
            if (session.previewRedo) session.redoStack = session.previewRedo
            session.previewRedo = undefined
          }
        }
        const error = (result as { failures?: Array<{ error?: string }> }).failures?.[0]?.error
        if (error && !refusals.has(error)) {
          refusals.add(error)
          console.warn(`[office] deck refused an edit: ${error.split('\n')[0]}`)
        }
        return null
      }
      session.dirty = true
      return renderSlideAt(session, index)
    }

    /** Escape mid-drag: the snapshot is the pre-gesture state, so restoring it leaves no trace. */
    case 'cancelTransformPreview': {
      const session = sessions.get(path)
      if (!session || !session.transformPreview) return null
      session.transformPreview = false
      const snapshot = session.undoStack.pop()
      if (snapshot) loadEngine().restoreSnapshot(session, snapshot)
      if (session.previewRedo) session.redoStack = session.previewRedo
      session.previewRedo = undefined
      return renderSlideAt(session, Number((rest[0] as { slideIndex?: unknown } | undefined)?.slideIndex) || 0)
    }

    /** Several shapes dragged together: one transaction, one rebuilt page. */
    case 'editTransformMulti': {
      const request = (rest[0] ?? {}) as { slideIndex?: unknown; items?: unknown; fitWidthPx?: unknown }
      const session = sessions.get(path)
      if (!session) return null
      const index = Number(request.slideIndex) || 0
      const items = Array.isArray(request.items) ? (request.items as Array<Record<string, unknown>>) : []
      const ops = items
        .map((item) => transformOpFor(session, index, { ...request, ...item }))
        .filter((op): op is Record<string, unknown> => Boolean(op))
      if (ops.length === 0) return null
      const result = deckApply(path, ops)
      if (result.applied !== true) return null
      if (Number(request.fitWidthPx) > 0) session.fitWidthPx = Number(request.fitWidthPx)
      return renderSlideAt(session, index)
    }

    /** A picture from a URL: fetched here, then the same `addPicture` op as a dropped file. */
    case 'insertImageUrl': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const session = sessions.get(path)
      if (!session) return null
      const url = typeof request.url === 'string' ? request.url : ''
      if (!/^https?:/i.test(url)) return null
      const index = Number(request.slideIndex) || 0
      let bytes: Uint8Array
      let ext = 'png'
      try {
        const response = await fetch(url)
        if (!response.ok) return null
        bytes = new Uint8Array(await response.arrayBuffer())
        const type = response.headers.get('content-type') ?? ''
        const guessed = /image\/(png|jpeg|jpg|gif|webp|bmp|tiff)/.exec(type)?.[1]
        if (guessed) ext = guessed === 'jpeg' ? 'jpg' : guessed
      } catch {
        return null
      }
      const result = deckApply(path, [
        {
          op: 'addPicture',
          target: { slide: index },
          bytes,
          ext,
          offset: {
            x: pxToEmu(request.xPx, request.fitWidthPx, session),
            y: pxToEmu(request.yPx, request.fitWidthPx, session),
            cx: Math.max(1, pxToEmu(request.wPx, request.fitWidthPx, session)),
            cy: Math.max(1, pxToEmu(request.hPx, request.fitWidthPx, session)),
          },
          ...(typeof request.name === 'string' && request.name ? { name: request.name } : {}),
        },
      ])
      if (result.applied !== true) return null
      const created = ((result as { records?: unknown[] }).records?.[0] as { created?: unknown[] } | undefined)?.created?.[0]
      const slide = renderSlideAt(session, index)
      return slide ? { slide, sourceId: created ?? null } : null
    }

    /** Swapping a picture for one at a URL: the same fetch, then `replacePicture`. */
    case 'replacePictureUrl': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const url = typeof request.url === 'string' ? request.url : ''
      if (!/^https?:/i.test(url)) return null
      const index = Number(request.slideIndex) || 0
      let bytes: Uint8Array
      let ext = 'png'
      try {
        const response = await fetch(url)
        if (!response.ok) return null
        bytes = new Uint8Array(await response.arrayBuffer())
        const type = response.headers.get('content-type') ?? ''
        const guessed = /image\/(png|jpeg|jpg|gif|webp|bmp|tiff)/.exec(type)?.[1]
        if (guessed) ext = guessed === 'jpeg' ? 'jpg' : guessed
      } catch {
        return null
      }
      return editSlide(path, index, [
        {
          op: 'replacePicture',
          target: { slide: index, el: request.sourceId },
          bytes,
          ext,
        },
      ])
    }

    // ---- the last few the editor can actually do here ------------------------------------
    //
    // A shape's media bytes, a recorded narration, and the editor's own edit script. Everything
    // else in this host's pending list needs a second window, a master part, or the OS clipboard —
    // surfaces this app does not have.

    /** The audio/video bytes behind a media shape, so the editor plays the real thing. */
    case 'getMediaData': {
      const session = sessions.get(path)
      const index = Number(rest[0]) || 0
      const sourceId = typeof rest[1] === 'string' ? (rest[1] as string) : ''
      if (!session || !sourceId) return null
      const element = (elementsOf(session)[index] ?? []).find((candidate) => candidate.id === sourceId)
      const target = (element as { media?: { target?: string; external?: boolean } } | undefined)?.media?.target
      if (!target) return null
      const archive = archiveOf(session) as { readBytes?: (path: string) => Uint8Array | null } | undefined
      const bytes = archive?.readBytes?.(target)
      return bytes ? new Uint8Array(bytes) : null
    }

    /**
     * A recorded narration: one `addNarration` per slide, plus the rehearsed advance time.
     *
     * The audio arrives as base64 (the editor recorded it with `getUserMedia`), so nothing has to be
     * written to disk first — the op embeds the bytes in the package.
     */
    case 'saveRecording': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as { slides?: unknown; fitWidthPx?: unknown }
      const recorded = Array.isArray(request.slides) ? (request.slides as Array<Record<string, unknown>>) : []
      if (!session || recorded.length === 0) return null
      const slides = slidesOf(session)
      const ops: Array<Record<string, unknown>> = []
      for (const entry of recorded) {
        const index = Number(entry.slideIndex) || 0
        if (!slides[index]) continue
        const base64 = typeof entry.wavBase64 === 'string' ? entry.wavBase64 : ''
        if (base64) {
          ops.push({
            op: 'addNarration',
            target: { slide: index },
            bytes: Uint8Array.from(Buffer.from(base64, 'base64')),
            ext: 'wav',
            durationMs: Math.max(0, Math.round(Number(entry.durationMs) || 0)),
          })
        }
        const advance = Number(entry.advanceMs)
        if (Number.isFinite(advance) && advance > 0) {
          ops.push({ op: 'setAdvanceTime', target: { slide: index }, ms: Math.round(advance) })
        }
      }
      if (ops.length === 0) return null
      const result = deckApply(path, ops)
      if (result.applied !== true) return null
      if (Number(request.fitWidthPx) > 0) session.fitWidthPx = Number(request.fitWidthPx)
      return slideUpdate(session)
    }

    /**
     * The editor's edit script — a compact list of changes it builds for AI/programmatic edits.
     *
     * Mapped to ops by the engine's own `mapScriptOps`, which is the same mapper GenOffice's main
     * calls: a second translation here would be a second dialect of the same script.
     */
    case 'applyEditScript': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as Record<string, unknown>
      if (!session) return null
      const ops = loadEngine().mapScriptOps(session.opened, request)
      if (ops.length === 0) return null
      const result = deckApply(path, ops)
      if (result.applied !== true) {
        const error = (result as { failures?: Array<{ error?: string }> }).failures?.[0]?.error
        return { error: error ?? 'the transaction could not be applied' }
      }
      const index = Number(request.slideIndex) || 0
      return renderSlideAt(session, index)
    }

    // ---- slide background, and Save As ---------------------------------------------------
    //
    // A background image is chosen by a **person**, not by this process: the frame picks the file
    // and hands the bytes here (`pick: false` with `source`), so the same op path serves both a
    // hosted editor and an export window. Colour and gradient need nobody.

    case 'editBackground': {
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const session = sessions.get(path)
      if (!session) return null
      const slideIndex = Number(request.slideIndex)
      const slides = slidesOf(session)
      const targets = slideIndex === -1 ? slides.map((_slide, at) => at) : [slideIndex]
      if (targets.length === 0 || targets.some((index) => !slides[index])) return null
      const kind = String(request.kind ?? 'solid')
      const base: Record<string, unknown> =
        kind === 'solid'
          ? { kind: 'solid', color: request.color }
          : kind === 'gradient'
            ? {
                kind: 'gradient',
                from: request.from,
                to: request.to,
                ...(request.angleDeg != null ? { angle: Math.round(Number(request.angleDeg) * 60_000) } : {}),
              }
            : {
                kind: 'image',
                source: (request.source as Record<string, unknown> | undefined) ?? undefined,
                tile: request.mode === 'tile',
              }
      if (kind === 'image' && !base.source) return null
      let landed: string | null = null
      let applied = 0
      for (const index of targets) {
        // The picked bytes land as one media part; the rest are a relationship to it.
        const op = {
          op: 'setBackground',
          target: { slide: index },
          ...base,
          ...(kind === 'image' && landed ? { source: { mediaPath: landed } } : {}),
        }
        const result = deckApply(path, [op])
        if (result.applied !== true) continue
        applied += 1
        const used = ((result as { records?: unknown[] }).records?.[0] as { after?: { mediaPath?: string } } | undefined)
          ?.after?.mediaPath
        if (used) landed = used
      }
      if (applied === 0) return null
      return renderSlideAt(session, targets[0] === -1 ? 0 : targets[0])
    }

    /**
     * Save a copy under another name.
     *
     * The deck's own `save` writes to its path; this writes the same model to a **different** file
     * and leaves the open document where it was — what "Save As" means, and what the client's own
     * dialog supplies the path for.
     */
    case 'saveAs': {
      const request = (rest[0] ?? {}) as { path?: unknown }
      const session = sessions.get(path)
      const target = typeof request.path === 'string' ? request.path : ''
      if (!session || !target) return null
      await loadEngine().savePptxToFile(session.opened, target)
      // The open document stays where it was: this is a copy, not a move.
      return { ok: true, path: target }
    }

    // ---- master view: editing a layout or a master part --------------------------------
    //
    // A layout/master is a slide-shaped part that slides inherit from. Its edits are the same ops,
    // addressed to `{ part: <path> }` instead of `{ slide: <index> }` — the op layer flushes the
    // given part object back into the package, so nothing here has to know how a part is written.
    //
    // Every commit re-parses the slides: inheritance has to take effect immediately, or the page
    // keeps drawing the old master while the editor shows the new one.

    case 'masterEnter': {
      const session = sessions.get(path)
      if (!session) return null
      if (Number(rest[0]) > 0) session.fitWidthPx = Number(rest[0])
      const deckEngine = loadEngine()
      const archive = archiveOf(session)
      const size = (session.opened as { deck?: { size?: unknown } }).deck?.size
      const media = deckEngine.makeMediaResolver(session.opened)
      const items: Array<Record<string, unknown>> = []
      for (const part of deckEngine.listMasterParts(archive)) {
        const slide = deckEngine.parseMasterPart(archive, part.partPath)
        if (!slide) continue
        const rendered = deckEngine.buildRenderSlide(slide, size, {
          fitWidthPx: session.fitWidthPx,
          media,
        })
        items.push({ partPath: part.partPath, kind: part.kind, name: part.name, slide: rendered })
        if (!session.masterEdit) session.masterEdit = { partPath: part.partPath, slide }
      }
      return items.length > 0 ? { items } : null
    }

    case 'masterOpen': {
      const session = sessions.get(path)
      const partPath = typeof rest[0] === 'string' ? (rest[0] as string) : ''
      if (!session || !partPath) return null
      const deckEngine = loadEngine()
      const slide = deckEngine.parseMasterPart(archiveOf(session), partPath)
      if (!slide) return null
      session.masterEdit = { partPath, slide }
      return masterRender(session)
    }

    case 'masterClose': {
      const session = sessions.get(path)
      if (!session) return null
      // Edits were materialized one by one while the view was open; leaving only fetches the tree.
      session.masterEdit = undefined
      return loadEngine().buildAllRenderSlides(session.opened, session.fitWidthPx)
    }

    case 'masterEditText':
    case 'masterEditTransform':
    case 'masterEditFill':
    case 'masterEditStroke':
    case 'masterAddElement':
    case 'masterDeleteElement': {
      const session = sessions.get(path)
      const request = (rest[0] ?? {}) as Record<string, unknown>
      const master = session?.masterEdit
      if (!session || !master) return null
      const op = masterOpFor(method, master.partPath, request, session)
      if (!op) return null
      const result = masterApply(session, master, op)
      if (result !== true) return null
      return masterRender(session)
    }

    /**
     * Each shape's reusable key: id, spid, name.
     *
     * The editor pairs shapes **across slides** by this (a Morph transition needs to know which
     * shape on slide 2 is which on slide 1). `sourceId` is re-derived on every parse, so the name
     * and spid are the parts that survive a round trip.
     */
    case 'getShapeKeys': {
      const session = sessions.get(path)
      const index = Number(rest[0]) || 0
      if (!session) return []
      const deckEngine = loadEngine()
      return (elementsOf(session)[index] ?? []).map((element) => ({
        sourceId: (element as { id?: string }).id ?? '',
        spid: deckEngine.elementSpid(element),
        name: typeof (element as { name?: unknown }).name === 'string' ? (element as { name: string }).name : '',
      }))
    }

    /**
     * The deck's own layouts, plus the built-in standard set when it has none.
     *
     * This is the "add a slide with this layout" menu: a deck generated by a tool often carries a
     * single blank layout, and an empty menu there reads as a broken editor.
     */
    case 'getLayouts': {
      const session = sessions.get(path)
      if (!session) return null
      const deckEngine = loadEngine()
      const layouts = deckEngine.listSlideLayouts(archiveOf(session))
      if (deckEngine.shouldOfferBuiltinLayouts(layouts)) {
        const size = (session.opened as { deck?: { size?: { cx?: number; cy?: number } } }).deck?.size
        layouts.push(
          ...deckEngine.builtinLayoutInfos(
            { cx: size?.cx ?? 12192000, cy: size?.cy ?? 6858000 },
            new Set(layouts.map((layout) => layout.name)),
          ),
        )
      }
      const size = (session.opened as { deck?: { size?: { cx?: number; cy?: number } } }).deck?.size
      return { layouts, size: { cx: size?.cx ?? 12192000, cy: size?.cy ?? 6858000 } }
    }

    /**
     * Switched off **with a reason**, and answered as `null` rather than by throwing later.
     *
     * `fontCatalog` is GenOffice's downloadable font store (a CDN this host does not run), and
     * `recent` is a desktop file history — neither is a document fact we could answer honestly.
     */
    case 'fontCatalog':
    case 'recent':
      return null

    default:
      noteUnwired('deck', method)
      return undefined
  }
}

const unwired = new Set<string>()

/**
 * Say "this host does not answer that" once per method per process.
 *
 * `undefined` is what an editor reads as *feature off*, which is the right answer — but silence is
 * how a whole feature goes missing without a trace. One line in the app's log turns "what does the
 * editor ask that we dropped?" into a question the log answers, instead of a bug someone discovers
 * by clicking.
 */
export function noteUnwired(app: string, method: string): void {
  const key = `${app}:${method}`
  if (unwired.has(key)) return
  unwired.add(key)
  console.warn(`[office] ${app} asked for ${method}, which this host does not answer`)
}
