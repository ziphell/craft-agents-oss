import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildPrototypePromptContext,
  createPrototype,
  formatPrototypeContextForPrompt,
  getPrototypeDirPath,
  type PrototypePromptContext,
} from '..'

/** A context with nothing interesting in it apart from what a test sets. */
function makeContext(overrides: Partial<PrototypePromptContext> = {}): PrototypePromptContext {
  return {
    slug: 'checkout-flow',
    dir: '/tmp/prototypes/checkout-flow',
    requirements: [],
    findings: [],
    reviews: { total: 0, unresolved: [] },
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

  // The model in one line: a folder with a specification in it. There is no page layer and no
  // change layer any more, so nothing in the block may send the agent looking for one.
  it('says what a prototype is: a folder with a specification', () => {
    const text = formatPrototypeContextForPrompt(makeContext())

    expect(text).toContain('a **folder that holds a specification**')
    expect(text).toContain('The specification is the markdown files in')
    expect(text).toContain('Everything else in that folder is yours, in any format')
  })

  it('says there is no requirement yet, and asks for one', () => {
    const text = formatPrototypeContextForPrompt(makeContext())

    expect(text).toContain('No requirement has been written yet')
    expect(text).toContain('is a picture, not a proposal')
  })

  // The one thing the workbench cannot check about a requirement is whether it was worth
  // writing, so the block has to ask for that thinking before the entry is written.
  it('asks for the value to be thought through before a requirement is written', () => {
    const text = formatPrototypeContextForPrompt(makeContext())

    expect(text).toContain('think from first principles about the value')
    expect(text).toContain('never that it was worth writing')
  })

  it('lists the requirements written so far, and what refers to each', () => {
    const text = formatPrototypeContextForPrompt(
      makeContext({
        requirements: [
          { id: 'R-001', title: 'A cart holds its line', files: [], findings: [] },
          { id: 'R-002', title: 'Checking out takes one step', files: ['cart.html'], findings: ['F-001'] },
        ],
      }),
    )

    expect(text).toContain('- R-001 A cart holds its line — **nothing refers to it yet**')
    expect(text).toContain('- R-002 Checking out takes one step — referred to by cart.html, F-001 (finding)')
  })

  it('says how to declare what a file serves, and where research goes', () => {
    const text = formatPrototypeContextForPrompt(makeContext())

    expect(text).toContain("'@requirement R-001' in a comment in the file")
    expect(text).toContain('/research/ holds what you learned from other products')
    expect(text).toContain("'claim:', 'source:', 'captured:', 'evidence:'")
    expect(text).toContain('research/ is **not** delivered')
  })

  it('says where a finding’s evidence can come from', () => {
    const text = formatPrototypeContextForPrompt(makeContext())

    expect(text).toContain('a screenshot you took')
    expect(text).toContain('evidence:')
  })

  it('says what a review is about, and that a dispute needs a fingerprint', () => {
    const text = formatPrototypeContextForPrompt(makeContext())

    expect(text).toContain("'about:', 'status:', 'claim:', 'evidence:'")
    expect(text).toContain("'about:' names one thing: 'requirement R-001'")
    expect(text).toContain("A dispute also needs 'on:'")
  })

  it('lists the disputes that still stand', () => {
    const text = formatPrototypeContextForPrompt(
      makeContext({
        reviews: {
          total: 3,
          unresolved: [
            {
              id: 'D-001',
              file: 'reviews/D-001-x.md',
              about: 'requirement R-001',
              status: 'open',
              stale: true,
              staleReason: 'R-001 in PRD.md has changed since this was filed',
              claim: 'it scrolls off screen',
            },
          ],
        },
      }),
    )

    expect(text).toContain('Still standing (3 filed so far)')
    expect(text).toContain('- D-001 (open, **stale**: R-001 in PRD.md has changed since this was filed) about requirement R-001 — it scrolls off screen (reviews/D-001-x.md)')
  })

  // Nothing in the block may mention the machinery that was removed: an agent told about a patch
  // layer or a mock will go looking for one.
  it('says nothing about pages, patches, anchors, a host or a mock', () => {
    const text = formatPrototypeContextForPrompt(
      makeContext({
        requirements: [{ id: 'R-001', title: 'x', files: ['cart.html'], findings: [] }],
      }),
    )

    for (const gone of ['@target', 'patches/', 'anchors/', '_layout.html', 'overlay', 'entry page', 'folded', 'fragments/', 'x-mock', 'fixtures', 'state.json', 'mock'])
      expect(text).not.toContain(gone)
    expect(text).toContain('Workflow: write the files above')
  })
})

describe('buildPrototypePromptContext', () => {
  let workspaceRoot = ''

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('lists the requirements of the bound prototype', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-prompt-'))
    createPrototype(workspaceRoot, { name: 'Checkout flow' })
    const dir = getPrototypeDirPath(workspaceRoot, 'checkout-flow')
    writeFileSync(join(dir, 'PRD.md'), '## R-001 A cart holds its line\n', 'utf-8')
    writeFileSync(join(dir, 'cart.html'), '<!doctype html><!-- @requirement R-001 --><html><body>cart</body></html>', 'utf-8')

    const context = buildPrototypePromptContext(workspaceRoot, 'checkout-flow')

    expect(context?.requirements.map((requirement) => `${requirement.id}:${requirement.files.join(',')}`)).toEqual([
      'R-001:cart.html',
    ])
  })

  it('returns null for a prototype that does not exist', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-prompt-'))
    expect(buildPrototypePromptContext(workspaceRoot, 'nope')).toBeNull()
  })
})
