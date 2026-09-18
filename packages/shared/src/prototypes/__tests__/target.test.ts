import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createPrototype,
  readPrototypeConfig,
  requireTargetUrl,
  setPrototypePageUrl,
  writePrototypeConfig,
  writePrototypePage,
} from '..'

const SLUG = 'checkout-flow'
const PAGE = '<!doctype html><html><body><h1>Quotes</h1></body></html>'

describe('setPrototypePageUrl', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-target-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /** A prototype whose one page is a live address. */
  function makeOverlay(slug = SLUG, url = 'https://app.example.com/checkout'): string {
    createPrototype(workspaceRoot, { name: slug })
    writePrototypeConfig(workspaceRoot, slug, {
      pages: [{ name: 'entry', kind: 'overlay', url, entry: true }],
    })
    return slug
  }

  /**
   * The reason this exists at all: one page, several environments. The same
   * patches are meant to be looked at in each, and an immutable address would turn
   * "look at it on staging" into "copy everything into a second prototype".
   */
  it('repoints a live page at the same page in another environment', () => {
    const slug = makeOverlay()

    const updated = setPrototypePageUrl(workspaceRoot, slug, 'https://staging.example.com/checkout')

    expect(updated.pages).toEqual([
      { name: 'entry', kind: 'overlay', url: 'https://staging.example.com/checkout', entry: true },
    ])
    expect(readPrototypeConfig(workspaceRoot, slug)).toEqual({
      pages: [{ name: 'entry', kind: 'overlay', url: 'https://staging.example.com/checkout', entry: true }],
    })
  })

  function makeTwoOverlays(): string {
    createPrototype(workspaceRoot, { name: SLUG })
    writePrototypeConfig(workspaceRoot, SLUG, {
      pages: [
        { name: 'cart', kind: 'overlay', url: 'https://app.example.com/cart', entry: true },
        { name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay' },
      ],
    })
    return SLUG
  }

  // A flow has several live pages, and "point it somewhere else" has to be able to
  // name which one.
  it('repoints the page it is told to, not the first one', () => {
    const slug = makeTwoOverlays()

    const updated = setPrototypePageUrl(workspaceRoot, slug, 'https://staging.example.com/pay', 'pay')

    expect(updated.pages).toEqual([
      { name: 'cart', kind: 'overlay', url: 'https://app.example.com/cart', entry: true },
      { name: 'pay', kind: 'overlay', url: 'https://staging.example.com/pay' },
    ])
  })

  it('repoints the entry page when it is not told which one', () => {
    const slug = makeTwoOverlays()

    setPrototypePageUrl(workspaceRoot, slug, 'https://staging.example.com/cart')

    expect(readPrototypeConfig(workspaceRoot, slug).pages?.[0]?.url).toBe('https://staging.example.com/cart')
  })

  it('leaves everything else about the prototype alone', () => {
    const slug = makeOverlay()
    // A second page, so "the rest of the table is untouched" has something to mean.
    writePrototypeConfig(workspaceRoot, slug, {
      pages: [
        { name: 'entry', kind: 'overlay', url: 'https://app.example.com/checkout', entry: true },
        { name: 'orders', kind: 'scratch' },
      ],
    })

    setPrototypePageUrl(workspaceRoot, slug, 'http://localhost:3000/checkout')

    const config = readPrototypeConfig(workspaceRoot, slug)
    expect(config.pages).toEqual([
      { name: 'entry', kind: 'overlay', url: 'http://localhost:3000/checkout', entry: true },
      { name: 'orders', kind: 'scratch' },
    ])
  })

  /**
   * A page of ours is a document in this prototype; a URL stored against it would
   * be a claim nothing honours (the same reason `writePrototypeConfig` drops one).
   * This is the one refusal left in this module — the risk of patches not fitting
   * another environment is the caller's to take, see the module note.
   */
  it('refuses a page of ours, which has no external page for an address to mean', () => {
    createPrototype(workspaceRoot, { name: 'quotes-flow' })
    writePrototypePage(workspaceRoot, 'quotes-flow', 'cart', PAGE)

    expect(() => setPrototypePageUrl(workspaceRoot, 'quotes-flow', 'https://app.example.com/x'))
      .toThrow(/scratch page/)
    // …and the same when the caller names it explicitly.
    expect(() => setPrototypePageUrl(workspaceRoot, 'quotes-flow', 'https://app.example.com/x', 'cart'))
      .toThrow(/scratch page/)
  })

  it('refuses a prototype with no pages, since there is nothing to point', () => {
    createPrototype(workspaceRoot, { name: 'empty' })

    expect(() => setPrototypePageUrl(workspaceRoot, 'empty', 'https://app.example.com/x'))
      .toThrow(/has no pages/)
    expect(() => setPrototypePageUrl(workspaceRoot, 'empty', 'https://app.example.com/x'))
      .toThrow(/pages --add/)
  })

  // One screen, one name: two pages claiming one address would make "which page am
  // I looking at" ambiguous rather than merely redundant.
  it('refuses an address another page of the flow already claims', () => {
    const slug = makeTwoOverlays()

    expect(() => setPrototypePageUrl(workspaceRoot, slug, 'https://app.example.com/pay', 'cart'))
      .toThrow(/already has page "pay"/)
  })

  it('refuses a prototype that does not exist, naming how to list them', () => {
    expect(() => setPrototypePageUrl(workspaceRoot, 'nope', 'https://app.example.com/x'))
      .toThrow(/list/)
  })

  it('refuses a value a browser cannot open', () => {
    const slug = makeOverlay()

    expect(() => setPrototypePageUrl(workspaceRoot, slug, 'app.example.com/checkout'))
      .toThrow(/Include the scheme/)
    // …and the old address is untouched.
    expect(readPrototypeConfig(workspaceRoot, slug).pages?.[0]?.url).toBe('https://app.example.com/checkout')
  })

  it('trims the address rather than storing whitespace around it', () => {
    const slug = makeOverlay()

    expect(setPrototypePageUrl(workspaceRoot, slug, '  https://staging.example.com/checkout  ').pages?.[0]?.url)
      .toBe('https://staging.example.com/checkout')
  })
})

describe('requireTargetUrl', () => {
  it('accepts http and https, and trims', () => {
    expect(requireTargetUrl('https://app.example.com/x')).toBe('https://app.example.com/x')
    expect(requireTargetUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x')
  })

  // The common typo: recorded happily, then failing much later as a navigation
  // error with nothing pointing back at the config.
  it('refuses a scheme-less value, and says what to add', () => {
    expect(() => requireTargetUrl('app.example.com/x')).toThrow(/Include the scheme/)
    expect(() => requireTargetUrl('')).toThrow(/not an address/)
  })
})
