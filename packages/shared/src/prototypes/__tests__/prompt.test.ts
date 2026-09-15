import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildPrototypePromptContext,
  createPrototype,
  formatPrototypeContextForPrompt,
  linkPrototypeReference,
  type PrototypePromptContext,
} from '..'

/** A context with nothing interesting in it apart from what a test sets. */
function makeContext(overrides: Partial<PrototypePromptContext> = {}): PrototypePromptContext {
  return {
    slug: 'checkout-flow',
    kind: 'scratch',
    references: [],
    dir: '/tmp/prototypes/checkout-flow',
    baseHtmlPath: null,
    patches: [],
    services: [],
    distFiles: [],
    violations: [],
    ...overrides,
  }
}

describe('formatPrototypeContextForPrompt', () => {
  // An overlay's page is the live address; a copy of it would run none of that
  // page's own JS. So the block must not send the agent looking for a base.html
  // that is never going to exist, and must not ask it to keep one fresh.
  it('tells an overlay its page is the live address, not a copy of it', () => {
    const text = formatPrototypeContextForPrompt(
      makeContext({ kind: 'overlay', targetUrl: 'https://app.example.com/cart' }),
    )
    expect(text).toContain('**overlay**')
    expect(text).toContain('https://app.example.com/cart')
    expect(text).toContain('the prototype\'s page *is* the live address')
    expect(text).toContain('There is no base.html and none is wanted')
    expect(text).not.toContain('prototype-capture')
  })

  // A scratch page is ours; the only way it changes hands is an import, which
  // replaces the document outright.
  it('allows a scratch base to have been imported, but not overwritten', () => {
    const text = formatPrototypeContextForPrompt(makeContext())
    expect(text).toContain('**from-scratch**')
    expect(text).toContain('"prototype-import --from <slug>" to start from another')
    expect(text).toContain('do not import over a base.html whose')
  })

  // Nothing is seeded at creation, so "no base page" is the state every new
  // prototype is in — and the block has to say how to leave it. Both ways are the
  // agent's own commands now: the panel no longer asks the user to open a window
  // and press a button.
  it('names the ways to get a first base page', () => {
    const text = formatPrototypeContextForPrompt(makeContext({ baseHtmlPath: null }))
    expect(text).toContain('Write base.html')
    expect(text).toContain('prototype-import')
  })

  // Reading 14-B: this is the rule that keeps reference selectors out of the
  // reader's deliverable. Without it an agent will copy the patch files across.
  it('lists references and forbids copying their patches', () => {
    const text = formatPrototypeContextForPrompt(
      makeContext({
        references: [
          { slug: 'rival-checkout', kind: 'overlay', targetUrl: 'https://rival.example.com/cart' },
        ],
      }),
    )
    expect(text).toContain('rival-checkout (overlay — https://rival.example.com/cart)')
    expect(text).toContain('evidence, not material')
    expect(text).toContain('Do NOT copy a reference')
  })

  it('says nothing about references when there are none', () => {
    const text = formatPrototypeContextForPrompt(makeContext())
    expect(text).not.toContain('evidence, not material')
  })

  // A reference is a relation between two independent prototypes, so the rule must
  // not depend on what kind either side is — scratch-on-scratch is the same thing
  // as scratch-on-overlay.
  it('states the same rule for a scratch reference as for an overlay one', () => {
    const scratch = formatPrototypeContextForPrompt(
      makeContext({ references: [{ slug: 'our-other-page', kind: 'scratch' }] }),
    )
    const overlay = formatPrototypeContextForPrompt(
      makeContext({
        references: [{ slug: 'rival-checkout', kind: 'overlay', targetUrl: 'https://rival.example.com/cart' }],
      }),
    )

    expect(scratch).toContain('our-other-page (scratch) at prototypes/our-other-page/')
    expect(scratch).toContain('evidence, not material')
    expect(scratch).toContain('Do NOT copy a reference')
    // The rule paragraph is identical apart from the listing above it.
    const ruleOf = (text: string) => text.slice(text.indexOf('A reference is **evidence'))
    expect(ruleOf(scratch)).toBe(ruleOf(overlay))
  })
})

describe('buildPrototypePromptContext', () => {
  let workspaceRoot = ''

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('resolves each reference to its own kind and target page', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-prompt-'))
    createPrototype(workspaceRoot, { name: 'Checkout flow', kind: 'scratch' })
    createPrototype(workspaceRoot, {
      name: 'Rival checkout',
      kind: 'overlay',
      targetUrl: 'https://rival.example.com/cart',
    })
    linkPrototypeReference(workspaceRoot, 'checkout-flow', 'rival-checkout')

    const context = buildPrototypePromptContext(workspaceRoot, 'checkout-flow')
    expect(context?.kind).toBe('scratch')
    expect(context?.references).toEqual([
      { slug: 'rival-checkout', kind: 'overlay', targetUrl: 'https://rival.example.com/cart' },
    ])
  })

  it('returns null for a prototype that does not exist', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-prompt-'))
    expect(buildPrototypePromptContext(workspaceRoot, 'nope')).toBeNull()
  })
})
