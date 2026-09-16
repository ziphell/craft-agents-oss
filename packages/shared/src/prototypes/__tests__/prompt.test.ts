import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildPrototypePromptContext,
  createPrototype,
  formatPrototypeContextForPrompt,
  linkPrototypeReference,
  writePrototypeConfig,
  writePrototypePage,
  type PrototypePromptContext,
} from '..'

/** A context with nothing interesting in it apart from what a test sets. */
function makeContext(overrides: Partial<PrototypePromptContext> = {}): PrototypePromptContext {
  return {
    slug: 'checkout-flow',
    dir: '/tmp/prototypes/checkout-flow',
    pages: [],
    entryPage: null,
    layoutPath: null,
    references: [],
    projectSlug: null,
    requirements: [],
    findings: [],
    patches: [],
    services: [],
    distFiles: [],
    violations: [],
    ...overrides,
  }
}

describe('formatPrototypeContextForPrompt', () => {
  // A live page is an address on someone else's site, and a copy of it would run
  // none of that page's own JavaScript. So the block must not send the agent
  // looking for a document that is never going to exist.
  it('tells the agent a live page is an address, not a copy of it', () => {
    const text = formatPrototypeContextForPrompt(
      makeContext({
        pages: [{ name: 'pay', kind: 'overlay', url: 'https://app.example.com/cart', file: null, entry: true }],
        entryPage: 'pay',
      }),
    )

    expect(text).toContain('**overlay**')
    expect(text).toContain('- pay (overlay) — https://app.example.com/cart (entry)')
    expect(text).toContain('never copied')
    expect(text).toContain("The address root (/) opens 'pay'.")
    expect(text).not.toContain('prototype-capture')
  })

  // A page of ours is a document we own, so changing it is editing that file.
  it('tells the agent a page of ours is a document we own', () => {
    const text = formatPrototypeContextForPrompt(
      makeContext({
        pages: [{ name: 'cart', kind: 'scratch', url: 'http://x/cart.html', file: 'cart.html', entry: true }],
        entryPage: 'cart',
      }),
    )

    expect(text).toContain('**scratch**')
    expect(text).toContain('- cart (scratch) — cart.html (entry)')
    expect(text).toContain('a document of ours')
    expect(text).toContain('Pages of ours live in the directory above as ordinary .html files')
  })

  // The default, and the one no page has to earn: the index lists every page, so
  // the agent can always say what the prototype is made of.
  it('says the root shows the generated index when no page is the entry', () => {
    const text = formatPrototypeContextForPrompt(
      makeContext({
        pages: [{ name: 'orders', kind: 'scratch', url: 'http://x/orders.html', file: 'orders.html', entry: false }],
        entryPage: null,
      }),
    )

    expect(text).toContain('The address root (/) shows the generated page index')
  })

  it('says which page each patch changes', () => {
    const text = formatPrototypeContextForPrompt(
      makeContext({
        pages: [{ name: 'cart', kind: 'scratch', url: 'http://x/cart.html', file: 'cart.html', entry: true }],
        entryPage: 'cart',
        patches: [
          { file: 'A-001-btn.css', lane: 'A', kind: 'css', page: null, targets: [] },
          { file: 'cart/B-002-total.js', lane: 'B', kind: 'js', page: 'cart', targets: [] },
        ],
      }),
    )

    expect(text).toContain('- A-001-btn.css (lane A, css, every page)')
    expect(text).toContain('- cart/B-002-total.js (lane B, js, page cart)')
    expect(text).toContain('patches/<page>/… applies to that page only')
  })

  // Nothing is seeded at creation, so "no pages" is the state every new prototype
  // is in — and the block has to say how to leave it. That is the agent's own file
  // tools now: there is no command that copies material in.
  it('names how a first page arrives', () => {
    const text = formatPrototypeContextForPrompt(makeContext())

    expect(text).toContain('no pages yet')
    expect(text).toContain('<name>.html with the Write tool for a page of ours')
    expect(text).toContain('Pages: none yet, so patches have nothing to apply to.')
    expect(text).not.toContain('prototype-import')
  })

  /**
   * A page of ours is a document the agent writes, so the block has to say what a
   * good one looks like — and where the frame already is, since that is the only
   * reuse mechanism this model has (no template engine, by design).
   */
  it('tells the agent how to write a page, and where the frame already is', () => {
    const withShell = formatPrototypeContextForPrompt(
      makeContext({
        pages: [{ name: 'cart', kind: 'scratch', url: 'http://x/cart.html', file: 'cart.html', entry: true }],
        entryPage: 'cart',
        layoutPath: '/w/prototypes/checkout-flow/_layout.html',
      }),
    )

    expect(withShell).toContain('Writing a page of ours')
    expect(withShell).toContain('no build step')
    expect(withShell).toContain('/w/prototypes/checkout-flow/_layout.html')
    expect(withShell).toContain('Do not copy the frame into a page')
    expect(withShell).toContain('No eval and no new Function')
    expect(withShell).toContain('no external host')
    // Standard HTML first: the page-level answer to "do I need a library for this?"
    expect(withShell).toContain('Reach for standard HTML before writing any JS')
    expect(withShell).toContain('<details>')
    // Where a change belongs is the rule the model turns on most often.
    expect(withShell).toContain('Add a screen by writing a page')

    // No shell yet: say how to make one rather than naming a file that is not there.
    const withoutShell = formatPrototypeContextForPrompt(
      makeContext({
        pages: [{ name: 'cart', kind: 'scratch', url: 'http://x/cart.html', file: 'cart.html', entry: true }],
        entryPage: 'cart',
      }),
    )
    expect(withoutShell).toContain('write _layout.html')

    // All pages are live ones: there is no document of ours to write, so the
    // guidance would be noise.
    const liveOnly = formatPrototypeContextForPrompt(
      makeContext({
        pages: [{ name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay', file: null, entry: true }],
        entryPage: 'pay',
      }),
    )
    expect(liveOnly).not.toContain('Writing a page of ours')
  })

  // Reading 14-B: this is the rule that keeps reference selectors out of the
  // reader's deliverable. Without it an agent will copy the patch files across.
  it('lists references and forbids copying their patches', () => {
    const text = formatPrototypeContextForPrompt(
      makeContext({
        references: [{ slug: 'rival-checkout', summary: '3 pages (3 on a live site)' }],
      }),
    )

    expect(text).toContain('- rival-checkout — 3 pages (3 on a live site), at prototypes/rival-checkout/')
    expect(text).toContain('evidence, not material')
    expect(text).toContain('Do NOT copy a reference')
  })

  it('says nothing about references when there are none', () => {
    const text = formatPrototypeContextForPrompt(makeContext())
    expect(text).not.toContain('evidence, not material')
  })

  // A reference is a relation between two independent prototypes, so the rule must
  // not depend on what either side is made of — a scratch prototype referencing
  // another scratch prototype is the same thing as one referencing live pages.
  it('states the same rule whatever the referenced prototype is made of', () => {
    const ours = formatPrototypeContextForPrompt(
      makeContext({ references: [{ slug: 'our-other-page', summary: '2 pages (2 of ours)' }] }),
    )
    const theirs = formatPrototypeContextForPrompt(
      makeContext({ references: [{ slug: 'rival-checkout', summary: '3 pages (3 on a live site)' }] }),
    )

    expect(ours).toContain('- our-other-page — 2 pages (2 of ours), at prototypes/our-other-page/')
    // The rule paragraph is identical apart from the listing above it.
    const ruleOf = (text: string) => text.slice(text.indexOf('A reference is **evidence'))
    expect(ruleOf(ours)).toBe(ruleOf(theirs))
  })
})

describe('buildPrototypePromptContext', () => {
  let workspaceRoot = ''

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('lists the pages of the bound prototype, with each page’s own kind', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-prompt-'))
    createPrototype(workspaceRoot, { name: 'Checkout flow' })
    writePrototypePage(workspaceRoot, 'checkout-flow', 'cart', '<!doctype html><html><body>cart</body></html>')
    writePrototypeConfig(workspaceRoot, 'checkout-flow', {
      pages: [
        { name: 'cart', kind: 'scratch', entry: true },
        { name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay' },
      ],
    })

    const context = buildPrototypePromptContext(workspaceRoot, 'checkout-flow')

    expect(context?.pages.map((page) => `${page.name}:${page.kind}:${page.entry}`)).toEqual([
      'cart:scratch:true',
      'pay:overlay:false',
    ])
    expect(context?.entryPage).toBe('cart')
  })

  it('summarises each referenced prototype from its own page table', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-prompt-'))
    createPrototype(workspaceRoot, { name: 'Checkout flow' })
    createPrototype(workspaceRoot, { name: 'Rival checkout' })
    writePrototypeConfig(workspaceRoot, 'rival-checkout', {
      pages: [{ name: 'pay', kind: 'overlay', url: 'https://rival.example.com/cart', entry: true }],
    })
    linkPrototypeReference(workspaceRoot, 'checkout-flow', 'rival-checkout')

    const context = buildPrototypePromptContext(workspaceRoot, 'checkout-flow')

    expect(context?.references).toEqual([
      { slug: 'rival-checkout', summary: '1 page (1 on a live site)' },
    ])
  })

  it('returns null for a prototype that does not exist', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-prompt-'))
    expect(buildPrototypePromptContext(workspaceRoot, 'nope')).toBeNull()
  })
})
