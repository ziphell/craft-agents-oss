/**
 * Tests for "which prototype is this page, and which page of it" (plan §22).
 *
 * The rule these pin: **the page decides first**, and the conversation's binding
 * only answers for a page that can say nothing. Getting that backwards is not a
 * cosmetic bug — it tells an agent to patch one prototype while it is looking at
 * another, and the window it is looking at is the one that shows the truth.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createPrototype,
  setPrototypeBaseUrlResolver,
  updatePrototypePages,
  writePrototypePage,
} from '@craft-agent/shared/prototypes'
import type { BrowserTabSummary } from '@craft-agent/shared/protocol'
import { describePrototypeAtPage } from '../prototype-page'

/** The address the host serves prototypes on, pinned so pages match. */
const ORIGIN = 'http://checkout-flow-abc123ab.localhost'

const PAGE = '<!doctype html><html><body><h1>Checkout</h1></body></html>'

/** One page as the browser side reports it. */
function tab(overrides: Partial<BrowserTabSummary> = {}): BrowserTabSummary {
  return {
    id: 'tab-1',
    url: 'about:blank',
    title: 'Checkout',
    favicon: null,
    isLoading: false,
    active: true,
    prototype: null,
    prototypePage: null,
    disposition: null,
    belongsTo: null,
    driverSessionId: null,
    cursorOf: null,
    lockedBy: null,
    ...overrides,
  }
}

describe('describePrototypeAtPage', () => {
  const slug = 'checkout-flow'
  const otherSlug = 'rival-checkout'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-page-'))
    createPrototype(workspaceRoot, { name: slug })
    createPrototype(workspaceRoot, { name: otherSlug })
    setPrototypeBaseUrlResolver(() => ORIGIN)
  })

  afterEach(() => {
    setPrototypeBaseUrlResolver(null)
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /** A page of ours: a document in the prototype's directory, addressed under its origin. */
  function writeScratchPage(name: string, prototypeSlug = slug): void {
    writePrototypePage(workspaceRoot, prototypeSlug, name, PAGE)
  }

  /** A live page: someone else's address, declared so the table knows where it is. */
  function addLivePage(name: string, url: string, prototypeSlug = slug): void {
    updatePrototypePages(workspaceRoot, prototypeSlug, { op: 'add', name, url })
  }

  it('reads the prototype off the page, not off the conversation', () => {
    writeScratchPage('cart')

    // The page says it is the *other* prototype's; the conversation is bound to
    // this one. The page wins — that is the whole rule.
    const result = describePrototypeAtPage(
      tab({
        url: `${ORIGIN}/cart.html`,
        prototype: { slug: otherSlug, origin: ORIGIN },
        prototypePage: 'cart',
      }),
      slug,
      `${ORIGIN}/cart.html`,
      workspaceRoot,
    )

    expect(result?.slug).toBe(otherSlug)
    expect(result?.page).toBe('cart')
  })

  it('takes the page name the browser side already worked out', () => {
    addLivePage('pay', 'https://app.example.com/pay')

    const result = describePrototypeAtPage(
      tab({
        url: 'https://app.example.com/pay',
        prototype: { slug, origin: ORIGIN },
        prototypePage: 'pay',
      }),
      undefined,
      'https://app.example.com/pay',
      workspaceRoot,
    )

    // An overlay's address says nothing about which page it is; the name can only
    // come from the page table, which the browser side asked.
    expect(result?.page).toBe('pay')
    expect(result?.kind).toBe('overlay')
    expect(result?.origin).toBe(ORIGIN)
  })

  it('falls back to the conversation for a page that belongs to no prototype', () => {
    writeScratchPage('cart')

    const result = describePrototypeAtPage(
      tab({ url: 'https://docs.example.com/' }),
      slug,
      'https://docs.example.com/',
      workspaceRoot,
    )

    // The conversation's prototype is named, and both the page and its kind are
    // null: the window is on no page of the flow, which is worth saying rather
    // than guessing.
    expect(result?.slug).toBe(slug)
    expect(result?.page).toBeNull()
    expect(result?.kind).toBeNull()
  })

  it('places a page on the prototype\'s own address that the table does not describe', () => {
    writeScratchPage('cart')

    // No page declared it, but it is on this prototype's origin — the generated
    // index, say. It is still this prototype's, on no page of it.
    const result = describePrototypeAtPage(
      tab({ url: `${ORIGIN}/_index` }),
      slug,
      `${ORIGIN}/_index`,
      workspaceRoot,
    )

    expect(result?.slug).toBe(slug)
    expect(result?.page).toBeNull()
  })

  it('says nothing when neither the page nor the conversation knows', () => {
    expect(
      describePrototypeAtPage(tab({ url: 'https://docs.example.com/' }), undefined, 'https://docs.example.com/', workspaceRoot),
    ).toBeNull()
    expect(describePrototypeAtPage(undefined, null, null, workspaceRoot)).toBeNull()
  })
})
