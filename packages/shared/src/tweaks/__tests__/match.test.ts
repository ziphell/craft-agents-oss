import { describe, expect, it } from 'bun:test'
import {
  anyMatchPatternMatches,
  isValidMatchPattern,
  matchPatternMatches,
  parseMatchPattern,
  whyMatchPatternIsInvalid,
} from '../match'

describe('parseMatchPattern', () => {
  it('reads the three parts of the grammar', () => {
    expect(parseMatchPattern('*://*.example.com/admin/*')).toEqual({
      scheme: '*',
      host: 'example.com',
      subdomains: true,
      path: '/admin/*',
    })
    expect(parseMatchPattern('https://app.example.com/')).toEqual({
      scheme: 'https',
      host: 'app.example.com',
      subdomains: false,
      path: '/',
    })
    expect(parseMatchPattern('http://*/x')).toEqual({
      scheme: 'http',
      host: null,
      subdomains: false,
      path: '/x',
    })
  })

  it('refuses what the grammar does not allow', () => {
    for (const pattern of [
      'example.com/admin',       // no scheme
      'ftp://example.com/',      // a scheme a page cannot be
      'https://example.com',     // no path
      'https://example.com/a/*/b', // a wildcard that does not end the path
      'https://exa mple.com/',
      '',
    ]) {
      expect(isValidMatchPattern(pattern)).toBe(false)
      // The write path has to say something a person can act on.
      expect(whyMatchPatternIsInvalid(pattern)).toContain('match pattern')
    }

    expect(whyMatchPatternIsInvalid('*://*.example.com/admin/*')).toBeNull()
  })
})

describe('matchPatternMatches', () => {
  it('matches the scheme it names', () => {
    expect(matchPatternMatches('https://example.com/', 'https://example.com/')).toBe(true)
    expect(matchPatternMatches('https://example.com/', 'http://example.com/')).toBe(false)
    // `*` is the web's two schemes, not "anything".
    expect(matchPatternMatches('*://example.com/', 'http://example.com/')).toBe(true)
    expect(matchPatternMatches('*://example.com/', 'https://example.com/')).toBe(true)
    expect(matchPatternMatches('*://example.com/', 'file://example.com/')).toBe(false)
  })

  it('matches the host it names, and the subdomains only when it asked for them', () => {
    expect(matchPatternMatches('*://*.example.com/', 'https://example.com/')).toBe(true)
    expect(matchPatternMatches('*://*.example.com/', 'https://app.example.com/')).toBe(true)
    expect(matchPatternMatches('*://example.com/', 'https://app.example.com/')).toBe(false)
    // `*.example.com` is that domain and what is under it — not a suffix to be loose about.
    expect(matchPatternMatches('*://*.example.com/', 'https://notexample.com/')).toBe(false)
    expect(matchPatternMatches('*://*/', 'https://anything.test/')).toBe(true)
  })

  it('anchors the path, and lets only a trailing wildcard run past it', () => {
    expect(matchPatternMatches('*://example.com/admin/*', 'https://example.com/admin/users')).toBe(true)
    expect(matchPatternMatches('*://example.com/admin/*', 'https://example.com/admin/')).toBe(true)
    // The pattern has that slash in it, so the bare prefix is a different page.
    expect(matchPatternMatches('*://example.com/admin/*', 'https://example.com/admin')).toBe(false)
    // And the distinction this grammar is for: a tweak for an admin console must not
    // reach a page whose name merely starts the same way.
    expect(matchPatternMatches('*://example.com/admin/*', 'https://example.com/administrate')).toBe(false)
    expect(matchPatternMatches('*://example.com/', 'https://example.com/other')).toBe(false)
  })

  it('spans slashes with the wildcard, and ignores the query and fragment', () => {
    expect(matchPatternMatches('*://example.com/admin/*', 'https://example.com/admin/a/b/c')).toBe(true)
    expect(matchPatternMatches('*://example.com/', 'https://example.com/?q=1#top')).toBe(true)
  })

  it('answers nothing for a pattern or an address it cannot read', () => {
    expect(matchPatternMatches('not a pattern', 'https://example.com/')).toBe(false)
    expect(matchPatternMatches('*://example.com/', 'not a url')).toBe(false)
  })
})

describe('anyMatchPatternMatches', () => {
  it('is true when one of a tweak’s pages is this one', () => {
    const patterns = ['*://*.example.com/admin/*', 'https://other.test/report']

    expect(anyMatchPatternMatches(patterns, 'https://app.example.com/admin/users')).toBe(true)
    expect(anyMatchPatternMatches(patterns, 'https://other.test/report')).toBe(true)
    expect(anyMatchPatternMatches(patterns, 'https://other.test/')).toBe(false)
  })
})
