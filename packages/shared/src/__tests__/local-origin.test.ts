import { describe, expect, it } from 'bun:test'
import {
  contentTypeFor,
  localHostLabel,
  localHostOrigin,
  labelFromHost,
  LOCAL_HOST_SUFFIX,
} from '../local-origin'

describe('localHostLabel', () => {
  it('is readable (the slug) plus the directory hash', () => {
    const label = localHostLabel('checkout-flow', '/ws/sites/checkout-flow')

    expect(label.startsWith('checkout-flow-')).toBe(true)
    expect(label.slice('checkout-flow-'.length)).toMatch(/^[0-9a-f]{8}$/)
  })

  // Why the hash is there at all: a slug is unique only within one workspace, so the
  // directory — not the name — is what a label names.
  it('gives the same slug in two directories two labels', () => {
    const here = localHostLabel('cart', '/ws/sites/cart')
    const elsewhere = localHostLabel('cart', '/other/workspace/sites/cart')

    expect(here).not.toBe(elsewhere)
  })

  it('sanitises a slug down to a DNS label', () => {
    expect(localHostLabel('My Cart! 2', '/ws/sites/cart')).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/)
    expect(localHostLabel('x'.repeat(120), '/ws/sites/cart').length).toBeLessThanOrEqual(63)
  })
})

describe('localHostOrigin', () => {
  it('is an origin, not a URL', () => {
    expect(localHostOrigin('cart-1a2b3c4d')).toBe(`http://cart-1a2b3c4d${LOCAL_HOST_SUFFIX}`)
  })
})

describe('labelFromHost', () => {
  it('reads the label back, with or without a port', () => {
    expect(labelFromHost('cart-1a2b3c4d.localhost')).toBe('cart-1a2b3c4d')
    expect(labelFromHost('cart-1a2b3c4d.localhost:5173')).toBe('cart-1a2b3c4d')
  })

  it('refuses a name that is not one of ours', () => {
    expect(labelFromHost('example.com')).toBeNull()
    expect(labelFromHost(undefined)).toBeNull()
    // Two labels would reach something through a name nobody handed out.
    expect(labelFromHost('a.b.localhost')).toBeNull()
  })
})

describe('contentTypeFor', () => {
  // Every response carries `nosniff`, so a font answered as octet-stream is refused
  // by the browser rather than decoded. What is served here therefore has to be
  // named correctly, not merely plausibly.
  it('names the fonts and XML a served app loads as subresources', () => {
    expect(contentTypeFor('/fonts/diagram.woff2')).toBe('font/woff2')
    expect(contentTypeFor('/fonts/diagram.otf')).toBe('font/otf')
    expect(contentTypeFor('/stencils/aws.xml')).toBe('application/xml; charset=utf-8')
  })

  it('is case-insensitive and falls back for the unknown', () => {
    expect(contentTypeFor('/IMG/Logo.PNG')).toBe('image/png')
    expect(contentTypeFor('/drawio-assets.json')).toBe('application/json; charset=utf-8')
    expect(contentTypeFor('/mystery.bin')).toBe('application/octet-stream')
  })
})
