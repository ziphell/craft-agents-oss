import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildPrototypeStatus,
  createPrototype,
  getPrototypeDirPath,
  getPrototypeReviewsPath,
  parseRequirementDocument,
  requirementFingerprint,
  resolveRequirementCoverage,
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

/** The fingerprint a dispute must record for a requirement as the PRD above states it. */
function fingerprintOf(id: string, prd = PRD): string {
  const requirement = parseRequirementDocument(prd, 'PRD.md').requirements.find((entry) => entry.id === id)
  if (!requirement) throw new Error(`fixture PRD has no ${id}`)
  return requirementFingerprint(requirement)
}

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

  function writeReview(file: string, lines: string[]): void {
    mkdirSync(getPrototypeReviewsPath(workspaceRoot, slug), { recursive: true })
    writeFileSync(join(getPrototypeReviewsPath(workspaceRoot, slug), file), `${lines.join('\n')}\n`, 'utf-8')
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
      `${PRD}\nThe detail is in [[docs/checkout.md]], and stray [[gone.md]].\n`,
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

  it('names an objection nobody answered, and a stale one with its reason', () => {
    implementR003()
    const staleFingerprint = fingerprintOf('R-001', PRD)
    writeReview('D-001-line.md', [
      '# D-001 the line is not held',
      '',
      'about: requirement R-001',
      `on: ${staleFingerprint}`,
      'status: open',
      'claim: it goes negative',
    ])
    // The requirement is rewritten: the argument is now about a wording that no longer exists.
    writeFileSync(
      join(getPrototypeDirPath(workspaceRoot, slug), 'PRD.md'),
      PRD.replace('A cart holds its line', 'A cart holds its line until stock runs out'),
      'utf-8',
    )

    const reasons = whyPrototypeIsNotSettled(buildPrototypeStatus(workspaceRoot, slug))

    expect(reasons).toHaveLength(1)
    expect(reasons[0]?.code).toBe('gate.disputeStanding')
    expect(reasons[0]?.text).toContain('reviews/D-001-line.md disputes requirement R-001')
    expect(reasons[0]?.text).toContain('still stands (open)')
    expect(reasons[0]?.text).toContain('has changed since this was filed')
  })
})

describe('the status report carries the argument', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-settlement-status-'))
    createPrototype(workspaceRoot, { name: slug })
    const dir = getPrototypeDirPath(workspaceRoot, slug)
    writeFileSync(join(dir, 'PRD.md'), PRD, 'utf-8')
    mkdirSync(getPrototypeReviewsPath(workspaceRoot, slug), { recursive: true })
    // One dispute per file, both read the same way — the id at the top of the file is the review.
    writeFileSync(
      join(getPrototypeReviewsPath(workspaceRoot, slug), 'D-001-line.md'),
      [
        '# D-001 the line is not held',
        '',
        'about: requirement R-001',
        `on: ${fingerprintOf('R-001')}`,
        'status: open',
        'claim: it goes negative',
      ].join('\n'),
      'utf-8',
    )
    writeFileSync(
      join(getPrototypeReviewsPath(workspaceRoot, slug), 'D-002-price.md'),
      ['# D-002 the price comes from the client', '', 'about: requirement R-002', `on: ${fingerprintOf('R-002')}`, 'status: rebutted', 'claim: x'].join('\n'),
      'utf-8',
    )
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('counts the disputes by status and lists the ones that stand', () => {
    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.reviews.total).toBe(2)
    expect(status.reviews.byStatus).toEqual({ open: 1, fixed: 0, rebutted: 1, accepted: 0 })
    expect(status.reviews.unresolved.map((dispute) => dispute.id)).toEqual(['D-001'])
    expect(status.unresolved.disputes).toHaveLength(1)
  })

  it('hangs a dispute on the requirement it names', () => {
    const status = buildPrototypeStatus(workspaceRoot, slug)
    const row = status.requirements.find((requirement) => requirement.id === 'R-001')

    expect(row?.disputes.map((dispute) => dispute.id)).toEqual(['D-001'])
  })

  it('reads the PRD it was given, so the fixtures above are the real thing', () => {
    expect(resolveRequirementCoverage(workspaceRoot, slug).requirements.map((r) => r.id)).toEqual([
      'R-001',
      'R-002',
      'R-003',
    ])
  })
})
