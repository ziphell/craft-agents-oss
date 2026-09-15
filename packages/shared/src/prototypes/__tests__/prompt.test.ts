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
  it('says an overlay is a snapshot to refresh, not a document to edit', () => {
    const text = formatPrototypeContextForPrompt(
      makeContext({ kind: 'overlay', targetUrl: 'https://app.example.com/cart' }),
    )
    expect(text).toContain('**overlay**')
    expect(text).toContain('https://app.example.com/cart')
    expect(text).toContain('Re-capture rather than patching a stale base')
  })

  // Reading 14-A: a scratch page may be seeded by capturing a page first, so the
  // old wording ("there is nothing to capture") would forbid the main flow.
  it('allows a scratch base to have been captured, but not overwritten', () => {
    const text = formatPrototypeContextForPrompt(makeContext())
    expect(text).toContain('**from-scratch**')
    expect(text).toContain('seeded by capturing a page')
    expect(text).toContain('Never re-capture over an existing base.html')
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

  // A reference is a relation between two independent projects, so the rule must
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
