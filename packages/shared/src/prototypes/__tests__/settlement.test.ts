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

const PRD = [
  '## R-001 A cart holds its line',
  '',
  '## R-002 The cart is priced by the service',
  '',
  '## R-003 An order can be cancelled',
  '',
].join('\n')

describe('whyPrototypeIsNotSettled', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-settlement-'))
    createPrototype(workspaceRoot, { name: slug })
    const dir = getPrototypeDirPath(workspaceRoot, slug)
    writeFileSync(join(dir, 'PRD.md'), PRD, 'utf-8')
    // R-001 and R-002 are implemented by files that declare them; R-003 by nothing, which is what
    // one of the tests below is about.
    writeFileSync(join(dir, 'cart.js'), '// @requirement R-001\nexport const total = 0\n', 'utf-8')
    writeFileSync(join(dir, 'pricing.md'), 'Prices come from the service. @requirement R-002\n', 'utf-8')
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /** Write the change that implements R-003, the requirement the fixture leaves open. */
  function implementR003(): void {
    writeFileSync(join(getPrototypeDirPath(workspaceRoot, slug), 'notes.md'), 'Cancellation. @requirement R-003\n', 'utf-8')
  }

  it('says nothing when there is nothing owed', () => {
    implementR003()

    expect(whyPrototypeIsNotSettled(buildPrototypeStatus(workspaceRoot, slug))).toEqual([])
  })

  // The folder is split by what a file *is*, not by its name: the markdown that states requirements
  // is the specification, and everything else is the material and the work's own files.
  it('separates the documents that define requirements from the rest of the folder', () => {
    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.specificationFiles.map((file) => file.name)).toEqual(['PRD.md'])
    expect(status.files.map((file) => file.name)).toEqual(['cart.js', 'pricing.md'])
    expect(status.requirements.map((requirement) => requirement.file)).toEqual([
      'PRD.md',
      'PRD.md',
      'PRD.md',
    ])
  })

  it('reads the links between documents, and reports one that points at nothing', () => {
    const dir = getPrototypeDirPath(workspaceRoot, slug)
    writeFileSync(
      join(dir, 'PRD.md'),
      `${PRD}\nThe detail is in [checkout](docs/checkout.md), and stray [gone](gone.md).\n`,
      'utf-8',
    )
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'checkout.md'), '# Checkout\n', 'utf-8')

    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.links.map((link) => `${link.target}→${link.to}`)).toEqual([
      'docs/checkout.md→docs/checkout.md',
      'gone.md→null',
    ])
    // A link that goes nowhere is a silent failure of an index — named with the other ones.
    expect(status.briefIssues.map((issue) => issue.text).join('\n')).toContain(
      'PRD.md links to gone.md, which is not in this prototype',
    )
  })

  it('names a requirement nothing implements', () => {
    const reasons = whyPrototypeIsNotSettled(buildPrototypeStatus(workspaceRoot, slug))

    // The code is the contract with the panel; the sentence is what the agent prints.
    expect(reasons.map((reason) => reason.code)).toEqual(['gate.requirementUnmet'])
    expect(reasons[0]?.text).toBe(
      'R-003 is in PRD.md but no file refers to it, so nothing implements it.',
    )
  })

  it('names a link that points at nothing, because that is a fact about the files', () => {
    implementR003()
    writeFileSync(
      join(getPrototypeDirPath(workspaceRoot, slug), 'PRD.md'),
      `${PRD}\nSee [the flow](docs/flow.md).\n`,
      'utf-8',
    )

    const reasons = whyPrototypeIsNotSettled(buildPrototypeStatus(workspaceRoot, slug))

    expect(reasons.map((reason) => reason.code)).toEqual(['gate.linkBroken'])
    expect(reasons[0]?.text).toBe('PRD.md links to docs/flow.md, which is not in this prototype.')
  })
})
