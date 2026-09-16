import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  commitPrototype,
  createPrototype,
  getPrototypeDirPath,
  getPrototypePatchesPath,
  readPrototypeAnchors,
  recordPrototypeAnchors,
  scanPrototypePatches,
  writePrototypeConfig,
  writePrototypePage,
} from '..'

const SLUG = 'checkout-flow'
const DOCUMENT = '<!doctype html><html><head><title>Cart</title></head><body><h1>Cart</h1></body></html>'

function writePatch(workspaceRoot: string, file: string, source: string): void {
  const path = join(getPrototypePatchesPath(workspaceRoot, SLUG), file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source, 'utf-8')
}

function patchPath(workspaceRoot: string, file: string): string {
  return join(getPrototypePatchesPath(workspaceRoot, SLUG), file)
}

function readPrototypeFile(workspaceRoot: string, relative: string): string {
  return readFileSync(join(getPrototypeDirPath(workspaceRoot, SLUG), relative), 'utf-8')
}

describe('commitPrototype', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-commit-'))
    createPrototype(workspaceRoot, { name: SLUG })
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /**
   * A live page's base is someone else's address, so the delta can only be folded
   * into a layer of ours. That layer replays last, and it keeps the markers of
   * everything it folded — otherwise every anchor recorded for those patches would
   * look orphaned the moment they were folded (plan §21.3).
   */
  it('folds a live page’s patches into one consolidated layer', () => {
    writePrototypeConfig(workspaceRoot, SLUG, {
      pages: [{ name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay' }],
    })
    writePatch(workspaceRoot, 'pay/A-001-btn.css', '/* @requirement R-001\n   @target .pay-btn */\n.pay-btn { color: red }')
    writePatch(workspaceRoot, 'pay/A-002-guard.js', 'window.guarded = true')

    const result = commitPrototype(workspaceRoot, SLUG)

    expect(result.nothingToCommit).toBe(false)
    const scope = result.scopes[0]!
    expect(scope.page).toBe('pay')
    expect(scope.kind).toBe('overlay')
    expect(scope.folded).toEqual(['pay/A-001-btn.css'])
    expect(scope.promoted).toEqual(['pay/A-002-guard.js'])
    expect(scope.deleted).toEqual(['pay/A-001-btn.css', 'pay/A-002-guard.js'])
    expect(scope.unverified).toEqual([])

    expect(existsSync(patchPath(workspaceRoot, 'pay/A-001-btn.css'))).toBe(false)
    expect(existsSync(patchPath(workspaceRoot, 'pay/A-002-guard.js'))).toBe(false)

    const patches = scanPrototypePatches(workspaceRoot, SLUG)
    expect(patches.map((patch) => patch.file)).toEqual(['pay/Z-001-upper.css', 'pay/Z-002-upper.js'])
    // The markers survive the fold, which is what keeps the anchors and the
    // requirement thread alive through it.
    expect(patches[0]?.targets).toEqual(['.pay-btn'])
    expect(patches[0]?.lane).toBe('Z')
    expect(patches[0]?.source).toContain('.pay-btn { color: red }')
    expect(patches[0]?.source).toContain('patches/pay/A-001-btn.css')
  })

  it('folds a page of ours into its own assets, and links them from the document', () => {
    writePrototypePage(workspaceRoot, SLUG, 'cart', DOCUMENT)
    writePrototypeConfig(workspaceRoot, SLUG, { pages: [{ name: 'cart', kind: 'scratch', entry: true }] })
    writePatch(workspaceRoot, 'cart/A-001-btn.css', '/* @target .pay-btn */\n.pay-btn { color: red }')
    writePatch(workspaceRoot, 'cart/A-002-total.js', 'document.title = "cart"')

    const result = commitPrototype(workspaceRoot, SLUG)
    const scope = result.scopes[0]!

    expect(scope.folded).toEqual(['cart/A-001-btn.css'])
    expect(scope.promoted).toEqual(['cart/A-002-total.js'])
    expect(readPrototypeFile(workspaceRoot, 'assets/cart/committed.css')).toContain('.pay-btn { color: red }')
    expect(readPrototypeFile(workspaceRoot, 'assets/cart/committed.js')).toContain('document.title = "cart"')

    const document = readPrototypeFile(workspaceRoot, 'cart.html')
    expect(document).toContain('<link rel="stylesheet" href="/assets/cart/committed.css">')
    expect(document).toContain('<script src="/assets/cart/committed.js"></script>')
    // Still a document, and still the one the page was: the fold adds references,
    // it does not rewrite the page.
    expect(document.indexOf('</head>')).toBeGreaterThan(document.indexOf('committed.css'))
    expect(scanPrototypePatches(workspaceRoot, SLUG)).toEqual([])
  })

  /**
   * The second commit is the interesting one: the fold has nothing to take, and
   * saying so is what keeps "I committed" from looking like "I committed again".
   */
  it('is a no-op the second time, and says so', () => {
    writePrototypeConfig(workspaceRoot, SLUG, {
      pages: [{ name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay' }],
    })
    writePatch(workspaceRoot, 'pay/A-001-btn.css', '/* @target .btn */\n.btn { color: red }')

    commitPrototype(workspaceRoot, SLUG)
    const second = commitPrototype(workspaceRoot, SLUG)

    expect(second.nothingToCommit).toBe(true)
    expect(second.scopes).toEqual([])
    // The consolidated layer is the target of a commit, never its input.
    expect(scanPrototypePatches(workspaceRoot, SLUG).map((patch) => patch.file)).toEqual(['pay/Z-001-upper.css'])
  })

  it('folds the shared patches into a shared consolidated layer', () => {
    writePrototypeConfig(workspaceRoot, SLUG, {
      pages: [{ name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay' }],
    })
    writePatch(workspaceRoot, 'A-001-banner.css', '/* @target .banner */\n.banner { display: none }')

    const result = commitPrototype(workspaceRoot, SLUG)

    expect(result.scopes.map((scope) => scope.page)).toEqual([null])
    expect(scanPrototypePatches(workspaceRoot, SLUG).map((patch) => patch.file)).toEqual(['Z-001-upper.css'])
  })

  it('folds only the page it is told to, and leaves the shared patches alone', () => {
    writePrototypePage(workspaceRoot, SLUG, 'cart', DOCUMENT)
    writePrototypePage(workspaceRoot, SLUG, 'orders', DOCUMENT)
    writePrototypeConfig(workspaceRoot, SLUG, {
      pages: [
        { name: 'cart', kind: 'scratch', entry: true },
        { name: 'orders', kind: 'scratch' },
      ],
    })
    writePatch(workspaceRoot, 'A-001-banner.css', '/* @target .banner */\n.banner { display: none }')
    writePatch(workspaceRoot, 'cart/A-001-btn.css', '/* @target .btn */\n.btn { color: red }')
    writePatch(workspaceRoot, 'orders/A-001-row.css', '/* @target .row */\n.row { color: blue }')

    const result = commitPrototype(workspaceRoot, SLUG, { page: 'cart' })

    expect(result.scopes.map((scope) => scope.page)).toEqual(['cart'])
    expect(existsSync(patchPath(workspaceRoot, 'orders/A-001-row.css'))).toBe(true)
    expect(existsSync(patchPath(workspaceRoot, 'A-001-banner.css'))).toBe(true)
  })

  it('names why nothing could be folded when a page document is gone', () => {
    // Declared in the table, absent on disk — the one state a fold cannot act on.
    writePrototypeConfig(workspaceRoot, SLUG, { pages: [{ name: 'cart', kind: 'scratch', entry: true }] })
    writePatch(workspaceRoot, 'cart/A-001-btn.css', '/* @target .btn */\n.btn { color: red }')

    const result = commitPrototype(workspaceRoot, SLUG)

    expect(result.nothingToCommit).toBe(false)
    expect(result.scopes[0]?.refused).toEqual([
      { file: 'cart/A-001-btn.css', reason: 'the page document is missing, so there is nothing to fold into it' },
    ])
    expect(result.scopes[0]?.deleted).toEqual([])
    expect(existsSync(patchPath(workspaceRoot, 'cart/A-001-btn.css'))).toBe(true)
  })

  it('says which patches nobody could check, and folds them anyway', () => {
    writePrototypeConfig(workspaceRoot, SLUG, {
      pages: [{ name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay' }],
    })
    writePatch(workspaceRoot, 'pay/A-001-btn.css', '.btn { color: red }')

    const result = commitPrototype(workspaceRoot, SLUG)

    expect(result.scopes[0]?.unverified).toEqual(['pay/A-001-btn.css'])
    expect(result.scopes[0]?.folded).toEqual(['pay/A-001-btn.css'])
  })

  it('refuses a page that does not exist, naming the ones that do', () => {
    expect(() => commitPrototype(workspaceRoot, SLUG, { page: 'nope' })).toThrow(
      'No page "nope" in prototype "checkout-flow". Pages: (none)',
    )
  })

  /**
   * A page of ours is where its elements live after a fold, so its anchors have
   * nothing left to drift against. A live page is the opposite case and keeps
   * them — `anchors.test.ts` covers the record itself.
   */
  it('drops a page of ours’ anchors, and keeps a live page’s', () => {
    writePrototypePage(workspaceRoot, SLUG, 'cart', DOCUMENT)
    writePrototypeConfig(workspaceRoot, SLUG, {
      pages: [
        { name: 'cart', kind: 'scratch', entry: true },
        { name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay' },
      ],
    })
    writePatch(workspaceRoot, 'cart/A-001-btn.css', '/* @target .cart-btn */\n.cart-btn { color: red }')
    writePatch(workspaceRoot, 'pay/A-001-btn.css', '/* @target .pay-btn */\n.pay-btn { color: red }')
    const fingerprint = { tag: 'button', text: 'Pay', path: 'form > button', attrs: [] }
    recordPrototypeAnchors(workspaceRoot, SLUG, 'cart', {
      url: null,
      observed: [{ target: '.cart-btn', matched: 1, patches: ['cart/A-001-btn.css'], fingerprint }],
    })
    recordPrototypeAnchors(workspaceRoot, SLUG, 'pay', {
      url: 'https://app.example.com/pay',
      observed: [{ target: '.pay-btn', matched: 1, patches: ['pay/A-001-btn.css'], fingerprint }],
    })

    commitPrototype(workspaceRoot, SLUG)

    expect(readPrototypeAnchors(workspaceRoot, SLUG, 'cart')?.anchors).toEqual([])
    expect(readPrototypeAnchors(workspaceRoot, SLUG, 'pay')?.anchors.map((anchor) => anchor.target)).toEqual([
      '.pay-btn',
    ])
  })

  /**
   * The order rule, stated rather than inherited from the alphabet: a patch that
   * declares a high order in another lane still replays before the fold, because
   * what was folded is what it was folded *from* (plan §21.3).
   */
  it('replays the consolidated layer after everything else', () => {
    writePrototypeConfig(workspaceRoot, SLUG, {
      pages: [{ name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay' }],
    })
    writePatch(workspaceRoot, 'pay/A-001-btn.css', '/* @target .btn */\n.btn { color: red }')
    commitPrototype(workspaceRoot, SLUG)
    writePatch(workspaceRoot, 'pay/A-999-late.css', '/* @target .btn */\n.btn { color: green }')

    expect(scanPrototypePatches(workspaceRoot, SLUG).map((patch) => patch.file)).toEqual([
      'pay/A-999-late.css',
      'pay/Z-001-upper.css',
    ])
  })
})
