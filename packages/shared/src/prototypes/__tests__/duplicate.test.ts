import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createPrototype,
  duplicatePrototype,
  getPrototypeDirPath,
  getPrototypeDistPath,
  getPrototypePagePatchesPath,
  getPrototypePatchesPath,
  readPrototypeConfig,
  readPrototypePage,
  writePrototypeConfig,
  writePrototypePage,
} from '..'

const PAGE = '<!doctype html><html><body><h1>Orders</h1></body></html>'

/** Write a patch using a name the injector will actually replay. */
function writePatch(workspaceRoot: string, slug: string, file: string, body = '/* x */'): void {
  writeFileSync(join(getPrototypePatchesPath(workspaceRoot, slug), file), body, 'utf-8')
}

describe('duplicatePrototype', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-duplicate-prototype-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /** A prototype with a page and two patches — something worth copying. */
  function makeSource(slug = 'orders'): string {
    createPrototype(workspaceRoot, { name: slug })
    writePrototypePage(workspaceRoot, slug, 'orders', PAGE)
    writePatch(workspaceRoot, slug, 'A-001-heading.css', 'h1 { color: red; }')
    writePatch(workspaceRoot, slug, 'B-002-total.js', 'console.log(1)')
    return slug
  }

  it('brings the pages and every replayable patch over, under a new slug', () => {
    makeSource()

    const copied = duplicatePrototype(workspaceRoot, 'orders')

    expect(copied.sourceSlug).toBe('orders')
    expect(copied.slug).toBe('orders-copy')
    expect(copied.copiedPages).toEqual(['orders'])
    expect(copied.copiedPatches).toEqual(['A-001-heading.css', 'B-002-total.js'])
    expect(readPrototypePage(workspaceRoot, 'orders-copy', 'orders.html')).toBe(PAGE)
  })

  // The two prototypes stop sharing anything the moment the copy exists: a copy
  // that read through to the source would be a link, not a copy.
  it('copies the material rather than pointing at it', () => {
    const source = makeSource()
    duplicatePrototype(workspaceRoot, source)

    writePatch(workspaceRoot, source, 'A-001-heading.css', 'h1 { color: blue; }')
    writePrototypePage(workspaceRoot, source, 'orders', '<!doctype html><html><body>changed</body></html>')

    const copyPatches = getPrototypePatchesPath(workspaceRoot, 'orders-copy')
    expect(readFileSync(join(copyPatches, 'A-001-heading.css'), 'utf-8')).toBe('h1 { color: red; }')
    expect(readPrototypePage(workspaceRoot, 'orders-copy', 'orders.html')).toBe(PAGE)
  })

  // A page's own patches are named by the directory they sit in, so they travel
  // with the page they belong to and keep their scope in the copy (plan §19.4).
  it('brings each page’s own patches along, under the same page name', () => {
    makeSource()
    mkdirSync(getPrototypePagePatchesPath(workspaceRoot, 'orders', 'orders'), { recursive: true })
    writeFileSync(join(getPrototypePagePatchesPath(workspaceRoot, 'orders', 'orders'), 'A-002-page.css'), '.page{}')

    const copied = duplicatePrototype(workspaceRoot, 'orders')

    // Replay order is declared order, then path — the writer prefix is an identity, not a
    // sort key, so a page's patch no longer sorts next to the patches of the writer that
    // happens to share its first character.
    expect(copied.copiedPatches).toEqual(['A-001-heading.css', 'B-002-total.js', 'orders/A-002-page.css'])
  })

  // The page table is a fact about the flow, not about which prototype owns it, so
  // the copy is the same flow under a different name.
  it('keeps the source’s page table, whole', () => {
    createPrototype(workspaceRoot, { name: 'Rival' })
    writePrototypeConfig(workspaceRoot, 'rival', {
      pages: [
        { name: 'entry', kind: 'overlay', url: 'https://rival.example.com/cart', entry: true },
        { name: 'pay', kind: 'overlay', url: 'https://rival.example.com/pay' },
      ],
    })
    writePatch(workspaceRoot, 'rival', 'A-001-banner.css', '.banner { display: none; }')

    const copied = duplicatePrototype(workspaceRoot, 'rival')

    expect(copied.copiedPages).toEqual(['entry', 'pay'])
    expect(readPrototypeConfig(workspaceRoot, copied.slug).pages).toEqual([
      { name: 'entry', kind: 'overlay', url: 'https://rival.example.com/cart', entry: true },
      { name: 'pay', kind: 'overlay', url: 'https://rival.example.com/pay' },
    ])
    expect(readPrototypePage(workspaceRoot, copied.slug, 'cart.html')).toBeNull()
  })

  it('carries contract services and other files along', () => {
    const source = makeSource()
    const serviceDir = join(getPrototypeDirPath(workspaceRoot, source), 'services', 'checkout-api')
    mkdirSync(serviceDir, { recursive: true })
    writeFileSync(join(serviceDir, 'openapi.yaml'), 'openapi: 3.0.0\n', 'utf-8')

    const copied = duplicatePrototype(workspaceRoot, source)

    expect(readFileSync(join(getPrototypeDirPath(workspaceRoot, copied.slug), 'services', 'checkout-api', 'openapi.yaml'), 'utf-8'))
      .toBe('openapi: 3.0.0\n')
  })

  // Deliverables are derived (export rebuilds them), so a copied dist/ would be a
  // second, stale source of truth.
  it('leaves dist/ behind', () => {
    const source = makeSource()
    const distDir = getPrototypeDistPath(workspaceRoot, source)
    mkdirSync(distDir, { recursive: true })
    writeFileSync(join(distDir, 'dev-spec.md'), 'spec', 'utf-8')

    const copied = duplicatePrototype(workspaceRoot, source)

    expect(existsSync(getPrototypeDistPath(workspaceRoot, copied.slug))).toBe(false)
  })

  it('names the second copy differently, so copying twice in a row does not collide', () => {
    makeSource()

    expect(duplicatePrototype(workspaceRoot, 'orders').slug).toBe('orders-copy')
    expect(duplicatePrototype(workspaceRoot, 'orders').slug).toBe('orders-copy-2')
    expect(duplicatePrototype(workspaceRoot, 'orders-copy').slug).toBe('orders-copy-copy')
  })

  it('uses a requested name for the new slug', () => {
    makeSource()
    expect(duplicatePrototype(workspaceRoot, 'orders', { name: 'Checkout v2' }).slug).toBe('checkout-v2')
  })

  it('refuses a requested name that is already taken', () => {
    makeSource()
    expect(() => duplicatePrototype(workspaceRoot, 'orders', { name: 'orders' })).toThrow(/already exists/)
  })

  it('refuses an unknown prototype rather than creating one', () => {
    expect(() => duplicatePrototype(workspaceRoot, 'nope')).toThrow(/does not exist/)
  })

  // A reference to the source would say "study yourself" once the copy carries it.
  it('drops a reference that would point at the copy itself', () => {
    makeSource()
    writePrototypeConfig(workspaceRoot, 'orders', { references: ['orders-copy'] })

    const copied = duplicatePrototype(workspaceRoot, 'orders')

    expect(readPrototypeConfig(workspaceRoot, copied.slug).references ?? []).toEqual([])
  })

  it('keeps the ordinary references of the source', () => {
    makeSource()
    createPrototype(workspaceRoot, { name: 'Quotes' })
    writePrototypeConfig(workspaceRoot, 'orders', { references: ['quotes'] })

    const copied = duplicatePrototype(workspaceRoot, 'orders')

    expect(readPrototypeConfig(workspaceRoot, copied.slug).references ?? []).toEqual(['quotes'])
  })
})
