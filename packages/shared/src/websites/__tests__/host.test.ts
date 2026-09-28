import { describe, expect, it } from 'bun:test'
import { resolve } from 'path'
import { resolveWebsiteRequest, WEBSITE_DATA_PATH, WEBSITE_INDEX_FILE, type ServedWebsite } from '../host'

const DIR = resolve('/tmp/ws/websites/report')

const website: ServedWebsite = { workspaceRootPath: '/tmp/ws', slug: 'report', dir: DIR }

const HTML = 'text/html,application/xhtml+xml'

describe('resolveWebsiteRequest', () => {
  it('opens the site document at the address root', () => {
    expect(resolveWebsiteRequest(website, '', HTML)).toEqual({
      kind: 'file',
      path: resolve(DIR, WEBSITE_INDEX_FILE),
    })
  })

  // The site is a directory at its own origin, so a root-absolute path resolves to
  // a file of the site — which is the whole reason it has an origin.
  it('serves a file the site names, at any depth', () => {
    expect(resolveWebsiteRequest(website, 'assets/app.css', '*/*')).toEqual({
      kind: 'file',
      path: resolve(DIR, 'assets/app.css'),
    })
    expect(resolveWebsiteRequest(website, 'report.html', HTML)).toEqual({
      kind: 'file',
      path: resolve(DIR, 'report.html'),
    })
  })

  it('falls back to the document for a history-API route', () => {
    expect(resolveWebsiteRequest(website, 'orders', HTML)).toEqual({
      kind: 'file',
      path: resolve(DIR, WEBSITE_INDEX_FILE),
    })
  })

  // A missing path a script asked for must not come back as HTML: the caller
  // would try to parse a document as JSON.
  it('does not answer a fetch with the document', () => {
    const resolution = resolveWebsiteRequest(website, 'api/orders', '*/*')

    expect(resolution.kind).toBe('missing')
  })

  describe('the host’s own bookkeeping is never the site', () => {
    it('refuses the config, the poster and the store', () => {
      for (const requested of ['website.json', 'thumbnail.jpg', 'data/store.sqlite', 'data/notes.json']) {
        expect(resolveWebsiteRequest(website, requested, '*/*').kind).toBe('refused')
      }
    })

    // The one thing under `data/` that is the site's: the snapshot its store publishes.
    // A site has a real origin so its own scripts can fetch — this is what they fetch.
    it('serves the published data snapshot, which its own scripts fetch', () => {
      expect(resolveWebsiteRequest(website, WEBSITE_DATA_PATH, '*/*')).toEqual({
        kind: 'file',
        path: resolve(DIR, 'data', 'snapshot.json'),
      })
    })

    // The rule is about the site's own names, not about what a site may contain:
    // a file an author puts in a subdirectory is the author's.
    it('serves the same name once it is not at the root', () => {
      expect(resolveWebsiteRequest(website, 'assets/website.json', '*/*')).toEqual({
        kind: 'file',
        path: resolve(DIR, 'assets/website.json'),
      })
    })
  })

  it('refuses a path that escapes the directory', () => {
    expect(resolveWebsiteRequest(website, '../other-site/index.html', HTML).kind).toBe('refused')
    expect(resolveWebsiteRequest(website, '..%2f..%2fetc%2fpasswd', HTML).kind).toBe('refused')
  })
})
