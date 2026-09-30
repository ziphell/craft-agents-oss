import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildPrototypeStatus,
  createPrototype,
  getPrototypeDirPath,
  whyPrototypeIsNotSettled,
} from '..'

/** The entry: an index that states no spec of its own. */
const INDEX = ['# Checkout flow', '', 'The specification, read from the folder beside this file.'].join('\n')

describe('whyPrototypeIsNotSettled', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''
  let dir = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-settlement-'))
    createPrototype(workspaceRoot, { name: slug })
    dir = getPrototypeDirPath(workspaceRoot, slug)
    writeFileSync(join(dir, 'spec.md'), INDEX, 'utf-8')
    writeFileSync(join(dir, 'cart-line.spec.md'), '# A cart holds its line\n', 'utf-8')
    writeFileSync(join(dir, 'pricing.spec.md'), '# The cart is priced by the service\n', 'utf-8')
    writeFileSync(join(dir, 'cart.js'), 'export const total = 0\n', 'utf-8')
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('says nothing when there is nothing owed', () => {
    expect(whyPrototypeIsNotSettled(buildPrototypeStatus(workspaceRoot, slug))).toEqual([])
  })

  // The folder is split by what a file *is*, not by its format: each `*.spec.md` is a spec,
  // and everything else is the material and the work's own files.
  it('separates the spec files from the rest of the folder', () => {
    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.specificationFiles.map((file) => file.name)).toEqual([
      'spec.md',
      'cart-line.spec.md',
      'pricing.spec.md',
    ])
    expect(status.files.map((file) => file.name)).toEqual(['cart.js'])
    expect(status.specs.map((spec) => spec.file)).toEqual([
      'cart-line.spec.md',
      'pricing.spec.md',
    ])
  })

  // The entry's new name is `spec.md`, which does not end in `.spec.md`, so it must not collide
  // with the "one spec per *.spec.md file" rule: the entry is the specification's first row
  // and never a spec, while a `cart.spec.md` beside it is one.
  it('keeps the entry spec.md out of the specs, and reads cart.spec.md as one', () => {
    writeFileSync(join(dir, 'cart.spec.md'), '# A cart holds its line\n', 'utf-8')

    const status = buildPrototypeStatus(workspaceRoot, slug)

    // The entry is the specification's first row, and it is not listed with the material either.
    expect(status.specificationFiles[0]?.name).toBe('spec.md')
    expect(status.files.map((file) => file.name)).not.toContain('spec.md')

    // `spec.md` states nothing — the suffix, not the word "spec", is what makes a spec.
    expect(status.specs.map((spec) => spec.file)).not.toContain('spec.md')
    expect(status.specs.map((spec) => spec.file)).toContain('cart.spec.md')
  })

  // The entry is the specification's first row whether or not the folder holds a spec: it is
  // where the specification begins, so naming it among the material would tell the reader the wrong
  // thing about the folder. One file belongs to one list.
  it('holds the entry in the specification, and out of the rest, even when it states nothing', () => {
    writeFileSync(join(dir, 'spec.md'), 'Prose only.\n', 'utf-8')

    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.specificationFiles.map((file) => file.name)).toEqual([
      'spec.md',
      'cart-line.spec.md',
      'pricing.spec.md',
    ])
    expect(status.files.map((file) => file.name)).toEqual(['cart.js'])
    // The entry states nothing; the specs are exactly the `.spec.md` files.
    expect(status.specs.map((spec) => spec.file)).toEqual([
      'cart-line.spec.md',
      'pricing.spec.md',
    ])
  })

  // Being markdown is not the test: a document that merely *mentions* a spec — a research
  // report carrying a `## R-001` heading — is material, and goes to `files`, with no issue raised.
  it('keeps a markdown document that is not *.spec.md out of the specs, in the files', () => {
    mkdirSync(join(dir, 'research'), { recursive: true })
    writeFileSync(join(dir, 'research', 'report.md'), '## R-001 A cart holds its line\n', 'utf-8')

    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.specs.map((spec) => spec.file)).toEqual([
      'cart-line.spec.md',
      'pricing.spec.md',
    ])
    expect(status.files.map((file) => file.name)).toEqual(['cart.js', 'research/report.md'])
    // No duplicate-id issue can exist any more: a spec is a file, and files do not collide.
    expect(status.briefIssues).toEqual([])
  })

  it('lists a spec as its file and the title its first heading states', () => {
    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.specs[0]).toEqual({
      file: 'cart-line.spec.md',
      title: 'A cart holds its line',
    })
  })

  it('reads the links between documents, and reports one that points at nothing', () => {
    writeFileSync(
      join(dir, 'spec.md'),
      `${INDEX}\nThe detail is in [checkout](docs/checkout.md), and stray [gone](gone.md).\n`,
      'utf-8',
    )
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'checkout.md'), '# Checkout\n', 'utf-8')

    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.links.map((link) => `${link.target}→${link.to}`)).toEqual([
      'docs/checkout.md→docs/checkout.md',
      'gone.md→null',
    ])
  })

  it('names a link that points at nothing, because that is a fact about the files', () => {
    writeFileSync(join(dir, 'spec.md'), `${INDEX}\nSee [the flow](docs/flow.md).\n`, 'utf-8')

    const status = buildPrototypeStatus(workspaceRoot, slug)
    const reasons = whyPrototypeIsNotSettled(status)

    // The code is the contract with the panel; the sentence is what the agent prints.
    expect(reasons.map((reason) => reason.code)).toEqual(['gate.linkBroken'])
    expect(reasons[0]?.text).toBe('spec.md links to docs/flow.md, which is not in this prototype.')
    // Said once, and by the gate: the brief issues do not repeat what `unresolved` already says.
    expect(status.briefIssues).toEqual([])
  })
})
