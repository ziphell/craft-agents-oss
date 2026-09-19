import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createPrototype,
  describePrototypePages,
  getPrototypeDirPath,
  getPrototypePagePatchesPath,
  isPrototypePagePath,
  listPrototypePages,
  matchPrototypePage,
  setPrototypeBaseUrlResolver,
  updatePrototypePages,
  writePrototypeConfig,
  writePrototypePage,
  type PrototypePageEntry,
} from '..'

const ORIGIN = 'http://checkout-flow-abc123ab.localhost:41234'
const PAGE = '<!doctype html><html><body><h1>Checkout</h1></body></html>'

describe('isPrototypePagePath', () => {
  it('accepts a top-level document', () => {
    expect(isPrototypePagePath('orders.html')).toBe(true)
    expect(isPrototypePagePath('/orders.html')).toBe(true)
  })

  // Underlined names are the host's own: the shared layout and the generated page
  // index. That is the whole rule that keeps "is this a page" answerable without
  // a list to check against.
  it('refuses the host’s own files', () => {
    expect(isPrototypePagePath('_layout.html')).toBe(false)
    expect(isPrototypePagePath('_index')).toBe(false)
  })

  // base.html is no longer a special case: it is just the page an ordinary file
  // happens to name, which is what a legacy scratch prototype is promoted to.
  it('accepts base.html, which is a page like any other', () => {
    expect(isPrototypePagePath('base.html')).toBe(true)
  })

  it('refuses anything that is not a top-level document', () => {
    expect(isPrototypePagePath('flows/step1.html')).toBe(false)
    expect(isPrototypePagePath('dist/prototype.html')).toBe(false)
    expect(isPrototypePagePath('assets/app.css')).toBe(false)
    expect(isPrototypePagePath('')).toBe(false)
  })
})

describe('listPrototypePages', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-pages-'))
    setPrototypeBaseUrlResolver(() => ORIGIN)
  })

  afterEach(() => {
    setPrototypeBaseUrlResolver(null)
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /**
   * Two facts are merged here (plan §19.2): the filesystem says what exists, the
   * table says the order and the entry. So a document nobody declared is still a
   * page, and declaring one only places it in the flow.
   */
  it('lists the table first, then the documents nobody declared, by name', () => {
    createPrototype(workspaceRoot, { name: 'checkout-flow' })
    writePrototypePage(workspaceRoot, 'checkout-flow', 'cart', PAGE)
    writePrototypePage(workspaceRoot, 'checkout-flow', 'orders', PAGE)
    writePrototypePage(workspaceRoot, 'checkout-flow', 'payment', PAGE)
    writePrototypeConfig(workspaceRoot, 'checkout-flow', {
      pages: [{ name: 'cart', kind: 'scratch', entry: true }],
    })

    const dir = getPrototypeDirPath(workspaceRoot, 'checkout-flow')
    // None of these is a page: the layout is the host's, the rest are assets.
    mkdirSync(join(dir, 'flows'), { recursive: true })
    writeFileSync(join(dir, 'flows', 'step1.html'), PAGE, 'utf-8')
    writeFileSync(join(dir, 'notes.txt'), 'scratch', 'utf-8')
    writeFileSync(join(dir, '_layout.html'), '<html><slot name="page"></slot></html>', 'utf-8')

    const pages = listPrototypePages(workspaceRoot, 'checkout-flow')

    expect(pages.map((page) => page.name)).toEqual(['cart', 'orders', 'payment'])
    expect(pages[0]).toEqual({
      name: 'cart',
      kind: 'scratch',
      file: 'cart.html',
      url: `${ORIGIN}/cart.html`,
      entry: true,
      useLayout: true,
    })
    expect(pages[1]).toEqual({
      name: 'orders',
      kind: 'scratch',
      file: 'orders.html',
      url: `${ORIGIN}/orders.html`,
      entry: false,
      useLayout: true,
    })
  })

  // No row carries the entry flag, so the address root shows the generated page
  // index — the default, because no page of a flow is naturally the first one.
  it('has no entry when no row carries the flag', () => {
    createPrototype(workspaceRoot, { name: 'checkout-flow' })
    writePrototypePage(workspaceRoot, 'checkout-flow', 'orders', PAGE)

    const pages = listPrototypePages(workspaceRoot, 'checkout-flow')

    expect(pages.map((page) => page.name)).toEqual(['orders'])
    expect(pages.some((page) => page.entry)).toBe(false)
  })

  // A page can be a design of its own: its row says the shared layout does not wrap
  // it, which is the answer the rest of the engine reads off the resolved page —
  // and every other page, declared or not, keeps the default (plan §19.2).
  it('carries a page’s own answer about the shared layout', () => {
    createPrototype(workspaceRoot, { name: 'checkout-flow' })
    writePrototypePage(workspaceRoot, 'checkout-flow', 'cart', PAGE)
    writePrototypePage(workspaceRoot, 'checkout-flow', 'landing', PAGE)
    writePrototypeConfig(workspaceRoot, 'checkout-flow', {
      pages: [
        { name: 'cart', kind: 'scratch' },
        { name: 'landing', kind: 'scratch', useLayout: false },
      ],
    })

    const pages = listPrototypePages(workspaceRoot, 'checkout-flow')

    expect(pages.map((page) => `${page.name}:${page.useLayout}`)).toEqual(['cart:true', 'landing:false'])
  })

  it('lists an overlay row as a page with no document, on its own address', () => {
    createPrototype(workspaceRoot, { name: 'rival' })
    writePrototypeConfig(workspaceRoot, 'rival', {
      pages: [
        { name: 'pay', kind: 'overlay', url: 'https://rival.example.com/pay', entry: true },
      ],
    })

    expect(listPrototypePages(workspaceRoot, 'rival')).toEqual([
      {
        name: 'pay',
        kind: 'overlay',
        file: null,
        url: 'https://rival.example.com/pay',
        entry: true,
        // A live page is someone else's document: not ours to wrap (plan §19.2).
        useLayout: false,
      },
    ])
  })

  // An overlay page *is* its address, so a row without one describes nothing —
  // it is reported rather than guessed at, and it is not a page.
  it('lists nothing for an overlay row that records no address', () => {
    createPrototype(workspaceRoot, { name: 'rival' })
    writeFileSync(
      join(getPrototypeDirPath(workspaceRoot, 'rival'), 'config.json'),
      JSON.stringify({ pages: [{ name: 'pay', kind: 'overlay' }] }),
      'utf-8',
    )

    expect(listPrototypePages(workspaceRoot, 'rival')).toEqual([])
  })

  // A page file that disappeared is worth knowing about, not worth disappearing
  // twice: the row stays, with no document and an issue naming the file.
  it('keeps a declared page whose document is gone, and says so', () => {
    createPrototype(workspaceRoot, { name: 'checkout-flow' })
    writePrototypeConfig(workspaceRoot, 'checkout-flow', {
      pages: [{ name: 'cart', kind: 'scratch', entry: true }],
    })

    const table = describePrototypePages(workspaceRoot, 'checkout-flow')

    expect(table.pages).toEqual([
      { name: 'cart', kind: 'scratch', file: null, url: null, entry: true, useLayout: true },
    ])
    expect(table.issues.map((issue) => issue.code)).toEqual(['page.documentMissing'])
    expect(table.issues[0]?.text).toContain('cart.html is not in the prototype directory')
  })
})

describe('matchPrototypePage', () => {
  const pages = [
    {
      name: 'cart',
      kind: 'scratch' as const,
      file: 'cart.html',
      url: `${ORIGIN}/cart.html`,
      entry: true,
      useLayout: true,
    },
    {
      name: 'orders',
      kind: 'scratch' as const,
      file: 'orders.html',
      url: `${ORIGIN}/orders.html`,
      entry: false,
      useLayout: true,
    },
  ]

  it('names the page a URL is', () => {
    expect(matchPrototypePage(pages, `${ORIGIN}/cart.html`)).toBe('cart')
    expect(matchPrototypePage(pages, `${ORIGIN}/orders.html`)).toBe('orders')
  })

  // A history-API route is served by the entry document, so it *is* the entry page
  // rather than a page nobody listed.
  it('treats an unlisted path on the prototype’s own host as the entry page', () => {
    expect(matchPrototypePage(pages, `${ORIGIN}/orders/42`)).toBe('cart')
  })

  it('says nothing when the window is somewhere else', () => {
    expect(matchPrototypePage(pages, 'https://elsewhere.example.com/')).toBeNull()
    expect(matchPrototypePage(pages, 'about:blank')).toBeNull()
    expect(matchPrototypePage(pages, null)).toBeNull()
  })

  // Nothing is served at an overlay's own address, so there is no fallback there:
  // a redirect to `/login?next=…` is not the screen the prototype describes, and
  // claiming it is would hide exactly the thing worth noticing.
  it('does not fall back to the entry for an overlay page we do not serve', () => {
    const overlayPages = [
      {
        name: 'entry',
        kind: 'overlay' as const,
        file: null,
        url: 'https://app.example.com/checkout',
        entry: true,
        useLayout: false,
      },
    ]

    expect(matchPrototypePage(overlayPages, 'https://app.example.com/checkout')).toBe('entry')
    expect(matchPrototypePage(overlayPages, 'https://app.example.com/login?next=%2Fcheckout')).toBeNull()
  })
})

describe('the page table', () => {
  const SLUG = 'checkout-flow'
  const ENTRY = 'https://app.example.com/cart'
  const PAY = 'https://app.example.com/checkout/payment'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-pages-table-'))
    setPrototypeBaseUrlResolver(() => ORIGIN)
  })

  afterEach(() => {
    setPrototypeBaseUrlResolver(null)
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  function seed(rows: PrototypePageEntry[]): void {
    createPrototype(workspaceRoot, { name: SLUG })
    writePrototypeConfig(workspaceRoot, SLUG, { pages: rows })
  }

  function overlayRows(): PrototypePageEntry[] {
    return [
      { name: 'entry', kind: 'overlay', url: ENTRY, entry: true },
      { name: 'payment', kind: 'overlay', url: PAY },
    ]
  }

  // The point of the table: a flow's order is the order it was written in, not
  // alphabetical order, and "which screen is this" is answerable per page.
  it('lists the rows in table order, and names a later page by its own address', () => {
    seed([
      { name: 'entry', kind: 'overlay', url: ENTRY, entry: true },
      { name: 'payment', kind: 'overlay', url: PAY },
      { name: 'address', kind: 'overlay', url: 'https://app.example.com/checkout/address' },
    ])

    const pages = listPrototypePages(workspaceRoot, SLUG)

    expect(pages.map((page) => page.name)).toEqual(['entry', 'payment', 'address'])
    expect(matchPrototypePage(pages, PAY)).toBe('payment')
    expect(matchPrototypePage(pages, ENTRY)).toBe('entry')
  })

  // A flow may mix both kinds: two screens of ours plus the one live page we
  // cannot rebuild. Each row carries its own kind, and the order is the flow's.
  it('mixes both kinds in one flow, in table order', () => {
    seed([
      { name: 'cart', kind: 'scratch', entry: true },
      { name: 'orders', kind: 'scratch' },
      { name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay' },
    ])
    writePrototypePage(workspaceRoot, SLUG, 'cart', PAGE)
    writePrototypePage(workspaceRoot, SLUG, 'orders', PAGE)

    expect(listPrototypePages(workspaceRoot, SLUG)).toEqual([
      {
        name: 'cart',
        kind: 'scratch',
        file: 'cart.html',
        url: `${ORIGIN}/cart.html`,
        entry: true,
        useLayout: true,
      },
      {
        name: 'orders',
        kind: 'scratch',
        file: 'orders.html',
        url: `${ORIGIN}/orders.html`,
        entry: false,
        useLayout: true,
      },
      {
        name: 'pay',
        kind: 'overlay',
        file: null,
        url: 'https://app.example.com/pay',
        entry: false,
        useLayout: false,
      },
    ])
  })

  it('adds an overlay page at the end of the flow', () => {
    seed([{ name: 'entry', kind: 'overlay', url: ENTRY, entry: true }])

    const result = updatePrototypePages(workspaceRoot, SLUG, {
      op: 'add',
      name: 'done',
      url: 'https://app.example.com/checkout/done',
    })

    expect(result.note).toBe('added overlay page "done" → https://app.example.com/checkout/done')
    expect(result.pages.map((page) => page.name)).toEqual(['entry', 'done'])
  })

  // Declaring a page of ours is about order and entry, never creation: the
  // document is what makes it a page (plan §19.8), so `add` without an address is
  // refused unless the file is already there — and once it is, declaring it is how
  // that page is placed in the flow instead of being left where the filesystem
  // happens to put it (after the declared pages, by name).
  it('refuses to declare a page of ours, naming the file that would have to exist', () => {
    seed([])

    expect(() => updatePrototypePages(workspaceRoot, SLUG, { op: 'add', name: 'cart' }))
      .toThrow(/cart\.html has to exist/)

    // Writing the document alone is enough to have the page…
    writePrototypePage(workspaceRoot, SLUG, 'cart', PAGE)
    expect(listPrototypePages(workspaceRoot, SLUG).map((page) => page.name)).toEqual(['cart'])

    // …and the row is what gives it a position in the flow.
    const declared = updatePrototypePages(workspaceRoot, SLUG, { op: 'add', name: 'cart' })
    expect(declared.note).toMatch(/declared page "cart"/)
    expect(declared.pages).toEqual([{ name: 'cart', kind: 'scratch' }])
    expect(listPrototypePages(workspaceRoot, SLUG).map((page) => `${page.name}:${page.kind}`)).toEqual(['cart:scratch'])

    // Declaring the same page twice is not a second thing to say.
    expect(() => updatePrototypePages(workspaceRoot, SLUG, { op: 'add', name: 'cart' }))
      .toThrow(/already declares the page "cart"/)
  })

  // Re-adding a name is not how a page is repointed any more — every rule that
  // follows from a page's kind is fixed when the page is added (plan §13.2), and
  // `setPrototypePageUrl` is the one way an address moves.
  it('refuses to add a name the table already has', () => {
    seed(overlayRows())

    expect(() => updatePrototypePages(workspaceRoot, SLUG, {
      op: 'add',
      name: 'payment',
      url: 'https://staging.example.com/pay',
    })).toThrow(/already has a page "payment"/)
  })

  it('removes an overlay page from the flow', () => {
    seed(overlayRows())

    const result = updatePrototypePages(workspaceRoot, SLUG, { op: 'remove', name: 'payment' })

    expect(result.note).toBe('removed overlay page "payment" from the flow')
    expect(result.pages.map((page) => page.name)).toEqual(['entry'])
  })

  // A page of ours *is* its document, so removing the page removes it — and its
  // patches go with it, or they would sit under a directory no page owns.
  it('removes a page of ours together with its document and its patches', () => {
    seed([
      { name: 'cart', kind: 'scratch', entry: true },
      { name: 'orders', kind: 'scratch' },
    ])
    writePrototypePage(workspaceRoot, SLUG, 'orders', PAGE)
    mkdirSync(getPrototypePagePatchesPath(workspaceRoot, SLUG, 'orders'), { recursive: true })

    const result = updatePrototypePages(workspaceRoot, SLUG, { op: 'remove', name: 'orders' })

    expect(result.note).toContain('and its document orders.html')
    expect(existsSync(join(getPrototypeDirPath(workspaceRoot, SLUG), 'orders.html'))).toBe(false)
    expect(existsSync(getPrototypePagePatchesPath(workspaceRoot, SLUG, 'orders'))).toBe(false)
    expect(result.pages.map((page) => page.name)).toEqual(['cart'])
  })

  it('renames an overlay page, keeping its address', () => {
    seed([
      { name: 'entry', kind: 'overlay', url: ENTRY, entry: true },
      { name: 'pay', kind: 'overlay', url: PAY },
    ])

    const result = updatePrototypePages(workspaceRoot, SLUG, { op: 'rename', from: 'pay', to: 'payment' })

    expect(result.note).toBe('renamed overlay page "pay" to "payment"')
    expect(result.pages).toEqual([
      { name: 'entry', kind: 'overlay', url: ENTRY, entry: true },
      { name: 'payment', kind: 'overlay', url: PAY },
    ])
  })

  // A page of ours is three things at once — the file, its patch directory, and
  // the row that may carry the entry flag — so a rename has to move all of them.
  it('renames a page of ours, taking its document and its patches along', () => {
    seed([{ name: 'cart', kind: 'scratch', entry: true }])
    writePrototypePage(workspaceRoot, SLUG, 'cart', PAGE)
    mkdirSync(getPrototypePagePatchesPath(workspaceRoot, SLUG, 'cart'), { recursive: true })

    const result = updatePrototypePages(workspaceRoot, SLUG, { op: 'rename', from: 'cart', to: 'checkout' })

    expect(result.note).toContain('cart.html → checkout.html, and its patches')
    expect(result.pages).toEqual([{ name: 'checkout', kind: 'scratch', entry: true }])
    expect(existsSync(join(getPrototypeDirPath(workspaceRoot, SLUG), 'checkout.html'))).toBe(true)
    expect(existsSync(getPrototypePagePatchesPath(workspaceRoot, SLUG, 'checkout'))).toBe(true)
    expect(existsSync(join(getPrototypeDirPath(workspaceRoot, SLUG), 'cart.html'))).toBe(false)
  })

  // Every table operation rewrites the file, so a page's answer about the layout has
  // to travel through them: reframing a page as a side effect of renaming it or of
  // moving the entry would be a change nobody asked for (plan §19.2).
  it('keeps a page’s answer about the layout through a rename and an entry change', () => {
    seed([{ name: 'cart', kind: 'scratch', useLayout: false }])
    writePrototypePage(workspaceRoot, SLUG, 'cart', PAGE)

    const renamed = updatePrototypePages(workspaceRoot, SLUG, { op: 'rename', from: 'cart', to: 'checkout' })
    expect(renamed.pages).toEqual([{ name: 'checkout', kind: 'scratch', useLayout: false }])

    const entry = updatePrototypePages(workspaceRoot, SLUG, { op: 'entry', name: 'checkout' })
    expect(entry.pages).toEqual([{ name: 'checkout', kind: 'scratch', entry: true, useLayout: false }])
  })

  // The flag lives on a row, so a document nobody declared becomes one the moment it
  // has something to say — and a live page has nothing to say about a layout that is
  // not ours (plan §19.2).
  it('sets and clears whether the shared layout wraps a page', () => {
    seed([])
    writePrototypePage(workspaceRoot, SLUG, 'landing', PAGE)

    const off = updatePrototypePages(workspaceRoot, SLUG, { op: 'layout', name: 'landing', useLayout: false })
    expect(off.note).toContain('is served as written')
    expect(off.note).toContain('it can carry the flag')
    expect(off.pages).toEqual([{ name: 'landing', kind: 'scratch', useLayout: false }])

    // Going back to the default drops the key rather than storing a second way of
    // saying nothing.
    const on = updatePrototypePages(workspaceRoot, SLUG, { op: 'layout', name: 'landing', useLayout: true })
    expect(on.pages).toEqual([{ name: 'landing', kind: 'scratch' }])
    expect(on.note).toContain('is wrapped by the shared layout again')
  })

  it('refuses a layout decision about a page that is not there, or is not ours', () => {
    seed([{ name: 'pay', kind: 'overlay', url: PAY }])

    expect(() => updatePrototypePages(workspaceRoot, SLUG, { op: 'layout', name: 'nope', useLayout: false }))
      .toThrow(/has no page "nope"/)
    expect(() => updatePrototypePages(workspaceRoot, SLUG, { op: 'layout', name: 'pay', useLayout: false }))
      .toThrow(/someone else's document/)
  })

  // The entry is a flag on a row, so it can only ever point at a page that is
  // there — and clearing it hands the address root back to the page index.
  it('moves the entry flag to another page, and back to the index', () => {
    seed([
      { name: 'cart', kind: 'scratch', entry: true },
      { name: 'orders', kind: 'scratch' },
    ])

    const moved = updatePrototypePages(workspaceRoot, SLUG, { op: 'entry', name: 'orders' })

    expect(moved.note).toBe('"orders" is the entry page now')
    expect(moved.pages).toEqual([
      { name: 'cart', kind: 'scratch' },
      { name: 'orders', kind: 'scratch', entry: true },
    ])

    const back = updatePrototypePages(workspaceRoot, SLUG, { op: 'entry', name: null })

    expect(back.note).toBe('the address root shows the page index again')
    expect(back.pages.some((page) => page.entry)).toBe(false)
  })

  it('declares a document nobody listed, because only a row can carry the flag', () => {
    seed([])
    writePrototypePage(workspaceRoot, SLUG, 'orders', PAGE)

    const result = updatePrototypePages(workspaceRoot, SLUG, { op: 'entry', name: 'orders' })

    expect(result.note).toBe('"orders" is the entry page now (declared, so it can carry the flag)')
    expect(result.pages).toEqual([{ name: 'orders', kind: 'scratch', entry: true }])
  })

  // The failure names the way out: a name that does not exist is answered with the
  // names that do, rather than with "not found".
  it('refuses to remove, rename or enter a page that is not there, naming the ones that are', () => {
    seed(overlayRows())

    expect(() => updatePrototypePages(workspaceRoot, SLUG, { op: 'remove', name: 'nope' }))
      .toThrow(/Pages: entry, payment/)
    expect(() => updatePrototypePages(workspaceRoot, SLUG, { op: 'rename', from: 'nope', to: 'x' }))
      .toThrow(/Pages: entry, payment/)
    expect(() => updatePrototypePages(workspaceRoot, SLUG, { op: 'entry', name: 'nope' }))
      .toThrow(/Pages: entry, payment/)
  })

  // A name becomes a file name and an address segment, so it has to be usable as
  // both — and a leading "_" is the host's own namespace.
  it('refuses a name that is empty, reserved, or a path', () => {
    seed([])

    expect(() => updatePrototypePages(workspaceRoot, SLUG, { op: 'add', name: '  ', url: PAY }))
      .toThrow(/needs a name/)
    expect(() => updatePrototypePages(workspaceRoot, SLUG, { op: 'add', name: '_index', url: PAY }))
      .toThrow(/_index|reserved/)
    expect(() => updatePrototypePages(workspaceRoot, SLUG, { op: 'add', name: 'a/b', url: PAY }))
      .toThrow(/cannot be a page name/)
  })

  // An address a browser cannot open would be recorded happily and fail much
  // later, as nothing at all happening.
  it('refuses an address a browser cannot open', () => {
    seed([])

    expect(() => updatePrototypePages(workspaceRoot, SLUG, {
      op: 'add',
      name: 'x',
      url: 'app.example.com/x',
    })).toThrow(/not an address a browser can open/)
  })

  it('refuses a prototype that does not exist', () => {
    expect(() => updatePrototypePages(workspaceRoot, 'nope', { op: 'remove', name: 'x' }))
      .toThrow(/does not exist/)
  })
})
