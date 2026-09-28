import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  getPrototypeDirPath,
  getPrototypeReviewsPath,
  parsePrototypeReview,
  parseRequirementDocument,
  parseReviewTarget,
  readPrototypeReviews,
  requirementFingerprint,
} from '..'

const PRD = ['## R-001 A cart holds its line until stock runs out', '', 'Given a line is in the cart…', ''].join('\n')

/** The fingerprint a review has to record for the requirement as it stands above. */
function fingerprintOf(prd = PRD): string {
  const requirement = parseRequirementDocument(prd, 'PRD.md').requirements.find((entry) => entry.id === 'R-001')
  if (!requirement) throw new Error('fixture PRD has no R-001')
  return requirementFingerprint(requirement)
}

function reviewFile(lines: string[]): string {
  return `${lines.join('\n')}\n`
}

describe('parsePrototypeReview', () => {
  it('reads the id, the target, the status, the fingerprint and the claim', () => {
    const review = parsePrototypeReview(
      reviewFile([
        '# D-001 The total is not actually pinned',
        '',
        'about: requirement R-003',
        'on: 3f9a1c2e',
        'status: open',
        'claim: The summary row scrolls off screen once the list is long.',
        'evidence: shots/cart-scrolled.png',
        '',
        'The requirement does not say what happens when the line is gone.',
      ]),
      'reviews/D-001-sticky-total.md',
    )

    expect(review?.id).toBe('D-001')
    expect(review?.title).toBe('The total is not actually pinned')
    expect(review?.target).toEqual({ kind: 'requirement', ref: 'R-003' })
    expect(review?.status).toBe('open')
    expect(review?.on).toBe('3f9a1c2e')
    expect(review?.claim).toBe('The summary row scrolls off screen once the list is long.')
    expect(review?.evidence).toEqual(['shots/cart-scrolled.png'])
    expect(review?.body).toContain('does not say what happens when the line is gone')
  })

  it('normalises the requirement id it names', () => {
    const review = parsePrototypeReview(
      reviewFile(['# D-7 the total', 'about: requirement r-3', 'status: open', 'claim: x']),
      'reviews/D-007-total.md',
    )

    expect(review?.id).toBe('D-007')
    expect(review?.target).toEqual({ kind: 'requirement', ref: 'R-003' })
  })

  it('is null for a file that is not a review at all', () => {
    // A plain note is a legitimate thing to keep in the directory, exactly as it is in research/.
    expect(parsePrototypeReview('# notes\n\nsomething I noticed\n', 'reviews/notes.md')).toBeNull()
  })

  it('takes an unknown status as no status, rather than inventing one', () => {
    const review = parsePrototypeReview(
      reviewFile(['# D-001 x', 'about: requirement R-003', 'status: maybe', 'claim: x']),
      'reviews/D-001-x.md',
    )

    expect(review?.status).toBeNull()
    expect(review?.target).toEqual({ kind: 'requirement', ref: 'R-003' })
  })
})

describe('parseReviewTarget', () => {
  it('reads the one thing a dispute can be about', () => {
    expect(parseReviewTarget('requirement R-001')).toEqual({ kind: 'requirement', ref: 'R-001' })
  })

  // A page, a patch and an endpoint are no longer things this workbench has, so naming one is not a
  // target — it is a dispute that cannot be acted on, and `null` says so rather than guessing at an
  // intent.
  it('refuses anything else rather than guessing at it', () => {
    expect(parseReviewTarget('')).toBeNull()
    expect(parseReviewTarget('cart')).toBeNull()
    expect(parseReviewTarget('endpoint GET /api/cart')).toBeNull()
    expect(parseReviewTarget('page cart')).toBeNull()
    expect(parseReviewTarget('patch ui-001-x.css')).toBeNull()
    expect(parseReviewTarget('requirement TBD')).toBeNull()
  })
})

describe('readPrototypeReviews', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-reviews-'))
    mkdirSync(getPrototypeDirPath(workspaceRoot, slug), { recursive: true })
    mkdirSync(getPrototypeReviewsPath(workspaceRoot, slug), { recursive: true })
    writeFileSync(join(getPrototypeDirPath(workspaceRoot, slug), 'PRD.md'), PRD, 'utf-8')
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  function writeReview(file: string, lines: string[]): void {
    writeFileSync(join(getPrototypeReviewsPath(workspaceRoot, slug), file), reviewFile(lines), 'utf-8')
  }

  it('holds an objection against a requirement, while that requirement is unchanged', () => {
    writeReview('D-001-sticky.md', [
      '# D-001 the total is not pinned',
      '',
      'about: requirement R-001',
      `on: ${fingerprintOf()}`,
      'status: open',
      'claim: it scrolls off screen',
    ])

    const { reviews, issues } = readPrototypeReviews(workspaceRoot, slug)

    expect(reviews).toHaveLength(1)
    expect(reviews[0]?.stale).toBe(false)
    expect(reviews[0]?.staleReason).toBeNull()
    expect(issues).toEqual([])
  })

  it('reports an argument about a wording that no longer exists, with both fingerprints', () => {
    const before = fingerprintOf()
    writeReview('D-001-sticky.md', [
      '# D-001 the total is not pinned',
      '',
      'about: requirement R-001',
      `on: ${before}`,
      'status: open',
      'claim: it scrolls off screen',
    ])
    // The requirement is rewritten: the dispute is now about something that is not there.
    writeFileSync(join(getPrototypeDirPath(workspaceRoot, slug), 'PRD.md'), PRD.replace('runs out', 'runs out of stock'), 'utf-8')

    const { reviews } = readPrototypeReviews(workspaceRoot, slug)

    expect(reviews[0]?.stale).toBe(true)
    expect(reviews[0]?.staleReason).toContain(`R-001 in PRD.md has changed since this was filed (${before} → `)
  })

  it('reports "fixed" on a requirement that has not changed as a record that disagrees with the files', () => {
    writeReview('D-001-sticky.md', [
      '# D-001 the total is not pinned',
      '',
      'about: requirement R-001',
      `on: ${fingerprintOf()}`,
      'status: fixed',
      'claim: it scrolls off screen',
    ])

    const { reviews } = readPrototypeReviews(workspaceRoot, slug)

    expect(reviews[0]?.stale).toBe(true)
    expect(reviews[0]?.staleReason).toContain('marked fixed, but R-001 in PRD.md has not changed since this was filed')
  })

  it('does not check the disk for a decision about the argument', () => {
    // `rebutted` and `accepted` are adjudications: nothing a file says can contradict them.
    writeReview('D-001-sticky.md', [
      '# D-001 the total is not pinned',
      '',
      'about: requirement R-001',
      'on: 00000000',
      'status: rebutted',
      'claim: it scrolls off screen',
    ])

    expect(readPrototypeReviews(workspaceRoot, slug).reviews[0]?.stale).toBe(false)
  })

  it('reports a dispute it cannot act on, with the line to add', () => {
    writeReview('D-001-nothing.md', ['# D-001 something is off', '', 'status: open', 'claim: x'])
    writeReview('D-002-status.md', ['# D-002 x', '', 'about: requirement R-001', 'claim: x'])
    writeReview('D-003-claim.md', ['# D-003 x', '', 'about: requirement R-001', 'status: open'])
    writeReview('D-004-no-on.md', [
      '# D-004 x',
      '',
      'about: requirement R-001',
      'status: open',
      'claim: x',
    ])
    writeReview('D-005-undefined.md', [
      '# D-005 x',
      '',
      'about: requirement R-009',
      `on: ${fingerprintOf()}`,
      'status: open',
      'claim: x',
    ])

    const issues = readPrototypeReviews(workspaceRoot, slug).issues.join('\n')

    expect(issues).toContain('no usable "about:" line')
    expect(issues).toContain('no usable "status:" line')
    expect(issues).toContain('no "claim:" line')
    expect(issues).toContain('a dispute needs "on:"')
    expect(issues).toContain('which no document here defines')
  })

  it('reports two files claiming one id, and keeps the first', () => {
    writeReview('D-001-a.md', ['# D-001 first', '', 'about: requirement R-001', 'status: open', 'claim: x'])
    writeReview('D-001-b.md', ['# D-001 second', '', 'about: requirement R-001', 'status: open', 'claim: y'])

    const { reviews, issues } = readPrototypeReviews(workspaceRoot, slug)

    expect(reviews).toHaveLength(1)
    expect(reviews[0]?.claim).toBe('x')
    expect(issues.join('\n')).toContain('id D-001 is already used')
  })

  it('reads nothing at all when the prototype has no reviews', () => {
    expect(readPrototypeReviews(workspaceRoot, 'missing')).toEqual({ reviews: [], issues: [] })
  })
})
