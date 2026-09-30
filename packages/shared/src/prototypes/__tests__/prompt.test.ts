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
    specs: [],
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
    expect(text).toContain("The specification is the folder's '*.spec.md' files in")
    expect(text).toContain('Everything else in that folder is yours, in any format')
  })

  it('says there is no spec yet, and asks for one', () => {
    const text = formatPrototypeContextForPrompt(makeContext())

    expect(text).toContain('No spec has been written yet')
    expect(text).toContain('is a picture, not a proposal')
  })

  // The one thing the workbench cannot check about a spec is whether it was worth
  // writing, so the block has to ask for that thinking before the entry is written.
  it('asks for the value to be thought through before a spec is written', () => {
    const text = formatPrototypeContextForPrompt(makeContext())

    expect(text).toContain('think from first principles about the value')
    expect(text).toContain('never that it was worth writing')
  })

  it('lists the specs written so far, as a title and its file', () => {
    const text = formatPrototypeContextForPrompt(
      makeContext({
        specs: [
          { file: 'cart-line.spec.md', title: 'A cart holds its line' },
          { file: 'checkout.spec.md', title: 'Checking out takes one step' },
        ],
      }),
    )

    expect(text).toContain('- A cart holds its line (cart-line.spec.md)')
    expect(text).toContain('- Checking out takes one step (checkout.spec.md)')
  })

  // Nothing in the block may mention the machinery that was removed: an agent told about a patch
  // layer or a mock will go looking for one.
  it('says nothing about pages, patches, anchors, a host or a mock', () => {
    const text = formatPrototypeContextForPrompt(
      makeContext({
        specs: [{ file: 'cart-line.spec.md', title: 'x' }],
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

  it('lists the specs of the bound prototype', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-prompt-'))
    createPrototype(workspaceRoot, { name: 'Checkout flow' })
    const dir = getPrototypeDirPath(workspaceRoot, 'checkout-flow')
    writeFileSync(join(dir, 'cart-line.spec.md'), '# A cart holds its line\n', 'utf-8')
    writeFileSync(join(dir, 'cart.html'), '<!doctype html><html><body>cart</body></html>', 'utf-8')

    const context = buildPrototypePromptContext(workspaceRoot, 'checkout-flow')

    expect(context?.specs.map((spec) => spec.file)).toEqual(['cart-line.spec.md'])
    // Nothing in the context says a file implements a spec — there is no such statement.
    expect(context?.specs[0]).toEqual({
      file: 'cart-line.spec.md',
      title: 'A cart holds its line',
    })
  })

  it('returns null for a prototype that does not exist', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-prompt-'))
    expect(buildPrototypePromptContext(workspaceRoot, 'nope')).toBeNull()
  })
})
