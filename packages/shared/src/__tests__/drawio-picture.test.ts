import { deflateRawSync } from 'zlib'
import { describe, expect, it } from 'bun:test'
import { pictureStanding } from '../drawio/picture'

/**
 * The pair this module judges: a `.drawio` file, and the exported *editable* SVG a brief shows it in.
 *
 * The fixtures are written as the two really are, because that is the whole difficulty: the source is
 * a plain model an agent typed, and the picture's copy is the same model as the *editor* wrote it out —
 * deflated, with every attribute it fills in for itself spelled, and with each cell's attributes in name
 * order (`mxObjectCodec.encodeObject` sorts them). A comparison that is not careful reports that pair as
 * a difference, which is why most of what follows is one drawing written two ways.
 */

/** drawio's own compression — `base64(deflateRaw(uri-encoded))`, what every page of a copy carries. */
function deflated(xml: string): string {
  return deflateRawSync(Buffer.from(encodeURIComponent(xml), 'utf-8')).toString('base64')
}

/** The copy as an attribute value has to be: entity-escaped. */
function attributeValue(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

interface Page {
  id?: string
  name?: string
  /** The page's model, written whichever way the side being built writes it. */
  model: string
}

function pagesXml(pages: Page[]): string {
  const written = pages.map(
    ({ id, name, model }) =>
      `<diagram${id ? ` id="${id}"` : ''}${name ? ` name="${name}"` : ''}>${model}</diagram>`,
  )
  return `<mxfile>${written.join('')}</mxfile>`
}

/** A `.drawio` file: what the agent writes, and what the diagram is edited in. */
function source(pages: Page[]): string {
  return pagesXml(pages)
}

/** An exported editable SVG: a drawing, with the document it was drawn from inside it. */
function picture(pages: Page[]): string {
  const copy = pagesXml(pages.map((page) => ({ ...page, model: deflated(page.model) })))
  return `<svg xmlns="http://www.w3.org/2000/svg" content="${attributeValue(copy)}"><g/></svg>`
}

/** Exported without the copy: a picture and nothing else, which is what a plain `svg` is. */
const PICTURE_ONLY = '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>'

/** A drawing, as an agent types it: the attributes that say what the cell *is*, and no others. */
const AS_TYPED = [
  '<mxGraphModel pageWidth="850" pageHeight="1100"><root>',
  '<mxCell id="0"/>',
  '<mxCell id="1" parent="0"/>',
  '<mxCell id="2" value="Cart" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">',
  '<mxGeometry x="40" y="40" width="140" height="60" as="geometry"/>',
  '</mxCell>',
  '<mxCell id="3" value="Pay" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">',
  '<mxGeometry x="260" y="40" width="140" height="60" as="geometry"/>',
  '</mxCell>',
  '<mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="2" target="3">',
  '<mxGeometry relative="1" as="geometry"/>',
  '</mxCell>',
  '</root></mxGraphModel>',
].join('')

/** The same drawing as the editor hands it back: its own defaults, its own order, its own spacing. */
const AS_REDRAWN = [
  '<mxGraphModel arrows="1" connect="1" dx="800" dy="600" fold="1" grid="1" gridSize="10" guides="1" math="0"',
  ' page="1" pageHeight="1100" pageScale="1" pageWidth="850" shadow="0" tooltips="1"><root>',
  '<mxCell connectable="1" id="0" visible="1"/>',
  '<mxCell connectable="1" id="1" parent="0" visible="1"/>',
  '<mxCell connectable="1" id="2" parent="1" style="rounded=1;whiteSpace=wrap;html=1;" value="Cart" vertex="1">',
  '<mxGeometry as="geometry" height="60" width="140" x="40" y="40"/></mxCell>',
  '<mxCell connectable="1" id="3" parent="1" style="rounded=1;whiteSpace=wrap;html=1;" value="Pay" vertex="1">',
  '<mxGeometry as="geometry" height="60" width="140" x="260" y="40"/></mxCell>',
  '<mxCell connectable="1" edge="1" id="4" parent="1" style="edgeStyle=orthogonalEdgeStyle;html=1;" source="2" target="3">',
  '<mxGeometry as="geometry" relative="1"/></mxCell>',
  '</root></mxGraphModel>',
].join('')

const ONE_PAGE: Page[] = [{ id: 'page-1', name: 'Checkout', model: AS_TYPED }]
const PICTURE = picture([{ id: 'page-1', name: 'Checkout', model: AS_REDRAWN }])

/** The source with one thing changed — what a person does between two exports. */
function sourceWith(model: string, name = 'Checkout'): string {
  return source([{ id: 'page-1', name, model }])
}

describe('a picture and the diagram it was drawn from', () => {
  it('reads the same drawing as current, in the two spellings it is written in', () => {
    // The point of the pair below: not one character of these two texts agree, and the drawing does.
    expect(AS_REDRAWN).not.toBe(AS_TYPED)
    expect(AS_REDRAWN).toContain('connectable="1"')
    expect(AS_TYPED).not.toContain('connectable')
    expect(AS_REDRAWN).toContain('<mxGeometry as="geometry" height="60"')
    expect(AS_TYPED).toContain('<mxGeometry x="40" y="40" width="140"')

    expect(pictureStanding(PICTURE, source(ONE_PAGE))).toBe('current')
  })

  it('reads a label changed after the export as stale', () => {
    expect(pictureStanding(PICTURE, sourceWith(AS_TYPED.replace('value="Pay"', 'value="Pay now"')))).toBe(
      'stale',
    )
  })

  it('reads a cell added to the source as stale', () => {
    const added = AS_TYPED.replace(
      '</root>',
      '<mxCell id="5" value="Ship" vertex="1" parent="1"><mxGeometry x="40" y="140" width="140" height="60" as="geometry"/></mxCell></root>',
    )
    expect(pictureStanding(PICTURE, sourceWith(added))).toBe('stale')
  })

  it('reads a cell moved as stale', () => {
    expect(pictureStanding(PICTURE, sourceWith(AS_TYPED.replace('x="260"', 'x="300"')))).toBe('stale')
  })

  // The style is what a person changes when the drawing is right and its look is not, and it is a
  // string the redraw hands back untouched — so it is one of the things worth comparing.
  it('reads a style changed as stale', () => {
    expect(pictureStanding(PICTURE, sourceWith(AS_TYPED.replace('rounded=1;whiteSpace=wrap', 'ellipse')))).toBe(
      'stale',
    )
  })

  it('reads a page renamed as stale', () => {
    expect(pictureStanding(PICTURE, sourceWith(AS_TYPED, 'Checkout and payment'))).toBe('stale')
  })

  it('reads the page being gone from the source as stale', () => {
    const other = source([{ id: 'page-9', name: 'Checkout', model: AS_TYPED }])
    expect(pictureStanding(PICTURE, other)).toBe('stale')
  })

  // An unnamed page is given a name as the editor loads it ("Page-1"), so the copy carries a name the
  // source does not have. That says nothing about the drawing, and reporting it would report every
  // hand-written file that never named its single page.
  it('does not compare a name the source does not state', () => {
    const unnamed = picture([{ id: 'page-1', model: AS_REDRAWN }])
    const sourceWithoutName = source([{ id: 'page-1', model: AS_TYPED }])
    const namedAsTheEditorWould = picture([{ id: 'page-1', name: 'Page-1', model: AS_REDRAWN }])

    expect(pictureStanding(unnamed, sourceWithoutName)).toBe('current')
    expect(pictureStanding(namedAsTheEditorWould, sourceWithoutName)).toBe('current')
  })

  // A page the editor hands a name to is also handed an *id*: its own index. So the copy of a file
  // whose page was never given one carries `id="0"`, and the comparison has to know that is the same
  // page — otherwise every hand-written single-page file reads as stale.
  it('addresses a page the way drawio would, by index when the source names no id', () => {
    const withoutIds = source([{ name: 'Checkout', model: AS_TYPED }])
    const copyWithIndexId = picture([{ id: '0', name: 'Checkout', model: AS_REDRAWN }])

    expect(pictureStanding(copyWithIndexId, withoutIds)).toBe('current')
  })

  it('reads a page that was empty and is still empty as current', () => {
    const empty = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>'
    const emptyAsRedrawn = '<mxGraphModel arrows="1" page="1"><root><mxCell connectable="1" id="0" visible="1"/><mxCell connectable="1" id="1" parent="0" visible="1"/></root></mxGraphModel>'

    // The two root cells are what every file has and nobody draws, so neither side counts them.
    expect(pictureStanding(picture([{ id: 'p', model: emptyAsRedrawn }]), source([{ id: 'p', model: empty }]))).toBe(
      'current',
    )
  })

  it('reads a coordinate written a different way as the same place', () => {
    const rewritten = AS_TYPED.replace('x="40" y="40"', 'x="40.0" y="40.000"')
    expect(pictureStanding(PICTURE, sourceWith(rewritten))).toBe('current')
  })

  // A page *added* to the source is the one change this cannot see: an export made with `--page` holds
  // one page of several on purpose, and from here that and "the export is behind" are the same shape.
  // Pinned so that it stays a decision rather than becoming a surprise.
  it('says nothing about a page added to the source, because `--page` looks the same', () => {
    const twoPages = source([
      { id: 'page-1', name: 'Checkout', model: AS_TYPED },
      { id: 'page-2', name: 'Refunds', model: AS_TYPED },
    ])
    expect(pictureStanding(PICTURE, twoPages)).toBe('current')
  })

  // The other direction is a real answer: a picture whose page is not in the source at all.
  it('reads a picture holding a page the source does not have as stale', () => {
    const onePageOfAnother = source([{ id: 'page-1', name: 'Checkout', model: AS_TYPED.replace('Cart', 'Basket') }])
    expect(pictureStanding(picture([{ id: 'page-2', name: 'Refunds', model: AS_REDRAWN }]), onePageOfAnother)).toBe(
      'stale',
    )
  })

  it('has no answer for a picture that carries no copy', () => {
    expect(pictureStanding(PICTURE_ONLY, source(ONE_PAGE))).toBe('unknown')
  })

  // Both sides are read as documents, so which one is the file on disk and which is the export does not
  // change the answer — a caller that has them the other way round is not a caller that gets it wrong.
  it('reads either side as a document, whichever way round they are given', () => {
    expect(pictureStanding(PICTURE, source(ONE_PAGE))).toBe('current')
    expect(pictureStanding(source(ONE_PAGE), PICTURE)).toBe('current')
  })

  it('has no answer for a page body it cannot open', () => {
    const notDeflated = '<mxfile><diagram id="page-1" name="Checkout">not deflated, not xml</diagram></mxfile>'
    expect(pictureStanding(source([{ id: 'page-1', name: 'Checkout', model: 'not deflated' }]), source(ONE_PAGE))).toBe(
      'unknown',
    )
    // And the file that says so is a document either way — what it holds is what cannot be read.
    expect(pictureStanding(notDeflated, source(ONE_PAGE))).toBe('unknown')
  })
})
