import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createPrototype,
  getPrototypeConfigPath,
  getPrototypeDirPath,
  getPrototypePatchesPath,
  listPrototypePages,
  prototypeSlugFromName,
  readPrototypeLayout,
  readPrototypePage,
  updatePrototypePages,
  writePrototypePage,
} from '..'

describe('prototypeSlugFromName', () => {
  it('lowercases and collapses anything outside [a-z0-9] into a dash', () => {
    expect(prototypeSlugFromName('Checkout Flow v2')).toBe('checkout-flow-v2')
    expect(prototypeSlugFromName('  Quotes   &   Orders  ')).toBe('quotes-orders')
  })

  it('cannot produce a path-escaping slug, whatever the name', () => {
    // The point is not that these names are sensible — it is that none of them
    // can address something outside the prototypes directory.
    for (const name of ['../../etc/passwd', '..\\..\\windows', '/absolute/path', 'a/../b']) {
      const slug = prototypeSlugFromName(name)
      expect(slug).not.toContain('/')
      expect(slug).not.toContain('\\')
      expect(slug).not.toContain('..')
    }
  })

  it('produces an empty slug for a name with no usable characters', () => {
    expect(prototypeSlugFromName('!!!')).toBe('')
    expect(prototypeSlugFromName('中文名称')).toBe('')
  })
})

describe('createPrototype', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-create-prototype-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /**
   * Creation asks for a name and nothing else (plan §19.8): it writes no page and
   * no config, because "this prototype has no pages yet" is a true statement, and a
   * seeded document would assert a screen that is not there. It writes no layout
   * either: `_layout.html` appears when two pages would repeat the same shared markup, which
   * is a fact about the flow rather than a guess creation can make (plan §19.2).
   */
  it('creates the directory and its patches folder, and nothing else', () => {
    const created = createPrototype(workspaceRoot, { name: 'Checkout Flow' })

    expect(created.slug).toBe('checkout-flow')
    expect(created.dir).toBe(getPrototypeDirPath(workspaceRoot, 'checkout-flow'))
    expect(existsSync(created.patchesPath)).toBe(true)

    // The whole directory, so the shape of a new prototype is checkable rather than
    // assumed — and a layout is not part of it.
    expect(readdirSync(created.dir).sort()).toEqual(['patches'])
    expect(existsSync(getPrototypeConfigPath(workspaceRoot, 'checkout-flow'))).toBe(false)
    expect(listPrototypePages(workspaceRoot, 'checkout-flow')).toEqual([])
    expect(readPrototypeLayout(workspaceRoot, 'checkout-flow')).toBeNull()
  })

  /**
   * A kind and an address are facts about a *page*, so neither belongs here any
   * more: they are asked for where a page is added, which is also the only moment
   * an address is still at hand.
   */
  it('takes a name and nothing else — a kind is asked for where a page is added', () => {
    const created = createPrototype(workspaceRoot, { name: 'Rival checkout' })

    expect(listPrototypePages(workspaceRoot, created.slug)).toEqual([])
    expect(() => updatePrototypePages(workspaceRoot, created.slug, {
      op: 'add',
      name: 'pay',
      url: 'rival.example.com/cart',
    })).toThrow(/browser can open/)
  })

  it('refuses to reuse an existing prototype rather than mixing two sets of patches', () => {
    createPrototype(workspaceRoot, { name: 'Checkout Flow' })

    expect(() => createPrototype(workspaceRoot, { name: 'checkout-flow' })).toThrow(/already exists/)
  })

  it('refuses a name that yields no usable slug', () => {
    expect(() => createPrototype(workspaceRoot, { name: '!!!' })).toThrow(/usable slug/)
    // …and leaves nothing behind.
    expect(existsSync(getPrototypeDirPath(workspaceRoot, ''))).toBe(false)
  })
})

describe('writePrototypePage', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-write-page-'))
    createPrototype(workspaceRoot, { name: 'Checkout Flow' })
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('writes the page under its own name and reports its size', () => {
    const markup = '<html><body><h1>Rendered</h1></body></html>'

    const written = writePrototypePage(workspaceRoot, 'checkout-flow', 'cart', markup)

    expect(written.page).toBe('cart')
    expect(written.path.endsWith('cart.html')).toBe(true)
    expect(written.bytes).toBe(Buffer.byteLength(markup, 'utf-8'))
    expect(readPrototypePage(workspaceRoot, 'checkout-flow', 'cart.html')).toBe(markup)
    // Writing the file is enough to have a page: nothing has to be declared.
    expect(listPrototypePages(workspaceRoot, 'checkout-flow').map((page) => page.name)).toEqual(['cart'])
  })

  it('accepts a doctype-prefixed document', () => {
    const markup = '<!doctype html><html><body>x</body></html>'
    expect(() => writePrototypePage(workspaceRoot, 'checkout-flow', 'cart', markup)).not.toThrow()
  })

  it('rejects a fragment, which would only fail later at export time', () => {
    expect(() => writePrototypePage(workspaceRoot, 'checkout-flow', 'cart', '<div>nope</div>')).toThrow(
      /complete HTML document/,
    )
  })

  // The name becomes the file name and an address segment, so it has to be usable
  // as both — and a leading "_" is the host's own namespace (the layout, the index).
  it('refuses a name that cannot be a page', () => {
    expect(() => writePrototypePage(workspaceRoot, 'checkout-flow', '_layout', '<html></html>')).toThrow(
      /cannot be a page name/,
    )
    expect(() => writePrototypePage(workspaceRoot, 'checkout-flow', 'flows/cart', '<html></html>')).toThrow(
      /cannot be a page name/,
    )
  })

  it('refuses to write into a prototype that does not exist', () => {
    expect(() => writePrototypePage(workspaceRoot, 'nope', 'cart', '<html></html>')).toThrow(/does not exist/)
  })
})

describe('readPrototypePage', () => {
  it('returns null when the document is not there', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-read-page-'))
    try {
      mkdirSync(getPrototypeDirPath(workspaceRoot, 'empty'), { recursive: true })
      expect(readPrototypePage(workspaceRoot, 'empty', 'cart.html')).toBeNull()
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('reads back what was written', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-read-page-2-'))
    try {
      createPrototype(workspaceRoot, { name: 'Quotes' })
      writePrototypePage(workspaceRoot, 'quotes', 'quotes', '<html><body>quotes</body></html>')
      expect(readPrototypePage(workspaceRoot, 'quotes', 'quotes.html')).toBe('<html><body>quotes</body></html>')
      expect(existsSync(getPrototypePatchesPath(workspaceRoot, 'quotes'))).toBe(true)
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })
})
