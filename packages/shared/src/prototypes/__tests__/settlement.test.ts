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
].join('\n')

describe('whyPrototypeIsNotSettled', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-settlement-'))
    createPrototype(workspaceRoot, { name: slug })
    const dir = getPrototypeDirPath(workspaceRoot, slug)
    writeFileSync(join(dir, 'PRD.md'), PRD, 'utf-8')
    writeFileSync(join(dir, 'cart.js'), 'export const total = 0\n', 'utf-8')
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('says nothing when there is nothing owed', () => {
    expect(whyPrototypeIsNotSettled(buildPrototypeStatus(workspaceRoot, slug))).toEqual([])
  })

  // The folder is split by what a file *is*, not by its name: the markdown that states requirements
  // is the specification, and everything else is the material and the work's own files.
  it('separates the documents that define requirements from the rest of the folder', () => {
    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.specificationFiles.map((file) => file.name)).toEqual(['PRD.md'])
    expect(status.files.map((file) => file.name)).toEqual(['cart.js'])
    expect(status.requirements.map((requirement) => requirement.file)).toEqual([
      'PRD.md',
      'PRD.md',
    ])
  })

  // A requirement is prose in a document. The report carries no second statement of the work, so
  // nothing here says a requirement is implemented — the row is the heading and nothing else.
  it('lists the requirements and claims nothing about what implements them', () => {
    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.requirements[0]).toEqual({
      id: 'R-001',
      title: 'A cart holds its line',
      file: 'PRD.md',
      findings: [],
    })
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
  })

  // A finding names what it argues for on its `requirements:` line. An id no document defines is a
  // citation to something that was never written — a fact about the files, so it is named.
  it('names a finding that argues for an id no document defines', () => {
    const dir = getPrototypeDirPath(workspaceRoot, slug)
    mkdirSync(join(dir, 'research'), { recursive: true })
    writeFileSync(
      join(dir, 'research', 'F-001-sticky.md'),
      '# F-001 Sticky total\n\nclaim: The total stays on screen.\nrequirements: R-099\n',
      'utf-8',
    )

    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.briefIssues.map((issue) => issue.code)).toEqual(['requirement.undefined'])
    expect(status.briefIssues[0]?.text).toBe(
      'research/F-001-sticky.md names R-099, which no document in this prototype defines.',
    )
  })

  it('names a link that points at nothing, because that is a fact about the files', () => {
    writeFileSync(
      join(getPrototypeDirPath(workspaceRoot, slug), 'PRD.md'),
      `${PRD}\nSee [the flow](docs/flow.md).\n`,
      'utf-8',
    )

    const status = buildPrototypeStatus(workspaceRoot, slug)
    const reasons = whyPrototypeIsNotSettled(status)

    // The code is the contract with the panel; the sentence is what the agent prints.
    expect(reasons.map((reason) => reason.code)).toEqual(['gate.linkBroken'])
    expect(reasons[0]?.text).toBe('PRD.md links to docs/flow.md, which is not in this prototype.')
    // Said once, and by the gate: the brief issues do not repeat what `unresolved` already says.
    expect(status.briefIssues).toEqual([])
  })
})
