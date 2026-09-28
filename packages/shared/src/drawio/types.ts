/**
 * The contract between the app and the document that renders a drawio diagram.
 *
 * Two facts shape it:
 *
 * - **The frame is the untrusted side.** It is served from the app's own origin but
 *   runs drawio's code, so everything it sends back is bounded and validated, while
 *   the one message it receives is the app's own. That asymmetry is the whole shape
 *   of this file: one outbound message carrying the document, and two tiny inbound
 *   verdicts.
 * - **This module has no imports, on purpose.** The renderer may take *values* from a
 *   `<family>/types` module and from nothing else in this package
 *   (see docs/renderer-imports.md), and both ends of the bridge need the same
 *   protocol string — a second copy would drift, which is the failure the rule
 *   exists to prevent. The functions below are here for the same reason; they have
 *   no dependencies to pull in.
 *
 * Two layers live here, and they are not symmetrical. The **outer** one is this app's:
 * an envelope with a `protocol` string, a bounded parser, one outbound document and two
 * tiny inbound verdicts. The **inner** one is drawio's own `{ event, action }` JSON,
 * spoken by the editor's embed mode — unwrapped, unversioned by us, and impossible to
 * add a protocol string to because drawio is not a participant in ours. Each frame that
 * embeds the origin picks the layer its document speaks.
 *
 * The inner layer is **stringified in both directions** (`proto=json` means the editor
 * `JSON.parse`s whatever it is told, and stringifies whatever it says), while the outer one is
 * plain objects. That difference has cost a blank editor once — see `buildDrawioLoadMessage`.
 */

/**
 * Bump on any incompatible change. A message carrying another value is dropped
 * rather than migrated: both ends ship together, so a mismatch means a bug.
 */
export const DRAWIO_BRIDGE_PROTOCOL = 'craft-drawio/v1'

/**
 * Where the app's own shell document is served, on the drawio origin.
 *
 * A reserved path rather than a file under the vendored directory, because that
 * directory is fetched and pruned (scripts/fetch-drawio-assets.ts) and would take
 * our page with it on a refetch.
 */
export const DRAWIO_VIEWER_PATH = '/__craft/viewer.html'

/** app → frame: draw this document and hand back its SVG. */
export interface DrawioRenderMessage {
  protocol: typeof DRAWIO_BRIDGE_PROTOCOL
  type: 'render'
  xml: string
  dark: boolean
  /**
   * Which page to draw, by drawio's own page id.
   *
   * Omitted means the document's **first page** — the viewer's own default, measured: it draws one
   * page of a multi-page file and never stacks them. A page is addressed by id rather than by name
   * because the viewer's `page` attribute is a 0-based index that it clamps silently, while
   * `pageId` is exact; resolving a name into an id is `findDrawioPage`'s job, where a miss can be
   * reported instead of drawn.
   */
  pageId?: string
}

/** frame → app: the viewer script is loaded and a document may be sent. */
export interface DrawioReadyMessage {
  protocol: typeof DRAWIO_BRIDGE_PROTOCOL
  type: 'ready'
}

/**
 * frame → app: the document was drawn, or refused with a reason.
 *
 * `svg` is the drawn diagram itself, and it is what the app shows: the frame is an engine
 * that turns a document into an SVG, not something to put on screen. Displaying the frame is
 * what made every scrollbar, every size and every cursor a thing to be argued with across the
 * frame boundary — the diagram is an SVG, and an SVG is something this app can simply render.
 */
export interface DrawioRenderedMessage {
  protocol: typeof DRAWIO_BRIDGE_PROTOCOL
  type: 'rendered'
  ok: boolean
  svg?: string
  error?: string
}

export type DrawioIncomingMessage = DrawioReadyMessage | DrawioRenderedMessage

/**
 * The largest inbound message accepted when it carries no diagram.
 *
 * A frame that is only saying "ready" or naming a failure has no business sending much, and
 * dropping a message that approaches this is cheaper than reasoning about it.
 */
export const DRAWIO_MAX_INBOUND_CHARS = 8 * 1024

/**
 * The largest drawn diagram accepted, in characters of JSON.
 *
 * A message carrying an SVG is a different kind of message: it is the diagram, on its way to
 * the screen, and a real one is easily a hundred kilobytes of markup. Bounded at the same
 * figure as a document going the other way, because the two are the same diagram.
 */
export const DRAWIO_MAX_DIAGRAM_CHARS = 8 * 1024 * 1024

/**
 * The size the viewer drew at, as the markup it hands back states it.
 *
 * The root element carries `width: 100%` — a fact about the *box* it is in, not about the drawing —
 * and beside it `min-width`/`min-height`, which are the drawing's own bounds plus its margin
 * (measured against the vendored bundle, not assumed). Those two are the drawing's size, and they
 * are the only place it is stated: there is no `viewBox` to read, and the element's own box in a
 * page is whatever the CSS default for a replaced element makes it.
 *
 * This is the *viewer's* output format, which is why the parsing lives next to the rest of that
 * protocol: both surfaces that show the markup — the window and the picture in a conversation —
 * read the size the same way, and neither guesses.
 */
export function parseDrawioSvgSize(svg: string): { width: number; height: number } | null {
  const width = svg.match(/min-width:\s*(\d+(?:\.\d+)?)px/)
  const height = svg.match(/min-height:\s*(\d+(?:\.\d+)?)px/)
  if (!width?.[1] || !height?.[1]) return null

  const size = { width: parseFloat(width[1]), height: parseFloat(height[1]) }
  return size.width > 0 && size.height > 0 ? size : null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── The pages of a document ──────────────────────────────────────────────────

/** One page of a `.drawio` file: how a person named it, the id drawio addresses it by, and whether its
 *  content is the compressed spelling — see `isCompressedBody`. */
export interface DrawioPage {
  id: string
  /** What the page is called, or an empty string when it has no name. */
  name: string
  /**
   * Whether the page's body is deflate+base64 rather than a plain model.
   *
   * Worth knowing *before* reading the file: a compressed body is not XML anyone can edit, so a caller
   * that means to change the shapes has to have the file written out plain first (`export --format drawio`).
   */
  compressed: boolean
}

/**
 * `<diagram …>` **opening** tags, and where a page's own element ends — the two pieces of text every
 * reader of a document's pages is built from (`drawioPages`, `drawioPageBodies`, `projectDrawioPage`).
 *
 * What follows a page's attributes is never *parsed* here: a page's name and id are on the tag, while
 * its content may be compressed — that is drawio's *Compressed* save option, and the default of older
 * versions (the build this app ships writes plain models) — so only a reader with drawio's
 * decompressor could look inside. Nothing in this module does; `drawio/picture.ts` is where one does.
 */
const DRAWIO_PAGE_TAGS = /<diagram\b[^>]*>/gi
const DRAWIO_PAGE_CLOSE = '</diagram>'

/** The entities drawio writes into an attribute value. */
const ATTRIBUTE_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/**
 * An attribute of a tag, as it is written in the text.
 *
 * Exported because reading a tag's attributes is what both halves of the reading do — the pages
 * here (`drawioPageBodies`) and the cells of a model (`drawio/picture.ts`) — and a second regex for
 * it would be a second answer to "what is this attribute", which is how a reader ends up disagreeing
 * with itself.
 */
export function attributeOf(tag: string, name: string): string | null {
  // Anchored on whitespace or the tag's own `<`, so an attribute that merely *ends* in the name
  // (`data-id`, `data-name`) is not the attribute being read.
  const match = new RegExp(`(?:^|[\\s<])${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)
  return match?.[1] ?? null
}

/** An attribute value as a string: the entities drawio writes into one, decoded. */
export function decodeAttribute(value: string): string {
  return value.replace(/&(#?\w+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16)) || whole
    }
    if (entity.startsWith('#')) {
      return String.fromCodePoint(parseInt(entity.slice(1), 10)) || whole
    }
    return ATTRIBUTE_ENTITIES[entity] ?? whole
  })
}

/**
 * The document inside a file's text — which is not always the text itself.
 *
 * An SVG exported with "include a copy of my diagram" is a drawing **and** the document it was drawn
 * from: drawio calls it an *editable* SVG, and the copy sits in a `content` attribute, entity-escaped
 * because that is what an attribute value is. Such a file is a drawio document as far as everything
 * that draws one is concerned — the editor unwraps it on load, the viewer on draw — so everything that
 * *reads* one has to see through the wrapper too. Otherwise a file could be drawn and not listed.
 *
 * **Exported because the read is where this belongs.** A command handed a file reads it through this
 * first, so `export` and `render` are given a document whether the file on disk is an `<mxfile>` or
 * an exported SVG — which is what makes an exported SVG a file you can get back from (`--format drawio`
 * writes that document out) rather than one only drawio can use. Keeping the unwrap to the *drawing*
 * side instead would leave "can this be read back" resting on drawio's own load path.
 *
 * Only a root `<svg>` is unwrapped, and only when it carries a copy: a drawing exported without one
 * is a picture and no document, and an mxfile that happens to contain an SVG somewhere is an mxfile.
 */
export function drawioDocument(fileText: string): string {
  const root = /^\s*(?:<\?xml[^>]*\?>\s*)?(<svg\b[^>]*>)/i.exec(fileText)
  const content = root ? attributeOf(root[1]!, 'content') : null
  return content ? decodeSvgCopy(content) : fileText
}

/**
 * What an editable SVG's `content` attribute holds, in whichever spelling drawio wrote it.
 *
 * drawio's own reader takes three — the document itself, a URL-encoded one, or base64 — and taking
 * only the first would put us back where we started: a file the drawing commands open and the listing
 * cannot read. Anything that is none of the three is handed back as it is, and a listing that finds
 * no pages says exactly that.
 */
function decodeSvgCopy(content: string): string {
  const copy = decodeAttribute(content)
  if (copy.startsWith('<')) return copy
  try {
    if (copy.startsWith('%')) return decodeURIComponent(copy)
    return new TextDecoder().decode(Uint8Array.from(atob(copy), (char) => char.charCodeAt(0)))
  } catch {
    return copy
  }
}

/**
 * Whether a page's body is the compressed spelling.
 *
 * One character answers it: a plain body opens with `<` (the `<mxGraphModel>`, or the next element when
 * the page closes itself), and base64 has no `<` in its alphabet — so this is decided on the very thing
 * the reader above refuses to parse. Whitespace is skipped because a hand-written file may indent.
 */
function isCompressedBody(document: string, at: number): boolean {
  const body = document.slice(at, at + 64).trimStart()
  return body.length > 0 && !body.startsWith('<')
}

/**
 * The pages of a document, in the order it states them.
 *
 * Read from the opening tags **only**: a page's name and id are attributes on `<diagram>`, while
 * what sits between them may be compressed (the *Compressed* save option; the build this app ships
 * writes plain models) — so a reader that looked inside would need drawio's decompressor before it
 * could say anything, and one that lists names never has to. What it does say about the body is the one
 * bit that is legible from the tag itself: whether it is compressed (`isCompressedBody`).
 *
 * A page with no name is listed with an empty one: it is a page, and it is simply not addressable
 * by name. Nothing here is validated — this is a listing, not a judgement. The text may be an editable
 * SVG rather than the document itself; see `drawioDocument`.
 */
export function drawioPages(fileXml: string): DrawioPage[] {
  return drawioPageBodies(fileXml).map(({ page }) => page)
}

/**
 * The same pages, each with the text of its body — still in whichever spelling the document stored it
 * in (`DrawioPage.compressed` says which, and nothing here opens it).
 *
 * `drawioPages` is a listing and stops at the tags on purpose. This is the other half, for a reader
 * that *does* have drawio's decompressor to hand and needs to compare what a page holds:
 * `drawio/picture.ts` is the one caller, and it is a module of its own because that reader needs
 * `zlib` — which this file may not reach for, being served to the renderer as well
 * (docs/renderer-imports.md).
 */
export function drawioPageBodies(fileXml: string): Array<{ page: DrawioPage; body: string }> {
  const document = drawioDocument(fileXml)
  DRAWIO_PAGE_TAGS.lastIndex = 0
  const found: Array<{ page: DrawioPage; body: string }> = []
  let tag: RegExpExecArray | null
  while ((tag = DRAWIO_PAGE_TAGS.exec(document)) !== null) {
    const opening = tag[0]
    const from = tag.index + opening.length

    // A page with nothing in it closes itself; one with content runs to its own closing tag, which
    // is the first after it — pages are not nested.
    const selfClosing = opening.endsWith('/>')
    const close = selfClosing ? from : document.indexOf(DRAWIO_PAGE_CLOSE, from)

    found.push({
      page: {
        id: attributeOf(opening, 'id') ?? '',
        name: decodeAttribute(attributeOf(opening, 'name') ?? ''),
        compressed: isCompressedBody(document, from),
      },
      body: selfClosing || close === -1 ? '' : document.slice(from, close),
    })
  }
  return found
}

/** The answer to "which page is `name`" — or why it is not a question that has one. */
export type DrawioPageLookup =
  | { ok: true; page: DrawioPage; /** 1-based, for the sentence a person reads. */ index: number; total: number }
  | { ok: false; reason: 'unknown' | 'ambiguous'; total: number; /** Every name the file does have. */ names: string[] }

/**
 * The page a name refers to.
 *
 * Exact and case-sensitive, and never a guess. A name no page has is `unknown` — the caller can say
 * which names the file does have, which is the sentence that lets a person fix a typo. A name two
 * pages share is `ambiguous` rather than the first of them, because "which one did you mean" is not
 * a question this can answer by picking.
 */
export function findDrawioPage(fileXml: string, name: string): DrawioPageLookup {
  const pages = drawioPages(fileXml)
  const wanted = name.trim()
  const found = pages
    .map((page, index) => ({ page, index }))
    .filter(({ page }) => page.name === wanted)

  if (found.length === 1) {
    return { ok: true, page: found[0]!.page, index: found[0]!.index + 1, total: pages.length }
  }

  return {
    ok: false,
    reason: found.length === 0 ? 'unknown' : 'ambiguous',
    total: pages.length,
    names: pages.map((page) => page.name).filter((value) => value.length > 0),
  }
}

/**
 * Why the page a name asked for is not there — the sentence both surfaces say.
 *
 * Composed here rather than by the lookup, because a lookup answers a question about the document
 * and this is what a reader is told; composed *once* rather than by each surface, because the
 * picture in a conversation and the word an agent gets back are describing the same document and
 * cannot be allowed to describe it differently. The names are what makes a typo fixable, which is
 * why the failure carries them.
 */
export function describeDrawioPageProblem(
  name: string,
  lookup: Extract<DrawioPageLookup, { ok: false }>,
): string {
  if (lookup.reason === 'ambiguous') return `Two pages are called "${name}" — rename one of them.`
  if (lookup.names.length === 0) {
    return `This file has no page called "${name}", and none of its pages are named.`
  }
  return `This file has no page called "${name}". Its pages are: ${lookup.names.join(', ')}.`
}

/**
 * The document reduced to one page — the form a drawing engine that cannot be told which page to
 * draw can be handed.
 *
 * The editor's export answers `pageId` for a PNG and for nothing else: an SVG, an editable SVG and
 * an HTML page are all drawn from whatever page is *current*, which after a load is the first one.
 * Cutting the page out first makes "draw this page" a fact about the document instead of a flag one
 * exporter honours and the next ignores — and the `<diagram>` element travels verbatim, so a page
 * drawio saved compressed stays compressed and loses nothing.
 *
 * The page is found the way it was listed, by the id on its opening tag, and the element runs to the
 * first `</diagram>` after it: a reader that paired elements up by position instead would silently
 * cut out the wrong page if any earlier page were unclosed.
 *
 * `null` when the document has no such element — the caller has a sentence for that, and a document
 * with a page missing from it would draw the wrong diagram rather than draw nothing.
 *
 * Handed an editable SVG it cuts the page out of the *copy*, and hands back a document rather than a
 * drawing: what takes it from here is the engine, which draws a document.
 */
export function projectDrawioPage(fileXml: string, pageId: string): string | null {
  const document = drawioDocument(fileXml)
  const mxfile = /<mxfile\b[^>]*>/.exec(document)?.[0]
  if (!mxfile) return null

  DRAWIO_PAGE_TAGS.lastIndex = 0
  let tag: RegExpExecArray | null
  while ((tag = DRAWIO_PAGE_TAGS.exec(document)) !== null) {
    if (attributeOf(tag[0], 'id') !== pageId) continue

    // A page with nothing in it closes itself; one with content runs to its own closing tag, which
    // is the first after it.
    if (tag[0].endsWith('/>')) return `${mxfile}\n${tag[0]}\n</mxfile>`

    const close = document.indexOf(DRAWIO_PAGE_CLOSE, tag.index + tag[0].length)
    if (close === -1) return null
    return `${mxfile}\n${document.slice(tag.index, close + DRAWIO_PAGE_CLOSE.length)}\n</mxfile>`
  }
  return null
}

export function buildDrawioRenderMessage(
  xml: string,
  dark: boolean,
  pageId?: string,
): DrawioRenderMessage {
  return {
    protocol: DRAWIO_BRIDGE_PROTOCOL,
    type: 'render',
    xml,
    dark,
    ...(pageId ? { pageId } : {}),
  }
}

/**
 * Parse an untrusted `MessageEvent.data` from the frame.
 *
 * Returns null for anything foreign, oversized or malformed — the caller drops such
 * events silently, because a frame can post arbitrary junk and none of it is news.
 */
export function parseDrawioIncoming(data: unknown): DrawioIncomingMessage | null {
  if (!isPlainObject(data) || data.protocol !== DRAWIO_BRIDGE_PROTOCOL) return null

  // The limit follows the claim: a message that says it carries a diagram is measured as one.
  const limit =
    typeof data.svg === 'string' ? DRAWIO_MAX_DIAGRAM_CHARS : DRAWIO_MAX_INBOUND_CHARS

  try {
    if (JSON.stringify(data).length > limit) return null
  } catch {
    return null // cyclic or unserialisable — never a message we sent a shape for
  }

  if (data.type === 'ready') return { protocol: DRAWIO_BRIDGE_PROTOCOL, type: 'ready' }

  if (data.type === 'rendered') {
    if (typeof data.ok !== 'boolean') return null
    const error = typeof data.error === 'string' ? data.error.slice(0, 500) : undefined
    // Only a drawn diagram carries one, and only an SVG: this markup goes into the app's own
    // document, so what the frame may hand over is narrowed here rather than at the call site.
    const svg =
      typeof data.svg === 'string' && data.svg.trimStart().startsWith('<svg') ? data.svg : undefined
    return {
      protocol: DRAWIO_BRIDGE_PROTOCOL,
      type: 'rendered',
      ok: data.ok,
      ...(svg !== undefined ? { svg } : {}),
      ...(error !== undefined ? { error } : {}),
    }
  }

  return null
}

// ============================================================================
// The inner layer: the editor, in drawio's own protocol
// ============================================================================

/**
 * The query the editable editor is embedded with, on the app's own origin.
 *
 * This is drawio's **embed mode** — the same application a person opens at
 * embed.diagrams.net, pointed at `embed=1&proto=json` so that it talks over
 * `postMessage` instead of drawing a window chrome of its own.
 *
 * `libraries=0` is load-bearing rather than a preference: the bundle this app serves
 * drops drawio's 41 MB raw `stencils/` directory and relies on the pre-built
 * `js/stencils.min.js`, and it is `libraries=1` that would ask for the directory.
 *
 * `offline=1` is drawio's own switch for not calling its hosted services, and it is what
 * drawio's desktop build passes in the same situation. It is *asked for, not enforced* —
 * this document is drawio's own application, so the policy that pins the app's viewer
 * shell to this origin does not reach it. Asking is the only lever available short of
 * rewriting a vendored document, and it is the lever drawio itself pulls.
 */
export const DRAWIO_EMBED_PARAMS =
  'embed=1&proto=json&spin=0&libraries=0&noSaveBtn=1&noExitBtn=1&saveAndExit=0&offline=1'

/**
 * The language to hand drawio, out of the app's own code for the language.
 *
 * drawio names a language by a bare, lowercase subtag (`zh`, `zh-tw`, `pt-br`) where this app names
 * it the way the platform does (`zh-Hans`). The primary subtag is the whole translation: everything
 * the app ships is either a bare code already or the simplified Chinese that drawio calls `zh`. A
 * code the vendored bundle has no dictionary for falls back to English on its own — drawio does that
 * itself — so this can hand over something it does not know without breaking anything.
 */
export function drawioLanguage(appLanguage: string | undefined): string {
  return appLanguage?.split('-')[0]?.toLowerCase() || 'en'
}

/**
 * The editor, embedded and told which language to speak — `&lang=` is read from the address, the
 * same way drawio's own hosted embed reads it.
 */
export function drawioEditorUrl(origin: string, dark = false, appLanguage?: string): string {
  return `${origin}/?${DRAWIO_EMBED_PARAMS}${dark ? '&dark=1' : ''}&lang=${encodeURIComponent(drawioLanguage(appLanguage))}`
}

/**
 * The viewer's engine page, told the same thing.
 *
 * In the address rather than in a message, because the viewer reads it **once, as it loads**
 * (`urlParams.lang`, before anything of ours could speak to it): a language sent afterwards would
 * arrive after the chrome had already been spelled out, and the bundle's own "follow the browser"
 * path is restricted to drawio's own hostnames, which this origin is not.
 */
export function drawioViewerUrl(origin: string, appLanguage?: string): string {
  return `${origin}${DRAWIO_VIEWER_PATH}?lang=${encodeURIComponent(drawioLanguage(appLanguage))}`
}

/**
 * What drawio says back — no `protocol` field, because drawio cannot be asked to carry
 * one. The property that shapes every caller is that **there is no request id**: a reply
 * cannot be matched to a request, so the frame embedding this has to know what it is
 * waiting for and hold that in its own state. The `init` handshake is the only ordering
 * it gets, and nothing else can be correlated.
 *
 * - `init` — the application has loaded; a document may now be sent.
 * - `autosave` / `save` — the person changed something. The **whole** document, not a
 *   diff, so a caller never has to apply anything.
 */
export type DrawioEmbedEvent =
  | { event: 'init' }
  | { event: 'autosave'; xml: string }
  | { event: 'save'; xml: string }

/**
 * How large a document drawio may hand back.
 *
 * Not a protocol limit — a real diagram is tens of kilobytes. It is the point at which a
 * reply stops being believable: the editor can only return the document it was given, so
 * a frame returning something enormous is not doing that.
 */
export const DRAWIO_MAX_DOCUMENT_CHARS = 8 * 1024 * 1024

/**
 * app → editor: load this document, and report every change to it.
 *
 * **A JSON string, not an object.** `proto=json` makes the editor run `JSON.parse` over
 * everything it is told, and a structured-cloned object *throws* in it — the editor then drops
 * the message as unparsable and stays empty, which is a blank canvas and nothing in any log.
 * drawio's own side is stringified the same way, which is why the parser below takes a string.
 */
export function buildDrawioLoadMessage(xml: string): string {
  return JSON.stringify({ action: 'load', xml, autosave: 1 })
}

/**
 * Parse an untrusted `MessageEvent.data` in drawio's own shape. Null for the rest.
 *
 * A **string**, because that is the whole of what drawio says: `{event: 'init'}` arrives as
 * `'{"event":"init"}'`. Reading objects here instead is the trap `buildDrawioLoadMessage`
 * describes from the other end, and it fails the same silent way.
 */
export function parseDrawioEmbedEvent(data: unknown): DrawioEmbedEvent | null {
  if (typeof data !== 'string' || data.length > DRAWIO_MAX_DOCUMENT_CHARS) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!isPlainObject(parsed) || typeof parsed.event !== 'string') return null

  if (parsed.event === 'init') return { event: 'init' }

  if (parsed.event === 'autosave' || parsed.event === 'save') {
    if (typeof parsed.xml !== 'string') return null
    if (parsed.xml.length === 0 || parsed.xml.length > DRAWIO_MAX_DOCUMENT_CHARS) return null
    return { event: parsed.event, xml: parsed.xml }
  }

  return null
}
