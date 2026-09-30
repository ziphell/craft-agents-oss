import { deflateRawSync } from 'zlib'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildPrototypeStatus, createPrototype, getPrototypeDirPath } from '..'

/**
 * The one relationship in a prototype folder that nothing else can see: the brief shows a diagram as an
 * exported SVG, and the `.drawio` it was drawn from sits beside it — so editing the diagram leaves the
 * brief showing the drawing as it was, until somebody exports again. The report says so, and this is
 * where that is pinned.
 *
 * The fixtures are the two real spellings: the source as an agent types it, and the picture's copy as
 * the editor wrote it out (deflated, with the attributes it fills in for itself). `drawio-picture.test.ts`
 * is where that comparison is examined on its own.
 */

const MODEL =
  '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="Cart" vertex="1" parent="1">' +
  '<mxGeometry x="40" y="40" width="140" height="60" as="geometry"/></mxCell></root></mxGraphModel>'

/** The same drawing as the editor hands it back: its own attributes, its own order. */
const AS_REDRAWN =
  '<mxGraphModel page="1"><root><mxCell connectable="1" id="0" visible="1"/>' +
  '<mxCell connectable="1" id="1" parent="0" visible="1"/>' +
  '<mxCell connectable="1" id="2" parent="1" value="Cart" vertex="1">' +
  '<mxGeometry as="geometry" height="60" width="140" x="40" y="40"/></mxCell></root></mxGraphModel>'

function diagram(model: string): string {
  return `<mxfile><diagram id="page-1" name="Checkout">${model}</diagram></mxfile>`
}

/** A `.drawio` drawn and exported with a copy of itself inside — the editable SVG a brief shows. */
function exported(model: string): string {
  const copy = diagram(deflateRawSync(Buffer.from(encodeURIComponent(model), 'utf-8')).toString('base64'))
  const escaped = copy
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return `<svg xmlns="http://www.w3.org/2000/svg" content="${escaped}"><g/></svg>`
}

describe('a drawing the brief shows an earlier state of', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-stale-diagram-'))
    createPrototype(workspaceRoot, { name: slug })
    // A spec beside the entry, so that a diagram notice is the only notice there can be here.
    write('cart-total.spec.md', '# The cart is priced at checkout\n')
    write('cart.js', 'export const total = 0\n')
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  function write(name: string, text: string): void {
    writeFileSync(join(getPrototypeDirPath(workspaceRoot, slug), name), text, 'utf-8')
  }

  function issues(): string[] {
    return buildPrototypeStatus(workspaceRoot, slug).briefIssues.map((issue) => issue.code)
  }

  it('says nothing while the picture still shows the diagram', () => {
    write('cart.drawio', diagram(MODEL))
    write('cart.drawio.svg', exported(AS_REDRAWN))

    expect(buildPrototypeStatus(workspaceRoot, slug).briefIssues).toEqual([])
  })

  it('reports the picture when the diagram has moved on since it was exported', () => {
    // What the docs call the one way this pair goes wrong: the `.drawio` is edited, and the export —
    // which is a separate command — is not run again.
    write('cart.drawio', diagram(MODEL.replace('value="Cart"', 'value="Basket"')))
    write('cart.drawio.svg', exported(AS_REDRAWN))

    const reported = buildPrototypeStatus(workspaceRoot, slug).briefIssues

    expect(reported.map((issue) => issue.code)).toEqual(['diagram.stale'])
    // The code is the contract with the panel; the sentence is what the agent prints.
    expect(reported[0]?.text).toBe(
      'cart.drawio.svg is not what cart.drawio draws any more — it was exported before the diagram changed.',
    )
    // The panel translates from the params, so both names have to travel with the notice.
    expect(reported[0]?.params).toEqual({ svg: 'cart.drawio.svg', source: 'cart.drawio' })
  })

  // Nothing pairs with it, so there is nothing to compare — and where a picture came from is not this
  // report's to guess. The file is still listed like any other, and still opens.
  it('says nothing about a picture with no diagram of that name beside it', () => {
    write('cart.drawio.svg', exported(AS_REDRAWN))

    expect(buildPrototypeStatus(workspaceRoot, slug).briefIssues).toEqual([])
  })

  // A plain `svg` export is a drawing and nothing else: no copy to compare, so no claim to make.
  it('says nothing about a picture that carries no copy', () => {
    write('cart.drawio', diagram(MODEL))
    write('cart.drawio.svg', '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>')

    expect(issues()).toEqual([])
  })

  // The pair is a convention about names, and only that one shape pairs: another `.svg` beside another
  // `.drawio` is two files, not a picture of one.
  it('pairs nothing but `<name>.drawio.svg` with `<name>.drawio`', () => {
    write('cart.drawio', diagram(MODEL.replace('value="Cart"', 'value="Basket"')))
    write('cart.svg', exported(AS_REDRAWN))

    expect(issues()).toEqual([])
  })
})
