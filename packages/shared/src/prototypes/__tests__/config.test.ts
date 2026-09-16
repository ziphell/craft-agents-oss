import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  LEGACY_BASE_PAGE_NAME,
  LEGACY_ENTRY_PAGE_NAME,
  getPrototypeConfigPath,
  getPrototypeDirPath,
  isPageKind,
  legacyPageRows,
  normalizePrototypePages,
  readPrototypeConfig,
  writePrototypeConfig,
} from '..'

const SLUG = 'checkout-flow'

function makePrototype(): string {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-config-'))
  mkdirSync(getPrototypeDirPath(workspaceRoot, SLUG), { recursive: true })
  return workspaceRoot
}

/** Write a config file straight to disk, bypassing the writer's normalisation. */
function writeRawConfig(workspaceRoot: string, value: unknown): void {
  writeFileSync(getPrototypeConfigPath(workspaceRoot, SLUG), JSON.stringify(value), 'utf-8')
}

describe('readPrototypeConfig', () => {
  let workspaceRoot = ''

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  // A prototype is created with no pages at all, and "no pages yet" is a true
  // statement rather than a broken config — so a missing file is not an error.
  it('has no pages when the prototype has no config', () => {
    workspaceRoot = makePrototype()
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({})
  })

  it('reads a written page table back, in declared order', () => {
    workspaceRoot = makePrototype()
    writePrototypeConfig(workspaceRoot, SLUG, {
      pages: [
        { name: 'cart', kind: 'scratch', entry: true },
        { name: 'orders', kind: 'scratch' },
        { name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay' },
      ],
    })

    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({
      pages: [
        { name: 'cart', kind: 'scratch', entry: true },
        { name: 'orders', kind: 'scratch' },
        { name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay' },
      ],
    })
  })

  // This file can be edited by hand or by another process, so a broken one is
  // expected rather than exceptional — it must not make the prototype unusable.
  it('reads a malformed config as no pages, instead of throwing', () => {
    workspaceRoot = makePrototype()
    writeFileSync(getPrototypeConfigPath(workspaceRoot, SLUG), '{ not json', 'utf-8')
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({})
  })

  // A top-level `kind` is what a pre-page-table config looked like; a value that
  // is not a page kind names no legacy shape, so there is no table to promote.
  it('reads an unknown top-level kind as no pages', () => {
    workspaceRoot = makePrototype()
    writeRawConfig(workspaceRoot, { kind: 'nonsense' })
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({})
  })

  it('reads references back', () => {
    workspaceRoot = makePrototype()
    writePrototypeConfig(workspaceRoot, SLUG, { references: ['rival-checkout'] })
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({ references: ['rival-checkout'] })
  })

  // A reference says "study something else", so pointing at yourself is
  // contradictory rather than merely useless.
  it('drops a self-reference', () => {
    workspaceRoot = makePrototype()
    writeRawConfig(workspaceRoot, { references: [SLUG, 'rival-checkout'] })
    expect(readPrototypeConfig(workspaceRoot, SLUG).references).toEqual(['rival-checkout'])
  })

  it('ignores a references value that is not an array', () => {
    workspaceRoot = makePrototype()
    writeRawConfig(workspaceRoot, { references: 'rival-checkout' })
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({})
  })

  it('drops blank and non-string entries, and de-duplicates', () => {
    workspaceRoot = makePrototype()
    writeRawConfig(workspaceRoot, { references: [' a ', 'a', '', 7, null, 'b'] })
    expect(readPrototypeConfig(workspaceRoot, SLUG).references).toEqual(['a', 'b'])
  })
})

/**
 * Old data is promoted on **read** (plan §19.7), so no prototype needs migrating:
 * a config written before the page table existed is read as rows of one, and the
 * file on disk is left alone until the next control-plane write.
 */
describe('reading a pre-page-table config', () => {
  let workspaceRoot = ''

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('reads a legacy overlay as an entry row plus its declared pages', () => {
    workspaceRoot = makePrototype()
    writeRawConfig(workspaceRoot, {
      kind: 'overlay',
      targetUrl: 'https://app.example.com/cart',
      pages: [
        { name: 'address', url: 'https://app.example.com/checkout/address' },
        { name: 'payment', url: 'https://app.example.com/checkout/payment' },
      ],
    })

    expect(readPrototypeConfig(workspaceRoot, SLUG).pages).toEqual([
      { name: LEGACY_ENTRY_PAGE_NAME, kind: 'overlay', url: 'https://app.example.com/cart', entry: true },
      { name: 'address', kind: 'overlay', url: 'https://app.example.com/checkout/address' },
      { name: 'payment', kind: 'overlay', url: 'https://app.example.com/checkout/payment' },
    ])
  })

  it('reads a legacy scratch prototype as its single page, base', () => {
    workspaceRoot = makePrototype()
    writeRawConfig(workspaceRoot, { kind: 'scratch' })

    expect(readPrototypeConfig(workspaceRoot, SLUG).pages).toEqual([
      { name: LEGACY_BASE_PAGE_NAME, kind: 'scratch', entry: true },
    ])
  })

  // A legacy prototype was one kind, so a `pages` list on a scratch config could
  // only have been overlay rows — and there was no such thing. The one page a
  // legacy scratch had is base.html.
  it('ignores a page list on a legacy scratch config', () => {
    workspaceRoot = makePrototype()
    writeRawConfig(workspaceRoot, {
      kind: 'scratch',
      pages: [{ name: 'orders', url: 'https://app.example.com/orders' }],
    })

    expect(readPrototypeConfig(workspaceRoot, SLUG).pages).toEqual([
      { name: LEGACY_BASE_PAGE_NAME, kind: 'scratch', entry: true },
    ])
  })

  // A legacy overlay without an address had nothing to open; it was not a page
  // then and it is not one now.
  it('reads a legacy overlay with no targetUrl as no pages', () => {
    workspaceRoot = makePrototype()
    writeRawConfig(workspaceRoot, { kind: 'overlay', targetUrl: 42 })
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({})
  })

  it('promotes old rows through the same rules as hand-written ones', () => {
    workspaceRoot = makePrototype()
    writeRawConfig(workspaceRoot, {
      kind: 'overlay',
      targetUrl: 'https://app.example.com/cart',
      pages: [{ name: 'cart-copy', url: 'https://app.example.com/cart' }],
    })

    const config = readPrototypeConfig(workspaceRoot, SLUG)

    expect(config.pages).toEqual([
      { name: LEGACY_ENTRY_PAGE_NAME, kind: 'overlay', url: 'https://app.example.com/cart', entry: true },
    ])
    expect(config.pageIssues?.join('\n')).toContain('is already another page\'s address')
  })
})

describe('legacyPageRows', () => {
  it('turns a legacy overlay into an entry row plus its declared pages', () => {
    expect(
      legacyPageRows({
        kind: 'overlay',
        targetUrl: 'https://app.example.com/cart',
        pages: [{ name: 'payment', url: 'https://app.example.com/pay' }],
      }),
    ).toEqual([
      { name: LEGACY_ENTRY_PAGE_NAME, kind: 'overlay', url: 'https://app.example.com/cart', entry: true },
      { name: 'payment', kind: 'overlay', url: 'https://app.example.com/pay' },
    ])
  })

  it('turns a legacy scratch prototype into the one page it had', () => {
    expect(legacyPageRows({ kind: 'scratch' })).toEqual([
      { name: LEGACY_BASE_PAGE_NAME, kind: 'scratch', entry: true },
    ])
  })

  it('emits no entry row for a legacy overlay with no address', () => {
    expect(legacyPageRows({ kind: 'overlay' })).toEqual([])
  })
})

describe('isPageKind', () => {
  it('knows the two kinds a page can be', () => {
    expect(isPageKind('scratch')).toBe(true)
    expect(isPageKind('overlay')).toBe(true)
    expect(isPageKind('nonsense')).toBe(false)
    expect(isPageKind(undefined)).toBe(false)
  })
})

/**
 * Every refused row is named. Dropping one quietly would mean the flow is missing
 * a screen and nothing anywhere says which — and a run of several bad lines must
 * still leave the good ones working.
 */
describe('normalizePrototypePages', () => {
  it('has nothing to say when there is no table', () => {
    expect(normalizePrototypePages(undefined)).toEqual({ pages: undefined, issues: [] })
  })

  it('says "not a list" rather than reading a table out of something else', () => {
    const { pages, issues } = normalizePrototypePages('cart')
    expect(pages).toBeUndefined()
    expect(issues.join('\n')).toContain('not a list of { name, kind }')
  })

  it('reports and drops a row that names no kind', () => {
    const { pages, issues } = normalizePrototypePages([{ name: 'cart' }])
    expect(pages).toBeUndefined()
    expect(issues.join('\n')).toContain('"cart"')
    expect(issues.join('\n')).toContain('needs a kind')
  })

  it('reports and drops an overlay row with no address', () => {
    const { pages, issues } = normalizePrototypePages([{ name: 'pay', kind: 'overlay' }])
    expect(pages).toBeUndefined()
    expect(issues.join('\n')).toContain('an overlay page needs a url')
  })

  it('drops the later of two rows sharing an address, and reports it', () => {
    const { pages, issues } = normalizePrototypePages([
      { name: 'cart', kind: 'overlay', url: 'https://app.example.com/cart' },
      { name: 'cart-copy', kind: 'overlay', url: 'https://app.example.com/cart' },
    ])

    expect(pages).toEqual([{ name: 'cart', kind: 'overlay', url: 'https://app.example.com/cart' }])
    expect(issues.join('\n')).toContain('"cart-copy"')
    expect(issues.join('\n')).toContain('one screen, one name')
  })

  it('drops the later of two rows sharing a name, and reports it', () => {
    const { pages, issues } = normalizePrototypePages([
      { name: 'cart', kind: 'scratch' },
      { name: 'cart', kind: 'scratch' },
    ])

    expect(pages).toEqual([{ name: 'cart', kind: 'scratch' }])
    expect(issues.join('\n')).toContain('already used by an earlier page')
  })

  // The page is real; the address is the part that cannot be honoured.
  it('keeps a scratch row that carries a url, and drops the url', () => {
    const { pages, issues } = normalizePrototypePages([
      { name: 'cart', kind: 'scratch', url: 'https://app.example.com/cart' },
    ])

    expect(pages).toEqual([{ name: 'cart', kind: 'scratch' }])
    expect(issues.join('\n')).toContain('a claim nothing will honour')
  })

  it('lets the first row keep the entry flag, and reports the second', () => {
    const { pages, issues } = normalizePrototypePages([
      { name: 'cart', kind: 'scratch', entry: true },
      { name: 'orders', kind: 'scratch', entry: true },
    ])

    expect(pages).toEqual([
      { name: 'cart', kind: 'scratch', entry: true },
      { name: 'orders', kind: 'scratch' },
    ])
    expect(issues.join('\n')).toContain('only one page can be the entry')
  })
})

describe('readPrototypeConfig page issues', () => {
  let workspaceRoot = ''

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('drops what it cannot read, and reports each one', () => {
    workspaceRoot = makePrototype()
    writeRawConfig(workspaceRoot, {
      pages: [
        { name: 'cart', kind: 'scratch', entry: true },
        { name: '', kind: 'scratch' },
        { name: 'cart', kind: 'overlay', url: 'https://app.example.com/other' },
        { name: 'pay', kind: 'overlay' },
        { name: 'orders', kind: 'scratch', entry: true },
        { name: 'stale', kind: 'nothing' },
        'nonsense',
      ],
    })

    const config = readPrototypeConfig(workspaceRoot, SLUG)

    expect(config.pages).toEqual([
      { name: 'cart', kind: 'scratch', entry: true },
      { name: 'orders', kind: 'scratch' },
    ])
    expect(config.pageIssues).toHaveLength(6)
    expect(config.pageIssues!.join('\n')).toContain('needs a name')
    expect(config.pageIssues!.join('\n')).toContain('already used by an earlier page')
    expect(config.pageIssues!.join('\n')).toContain('an overlay page needs a url')
    expect(config.pageIssues!.join('\n')).toContain('only one page can be the entry')
    expect(config.pageIssues!.join('\n')).toContain('needs a kind')
    expect(config.pageIssues!.join('\n')).toContain('expected { name, kind }')
  })

  // The diagnostic is for reading, not for writing: it must not leak back into the
  // file and turn into a fact about the prototype.
  it('never writes page issues back', () => {
    workspaceRoot = makePrototype()
    writeRawConfig(workspaceRoot, { pages: [{ name: 'pay', kind: 'overlay' }] })
    expect(readPrototypeConfig(workspaceRoot, SLUG).pageIssues).toHaveLength(1)

    writePrototypeConfig(workspaceRoot, SLUG, readPrototypeConfig(workspaceRoot, SLUG))

    expect(JSON.parse(readFileSync(getPrototypeConfigPath(workspaceRoot, SLUG), 'utf-8'))).toEqual({})
  })
})

describe('writePrototypeConfig', () => {
  let workspaceRoot = ''

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('drops a url on a scratch page rather than storing a claim nothing honours', () => {
    workspaceRoot = makePrototype()
    writePrototypeConfig(workspaceRoot, SLUG, {
      pages: [{ name: 'cart', kind: 'scratch', url: 'https://app.example.com/cart' }],
    })

    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({ pages: [{ name: 'cart', kind: 'scratch' }] })
  })

  // The writer normalises; it does not police. Whether an overlay page is
  // *allowed* to be written without an address is `updatePrototypePages`'s rule,
  // because adding a page is the only moment the address can still be asked for.
  it('omits an overlay row with a blank address rather than storing whitespace', () => {
    workspaceRoot = makePrototype()
    writePrototypeConfig(workspaceRoot, SLUG, { pages: [{ name: 'pay', kind: 'overlay', url: '   ' }] })

    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({})
  })

  it('omits an empty page table rather than writing an empty list', () => {
    workspaceRoot = makePrototype()
    writePrototypeConfig(workspaceRoot, SLUG, { pages: [] })

    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({})
    expect(readFileSync(getPrototypeConfigPath(workspaceRoot, SLUG), 'utf-8')).toBe('{}\n')
  })

  it('omits an empty references list rather than writing an empty array', () => {
    workspaceRoot = makePrototype()
    writePrototypeConfig(workspaceRoot, SLUG, { references: [] })

    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({})
  })

  // Writing is what retires the old shape: the file has no `kind` or `targetUrl`
  // at this level any more, so reading it back can only be the page table.
  it('writes a page table and nothing else', () => {
    workspaceRoot = makePrototype()
    writePrototypeConfig(workspaceRoot, SLUG, {
      pages: [{ name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay', entry: true }],
      references: ['rival-checkout'],
    })

    expect(JSON.parse(readFileSync(getPrototypeConfigPath(workspaceRoot, SLUG), 'utf-8'))).toEqual({
      pages: [{ name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay', entry: true }],
      references: ['rival-checkout'],
    })
  })
})
