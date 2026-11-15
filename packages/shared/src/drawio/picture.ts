/**
 * A picture, and the document it was drawn from — whether it still shows it.
 *
 * A `.drawio` file is not a picture until drawio's own renderer has drawn it, so a brief's diagram is
 * an *exported* SVG with the file it came from still sitting beside it. That pair is what nothing else
 * can check by looking: the picture is a snapshot, and editing the source leaves the brief showing
 * yesterday's drawing until somebody exports again.
 *
 * **It is read by content, not by time.** An exported *editable* SVG carries its own copy of the
 * document it was drawn from (`drawioDocument`), so "is this picture of the file beside it?" is two
 * documents compared — no name convention to trust, and no timestamp that a copy, a checkout or a
 * re-export without a change would lie about.
 *
 * **Only a difference that is certain is reported**, and this is what that costs:
 *
 * - Every page the picture holds must be a page of the source, unchanged. A picture holding *fewer*
 *   pages is not reported: an export made with `--page` is exactly that, on purpose, and from here the
 *   two are the same thing. (So one real change is invisible — a page *added* to the source after the
 *   export.)
 * - A redraw is not a copy, so what is compared is what a person drew — which cell, saying what,
 *   styled how, where — read by attribute *name*. Whitespace, attribute order, and every attribute
 *   drawio writes for itself are therefore invisible here rather than reported.
 * - A compressed body is opened with drawio's own recipe, which is why this module reaches for `zlib`
 *   and why it is not part of `types.ts`.
 */

import { inflateRawSync, inflateSync } from 'zlib'
import { attributeOf, decodeAttribute, drawioPageBodies, type DrawioPage } from './types.ts'

/** What a picture and the document beside it say about each other. */
export type PictureStanding =
  /** Every page the picture holds is the source's, unchanged. */
  | 'current'
  /** The picture was drawn from an earlier state of that document. */
  | 'stale'
  /**
   * Nothing to compare: the picture carries no copy of a document (an export without `--editable` is a
   * drawing and nothing else), or a body is written in a spelling this reader cannot open. Silence is
   * the honest answer — a report that guesses is worse than one that says nothing.
   */
  | 'unknown'

/**
 * Whether a picture still shows the document it was exported from.
 *
 * `source` is read as a document too, so either side may be a `.drawio` file or an exported SVG: what
 * matters is what the two of them hold.
 */
export function pictureStanding(picture: string, source: string): PictureStanding {
  const drawn = pagesOf(picture)
  const beside = pagesOf(source)
  if (!drawn || !beside) return 'unknown'

  for (const [key, page] of drawn) {
    const other = beside.get(key)
    if (!other) return 'stale'
    // A name is compared only when the *source* states one: drawio invents a name for an unnamed page
    // as it loads it ("Page-1"), so that difference says nothing about the drawing.
    if (other.name && page.name !== other.name) return 'stale'
    if (page.cells !== other.cells) return 'stale'
  }
  return 'current'
}

/** One page, reduced to the facts a redraw cannot rewrite. */
interface DrawnPage {
  /** What the source calls it, or empty when it says nothing. */
  name: string
  /** Its cells, as one comparable string. */
  cells: string
}

/**
 * The pages of a file, ready to compare — or null when there is nothing to compare.
 *
 * A file carrying no document at all (a plain `svg`) has no pages, and neither has one whose body this
 * reader cannot open. Both are null, and both mean "no answer" rather than "no difference".
 */
function pagesOf(fileText: string): Map<string, DrawnPage> | null {
  const pages = drawioPageBodies(fileText)
  if (pages.length === 0) return null

  const found = new Map<string, DrawnPage>()
  for (const [index, { page, body }] of pages.entries()) {
    const model = bodyText(page, body)
    if (model === null) return null
    // Addressed by the id drawio itself would give it: a page with no id is handed its own index as
    // one as the document loads (`EditorUi.setFileData`), so the copy carries an id the source does not.
    found.set(page.id || String(index), { name: page.name, cells: cellsOf(model) })
  }
  return found
}

/**
 * A page's body as XML, decompressed when it is stored that way.
 *
 * drawio's compressed spelling is `base64(deflateRaw(encodeURIComponent(xml)))` (`Graph.compress`), and
 * an *editable* SVG's copy is written that way on every page — so comparing a picture against its source
 * is comparing one plain model against one deflated one, every time. The zlib-wrapped spelling is in
 * drawio's tree as well, and its own reader accepts both, so both are tried.
 *
 * Null is a body in neither spelling: not something to compare, and not something to report.
 */
function bodyText(page: DrawioPage, body: string): string | null {
  const text = body.trim()
  if (text.length === 0) return ''
  if (!page.compressed) return text

  const bytes = Buffer.from(text, 'base64')
  for (const inflate of [inflateRawSync, inflateSync]) {
    try {
      return decodeURIComponent(inflate(bytes).toString('utf-8'))
    } catch {
      // The other spelling, or not a deflated body at all.
    }
  }
  return null
}

/** `<mxCell …>` and `<mxGeometry …>` opening tags — the two elements a drawing is made of. */
const CELL_TAGS = /<mxCell\b[^>]*>/gi
const GEOMETRY_TAG = /<mxGeometry\b[^>]*>/i

/**
 * A model's cells, in a form a redraw cannot change.
 *
 * Read by attribute name, so that everything drawio writes for itself — a default it fills in, a style
 * it normalises, a zero it spells out — is ignored instead of being reported as a difference. Sorted,
 * because the order a model lists its cells in is not part of what the drawing says. The two root cells
 * are left out: `id="0"` and `id="1"` are what every file has and nobody draws, so an empty page on one
 * side and two roots on the other is not a difference in a drawing.
 */
function cellsOf(model: string): string {
  const cells: string[] = []
  CELL_TAGS.lastIndex = 0

  let tag: RegExpExecArray | null
  while ((tag = CELL_TAGS.exec(model)) !== null) {
    const opening = tag[0]
    const id = attributeOf(opening, 'id')
    if (!id || id === '0' || id === '1') continue

    // A cell with no children closes itself; one with a geometry runs to its own closing tag, which is
    // the first after it — cells are not nested, and containment is said by `parent`.
    const selfClosing = opening.endsWith('/>')
    let geometry = ''
    if (!selfClosing) {
      const close = model.indexOf('</mxCell>', tag.index + opening.length)
      const inner = close === -1 ? '' : model.slice(tag.index + opening.length, close)
      geometry = geometryOf(GEOMETRY_TAG.exec(inner)?.[0] ?? '')
    }

    cells.push(
      [
        id,
        attributeText(opening, 'value'),
        attributeText(opening, 'style'),
        kindOf(opening),
        attributeText(opening, 'parent'),
        geometry,
      ].join('|'),
    )
  }

  return cells.sort().join('\n')
}

/** An attribute as the text a person reads: entities decoded, and absent saying what empty says. */
function attributeText(tag: string, name: string): string {
  const raw = attributeOf(tag, name)
  return raw === null ? '' : decodeAttribute(raw)
}

/**
 * Whether a cell is a shape or a connector — as the fact, not as the spelling.
 *
 * The attribute is `vertex="1"` for one and `edge="1"` for the other, but a file may state either as
 * `0`, and a redraw may write those zeroes out where the source left them off. So the value is read as
 * true-or-not rather than compared as text.
 */
function kindOf(tag: string): string {
  if (isSet(tag, 'edge')) return 'edge'
  return isSet(tag, 'vertex') ? 'vertex' : ''
}

function isSet(tag: string, name: string): boolean {
  const raw = attributeOf(tag, name)
  return raw !== null && raw !== '0' && raw.toLowerCase() !== 'false'
}

/** A cell's place and size as numbers, so that `40` and `40.0` are the same place. */
function geometryOf(tag: string): string {
  return (['x', 'y', 'width', 'height'] as const)
    .map((name) => {
      const raw = attributeOf(tag, name)
      return raw === null ? '' : String(Number(raw))
    })
    .join(',')
}
