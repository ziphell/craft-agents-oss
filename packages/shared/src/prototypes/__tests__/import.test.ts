import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createPrototype,
  getPrototypePatchesPath,
  importPrototype,
  readPrototypeBase,
  readPrototypeConfig,
  writePrototypeBase,
} from '..'

const PAGE = '<!doctype html><html><body><h1>Orders</h1></body></html>'
const OTHER_PAGE = '<!doctype html><html><body><h1>Quotes</h1></body></html>'

/** Write a patch using a name the injector will actually replay. */
function writePatch(workspaceRoot: string, slug: string, file: string, body = '/* x */'): void {
  writeFileSync(join(getPrototypePatchesPath(workspaceRoot, slug), file), body, 'utf-8')
}

describe('importPrototype', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-import-prototype-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /** A scratch prototype with a page, which is what a useful source looks like. */
  function makeSource(slug = 'orders', page = PAGE): string {
    createPrototype(workspaceRoot, { name: slug, kind: 'scratch' })
    writePrototypeBase(workspaceRoot, slug, page)
    return slug
  }

  it('brings the page and every replayable patch over', () => {
    const source = makeSource()
    writePatch(workspaceRoot, source, 'A-001-heading.css', 'h1 { color: red; }')
    writePatch(workspaceRoot, source, 'B-002-total.js', 'console.log(1)')
    createPrototype(workspaceRoot, { name: 'Checkout', kind: 'scratch' })

    const result = importPrototype(workspaceRoot, 'checkout', source)

    expect(result.copiedPatches).toEqual(['A-001-heading.css', 'B-002-total.js'])
    expect(result.skippedPatches).toEqual([])
    expect(result.bytes).toBeGreaterThan(0)
    expect(readPrototypeBase(workspaceRoot, 'checkout')).toBe(PAGE)
    expect(readdirSync(getPrototypePatchesPath(workspaceRoot, 'checkout')).sort())
      .toEqual(['A-001-heading.css', 'B-002-total.js'])
  })

  // The document and its patches are imported as a pair, and only as a pair: the
  // copies stay consistent because they were replayed against each other.
  it('copies patch contents, not references to them', () => {
    const source = makeSource()
    writePatch(workspaceRoot, source, 'A-001-heading.css', 'h1 { color: red; }')
    createPrototype(workspaceRoot, { name: 'Checkout', kind: 'scratch' })

    importPrototype(workspaceRoot, 'checkout', source)
    // Editing the source afterwards must not reach the imported copy.
    writePatch(workspaceRoot, source, 'A-001-heading.css', 'h1 { color: blue; }')

    const imported = readdirSync(getPrototypePatchesPath(workspaceRoot, 'checkout'))
    expect(imported).toEqual(['A-001-heading.css'])
    expect(readFileSync(join(getPrototypePatchesPath(workspaceRoot, 'checkout'), imported[0]!), 'utf-8'))
      .toBe('h1 { color: red; }')
  })

  // Overwriting this prototype's own patch would be the one loss nobody notices.
  it('leaves a same-named patch of its own alone, and says so', () => {
    const source = makeSource()
    writePatch(workspaceRoot, source, 'A-001-heading.css', 'h1 { color: red; }')
    writePatch(workspaceRoot, source, 'A-002-subtitle.css', 'h2 { color: red; }')
    createPrototype(workspaceRoot, { name: 'Checkout', kind: 'scratch' })
    writePatch(workspaceRoot, 'checkout', 'A-001-heading.css', 'h1 { color: green; }')

    const result = importPrototype(workspaceRoot, 'checkout', source)

    expect(result.copiedPatches).toEqual(['A-002-subtitle.css'])
    expect(result.skippedPatches).toEqual(['A-001-heading.css'])
    const patchesDir = getPrototypePatchesPath(workspaceRoot, 'checkout')
    expect(readdirSync(patchesDir).sort()).toEqual(['A-001-heading.css', 'A-002-subtitle.css'])
    expect(readFileSync(join(patchesDir, 'A-001-heading.css'), 'utf-8')).toBe('h1 { color: green; }')
  })

  // Material, not identity: the target is still the prototype it was created as.
  it('does not carry the source prototype over — only its files', () => {
    createPrototype(workspaceRoot, { name: 'rival-cart', kind: 'overlay', targetUrl: 'https://rival.example.com/cart' })
    writePrototypeBase(workspaceRoot, 'rival-cart', PAGE)
    createPrototype(workspaceRoot, { name: 'Checkout', kind: 'scratch' })

    importPrototype(workspaceRoot, 'checkout', 'rival-cart')

    const config = readPrototypeConfig(workspaceRoot, 'checkout')
    expect(config.kind).toBe('scratch')
    expect(config.targetUrl).toBeUndefined()
  })

  // Only replayable files are part of a prototype; the rest are reported as
  // ownership violations, and copying them would move that junk into a clean one.
  it('ignores files that the injector would never replay', () => {
    const source = makeSource()
    writePatch(workspaceRoot, source, 'notes.txt', 'scratch notes')
    writePatch(workspaceRoot, source, 'A-001-heading.css')
    createPrototype(workspaceRoot, { name: 'Checkout', kind: 'scratch' })

    const result = importPrototype(workspaceRoot, 'checkout', source)

    expect(result.copiedPatches).toEqual(['A-001-heading.css'])
    expect(readdirSync(getPrototypePatchesPath(workspaceRoot, 'checkout'))).toEqual(['A-001-heading.css'])
  })

  it('refuses an overlay as the target, because its base is its own snapshot', () => {
    const source = makeSource()
    writePatch(workspaceRoot, source, 'A-001-heading.css')
    createPrototype(workspaceRoot, { name: 'Rival', kind: 'overlay', targetUrl: 'https://rival.example.com/cart' })

    expect(() => importPrototype(workspaceRoot, 'rival', source)).toThrow(/is an overlay/)
    // …and leaves nothing behind, so the prototype is not half-converted.
    expect(readPrototypeBase(workspaceRoot, 'rival')).toBeNull()
    expect(readdirSync(getPrototypePatchesPath(workspaceRoot, 'rival'))).toEqual([])
  })

  it('refuses a source with no page to import', () => {
    createPrototype(workspaceRoot, { name: 'orders', kind: 'scratch' })
    createPrototype(workspaceRoot, { name: 'Checkout', kind: 'scratch' })

    expect(() => importPrototype(workspaceRoot, 'checkout', 'orders')).toThrow(/no base\.html to import/)
    expect(readPrototypeBase(workspaceRoot, 'checkout')).toBeNull()
  })

  it('refuses to import from itself', () => {
    const source = makeSource()
    expect(() => importPrototype(workspaceRoot, source, source)).toThrow(/cannot import from itself/)
  })

  it('refuses an unknown source, naming the command that lists what exists', () => {
    createPrototype(workspaceRoot, { name: 'Checkout', kind: 'scratch' })
    expect(() => importPrototype(workspaceRoot, 'checkout', 'nope')).toThrow(/prototype-list/)
  })

  it('refuses an unknown target rather than creating one', () => {
    const source = makeSource()
    expect(() => importPrototype(workspaceRoot, 'checkout', source)).toThrow(/does not exist/)
  })

  it('replaces an existing page of its own outright', () => {
    const source = makeSource()
    createPrototype(workspaceRoot, { name: 'Checkout', kind: 'scratch' })
    writePrototypeBase(workspaceRoot, 'checkout', OTHER_PAGE)

    importPrototype(workspaceRoot, 'checkout', source)

    expect(readPrototypeBase(workspaceRoot, 'checkout')).toBe(PAGE)
  })
})
