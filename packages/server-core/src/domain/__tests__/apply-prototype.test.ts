/**
 * Tests for the prototype ↔ live-browser bridge.
 *
 * The behaviour worth pinning is what the injector *does not* do: a page that
 * already arrived with its patches (the workbench's own rendered page) must not
 * have them run again, while a foreign document must still get all of them — and
 * a patch that belongs to another page must never be replayed on this one
 * (plan §19.4), which is why every case also says *whose* patches were replayed
 * (`result.page`).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildInlinedPatchProbeScript,
  createPrototype,
  getPrototypePagePatchesPath,
  getPrototypePatchesPath,
  setPrototypeBaseUrlResolver,
  writePrototypeConfig,
  writePrototypePage,
} from '@craft-agent/shared/prototypes'
import { applyPrototypeToBrowser } from '../apply-prototype'
import type { IBrowserPaneManager } from '../../handlers/browser-pane-manager-interface'

const PROBE = buildInlinedPatchProbeScript()

/** The address the host would serve this prototype on (url.ts), pinned so pages match. */
const ORIGIN = 'http://checkout-flow-abc123ab.localhost:41234'

const PAGE = '<!doctype html><html><body><h1>Checkout</h1></body></html>'

/** A stand-in browser pane that records what was done to the page. */
function makeBpm(inlined: unknown, currentUrl: string | null = null) {
  const evaluated: string[] = []
  const registered: string[] = []
  const cleared: string[] = []

  const bpm = {
    // The window's own URL is what decides which page's patches apply; null is
    // "no instance", i.e. a caller that cannot say where it is.
    getInstanceAsync: mock(async () =>
      currentUrl === null
        ? undefined
        : { ownerType: 'session', ownerSessionId: null, isVisible: true, title: '', currentUrl },
    ),
    evaluate: mock(async (_id: string, expression: string) => {
      // The probe is the only expression whose answer matters to the caller.
      if (expression === PROBE) return inlined
      evaluated.push(expression)
      return undefined
    }),
    addInitScript: mock(async (_id: string, key: string) => {
      registered.push(key)
      return key
    }),
    clearInitScripts: mock(async (_id: string, prefix: string) => {
      cleared.push(prefix)
      return []
    }),
  }

  return { bpm: bpm as unknown as IBrowserPaneManager, evaluated, registered, cleared }
}

describe('applyPrototypeToBrowser', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-apply-prototype-'))
    createPrototype(workspaceRoot, { name: slug })
    setPrototypeBaseUrlResolver(() => ORIGIN)
  })

  afterEach(() => {
    setPrototypeBaseUrlResolver(null)
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /** A shared patch: `patches/*` belongs to every page. */
  function writePatch(file: string, source: string): void {
    writeFileSync(join(getPrototypePatchesPath(workspaceRoot, slug), file), source, 'utf-8')
  }

  /** A page's own patch: `patches/<page>/*` is replayed on that page only. */
  function writePagePatch(page: string, file: string, source: string): void {
    const dir = getPrototypePagePatchesPath(workspaceRoot, slug, page)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, file), source, 'utf-8')
  }

  function writePage(name: string): void {
    writePrototypePage(workspaceRoot, slug, name, PAGE)
  }

  // An overlay's live page — a real document that knows nothing about us.
  it('injects every patch into a document that carries none', async () => {
    writePatch('A-001-btn.css', '.btn { color: red }')
    writePatch('A-002-guard.js', 'window.guard = true;')
    const { bpm, evaluated, registered, cleared } = makeBpm([], 'https://app.example.com/checkout')

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)

    expect(result.applied).toBe(2)
    expect(result.files).toEqual(['A-001-btn.css', 'A-002-guard.js'])
    expect(result.skipped).toEqual([])
    // Every patch here is shared and the window is on no page of this prototype,
    // so the answer says which scope was replayed instead of leaving it implicit.
    expect(result.page).toBeNull()
    expect(evaluated).toHaveLength(2)
    // Keys carry the slug, so clearing one prototype cannot touch another's.
    expect(registered).toEqual([
      `prototype:${slug}:A-001-btn.css`,
      `prototype:${slug}:A-002-guard.js`,
    ])
    expect(cleared).toEqual([`prototype:${slug}:`])
  })

  /**
   * The rendered page is the workbench's own document, and re-running a JS patch
   * that is already inlined is silently wrong: the page looks the same while the
   * patch has run twice.
   */
  it('leaves alone what the rendered page already carries', async () => {
    writePage('cart')
    writePatch('A-001-btn.css', '.btn { color: red }')
    const { bpm, evaluated, registered } = makeBpm(['A-001-btn.css'], `${ORIGIN}/cart.html`)

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)

    expect(result.page).toBe('cart')
    expect(result.applied).toBe(0)
    expect(result.files).toEqual([])
    expect(result.skipped).toEqual(['A-001-btn.css'])
    // Nothing ran now, and nothing is queued for the next load of that page.
    expect(evaluated).toEqual([])
    expect(registered).toEqual([])
  })

  // What keeps editing going on an open page: a patch written after it was
  // rendered still lands, in place, without disturbing the ones already there.
  it('injects a patch added after the render, and only that one', async () => {
    writePatch('A-001-btn.css', '.btn { color: red }')
    writePatch('A-002-new.js', 'window.newOne = true;')
    const { bpm, evaluated } = makeBpm(['A-001-btn.css'])

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)

    // No instance, so the caller cannot say which page it is on: the shared
    // patches are what is left to replay.
    expect(result.page).toBeNull()
    expect(result.applied).toBe(1)
    expect(result.files).toEqual(['A-002-new.js'])
    expect(result.skipped).toEqual(['A-001-btn.css'])
    expect(evaluated).toHaveLength(1)
    expect(evaluated[0]).toContain('window.newOne = true;')
  })

  // A patch belongs to a page (plan §19.4), so the window has to say which page it
  // is on — that is what stops `patches/orders/…` from landing on cart.
  it('replays the page the window is on, plus the shared patches', async () => {
    writePage('cart')
    writePage('orders')
    writePatch('A-001-btn.css', '.btn { color: red }')
    writePagePatch('cart', 'A-002-cart.js', 'window.cart = true;')
    writePagePatch('orders', 'A-003-orders.js', 'window.orders = true;')
    const { bpm, registered } = makeBpm([], `${ORIGIN}/cart.html`)

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)

    expect(result.page).toBe('cart')
    expect(result.files).toEqual(['A-001-btn.css', 'cart/A-002-cart.js'])
    // The page's name is part of the key, so two pages may each have an A-002.
    expect(registered).toEqual([
      `prototype:${slug}:A-001-btn.css`,
      `prototype:${slug}:cart/A-002-cart.js`,
    ])
  })

  // The window is somewhere the table does not describe. A page of ours is still
  // the page the prototype's own address renders, so the entry is what a bare
  // "apply" means — said out loud, so "the patch did nothing" stays distinguishable
  // from "the patch belongs to another page".
  it('falls back to the entry page when the window is on no described page', async () => {
    writePage('cart')
    writePage('orders')
    writePrototypeConfig(workspaceRoot, slug, {
      pages: [{ name: 'cart', kind: 'scratch', entry: true }],
    })
    writePatch('A-001-btn.css', '.btn { color: red }')
    writePagePatch('cart', 'A-002-cart.js', 'window.cart = true;')
    writePagePatch('orders', 'A-003-orders.js', 'window.orders = true;')
    const { bpm } = makeBpm([], 'https://app.example.com/elsewhere')

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)

    expect(result.page).toBe('cart')
    expect(result.files).toEqual(['A-001-btn.css', 'cart/A-002-cart.js'])
  })

  // The window wandered off the live page we described (a redirect, a sign-in
  // link). Another page's patches were written against a DOM that is not on
  // screen, so they are left out rather than guessed at.
  it('replays only the shared patches when no page of ours claims the window', async () => {
    writePrototypeConfig(workspaceRoot, slug, {
      pages: [{ name: 'checkout', kind: 'overlay', url: 'https://app.example.com/checkout', entry: true }],
    })
    writePatch('A-001-btn.css', '.btn { color: red }')
    writePagePatch('checkout', 'A-002-checkout.js', 'window.checkout = true;')
    const { bpm, evaluated } = makeBpm([], 'https://app.example.com/something-else')

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)

    expect(result.page).toBeNull()
    expect(result.files).toEqual(['A-001-btn.css'])
    expect(evaluated).toHaveLength(1)
  })

  // The mirror image: on the overlay page's own address, its patches are the ones
  // that belong there.
  it("replays an overlay page's own patches on its live address", async () => {
    writePrototypeConfig(workspaceRoot, slug, {
      pages: [{ name: 'checkout', kind: 'overlay', url: 'https://app.example.com/checkout', entry: true }],
    })
    writePatch('A-001-btn.css', '.btn { color: red }')
    writePagePatch('checkout', 'A-002-checkout.js', 'window.checkout = true;')
    const { bpm } = makeBpm([], 'https://app.example.com/checkout')

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)

    expect(result.page).toBe('checkout')
    expect(result.files).toEqual(['A-001-btn.css', 'checkout/A-002-checkout.js'])
  })

  // Assuming work was done is the dangerous direction: it would leave a page bare
  // while reporting success.
  it('treats an unreadable answer as an untouched document', async () => {
    writePatch('A-001-btn.css', '.btn { color: red }')
    const { bpm } = makeBpm(null)

    expect((await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)).applied).toBe(1)
  })

  it('reports nothing to do for a prototype with no patches', async () => {
    const { bpm, evaluated, cleared } = makeBpm([])

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)

    expect(result).toEqual({ slug, page: null, applied: 0, files: [], skipped: [] })
    expect(evaluated).toEqual([])
    // Still cleared: a registration left by a patch that was since deleted must go.
    expect(cleared).toEqual([`prototype:${slug}:`])
  })
})
