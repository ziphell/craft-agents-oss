import { describe, expect, it } from 'bun:test'
import { isAllowedUrl } from '../chromium.ts'

/**
 * The network policy is the one part of printing that is a security boundary, so it is tested as
 * one: every case here is a URL a document could name, and the answer is either "the document's
 * own bytes" or "nothing".
 */
describe('isAllowedUrl', () => {
  it('always allows what is not network: the document itself and its bytes', () => {
    expect(isAllowedUrl('file:///tmp/report.html')).toBe(true)
    expect(isAllowedUrl('data:text/html,<p>hi')).toBe(true)
    expect(isAllowedUrl('blob:http://localhost:9100/2f0a1b')).toBe(true)
    expect(isAllowedUrl('about:blank')).toBe(true)
  })

  it('blocks the outside world when the host named nothing', () => {
    expect(isAllowedUrl('https://example.com/logo.png')).toBe(false)
    expect(isAllowedUrl('http://169.254.169.254/latest/meta-data/')).toBe(false)
    expect(isAllowedUrl('http://127.0.0.1:9100/api/exports/1')).toBe(false)
  })

  it('allows exactly the origins the host named, scheme and port included', () => {
    const policy = { allowedOrigins: ['http://127.0.0.1:9100'] }
    expect(isAllowedUrl('http://127.0.0.1:9100/office/docs/index.html', policy)).toBe(true)
    expect(isAllowedUrl('http://127.0.0.1:9100', policy)).toBe(true)
    // A different port is a different origin, and a different origin is somebody else's process.
    expect(isAllowedUrl('http://127.0.0.1:9101/office/docs/index.html', policy)).toBe(false)
    expect(isAllowedUrl('https://127.0.0.1:9100/office/docs/index.html', policy)).toBe(false)
    expect(isAllowedUrl('http://localhost:9100/office/docs/index.html', policy)).toBe(false)
  })

  it('refuses schemes that are neither the document nor http', () => {
    expect(isAllowedUrl('chrome://settings')).toBe(false)
    expect(isAllowedUrl('ftp://example.com/a.txt')).toBe(false)
  })
})
