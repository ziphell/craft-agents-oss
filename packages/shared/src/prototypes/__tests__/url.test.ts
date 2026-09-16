import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  getPrototypeDirPath,
  prototypeDocumentUrl,
  resolvePrototypeEntry,
  setPrototypeBaseUrlResolver,
  writePrototypeConfig,
  writePrototypePage,
} from '..'

const SLUG = 'checkout-flow'
const DOCUMENT = '<!doctype html><html><body><h1>Cart</h1></body></html>'

function makeWorkspace(): { workspaceRoot: string; dir: string } {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-url-'))
  const dir = getPrototypeDirPath(workspaceRoot, SLUG)
  mkdirSync(dir, { recursive: true })
  return { workspaceRoot, dir }
}

/** A prototype whose one page is a document of ours. */
function seedPage(workspaceRoot: string): void {
  mkdirSync(getPrototypeDirPath(workspaceRoot, SLUG), { recursive: true })
  writePrototypePage(workspaceRoot, SLUG, 'cart', DOCUMENT)
  writePrototypeConfig(workspaceRoot, SLUG, { pages: [{ name: 'cart', kind: 'scratch', entry: true }] })
}

describe('prototypeDocumentUrl', () => {
  let workspaceRoot = ''
  let dir = ''

  afterEach(() => {
    setPrototypeBaseUrlResolver(null)
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  // No host server (tests, or any host without one) must not break: a document
  // with no cookies, no API calls and no modules is still fine on file://.
  it('falls back to file:// when no resolver is installed', () => {
    ;({ workspaceRoot, dir } = makeWorkspace())
    const file = join(dir, 'cart.html')
    expect(prototypeDocumentUrl(workspaceRoot, SLUG, file).startsWith('file://')).toBe(true)
  })

  it('falls back to file:// when the resolver declines', () => {
    ;({ workspaceRoot, dir } = makeWorkspace())
    setPrototypeBaseUrlResolver(() => null)
    const file = join(dir, 'cart.html')
    expect(prototypeDocumentUrl(workspaceRoot, SLUG, file).startsWith('file://')).toBe(true)
  })

  it('uses the served origin and a path relative to the prototype', () => {
    ;({ workspaceRoot, dir } = makeWorkspace())
    setPrototypeBaseUrlResolver(() => 'http://checkout-flow-abc123ab.localhost:41234')

    expect(prototypeDocumentUrl(workspaceRoot, SLUG, join(dir, 'cart.html')))
      .toBe('http://checkout-flow-abc123ab.localhost:41234/cart.html')
    // Nested deliverables keep their shape, with forward slashes on every platform.
    expect(prototypeDocumentUrl(workspaceRoot, SLUG, join(dir, 'dist', 'extension', 'cart.html')))
      .toBe('http://checkout-flow-abc123ab.localhost:41234/dist/extension/cart.html')
  })

  // The URL must never be able to address a file outside the prototype, even if a
  // caller hands us one — the server would refuse it anyway, but a URL that tries
  // is a bug worth not producing.
  it('falls back rather than climbing out of the prototype', () => {
    ;({ workspaceRoot, dir } = makeWorkspace())
    setPrototypeBaseUrlResolver(() => 'http://checkout-flow-abc123ab.localhost:41234')

    const outside = join(workspaceRoot, 'projects', 'other', 'secret.html')
    expect(prototypeDocumentUrl(workspaceRoot, SLUG, outside).startsWith('file://')).toBe(true)
  })

  it('reaches the same origin through resolvePrototypeEntry', () => {
    ;({ workspaceRoot, dir } = makeWorkspace())
    // A page of ours: the host renders it from its own document. (A live page would
    // resolve to its recorded address instead — see export.test.ts.)
    seedPage(workspaceRoot)
    setPrototypeBaseUrlResolver(() => 'http://checkout-flow-abc123ab.localhost:41234')

    const entry = resolvePrototypeEntry(workspaceRoot, SLUG)
    // The origin root, not the file: that address is the document rendered with
    // every applicable patch, which no single file on disk represents.
    expect(entry.url).toBe('http://checkout-flow-abc123ab.localhost:41234')
    expect(entry.page).toBe('cart')
    expect(entry.path?.endsWith('cart.html')).toBe(true)
    expect(entry.injectPatches).toBe(false)
  })

  // Without a rendering host there is nothing to open that would show the
  // patches: `file://cart.html` looks like the prototype while being the one
  // document that has none of them.
  it('refuses to resolve an entry when no host serves prototypes', () => {
    ;({ workspaceRoot, dir } = makeWorkspace())
    seedPage(workspaceRoot)

    expect(() => resolvePrototypeEntry(workspaceRoot, SLUG)).toThrow(/No host is serving prototypes/)
  })
})
