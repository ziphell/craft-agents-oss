import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildPrototypeStatus,
  compareAcceptance,
  createPrototype,
  getPrototypeAcceptancePath,
  getPrototypeDirPath,
  getPrototypePatchesPath,
  getPrototypeReviewsPath,
  getContractPathsPath,
  getContractFixturesPath,
  patchFingerprint,
  readPrototypeRequirements,
  resolveRequirementCoverage,
  whyPrototypeIsNotSettled,
  writeAcceptanceState,
  writePrototypePage,
} from '..'

const PAGE = '<!doctype html><html><body><h1>Cart</h1></body></html>'
const PATCH = '@requirement R-001\n@target .total\n.total { position: sticky }\n'

const PRD = [
  '## R-001 A cart holds its line',
  '',
  'check: selector [data-cart-total]',
  '',
  '## R-002 The cart is priced by the service',
  '',
  'check: endpoint GET /api/cart',
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
    writePrototypePage(workspaceRoot, slug, 'cart', PAGE)
    writeFileSync(join(getPrototypeDirPath(workspaceRoot, slug), 'PRD.md'), PRD, 'utf-8')
    mkdirSync(getPrototypePatchesPath(workspaceRoot, slug), { recursive: true })
    writeFileSync(join(getPrototypePatchesPath(workspaceRoot, slug), 'main-001-total.css'), PATCH, 'utf-8')
    // R-002 is served by the contract in this fixture, but the thread reads pages and patches: a
    // requirement no file carries a marker for is one nothing implements, by the rule in coverage.ts.
    writeFileSync(
      join(getPrototypePatchesPath(workspaceRoot, slug), 'main-002-api.js'),
      '@requirement R-002\nfetch("/api/cart")\n',
      'utf-8',
    )
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /** Write the change that implements R-003, the requirement the fixture leaves open. */
  function implementR003(): void {
    writeFileSync(
      join(getPrototypePatchesPath(workspaceRoot, slug), 'main-003-cancel.css'),
      '@requirement R-003\n.cancel { display: block }\n',
      'utf-8',
    )
  }

  /** A green round: every check the PRD declares answered `pass`. */
  function recordGreenRound(): void {
    const { state } = compareAcceptance(
      null,
      [
        { requirementId: 'R-001', kind: 'selector', target: '[data-cart-total]', status: 'pass' },
        { requirementId: 'R-002', kind: 'endpoint', target: 'GET /api/cart', status: 'pass' },
      ],
      '2026-09-16T10:00:00.000Z',
    )
    writeAcceptanceState(workspaceRoot, slug, state)
  }

  function writeReview(file: string, lines: string[]): void {
    mkdirSync(getPrototypeReviewsPath(workspaceRoot, slug), { recursive: true })
    writeFileSync(join(getPrototypeReviewsPath(workspaceRoot, slug), file), `${lines.join('\n')}\n`, 'utf-8')
  }

  it('says nothing when there is nothing owed', () => {
    implementR003()
    recordGreenRound()

    expect(whyPrototypeIsNotSettled(buildPrototypeStatus(workspaceRoot, slug))).toEqual([])
  })

  it('names a requirement nothing implements', () => {
    recordGreenRound()

    const reasons = whyPrototypeIsNotSettled(buildPrototypeStatus(workspaceRoot, slug))

    // The code is the contract with the panel; the sentence is what the agent prints.
    expect(reasons.map((reason) => reason.code)).toEqual(['gate.requirementUnmet'])
    expect(reasons[0]?.text).toBe(
      'R-003 is in PRD.md but no page or patch refers to it, so nothing implements it.',
    )
  })

  it('names an objection nobody answered, and a stale one with its reason', () => {
    implementR003()
    recordGreenRound()
    const fingerprint = patchFingerprint(PATCH)
    writeReview('D-001-total.md', [
      '# D-001 the total is not pinned',
      '',
      'about: patch main-001-total.css',
      `on: ${fingerprint}`,
      'status: open',
      'claim: it scrolls off screen',
    ])
    // The disputed patch moves: the argument is now about a version that no longer exists.
    writeFileSync(
      join(getPrototypePatchesPath(workspaceRoot, slug), 'main-001-total.css'),
      `${PATCH}.total { z-index: 2 }\n`,
      'utf-8',
    )

    const reasons = whyPrototypeIsNotSettled(buildPrototypeStatus(workspaceRoot, slug))

    expect(reasons).toHaveLength(1)
    expect(reasons[0]?.code).toBe('gate.disputeStanding')
    expect(reasons[0]?.text).toContain('reviews/D-001-total.md disputes patch patches/main-001-total.css')
    expect(reasons[0]?.text).toContain('still stands (open)')
    expect(reasons[0]?.text).toContain('has changed since this was filed')
  })

  it('names a red check from the last round', () => {
    implementR003()
    const { state } = compareAcceptance(
      null,
      [
        { requirementId: 'R-001', kind: 'selector', target: '[data-cart-total]', status: 'fail' },
        { requirementId: 'R-002', kind: 'endpoint', target: 'GET /api/cart', status: 'pass' },
      ],
      '2026-09-16T10:00:00.000Z',
    )
    writeAcceptanceState(workspaceRoot, slug, state)

    const reasons = whyPrototypeIsNotSettled(buildPrototypeStatus(workspaceRoot, slug))

    expect(reasons.map((reason) => reason.code)).toEqual(['gate.checkFailed'])
    expect(reasons[0]?.text).toBe('`selector: [data-cart-total]` failed in the last verification round.')
  })

  it('tells "never ran" apart from "nothing is red"', () => {
    implementR003()

    const reasons = whyPrototypeIsNotSettled(buildPrototypeStatus(workspaceRoot, slug))

    expect(reasons.map((reason) => reason.code)).toEqual(['gate.checksNeverRun'])
    expect(reasons[0]?.text).toContain('have never been run here')
  })

  it('names a faked response the contract declares but nobody wrote', () => {
    implementR003()
    recordGreenRound()

    // A service whose one faked response has no file: the route is skipped, so the request is
    // not faked — the recipient gets a page that reaches for something they do not have.
    const paths = getContractPathsPath(workspaceRoot, slug, 'checkout-api')
    mkdirSync(paths, { recursive: true })
    writeFileSync(
      join(paths, 'list-orders.yaml'),
      [
        '/orders:',
        '  get:',
        '    x-mock:',
        '      fixture: list-orders-200',
        '    responses:',
        "      '200':",
        '        description: OK',
        '',
      ].join('\n'),
      'utf-8',
    )

    const reasons = whyPrototypeIsNotSettled(buildPrototypeStatus(workspaceRoot, slug))

    expect(reasons.map((reason) => reason.code)).toEqual(['gate.serviceUncovered'])
    expect(reasons[0]?.params).toEqual({ service: 'checkout-api', fixtures: 'list-orders-200' })
    expect(reasons[0]?.text).toBe(
      'checkout-api declares responses that are not on disk: list-orders-200 — those requests are not faked, ' +
        'so they go to the real backend.',
    )
  })

  it('says nothing about a service whose faked response is on disk', () => {
    implementR003()
    recordGreenRound()

    const paths = getContractPathsPath(workspaceRoot, slug, 'checkout-api')
    mkdirSync(paths, { recursive: true })
    writeFileSync(
      join(paths, 'list-orders.yaml'),
      [
        '/orders:',
        '  get:',
        '    x-mock:',
        '      fixture: list-orders-200',
        '    responses:',
        "      '200':",
        '        description: OK',
        '',
      ].join('\n'),
      'utf-8',
    )
    const fixtures = getContractFixturesPath(workspaceRoot, slug, 'checkout-api')
    mkdirSync(fixtures, { recursive: true })
    writeFileSync(join(fixtures, 'list-orders-200.json'), '[{ "id": 1 }]', 'utf-8')

    expect(whyPrototypeIsNotSettled(buildPrototypeStatus(workspaceRoot, slug))).toEqual([])
  })
})

describe('the status report carries the argument and the last round', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-settlement-status-'))
    createPrototype(workspaceRoot, { name: slug })
    writePrototypePage(workspaceRoot, slug, 'cart', PAGE)
    writeFileSync(join(getPrototypeDirPath(workspaceRoot, slug), 'PRD.md'), PRD, 'utf-8')
    mkdirSync(getPrototypePatchesPath(workspaceRoot, slug), { recursive: true })
    writeFileSync(join(getPrototypePatchesPath(workspaceRoot, slug), 'main-001-total.css'), PATCH, 'utf-8')
    mkdirSync(getPrototypeReviewsPath(workspaceRoot, slug), { recursive: true })
    // One dispute per file, both read the same way — the id at the top of the file is the review.
    writeFileSync(
      join(getPrototypeReviewsPath(workspaceRoot, slug), 'D-001-total.md'),
      ['# D-001 the total is not pinned', '', 'about: requirement R-001', 'status: open', 'claim: it scrolls off screen'].join('\n'),
      'utf-8',
    )
    writeFileSync(
      join(getPrototypeReviewsPath(workspaceRoot, slug), 'D-002-heading.md'),
      ['# D-002 the heading was missing', '', 'about: page cart', 'status: fixed', 'claim: the h1 was not rendered'].join('\n'),
      'utf-8',
    )
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('counts the disputes by status and lists the ones that stand', () => {
    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.reviews.total).toBe(2)
    expect(status.reviews.byStatus).toEqual({ open: 1, fixed: 1, rebutted: 0, accepted: 0 })
    expect(status.reviews.unresolved.map((dispute) => dispute.id)).toEqual(['D-001'])
    expect(status.unresolved.disputes).toHaveLength(1)
  })

  it('hangs a dispute on the requirement it names', () => {
    const status = buildPrototypeStatus(workspaceRoot, slug)
    const row = status.requirements.find((requirement) => requirement.id === 'R-001')

    expect(row?.disputes.map((dispute) => dispute.id)).toEqual(['D-001'])
    expect(row?.checks).toEqual([{ kind: 'selector', target: '[data-cart-total]' }])
  })

  it('hangs a dispute on a patch on whatever that patch serves', () => {
    writeFileSync(
      join(getPrototypeReviewsPath(workspaceRoot, slug), 'D-003-patch.md'),
      [
        '# D-003 the sticky rule is not enough',
        '',
        'about: patch main-001-total.css',
        `on: ${patchFingerprint(PATCH)}`,
        'status: open',
        'claim: the container still scrolls away',
      ].join('\n'),
      'utf-8',
    )

    const coverage = resolveRequirementCoverage(workspaceRoot, slug)
    const row = coverage.requirements.find((requirement) => requirement.id === 'R-001')

    // The patch declares `@requirement R-001`, and the thread is derived rather than restated: the
    // review file never names the requirement.
    expect(row?.disputes.map((dispute) => dispute.id)).toEqual(['D-001', 'D-003'])
    expect(coverage.reviews.unresolved.map((dispute) => dispute.id)).toEqual(['D-001', 'D-003'])
  })

  it('reports the checks that have never run as no acceptance at all', () => {
    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.acceptance).toBeNull()
    expect(status.unresolved.redChecks).toEqual([])
  })

  it('reads the PRD it was given, so the fixtures above are the real thing', () => {
    expect(readPrototypeRequirements(workspaceRoot, slug).requirements.map((r) => r.id)).toEqual([
      'R-001',
      'R-002',
      'R-003',
    ])
    expect(getPrototypeAcceptancePath(workspaceRoot, slug)).toContain('acceptance')
  })
})
