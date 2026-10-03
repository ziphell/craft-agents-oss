/**
 * Tests for the low-entropy client hints put back on requests.
 *
 * The point of these is coherence, so the cases that matter are the ones where adding a hint would
 * make the headers lie or disagree with the page: a platform Chromium does not name, a URL that is
 * not a secure context, and hints the engine already sent itself.
 */

import { describe, it, expect } from 'bun:test'
import { applyLowEntropyClientHints, type ClientHintIdentity } from '../browser-client-hints'

const WINDOWS: ClientHintIdentity = { chromiumMajor: '142', platform: 'win32' }

describe('applyLowEntropyClientHints', () => {
  it('adds the three hints a Chromium browser sends on its own', () => {
    const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0 ... Chrome/142.0.7444.235' }
    applyLowEntropyClientHints(headers, 'https://example.com/', WINDOWS)

    expect(headers['Sec-CH-UA']).toBe('"Not_A Brand";v="99", "Chromium";v="142"')
    expect(headers['Sec-CH-UA-Mobile']).toBe('?0')
    expect(headers['Sec-CH-UA-Platform']).toBe('"Windows"')
  })

  it('names no Google Chrome brand — the engine is Chromium, and the header must agree with the page', () => {
    const headers: Record<string, string> = {}
    applyLowEntropyClientHints(headers, 'https://example.com/', WINDOWS)

    expect(headers['Sec-CH-UA']).not.toContain('Google Chrome')
  })

  it('tracks the engine version rather than a literal', () => {
    const headers: Record<string, string> = {}
    applyLowEntropyClientHints(headers, 'https://example.com/', { chromiumMajor: '151', platform: 'win32' })

    expect(headers['Sec-CH-UA']).toContain('v="151"')
  })

  it('leaves plain http alone — a secure context is the only place Chromium sends them', () => {
    const headers: Record<string, string> = {}
    applyLowEntropyClientHints(headers, 'http://example.com/', WINDOWS)

    expect(headers).toEqual({})
  })

  it('treats the loopback origins as secure, the way the browser does', () => {
    for (const url of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://[::1]:8080/', 'http://app.localhost/']) {
      const headers: Record<string, string> = {}
      applyLowEntropyClientHints(headers, url, WINDOWS)
      expect(headers['Sec-CH-UA']).toBeDefined()
    }
  })

  it('does not duplicate hints the engine already sent, in any casing', () => {
    const headers: Record<string, string> = { 'sec-ch-ua': '"Not_A Brand";v="99", "Chromium";v="142"' }
    applyLowEntropyClientHints(headers, 'https://example.com/', WINDOWS)

    expect(Object.keys(headers).filter((key) => key.toLowerCase().startsWith('sec-ch-ua'))).toEqual(['sec-ch-ua'])
    expect(headers['Sec-CH-UA']).toBeUndefined()
  })

  it('says nothing on a platform Chromium does not name', () => {
    const headers: Record<string, string> = {}
    applyLowEntropyClientHints(headers, 'https://example.com/', { chromiumMajor: '142', platform: 'freebsd' })

    expect(headers).toEqual({})
  })

  it('names the platform the way Chromium does', () => {
    const cases: Array<[string, string]> = [['win32', '"Windows"'], ['darwin', '"macOS"'], ['linux', '"Linux"']]
    for (const [platform, token] of cases) {
      const headers: Record<string, string> = {}
      applyLowEntropyClientHints(headers, 'https://example.com/', { chromiumMajor: '142', platform })
      expect(headers['Sec-CH-UA-Platform']).toBe(token)
    }
  })

  it('leaves a URL it cannot parse alone', () => {
    const headers: Record<string, string> = {}
    applyLowEntropyClientHints(headers, 'not a url', WINDOWS)

    expect(headers).toEqual({})
  })
})
