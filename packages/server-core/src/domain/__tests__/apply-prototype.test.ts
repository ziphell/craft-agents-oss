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
  getPrototypeDirPath,
  getPrototypePagePatchesPath,
  getPrototypePatchesPath,
  readPrototypeAnchors,
  setPrototypeBaseUrlResolver,
  writePrototypeConfig,
  writePrototypePage,
} from '@craft-agent/shared/prototypes'
import { applyPrototypeToBrowser, replayPrototypeInBrowser } from '../apply-prototype'
import type { IBrowserPaneManager } from '../../handlers/browser-pane-manager-interface'

const PROBE = buildInlinedPatchProbeScript()

/** The address the host would serve this prototype on (url.ts), pinned so pages match. */
const ORIGIN = 'http://checkout-flow-abc123ab.localhost:41234'

const PAGE = '<!doctype html><html><body><h1>Checkout</h1></body></html>'

/** A stand-in browser pane that records what was done to the page. */
function makeBpm(
  inlined: unknown,
  pageUrl: string | null = null,
  answers: { state?: unknown; fingerprints?: unknown; candidates?: unknown } = {},
) {
  const evaluated: string[] = []
  const registered: string[] = []
  const cleared: string[] = []
  const reloaded: string[] = []

  /**
   * The tab the command is about — the conversation's tab, which the *caller* names
   * (`pickCommandTarget` on the server side). Null is "no tab to judge by": a window with no
   * tabs, which is the same answer a caller with no instance gets.
   */
  const page = pageUrl === null ? null : { id: 'tab-1', url: pageUrl }

  const bpm = {
    evaluate: mock(async (_id: string, expression: string) => {
      // The probes are the only expressions whose answer matters to the caller.
      // Told apart by a distinctive line rather than by identity, because two are
      // built per call — and *not* by "mentions the state key", which every patch
      // script does now that each patch reports what it observed.
      if (expression === PROBE) return inlined
      if (expression.includes('const measured = (entry.matches')) return answers.state ?? {}
      if (expression.includes('const entries =')) return answers.candidates ?? {}
      if (expression.includes('out[target] = el ?')) return answers.fingerprints ?? {}
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
    reload: mock((id: string) => {
      reloaded.push(id)
    }),
  }

  return { bpm: bpm as unknown as IBrowserPaneManager, page, evaluated, registered, cleared, reloaded }
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
    const { bpm, page, evaluated, registered, cleared } = makeBpm([], 'https://app.example.com/checkout')

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug, page)

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
    const { bpm, page, evaluated, registered } = makeBpm(['A-001-btn.css'], `${ORIGIN}/cart.html`)

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug, page)

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
    const { bpm, page, registered } = makeBpm([], `${ORIGIN}/cart.html`)

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug, page)

    expect(result.page).toBe('cart')
    expect(result.files).toEqual(['A-001-btn.css', 'cart/A-002-cart.js'])
    // The page's name is part of the key, so two pages may each have an A-002.
    expect(registered).toEqual([
      `prototype:${slug}:A-001-btn.css`,
      `prototype:${slug}:cart/A-002-cart.js`,
    ])
  })

  /**
   * `--file`: one patch put on the page on its own — the loop a patch being iterated on
   * runs in. The clearing step is what makes this a real difference rather than a narrower
   * scan: a whole-set replay drops every registration and re-adds the pending ones, which
   * for one file would un-apply everything else on the next load.
   */
  describe('one named file', () => {
    it('injects that file alone, and touches no other registration', async () => {
      writePatch('A-001-btn.css', '.btn { color: red }')
      writePagePatch('cart', 'B-001-total.js', 'window.total = 1;')
      const { bpm, page, evaluated, registered, cleared } = makeBpm([], 'https://app.example.com/checkout')

      const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug, page, {
        file: join(getPrototypePatchesPath(workspaceRoot, slug), 'cart/B-001-total.js'),
      })

      expect(result.applied).toBe(1)
      expect(result.files).toEqual(['cart/B-001-total.js'])
      expect(result.file).toEqual({ name: 'cart/B-001-total.js', page: 'cart' })
      expect(registered).toEqual([`prototype:${slug}:cart/B-001-total.js`])
      expect(cleared).toEqual([])
      expect(evaluated).toHaveLength(1)
      expect(evaluated[0]).toContain('window.total = 1;')
    })

    // Two different questions, and only one of them can be read off the file: which page
    // the command acted on, and which page the patch belongs to. With another page open,
    // every target matching nothing has to be readable as the second answer.
    it('reports the file\'s own page beside the page the command acted on', async () => {
      writePage('cart')
      writePage('orders')
      writePagePatch('cart', 'B-001-total.js', 'window.total = 1;')
      const { bpm, page } = makeBpm([], `${ORIGIN}/orders.html`)

      const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug, page, {
        file: join(getPrototypePagePatchesPath(workspaceRoot, slug, 'cart'), 'B-001-total.js'),
      })

      expect(result.page).toBe('orders')
      expect(result.file).toEqual({ name: 'cart/B-001-total.js', page: 'cart' })
    })

    // The injector ignores files that are not named as patches, so a file named on purpose
    // and then not applied is exactly the outcome that has to be said out loud.
    it('refuses a file that is not a patch, saying which way it went wrong', async () => {
      const { bpm } = makeBpm([])
      const outside = join(workspaceRoot, 'notes.js')
      writeFileSync(outside, 'console.log(1)', 'utf-8')
      // Inside the prototype, but not under its `patches/` — a document of ours, not a change.
      const notUnderPatches = join(getPrototypeDirPath(workspaceRoot, slug), 'notes.md')
      writeFileSync(notUnderPatches, 'thoughts', 'utf-8')
      writePatch('README.md', 'not a patch, and never replayed')
      const apply = (file: string) =>
        applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug, null, { file })

      await expect(apply(join(workspaceRoot, 'missing.js'))).rejects.toThrow(/No such file/)
      await expect(apply(outside)).rejects.toThrow(/not inside prototype/)
      await expect(apply(notUnderPatches)).rejects.toThrow(/is not a patch/)
      await expect(apply(join(getPrototypePatchesPath(workspaceRoot, slug), 'README.md'))).rejects.toThrow(
        /is not a patch of prototype/,
      )
    })
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
    const { bpm, page } = makeBpm([], 'https://app.example.com/elsewhere')

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug, page)

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
    const { bpm, page, evaluated } = makeBpm([], 'https://app.example.com/something-else')

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug, page)

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
    const { bpm, page } = makeBpm([], 'https://app.example.com/checkout')

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug, page)

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

    expect(result).toEqual({
      slug,
      page: null,
      file: null,
      applied: 0,
      files: [],
      skipped: [],
      targets: [],
      unmatched: [],
      drifted: [],
      untargeted: [],
    })
    expect(evaluated).toEqual([])
    // Still cleared: a registration left by a patch that was since deleted must go.
    expect(cleared).toEqual([`prototype:${slug}:`])
  })

  /**
   * What each declared target made of the page (plan §21.1/§21.2). Without this,
   * a patch whose selector is wrong and a patch that changes nothing look the
   * same in every report the workbench produces.
   */
  it('names a declared target that matched nothing, and records what did match', async () => {
    writePatch('A-001-miss.css', '/* @target .gone */\n.gone { color: red }')
    writePatch('A-002-hit.css', '/* @target .btn */\n.btn { color: red }')
    const { bpm } = makeBpm([], null, {
      state: {
        'A-001-miss.css': { matches: { '.gone': 0 }, error: null },
        'A-002-hit.css': { matches: { '.btn': 2 }, error: null },
      },
      fingerprints: {
        '.btn': { tag: 'button', text: 'Pay now', path: 'form > button', attrs: ['#pay'] },
      },
    })

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)

    expect(result.unmatched).toEqual(['.gone'])
    expect(result.targets).toEqual([
      { file: 'A-001-miss.css', target: '.gone', matched: 0, recorded: false },
      { file: 'A-002-hit.css', target: '.btn', matched: 2, recorded: false },
    ])
    // The one that matched is the one worth remembering; the one that never did
    // is reported, not recorded (an anchor with no date beside it would read as
    // evidence of something).
    const record = readPrototypeAnchors(workspaceRoot, slug, null)
    expect(record?.anchors.map((anchor) => anchor.target)).toEqual(['.btn'])
    expect(record?.anchors[0]?.matched).toBe(2)
  })

  it('says which patches nothing could check, because they declare no target', async () => {
    writePatch('A-001-btn.css', '.btn { color: red }')
    const { bpm } = makeBpm([], null)

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)

    expect(result.untargeted).toEqual(['A-001-btn.css'])
  })

  /**
   * Drift, which needs the record: the same selector matched when the patch was
   * written and does not now. That is a page that moved — and because the anchor
   * kept a fingerprint, a replacement can be proposed instead of only reported.
   */
  it('reports a target that used to match as drift, with what it looks like now', async () => {
    writePatch('A-001-btn.css', '/* @target .btn */\n.btn { color: red }')
    const fingerprint = { tag: 'button', text: 'Pay now', path: 'form > button', attrs: ['#pay'] }

    const first = makeBpm([], 'https://app.example.com/checkout', {
      state: { 'A-001-btn.css': { matches: { '.btn': 1 }, error: null } },
      fingerprints: { '.btn': fingerprint },
    })
    await applyPrototypeToBrowser(first.bpm, 'browser-1', workspaceRoot, slug, first.page)
    expect(readPrototypeAnchors(workspaceRoot, slug, null)?.anchors[0]?.fingerprint).toEqual(fingerprint)

    // The site was redeployed: the selector the patch was written against is gone.
    const second = makeBpm([], 'https://app.example.com/checkout', {
      state: { 'A-001-btn.css': { matches: { '.btn': 0 }, error: null } },
      candidates: { '.btn': ['#pay'] },
    })
    const result = await applyPrototypeToBrowser(second.bpm, 'browser-1', workspaceRoot, slug, second.page)

    // Not "unmatched": it has a record of matching, so this is the page moving.
    expect(result.unmatched).toEqual([])
    expect(result.drifted).toHaveLength(1)
    expect(result.drifted[0]?.target).toBe('.btn')
    expect(result.drifted[0]?.suggestions).toEqual(['#pay'])
    expect(result.drifted[0]?.lastMatchedAt).not.toBe('')
  })

  /**
   * The replay after a file change (plan §21.4) reads which case it is off the
   * document: a page of ours arrives with its patches inlined, so re-registering
   * them would double the js on the next render — it is reloaded instead.
   */
  it('reloads a page of ours rather than injecting into it again', async () => {
    writePage('cart')
    writePatch('A-001-btn.css', '.btn { color: red }')
    const { bpm, page, evaluated, registered, reloaded } = makeBpm(['A-001-btn.css'], `${ORIGIN}/cart.html`)

    const result = await replayPrototypeInBrowser(bpm, 'browser-1', workspaceRoot, slug, page)

    expect(result.action).toBe('reloaded')
    expect(result.page).toBe('cart')
    expect(reloaded).toEqual(['browser-1'])
    expect(evaluated).toEqual([])
    expect(registered).toEqual([])
  })

  it('applies the patches to a page that carries none', async () => {
    writePatch('A-001-btn.css', '.btn { color: red }')
    const { bpm, page, evaluated, reloaded } = makeBpm([], 'https://app.example.com/checkout')

    const result = await replayPrototypeInBrowser(bpm, 'browser-1', workspaceRoot, slug, page)

    expect(result.action).toBe('applied')
    expect(result.applied).toBe(1)
    expect(evaluated).toHaveLength(1)
    expect(reloaded).toEqual([])
  })
})
