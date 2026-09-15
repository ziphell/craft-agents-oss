import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import {
  getPrototypeDirPath,
  prototypeDocumentUrl,
  setPrototypeBaseUrlResolver,
} from '@craft-agent/shared/prototypes'
import { installPrototypeBaseUrlResolver, resolveServedPath, startPrototypeServer } from '../prototype-server'

const DIR = resolve('/tmp/workspace/prototypes/checkout-flow')

/**
 * Go through loopback directly and carry the host in a header.
 *
 * Chromium resolves `*.localhost` to loopback (verified against this Electron
 * build), but Node's resolver does not, so the tests cannot dial the URL as
 * written. The server routes on the Host header either way, so overriding it
 * exercises the same code path.
 */
function fetchServed(url: string, init: RequestInit = {}) {
  const parsed = new URL(url)
  return fetch(`http://127.0.0.1:${parsed.port}${parsed.pathname}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), host: parsed.hostname },
  })
}

describe('resolveServedPath', () => {
  it('resolves a file inside the prototype', () => {
    expect(resolveServedPath(DIR, 'base.html')).toBe(resolve(DIR, 'base.html'))
    expect(resolveServedPath(DIR, 'dist/prototype.html')).toBe(resolve(DIR, 'dist/prototype.html'))
  })

  // This function is the only thing standing between a loopback HTTP request and
  // arbitrary files on disk, so every spelling of "go up" has to be refused.
  it('refuses to climb out of the prototype', () => {
    expect(resolveServedPath(DIR, '../other-prototype/base.html')).toBeNull()
    expect(resolveServedPath(DIR, 'dist/../../other/base.html')).toBeNull()
    expect(resolveServedPath(DIR, '../../../../etc/passwd')).toBeNull()
  })

  it('refuses an encoded traversal, which decodeURIComponent would otherwise turn back into ../', () => {
    expect(resolveServedPath(DIR, '%2e%2e/other/base.html')).toBeNull()
    expect(resolveServedPath(DIR, '..%2f..%2fetc%2fpasswd')).toBeNull()
  })

  // On Windows a backslash is a separator, so one left in place would smuggle a
  // parent segment past the prefix check.
  it('refuses backslashes and NUL', () => {
    expect(resolveServedPath(DIR, '..\\other\\base.html')).toBeNull()
    expect(resolveServedPath(DIR, 'base.html\0.png')).toBeNull()
  })

  // A sibling whose name merely starts with the same characters is not inside.
  it('refuses a sibling directory sharing the name prefix', () => {
    expect(resolveServedPath(DIR, '../checkout-flow-secrets/base.html')).toBeNull()
  })

  it('refuses a path that is not decodable', () => {
    expect(resolveServedPath(DIR, '%zz')).toBeNull()
  })
})

describe('prototype server over real HTTP', () => {
  const SLUG = 'checkout-flow'
  let workspaceRoot = ''
  let dir = ''
  let port = 0
  /** The address the workbench would hand out for the prototype's base page. */
  let entryUrl = ''

  beforeAll(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-server-'))
    dir = getPrototypeDirPath(workspaceRoot, SLUG)
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'base.html'), '<!doctype html><html><body>served</body></html>', 'utf-8')
    writeFileSync(join(dir, 'assets', 'app.css'), '.a{}', 'utf-8')
    // Outside the prototype, to prove it is not reachable.
    writeFileSync(join(workspaceRoot, 'secret.txt'), 'top secret', 'utf-8')

    port = (await startPrototypeServer()) ?? 0
    installPrototypeBaseUrlResolver()
    // Resolving the entry is what registers the prototype — and it is what the
    // app does whenever a prototype is opened or exported.
    entryUrl = prototypeDocumentUrl(workspaceRoot, SLUG, join(dir, 'base.html'))
  })

  afterAll(() => {
    setPrototypeBaseUrlResolver(null)
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('starts on a loopback port and hands out one host per prototype', () => {
    expect(port).toBeGreaterThan(0)
    // Readable (slug) and unique (directory hash), so two workspaces can both
    // own a `checkout-flow` without being served each other's files.
    expect(new URL(entryUrl).hostname).toMatch(/^checkout-flow-[0-9a-f]{8}\.localhost$/)
    // The prototype's directory is the origin root, not a path under it.
    expect(new URL(entryUrl).pathname).toBe('/base.html')
  })

  it('serves a file with the right type and no-store', async () => {
    const response = await fetchServed(entryUrl)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    // A cached base.html would show a previous capture with no hint of staleness.
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toContain('served')
  })

  // The reason the directory is the root: a page that assumes it owns its origin
  // writes `src="/assets/app.css"`, and that must land back on this prototype.
  it('serves root-absolute asset paths', async () => {
    const response = await fetchServed(new URL('/assets/app.css', entryUrl).toString())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8')
  })

  it('serves the prototype page at the origin root', async () => {
    const response = await fetchServed(new URL('/', entryUrl).toString())
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('served')
  })

  // The whole point of the root: it is the prototype *rendered*, so what a
  // reviewer opens is what an export would write right now. Serving base.html
  // would show a document with none of the patches.
  it('renders every patch into the page at the origin root', async () => {
    const patchesDir = join(dir, 'patches')
    mkdirSync(patchesDir, { recursive: true })
    writeFileSync(join(patchesDir, 'A-001-bold.css'), 'body { font-weight: 700 }', 'utf-8')
    writeFileSync(join(patchesDir, 'A-002-mark.js'), "document.body.dataset.marked = 'yes'", 'utf-8')

    const page = await (await fetchServed(new URL('/', entryUrl).toString())).text()

    expect(page).toContain('font-weight: 700')
    expect(page).toContain("dataset.marked = 'yes'")
    // …and it is still the base page, not a replacement for it.
    expect(page).toContain('served')

    // The raw base page stays reachable by name, with no patches in it.
    const raw = await (await fetchServed(entryUrl)).text()
    expect(raw).not.toContain('font-weight: 700')

    // Picking up a new patch needs no export and no restart.
    writeFileSync(join(patchesDir, 'A-003-late.css'), 'body { color: red }', 'utf-8')
    const after = await (await fetchServed(new URL('/', entryUrl).toString())).text()
    expect(after).toContain('color: red')
  })

  // A history-API route is a real request on reload; the SPA owns that path.
  it('falls back to the prototype page for an SPA route', async () => {
    const response = await fetchServed(new URL('/orders/42', entryUrl).toString(), {
      headers: { accept: 'text/html,application/xhtml+xml' },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('served')
  })

  // …but a missing script must stay a 404: answering it with HTML turns a clear
  // failure into a confusing parse error.
  it('does not fall back for a path that names a file', async () => {
    const response = await fetchServed(new URL('/missing.js', entryUrl).toString(), {
      headers: { accept: 'text/html' },
    })
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('<!doctype')
  })

  it('404s a host that was never handed out', async () => {
    const parsed = new URL(entryUrl)
    const response = await fetch(`http://127.0.0.1:${parsed.port}/base.html`, {
      headers: { host: 'not-a-prototype.localhost' },
    })
    expect(response.status).toBe(404)
  })

  it('404s a name with extra labels', async () => {
    const parsed = new URL(entryUrl)
    const response = await fetch(`http://127.0.0.1:${parsed.port}/base.html`, {
      headers: { host: `evil.${parsed.hostname}` },
    })
    expect(response.status).toBe(404)
  })

  // Note what this does and does not prove: the URL parser normalizes `..` (and
  // its `%2e` spellings) away before the request is even sent, so at this level
  // the traversal never reaches the server. The server's own refusal is covered
  // by the `resolveServedPath` tests above — this one only pins the observable
  // outcome, that no spelling reaches the file.
  it('never reaches a file outside the prototype', async () => {
    for (const spelling of ['../secret.txt', '%2e%2e/secret.txt', '..%2fsecret.txt']) {
      const response = await fetchServed(new URL(`/${spelling}`, entryUrl).toString())
      expect(`${spelling}: ${response.status}`).toBe(`${spelling}: 404`)
      expect(await response.text()).not.toContain('top secret')
    }
  })

  it('405s anything but GET/HEAD', async () => {
    const posted = await fetchServed(entryUrl, { method: 'POST' })
    expect(posted.status).toBe(405)
    expect(posted.headers.get('allow')).toBe('GET, HEAD')
  })
})

/**
 * A prototype whose base page is gone but whose deliverable is still on disk.
 *
 * The two must not be confused: the deliverable is reachable by name, and the
 * origin root is not a place to serve it from. Doing so would hand back a page
 * that looks like the prototype while being a frozen snapshot of an older state
 * — and one you cannot go on editing.
 */
describe('a prototype with no base page', () => {
  const SLUG = 'exported-only'
  let workspaceRoot = ''
  let origin = ''

  beforeAll(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-server-nobase-'))
    const dir = getPrototypeDirPath(workspaceRoot, SLUG)
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'prototype.html'), '<!doctype html><html><body>frozen</body></html>', 'utf-8')

    await startPrototypeServer()
    installPrototypeBaseUrlResolver()
    // Registering happens through the resolver, exactly as the app does it.
    origin = new URL(prototypeDocumentUrl(workspaceRoot, SLUG, join(dir, 'base.html'))).origin
  })

  afterAll(() => {
    setPrototypeBaseUrlResolver(null)
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('serves nothing at the origin root', async () => {
    const response = await fetchServed(`${origin}/`)
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('no page yet')
  })

  it('still serves the exported deliverable when it is named', async () => {
    const response = await fetchServed(`${origin}/dist/prototype.html`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('frozen')
  })
})
