import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createPrototype,
  getPrototypePatchesPath,
  getPrototypeDirPath,
  prototypeSlugFromName,
  readPrototypeBase,
  readPrototypeConfig,
  writePrototypeBase,
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

  it('creates the prototype and its patches folder, and seeds no base page', () => {
    // The default kind owns its own document, so there is nothing to be missing
    // on the other side of it: a new prototype is asked only for a name, and its
    // next step (write base.html, or import one) is always available.
    const created = createPrototype(workspaceRoot, { name: 'Checkout Flow' })

    expect(created.slug).toBe('checkout-flow')
    expect(created.kind).toBe('scratch')
    expect(existsSync(getPrototypePatchesPath(workspaceRoot, 'checkout-flow'))).toBe(true)
    expect(existsSync(created.baseHtmlPath)).toBe(false)
    expect(readPrototypeBase(workspaceRoot, 'checkout-flow')).toBeNull()
  })

  /**
   * An overlay's page *is* the address it was created against, and the kind is
   * fixed for the prototype's lifetime — so one created without an address would
   * have nothing to open, nothing to export against and no way to fill it in.
   * Creation is the only moment the address is still at hand, which is why the
   * refusal lives here rather than at the first command that needs it.
   */
  it('refuses an overlay with no target page', () => {
    expect(() => createPrototype(workspaceRoot, { name: 'Rival', kind: 'overlay' })).toThrow(/needs that page's address/)

    // …and leaves nothing behind, rather than a directory that looks deliberate.
    expect(existsSync(getPrototypeDirPath(workspaceRoot, 'rival'))).toBe(false)
  })

  it('takes an overlay with a target page, and records it', () => {
    const created = createPrototype(workspaceRoot, {
      name: 'Rival checkout',
      kind: 'overlay',
      targetUrl: 'https://rival.example.com/cart',
    })

    expect(created.kind).toBe('overlay')
    expect(readPrototypeConfig(workspaceRoot, created.slug)).toEqual({
      kind: 'overlay',
      targetUrl: 'https://rival.example.com/cart',
    })
  })

  // The same shape rule the later "change the address" path enforces (target.ts):
  // one rule with two entry points, so neither can be laxer than the other.
  it('refuses a target page a browser could not open', () => {
    expect(() => createPrototype(workspaceRoot, {
      name: 'Rival',
      kind: 'overlay',
      targetUrl: 'rival.example.com/cart',
    })).toThrow(/Include the scheme/)
  })

  // Same for scratch, even though its base will be our own document: an empty
  // one would claim a page exists, and both real ways to get a first page
  // (write it, import it) are reachable without one.
  it('seeds no base page for a scratch prototype either', () => {
    const created = createPrototype(workspaceRoot, { name: 'Quotes Flow', kind: 'scratch' })

    expect(created.kind).toBe('scratch')
    expect(existsSync(created.baseHtmlPath)).toBe(false)
    expect(readPrototypeBase(workspaceRoot, created.slug)).toBeNull()
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

describe('writePrototypeBase', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-write-base-'))
    createPrototype(workspaceRoot, { name: 'Checkout Flow', kind: 'scratch' })
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('writes base.html and reports its size', () => {
    const markup = '<html><body><h1>Rendered</h1></body></html>'

    const written = writePrototypeBase(workspaceRoot, 'checkout-flow', markup)

    expect(written.bytes).toBe(Buffer.byteLength(markup, 'utf-8'))
    expect(readPrototypeBase(workspaceRoot, 'checkout-flow')).toBe(markup)
  })

  it('accepts a doctype-prefixed document', () => {
    const markup = '<!doctype html><html><body>x</body></html>'
    expect(() => writePrototypeBase(workspaceRoot, 'checkout-flow', markup)).not.toThrow()
  })

  it('rejects a fragment, which would only fail later at export time', () => {
    expect(() => writePrototypeBase(workspaceRoot, 'checkout-flow', '<div>nope</div>')).toThrow(
      /complete HTML document/,
    )
  })

  it('refuses to write into a prototype that does not exist', () => {
    expect(() => writePrototypeBase(workspaceRoot, 'nope', '<html></html>')).toThrow(/does not exist/)
  })
})

describe('readPrototypeBase', () => {
  it('returns null when the prototype has no base page', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-read-base-'))
    try {
      mkdirSync(getPrototypeDirPath(workspaceRoot, 'empty'), { recursive: true })
      expect(readPrototypeBase(workspaceRoot, 'empty')).toBeNull()
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('reads back what was written', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-read-base-2-'))
    try {
      createPrototype(workspaceRoot, { name: 'Quotes', kind: 'scratch' })
      writePrototypeBase(workspaceRoot, 'quotes', '<html><body>quotes</body></html>')
      expect(readPrototypeBase(workspaceRoot, 'quotes')).toBe('<html><body>quotes</body></html>')
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })
})
