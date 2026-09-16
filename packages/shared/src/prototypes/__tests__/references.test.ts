import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  getPrototypeDirPath,
  getPrototypeReferences,
  linkPrototypeReference,
  readPrototypeConfig,
  unlinkPrototypeReference,
  writePrototypeConfig,
} from '..'

const READER = 'checkout-flow'
const REFERENCE = 'rival-checkout'

/** A workspace with a reader and one prototype to study. */
function makeWorkspace(options: { withReference?: boolean } = {}): string {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-refs-'))
  mkdirSync(getPrototypeDirPath(workspaceRoot, READER), { recursive: true })
  if (options.withReference !== false) {
    mkdirSync(getPrototypeDirPath(workspaceRoot, REFERENCE), { recursive: true })
    writePrototypeConfig(workspaceRoot, REFERENCE, {
      pages: [{ name: 'cart', kind: 'overlay', url: 'https://rival.example.com/cart', entry: true }],
    })
  }
  return workspaceRoot
}

describe('linkPrototypeReference', () => {
  let workspaceRoot = ''

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('records the relation on the reader, and leaves the reference alone', () => {
    workspaceRoot = makeWorkspace()
    linkPrototypeReference(workspaceRoot, READER, REFERENCE)

    expect(getPrototypeReferences(workspaceRoot, READER)).toEqual([REFERENCE])
    // One-way on purpose: the reference does not know it is being referenced.
    expect(getPrototypeReferences(workspaceRoot, REFERENCE)).toEqual([])
  })

  // A reference is an edge between two prototypes; it says nothing about what the
  // reader itself is made of, so the page table has to survive untouched.
  it('keeps the reader its own page table', () => {
    workspaceRoot = makeWorkspace()
    writePrototypeConfig(workspaceRoot, READER, {
      pages: [{ name: 'cart', kind: 'scratch', entry: true }],
    })
    linkPrototypeReference(workspaceRoot, READER, REFERENCE)

    expect(readPrototypeConfig(workspaceRoot, READER)).toEqual({
      pages: [{ name: 'cart', kind: 'scratch', entry: true }],
      references: [REFERENCE],
    })
  })

  it('is idempotent rather than throwing on a duplicate link', () => {
    workspaceRoot = makeWorkspace()
    linkPrototypeReference(workspaceRoot, READER, REFERENCE)
    linkPrototypeReference(workspaceRoot, READER, REFERENCE)
    expect(getPrototypeReferences(workspaceRoot, READER)).toEqual([REFERENCE])
  })

  it('keeps declaration order across several references', () => {
    workspaceRoot = makeWorkspace()
    for (const slug of ['second-rival', 'third-rival']) {
      mkdirSync(getPrototypeDirPath(workspaceRoot, slug), { recursive: true })
      writePrototypeConfig(workspaceRoot, slug, {
        pages: [{ name: 'cart', kind: 'overlay', url: `https://${slug}.example.com/cart`, entry: true }],
      })
    }
    linkPrototypeReference(workspaceRoot, READER, 'second-rival')
    linkPrototypeReference(workspaceRoot, READER, 'third-rival')
    expect(getPrototypeReferences(workspaceRoot, READER)).toEqual(['second-rival', 'third-rival'])
  })

  // The relation is kind-agnostic: a prototype of our own documents referencing
  // another one is the same thing as one referencing live pages, because what
  // matters is that the two prototypes are independent — not what either is.
  it('accepts a prototype of our own documents, and a reader of the same kind', () => {
    workspaceRoot = makeWorkspace()
    mkdirSync(getPrototypeDirPath(workspaceRoot, 'our-other-page'), { recursive: true })
    writePrototypeConfig(workspaceRoot, 'our-other-page', {
      pages: [{ name: 'quotes', kind: 'scratch', entry: true }],
    })

    linkPrototypeReference(workspaceRoot, READER, 'our-other-page')

    expect(getPrototypeReferences(workspaceRoot, READER)).toEqual(['our-other-page'])
    expect(readPrototypeConfig(workspaceRoot, 'our-other-page')).toEqual({
      pages: [{ name: 'quotes', kind: 'scratch', entry: true }],
    })
  })

  // A relation that cannot be honoured is worse than a failed command that says
  // why — the agent would be told to study something that is not there.
  it('refuses a reference that does not exist, naming what to check', () => {
    workspaceRoot = makeWorkspace({ withReference: false })
    expect(() => linkPrototypeReference(workspaceRoot, READER, REFERENCE)).toThrow(/No prototype "rival-checkout"/)
  })

  it('refuses a reader that does not exist', () => {
    workspaceRoot = makeWorkspace()
    expect(() => linkPrototypeReference(workspaceRoot, 'nope', REFERENCE)).toThrow(/does not exist/)
  })

  it('refuses a self-reference', () => {
    workspaceRoot = makeWorkspace()
    expect(() => linkPrototypeReference(workspaceRoot, READER, READER)).toThrow(/cannot reference itself/)
  })

  it('refuses an empty reference slug', () => {
    workspaceRoot = makeWorkspace()
    expect(() => linkPrototypeReference(workspaceRoot, READER, '   ')).toThrow(/needs a prototype slug/)
  })
})

describe('unlinkPrototypeReference', () => {
  let workspaceRoot = ''

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('drops the relation and leaves the rest of the config intact', () => {
    workspaceRoot = makeWorkspace()
    writePrototypeConfig(workspaceRoot, READER, {
      pages: [{ name: 'cart', kind: 'scratch', entry: true }],
    })
    linkPrototypeReference(workspaceRoot, READER, REFERENCE)

    unlinkPrototypeReference(workspaceRoot, READER, REFERENCE)

    expect(readPrototypeConfig(workspaceRoot, READER)).toEqual({
      pages: [{ name: 'cart', kind: 'scratch', entry: true }],
    })
  })

  it('is a no-op for a reference that was never linked', () => {
    workspaceRoot = makeWorkspace()
    expect(() => unlinkPrototypeReference(workspaceRoot, READER, REFERENCE)).not.toThrow()
    expect(getPrototypeReferences(workspaceRoot, READER)).toEqual([])
  })

  // Removing a reference to something already gone is how a dangling relation
  // gets cleaned up, so refusing here would strand the caller.
  it('still succeeds when the reference prototype is gone', () => {
    workspaceRoot = makeWorkspace()
    linkPrototypeReference(workspaceRoot, READER, REFERENCE)
    rmSync(getPrototypeDirPath(workspaceRoot, REFERENCE), { recursive: true, force: true })

    unlinkPrototypeReference(workspaceRoot, READER, REFERENCE)
    expect(getPrototypeReferences(workspaceRoot, READER)).toEqual([])
  })
})
