import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildPrototypePromptContext,
  createPrototype,
  formatPrototypeContextForPrompt,
  writePrototypeConfig,
  writePrototypePage,
  PROTOTYPE_DEFAULT_WRITER,
  type PrototypePromptContext,
} from '..'

/** A context with nothing interesting in it apart from what a test sets. */
function makeContext(overrides: Partial<PrototypePromptContext> = {}): PrototypePromptContext {
  return {
    slug: 'checkout-flow',
    writer: PROTOTYPE_DEFAULT_WRITER,
    dir: '/tmp/prototypes/checkout-flow',
    pages: [],
    entryPage: null,
    layoutPath: null,
    requirements: [],
    findings: [],
    reviews: { total: 0, unresolved: [] },
    acceptance: null,
    patches: [],
    services: [],
    distFiles: [],
    violations: [],
    ...overrides,
  }
}

describe('formatPrototypeContextForPrompt', () => {
  // The block's "you are bound to this" paragraph is what lets the agent rely on the
  // command default, so it has to be stated (and only one thing can produce the block:
  // this conversation's own binding — a project's note is background and is not a block).
  it('states the session binding as the default the commands use', () => {
    const text = formatPrototypeContextForPrompt(makeContext())

    expect(text).toContain('This session is bound to the prototype above')
    expect(text).toContain('target it by default')
  })

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
          { file: 'A-001-btn.css', writer: 'A', kind: 'css', page: null, targets: [], fingerprint: 'a1b2c3d4' },
          { file: 'cart/B-002-total.js', writer: 'B', kind: 'js', page: 'cart', targets: [], fingerprint: 'e5f6a7b8' },
        ],
      }),
    )

    expect(text).toContain('- A-001-btn.css [a1b2c3d4] (writer A, css, every page)')
    expect(text).toContain('- cart/B-002-total.js [e5f6a7b8] (writer B, js, page cart)')
    expect(text).toContain('patches/<page>/… applies to that page only')
    // The bracketed fingerprint is what a patch dispute records as `on:`, so the block has to say
    // what it is for — otherwise it is eight characters of noise on every line.
    expect(text).toContain("that is what a dispute's 'on:' records")
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

  // Reading 14-B: this is the rule that keeps another prototype's selectors out of the
  // reader's deliverable. Without it an agent will copy the patch files across. It has no
  // per-reference listing to hang off any more, so it is stated once and unconditionally.
  it('says where what you study is written down, and forbids copying another prototype’s patches', () => {
    const text = formatPrototypeContextForPrompt(makeContext())

    expect(text).toContain('is yours to write down')
    expect(text).toContain("another prototype's patch files are NEVER copied")
  })

  // The one thing the workbench cannot check about a requirement is whether it was worth
  // writing, so the block has to ask for that thinking before the entry is written.
  it('asks for the value to be thought through before a requirement is written', () => {
    const text = formatPrototypeContextForPrompt(makeContext())

    expect(text).toContain('think from first principles about the value')
    expect(text).toContain('never that it was worth writing')
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

    const context = buildPrototypePromptContext(workspaceRoot, 'checkout-flow', PROTOTYPE_DEFAULT_WRITER)

    expect(context?.pages.map((page) => `${page.name}:${page.kind}:${page.entry}`)).toEqual([
      'cart:scratch:true',
      'pay:overlay:false',
    ])
    expect(context?.entryPage).toBe('cart')
  })

  it('carries the writer identity into the block and its naming rule', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-prompt-'))
    createPrototype(workspaceRoot, { name: 'Checkout flow' })

    const context = buildPrototypePromptContext(workspaceRoot, 'checkout-flow', 'checkout-ui')
    const text = formatPrototypeContextForPrompt(context!)

    expect(context?.writer).toBe('checkout-ui')
    expect(text).toContain('writer="checkout-ui"')
    // The rule is stated in terms of the identity — not as a list of codes to pick from.
    expect(text).toContain("this conversation writes as 'checkout-ui'")
    expect(text).toContain('checkout-ui-<nnn>-<name>.{css,js}')
  })

  it('returns null for a prototype that does not exist', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-prompt-'))
    expect(buildPrototypePromptContext(workspaceRoot, 'nope', PROTOTYPE_DEFAULT_WRITER)).toBeNull()
  })
})
