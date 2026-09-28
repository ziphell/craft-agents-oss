import { describe, expect, it } from 'bun:test'
import {
  DRAWIO_BRIDGE_PROTOCOL,
  DRAWIO_MAX_DOCUMENT_CHARS,
  buildDrawioLoadMessage,
  buildDrawioRenderMessage,
  describeDrawioPageProblem,
  drawioDocument,
  drawioEditorUrl,
  drawioLanguage,
  drawioViewerUrl,
  drawioPages,
  findDrawioPage,
  parseDrawioIncoming,
  parseDrawioEmbedEvent,
  parseDrawioSvgSize,
  projectDrawioPage,
} from '../drawio/types'

describe('the render message', () => {
  // How big the diagram is drawn is CSS on the element that shows it, so it is not a message:
  // the frame's job ends at handng back an SVG.
  it('asks for a drawing, and says nothing about size', () => {
    expect(buildDrawioRenderMessage('<xml/>', false)).toEqual({
      protocol: DRAWIO_BRIDGE_PROTOCOL,
      type: 'render',
      xml: '<xml/>',
      dark: false,
    })
  })

  // A page travels as the id the viewer addresses; the name a person wrote is resolved before the
  // message is built, where a miss can be reported instead of drawn.
  it('carries a page id when one was resolved, and nothing when it was not', () => {
    expect(buildDrawioRenderMessage('<xml/>', false, 'page-2').pageId).toBe('page-2')
    expect('pageId' in buildDrawioRenderMessage('<xml/>', false)).toBe(false)
  })
})

describe('the drawn diagram', () => {
  it('carries an SVG back', () => {
    const svg = '<svg><g/></svg>'
    expect(
      parseDrawioIncoming({ protocol: DRAWIO_BRIDGE_PROTOCOL, type: 'rendered', ok: true, svg }),
    ).toEqual({ protocol: DRAWIO_BRIDGE_PROTOCOL, type: 'rendered', ok: true, svg })
  })

  // This markup goes into the app's own document, so what may arrive is narrowed at the parse
  // rather than trusted from the frame.
  it('drops a payload that is not an SVG', () => {
    expect(
      parseDrawioIncoming({
        protocol: DRAWIO_BRIDGE_PROTOCOL,
        type: 'rendered',
        ok: true,
        svg: '<html><body><script/></body></html>',
      }),
    ).toEqual({ protocol: DRAWIO_BRIDGE_PROTOCOL, type: 'rendered', ok: true })
  })

  // A real diagram is easily a hundred kilobytes, so the small cap that keeps junk out of the
  // frame's other messages must not be applied to one carrying the drawing.
  it('accepts a diagram far larger than a status message', () => {
    const svg = '<svg>' + 'x'.repeat(20 * 1024) + '</svg>'
    expect(
      parseDrawioIncoming({ protocol: DRAWIO_BRIDGE_PROTOCOL, type: 'rendered', ok: true, svg }),
    ).not.toBeNull()
    expect(
      parseDrawioIncoming({ protocol: DRAWIO_BRIDGE_PROTOCOL, type: 'ready', junk: svg }),
    ).toBeNull()
  })
})

describe('the size the viewer states', () => {
  // The viewer's own style, in the shape it hands back: `width: 100%` is about the box it is in,
  // and the `min-width`/`min-height` beside it are the drawing's own bounds plus its margin. Both
  // surfaces that show the markup read the size this way, because there is no `viewBox` to read.
  it('reads the size off the style, not the width percentage', () => {
    const svg =
      '<svg style="width: 100%; height: 100%; min-width: 640px; min-height: 400px;" viewBox="0 0 640 400"><g/></svg>'
    expect(parseDrawioSvgSize(svg)).toEqual({ width: 640, height: 400 })
  })

  it('reads the fractional sizes the viewer writes', () => {
    expect(parseDrawioSvgSize('<svg style="min-width: 512.5px; min-height: 300.25px"></svg>')).toEqual(
      { width: 512.5, height: 300.25 },
    )
  })

  // Without both, the drawing's size is not stated — and a size taken from the element's own box is
  // the CSS default for a replaced element, which says nothing about the drawing.
  it('says nothing when the markup states no size', () => {
    expect(parseDrawioSvgSize('<svg style="width: 100%; height: 100%"></svg>')).toBeNull()
    expect(parseDrawioSvgSize('<svg style="min-width: 640px"></svg>')).toBeNull()
    expect(parseDrawioSvgSize('<svg></svg>')).toBeNull()
  })

  it('refuses a size of zero', () => {
    expect(parseDrawioSvgSize('<svg style="min-width: 0px; min-height: 0px"></svg>')).toBeNull()
    expect(parseDrawioSvgSize('<svg style="min-width: 640px; min-height: 0px"></svg>')).toBeNull()
  })
})

describe('drawioEmbedEvent', () => {
  it('reads the two messages the editor acts on', () => {
    expect(parseDrawioEmbedEvent('{"event":"init"}')).toEqual({ event: 'init' })
    expect(parseDrawioEmbedEvent('{"event":"autosave","xml":"<mxfile/>"}')).toEqual({
      event: 'autosave',
      xml: '<mxfile/>',
    })
    expect(parseDrawioEmbedEvent('{"event":"save","xml":"<mxfile/>"}')).toEqual({
      event: 'save',
      xml: '<mxfile/>',
    })
  })

  // drawio sends more than we act on. Guessing at an unmodelled one would mean acting
  // on a shape nobody has written down.
  it('drops what it does not model', () => {
    expect(parseDrawioEmbedEvent('{"event":"export","data":"x"}')).toBeNull()
    expect(parseDrawioEmbedEvent('{"event":"configure"}')).toBeNull()
    expect(parseDrawioEmbedEvent('init')).toBeNull()
    expect(parseDrawioEmbedEvent('{oops')).toBeNull()
    expect(parseDrawioEmbedEvent(null)).toBeNull()
    expect(parseDrawioEmbedEvent('{}')).toBeNull()
  })

  it('drops a change with no usable document', () => {
    expect(parseDrawioEmbedEvent('{"event":"autosave"}')).toBeNull()
    expect(parseDrawioEmbedEvent('{"event":"autosave","xml":42}')).toBeNull()
    expect(parseDrawioEmbedEvent('{"event":"autosave","xml":""}')).toBeNull()
    expect(
      parseDrawioEmbedEvent(
        JSON.stringify({ event: 'autosave', xml: 'x'.repeat(DRAWIO_MAX_DOCUMENT_CHARS + 1) }),
      ),
    ).toBeNull()
  })

  /**
   * The one shape rule of drawio's own layer: `proto=json` means the editor `JSON.parse`s
   * everything it is told. An object sent to it therefore *throws* there and the message is
   * dropped — a blank editor with nothing in any log, which is exactly how this shipped once.
   */
  it('speaks to the editor in strings, not objects', () => {
    expect(buildDrawioLoadMessage('<mxfile/>')).toBe(
      '{"action":"load","xml":"<mxfile/>","autosave":1}',
    )
    expect(parseDrawioEmbedEvent({ event: 'init' })).toBeNull()
    expect(parseDrawioEmbedEvent({ event: 'autosave', xml: '<mxfile/>' })).toBeNull()
  })

  it('addresses the editor at the app’s own origin', () => {
    const url = drawioEditorUrl('http://drawio-1a2b3c4d.localhost')

    expect(url.startsWith('http://drawio-1a2b3c4d.localhost/?')).toBe(true)
    expect(url).toContain('embed=1')
    expect(url).toContain('proto=json')
    // The bundle drops the raw stencils directory, so asking for it would 404.
    expect(url).toContain('libraries=0')
    // Ask drawio not to call its hosted services. Not a fence — see the constant — but the
    // one lever there is over a document we do not serve.
    expect(url).toContain('offline=1')
    expect(url).not.toContain('dark=1')
    expect(drawioEditorUrl('http://drawio-1a2b3c4d.localhost', true)).toContain('dark=1')
  })

  it('speaks the app’s language, in the shape drawio names languages', () => {
    // drawio's own code for the language, not the app's: `zh-Hans` is `zh` to drawio, and it has
    // no dictionary for the app's spelling. The bundle falls back to English for a code it does
    // not know, so a miss here is a wrong language rather than a broken editor.
    expect(drawioLanguage('zh-Hans')).toBe('zh')
    expect(drawioLanguage('en')).toBe('en')
    expect(drawioLanguage('ja')).toBe('ja')
    // No language known yet (i18next before it resolves): English, which is also the fallback.
    expect(drawioLanguage(undefined)).toBe('en')

    expect(drawioEditorUrl('http://drawio-1a2b3c4d.localhost', false, 'zh-Hans')).toContain('lang=zh')
    // The viewer reads its language from the address as it loads, so it is in the address.
    expect(drawioViewerUrl('http://drawio-1a2b3c4d.localhost', 'zh-Hans')).toBe(
      'http://drawio-1a2b3c4d.localhost/__craft/viewer.html?lang=zh',
    )
  })
})

describe('the two layers stay apart', () => {
  // The editor speaks drawio's own JSON and the viewer shell speaks ours. A parser that
  // accepted the other layer's message would be quietly acting on the wrong protocol — and
  // the two are distinguishable by *shape* alone: ours is an object, drawio's is a string.
  it('never mistakes one layer for the other', () => {
    expect(parseDrawioIncoming({ event: 'init' })).toBeNull()
    expect(parseDrawioIncoming({ event: 'autosave', xml: '<mxfile/>' })).toBeNull()
    expect(parseDrawioIncoming('{"event":"init"}')).toBeNull()
    expect(
      parseDrawioEmbedEvent(JSON.stringify({ protocol: DRAWIO_BRIDGE_PROTOCOL, type: 'ready' })),
    ).toBeNull()
    expect(
      parseDrawioEmbedEvent(
        JSON.stringify({ protocol: DRAWIO_BRIDGE_PROTOCOL, type: 'rendered', ok: true }),
      ),
    ).toBeNull()
  })
})

describe('the pages of a document', () => {
  // What drawio itself saves: the model is deflated and base64'd, so nothing inside is readable —
  // which is why only the opening tags are read. The blob below contains no `<` at all.
  const compressed = '7Vpbc9o4FP41zLQP7YwvGHDIU5JJC24DgUCbpNPp'
  const pages = [
    '<mxfile>',
    '<diagram id="p1" name="One"><mxGraphModel><root/></mxGraphModel></diagram>',
    `<diagram id="p2" name="Two">${compressed}</diagram>`,
    '<diagram id="p3" />',
    '</mxfile>',
  ].join('')

  it('lists them in order, with the name each one was given', () => {
    expect(drawioPages(pages)).toEqual([
      { id: 'p1', name: 'One', compressed: false },
      // The one saved the way drawio saves: a deflated, base64'd body.
      { id: 'p2', name: 'Two', compressed: true },
      // A page with no name is still a page; it is simply not addressable by one.
      { id: 'p3', name: '', compressed: false },
    ])
  })

  // A page's contents are never read, so a body that *mentions* a diagram — escaped, as XML requires
  // — is not a page, and neither is anything in a compressed one.
  it('reads tags, not the text inside them', () => {
    const escaped = '<mxfile><diagram id="a" name="A"><mxGraphModel><root>' +
      '<mxCell value="&lt;diagram id=&quot;fake&quot; name=&quot;Nope&quot;&gt;"/></root></mxGraphModel></diagram></mxfile>'
    expect(drawioPages(escaped)).toEqual([{ id: 'a', name: 'A', compressed: false }])
    expect(drawioPages('<mxfile></mxfile>')).toEqual([])
    expect(drawioPages('not xml at all')).toEqual([])
    // The id is the one on the tag, not an attribute that merely ends in the same three letters.
    expect(drawioPages('<mxfile><diagram data-id="ghost" id="real" name="R"/></mxfile>')).toEqual([
      { id: 'real', name: 'R', compressed: false },
    ])
  })

  it('decodes the entities drawio writes into a name', () => {
    expect(drawioPages('<mxfile><diagram id="a" name="A &amp; B"/></mxfile>')).toEqual([
      { id: 'a', name: 'A & B', compressed: false },
    ])
  })

  // Whether a body is compressed is worth saying *before* anyone tries to edit it — a deflate+base64
  // page is not XML anything can change, and the file has to be written out plain first. It is legible
  // from the tag itself: a plain body opens with `<`, and base64 has no `<` in its alphabet.
  it('says which pages are stored compressed', () => {
    const file = [
      '<mxfile>',
      '<diagram id="p1" name="Plain"><mxGraphModel><root/></mxGraphModel></diagram>',
      '<diagram id="p2" name="Zipped">7Vpbc9o4FP41zLQP7YwvGHDIU5JJC24DgUCbpNPp</diagram>',
      // Nothing at all is not compressed either — and a hand-written file may indent.
      '<diagram id="p3" name="Empty" />',
      '<diagram id="p4" name="Indented">\n      <mxGraphModel><root/></mxGraphModel></diagram>',
      '<diagram id="p5" name="Zipped and indented">\n      7Vpbc9o4FP41zLQP7YwvGHDIU5JJC24D</diagram>',
      '</mxfile>',
    ].join('')

    expect(drawioPages(file)).toEqual([
      { id: 'p1', name: 'Plain', compressed: false },
      { id: 'p2', name: 'Zipped', compressed: true },
      { id: 'p3', name: 'Empty', compressed: false },
      { id: 'p4', name: 'Indented', compressed: false },
      { id: 'p5', name: 'Zipped and indented', compressed: true },
    ])
  })

  it('resolves a name to the page, and says where in the document it is', () => {
    expect(findDrawioPage(pages, 'Two')).toEqual({
      ok: true,
      page: { id: 'p2', name: 'Two', compressed: true },
      index: 2,
      total: 3,
    })
    expect(findDrawioPage(pages, '  One  ')).toEqual({
      ok: true,
      page: { id: 'p1', name: 'One', compressed: false },
      index: 1,
      total: 3,
    })
  })

  // A miss is answered with the names the file *does* have, because that list is what turns a
  // typo into a corrected spec. Exact and case-sensitive: "one" is a different name from "One",
  // and pretending otherwise is how a tool ends up drawing something nobody asked for.
  it('reports a name no page has, with the names there are', () => {
    expect(findDrawioPage(pages, 'one')).toEqual({
      ok: false,
      reason: 'unknown',
      total: 3,
      names: ['One', 'Two'],
    })
    expect(findDrawioPage(pages, 'Three')).toEqual({
      ok: false,
      reason: 'unknown',
      total: 3,
      names: ['One', 'Two'],
    })
  })

  // Two pages can share a name. Picking one would silently show a page the reader did not ask for.
  it('refuses a name two pages share rather than picking one', () => {
    const ambiguous = '<mxfile><diagram id="a" name="v1"/><diagram id="b" name="v1"/></mxfile>'
    expect(findDrawioPage(ambiguous, 'v1')).toEqual({
      ok: false,
      reason: 'ambiguous',
      total: 2,
      names: ['v1', 'v1'],
    })
  })

  // The sentence a reader or a model acts on. Built from the lookup rather than written twice, so
  // the picture in a conversation and the word an agent gets back cannot describe the same document
  // differently — and the names are what makes a typo fixable.
  it('says why the page is not there, in the words both surfaces use', () => {
    const problemWith = (fileXml: string, name: string): string => {
      const lookup = findDrawioPage(fileXml, name)
      if (lookup.ok) throw new Error(`expected no page to be called ${name}`)
      return describeDrawioPageProblem(name, lookup)
    }

    expect(problemWith(pages, 'Three')).toBe(
      'This file has no page called "Three". Its pages are: One, Two.',
    )
    expect(problemWith('<mxfile><diagram id="a" name="v1"/><diagram id="b" name="v1"/></mxfile>', 'v1'))
      .toBe('Two pages are called "v1" — rename one of them.')
    // Nothing to list: a document whose pages are all unnamed cannot offer a corrected spelling.
    expect(problemWith('<mxfile><diagram id="a"/></mxfile>', 'x')).toBe(
      'This file has no page called "x", and none of its pages are named.',
    )
  })

  // Cutting the page out is how a command draws it: the editor's export is told `pageId` for a PNG
  // and for nothing else, so what the caller asks for is made a fact about the document instead.
  it('reduces a document to one page, and leaves the rest of it behind', () => {
    const cut = projectDrawioPage(pages, 'p2')
    expect(cut).not.toBeNull()

    // One page, still the same page: a compressed body travels verbatim, so nothing is lost by the
    // cut and nothing needs drawio's decompressor to make it.
    expect(drawioPages(cut!)).toEqual([{ id: 'p2', name: 'Two', compressed: true }])
    expect(cut).toContain(compressed)
    expect(cut).not.toContain('id="p1"')
    expect(cut).not.toContain('id="p3"')

    // A page with no content closes itself, and is a page all the same.
    expect(projectDrawioPage(pages, 'p3')).toContain('<diagram id="p3" />')
  })

  it('has nothing to cut when the document does not hold that page at all', () => {
    expect(projectDrawioPage(pages, 'no-such-id')).toBeNull()
    // A document that is not an `<mxfile>` of pages is not one a page can be taken out of.
    expect(projectDrawioPage('<mxGraphModel><root/></mxGraphModel>', 'p1')).toBeNull()
  })

  // An SVG exported with "include a copy of my diagram" is a drawing *and* the document it came from,
  // and everything that draws one accepts it — the editor unwraps the copy on load. So the reader has
  // to see through the wrapper as well, or a file could be drawn and not listed.
  it('reads the pages of an editable SVG, out of the copy it carries', () => {
    const copy = '<mxfile><diagram id="p1" name="One"/><diagram id="p2" name="Two"/></mxfile>'
    const escaped = copy
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
    const svgWith = (content: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" content="${content}"><g/></svg>`
    const listed = [
      { id: 'p1', name: 'One', compressed: false },
      { id: 'p2', name: 'Two', compressed: false },
    ]

    // The copy as our own export writes it, and the two other spellings drawio's reader takes.
    for (const written of [escaped, Buffer.from(copy, 'utf-8').toString('base64'), encodeURIComponent(copy)]) {
      expect(drawioPages(svgWith(written))).toEqual(listed)
    }

    // And the same read is what a block's `page` and a command's `--page` go through, cutting from the
    // copy and handing the engine a document.
    expect(findDrawioPage(svgWith(escaped), 'Two')).toMatchObject({
      ok: true,
      page: { id: 'p2', name: 'Two', compressed: false },
    })
    expect(projectDrawioPage(svgWith(escaped), 'p2')).toContain('<diagram id="p2" name="Two"/>')
  })

  it('reads no pages out of a drawing that carries no copy, and leaves a document alone', () => {
    // Exported without the copy: a picture, and no document to list.
    expect(drawioPages('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>')).toEqual([])
    // Only a *root* `<svg>` is unwrapped — an mxfile is a document whatever it holds.
    expect(drawioPages('<mxfile><diagram id="a" name="A"/><svg/></mxfile>')).toEqual([
      { id: 'a', name: 'A', compressed: false },
    ])
  })
})

// The unwrap as the *read* path uses it: a command handed a file is given the document out of it,
// so a file that is an exported SVG is read back rather than handed on as a wrapper. This is what
// makes such a file recoverable (`--format drawio`) instead of resting on drawio's own load path.
describe('the document inside a file', () => {
  const copy = '<mxfile><diagram id="p1" name="One"/></mxfile>'
  const escaped = copy
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const svgWith = (content: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" content="${content}"><g/></svg>`

  it('reads the copy an editable SVG carries, in any of the three spellings', () => {
    for (const written of [escaped, Buffer.from(copy, 'utf-8').toString('base64'), encodeURIComponent(copy)]) {
      expect(drawioDocument(svgWith(written))).toBe(copy)
    }
  })

  it('leaves a document, and a drawing with no copy, exactly as they are', () => {
    expect(drawioDocument(copy)).toBe(copy)
    const picture = '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>'
    expect(drawioDocument(picture)).toBe(picture)
  })
})
