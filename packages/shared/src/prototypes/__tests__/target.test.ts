import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createPrototype,
  linkPrototypeReference,
  readPrototypeConfig,
  requireTargetUrl,
  setPrototypeTargetUrl,
} from '..'

const SLUG = 'checkout-flow'

describe('setPrototypeTargetUrl', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-target-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  function makeOverlay(slug = SLUG, targetUrl = 'https://app.example.com/checkout'): string {
    return createPrototype(workspaceRoot, { name: slug, kind: 'overlay', targetUrl }).slug
  }

  /**
   * The reason this exists at all: one page, several environments. The same
   * patches are meant to be looked at in each, and an immutable address would turn
   * "look at it on staging" into "copy everything into a second prototype".
   */
  it('repoints an overlay at the same page in another environment', () => {
    const slug = makeOverlay()

    const updated = setPrototypeTargetUrl(workspaceRoot, slug, 'https://staging.example.com/checkout')

    expect(updated.targetUrl).toBe('https://staging.example.com/checkout')
    expect(readPrototypeConfig(workspaceRoot, slug)).toEqual({
      kind: 'overlay',
      targetUrl: 'https://staging.example.com/checkout',
    })
  })

  it('leaves everything else about the prototype alone', () => {
    const slug = makeOverlay()
    createPrototype(workspaceRoot, { name: 'rival-cart', kind: 'overlay', targetUrl: 'https://rival.example.com/cart' })
    linkPrototypeReference(workspaceRoot, slug, 'rival-cart')

    setPrototypeTargetUrl(workspaceRoot, slug, 'http://localhost:3000/checkout')

    const config = readPrototypeConfig(workspaceRoot, slug)
    expect(config.kind).toBe('overlay')
    expect(config.targetUrl).toBe('http://localhost:3000/checkout')
    expect(config.references).toEqual(['rival-cart'])
  })

  /**
   * A from-scratch prototype's page is its own document; a URL stored against it
   * would be a claim nothing honours (the same reason `writePrototypeConfig` drops
   * one). This is the only refusal left in this module — the risk of patches not
   * fitting another environment is the caller's to take, see the module note.
   */
  it('refuses a from-scratch prototype, which has no external page', () => {
    createPrototype(workspaceRoot, { name: 'quotes-flow', kind: 'scratch' })

    expect(() => setPrototypeTargetUrl(workspaceRoot, 'quotes-flow', 'https://app.example.com/x'))
      .toThrow(/from-scratch/)
  })

  it('refuses a prototype that does not exist, naming how to list them', () => {
    expect(() => setPrototypeTargetUrl(workspaceRoot, 'nope', 'https://app.example.com/x'))
      .toThrow(/prototype-list/)
  })

  it('refuses a value a browser cannot open', () => {
    const slug = makeOverlay()

    expect(() => setPrototypeTargetUrl(workspaceRoot, slug, 'app.example.com/checkout'))
      .toThrow(/Include the scheme/)
    // …and the old address is untouched.
    expect(readPrototypeConfig(workspaceRoot, slug).targetUrl).toBe('https://app.example.com/checkout')
  })

  it('trims the address rather than storing whitespace around it', () => {
    const slug = makeOverlay()

    expect(setPrototypeTargetUrl(workspaceRoot, slug, '  https://staging.example.com/checkout  ').targetUrl)
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
