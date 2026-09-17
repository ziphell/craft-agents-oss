import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  getPrototypePatchesPath,
  getPrototypeReviewsPath,
  parsePrototypeReview,
  parseReviewTarget,
  patchFingerprint,
  readPrototypeReviews,
} from '..'

const PATCH = '@target .total\n.total { position: sticky; }\n'

function reviewFile(lines: string[]): string {
  return `${lines.join('\n')}\n`
}

describe('parsePrototypeReview', () => {
  it('reads the id, the target, the status and the claim', () => {
    const review = parsePrototypeReview(
      reviewFile([
        '# D-001 The total is not actually pinned',
        '',
        'about: patch ui-001-sticky.css',
        'on: 3f9a1c2e',
        'status: open',
        'claim: The summary row scrolls off screen once the list is long.',
        'evidence: prototype-verify — check: selector [data-cart-total] did not match',
        '',
        'position: sticky needs a scroll container that is not the page.',
      ]),
      'reviews/D-001-sticky-total.md',
    )

    expect(review?.id).toBe('D-001')
    expect(review?.title).toBe('The total is not actually pinned')
    // A patch is named the way everything else points at one, whether or not the author wrote the
    // `patches/` prefix.
    expect(review?.target).toEqual({ kind: 'patch', ref: 'patches/ui-001-sticky.css' })
    expect(review?.status).toBe('open')
    expect(review?.on).toBe('3f9a1c2e')
    expect(review?.claim).toBe('The summary row scrolls off screen once the list is long.')
    expect(review?.evidence).toEqual(['prototype-verify — check: selector [data-cart-total] did not match'])
    expect(review?.body).toContain('position: sticky needs a scroll container')
  })

  it('normalises the id and the requirement it names', () => {
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
      reviewFile(['# D-001 x', 'about: page cart', 'status: maybe', 'claim: x']),
      'reviews/D-001-x.md',
    )

    expect(review?.status).toBeNull()
    expect(review?.target).toEqual({ kind: 'page', ref: 'cart' })
  })
})

describe('parseReviewTarget', () => {
  it('reads the four things a dispute can be about', () => {
    expect(parseReviewTarget('patch cart/ui-002-x.css')).toEqual({ kind: 'patch', ref: 'patches/cart/ui-002-x.css' })
    expect(parseReviewTarget('page cart')).toEqual({ kind: 'page', ref: 'cart' })
    expect(parseReviewTarget('endpoint GET /api/cart')).toEqual({ kind: 'endpoint', ref: 'GET /api/cart' })
    expect(parseReviewTarget('requirement R-001')).toEqual({ kind: 'requirement', ref: 'R-001' })
  })

  it('refuses anything else rather than guessing at it', () => {
    expect(parseReviewTarget('')).toBeNull()
    expect(parseReviewTarget('cart')).toBeNull()
    expect(parseReviewTarget('patch')).toBeNull()
    expect(parseReviewTarget('screen cart')).toBeNull()
  })
})

describe('readPrototypeReviews', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-reviews-'))
    mkdirSync(getPrototypePatchesPath(workspaceRoot, slug), { recursive: true })
    mkdirSync(getPrototypeReviewsPath(workspaceRoot, slug), { recursive: true })
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  function writePatch(file: string, source: string): string {
    writeFileSync(join(getPrototypePatchesPath(workspaceRoot, slug), file), source, 'utf-8')
    return patchFingerprint(source)
  }

  function writeReview(file: string, lines: string[]): void {
    writeFileSync(join(getPrototypeReviewsPath(workspaceRoot, slug), file), reviewFile(lines), 'utf-8')
  }

  it('holds an objection against the file it names, while that file is unchanged', () => {
    const fingerprint = writePatch('ui-001-total.css', PATCH)
    writeReview('D-001-total.md', [
      '# D-001 the total is not pinned',
      '',
      'about: patch ui-001-total.css',
      `on: ${fingerprint}`,
      'status: open',
      'claim: it scrolls off screen',
    ])

    const { reviews, issues } = readPrototypeReviews(workspaceRoot, slug)

    expect(reviews).toHaveLength(1)
    expect(reviews[0]?.stale).toBe(false)
    expect(reviews[0]?.staleReason).toBeNull()
    expect(issues).toEqual([])
  })

  it('reports an argument about a stale version, with both fingerprints', () => {
    const before = writePatch('ui-001-total.css', PATCH)
    writeReview('D-001-total.md', [
      '# D-001 the total is not pinned',
      '',
      'about: patch ui-001-total.css',
      `on: ${before}`,
      'status: open',
      'claim: it scrolls off screen',
    ])
    const after = writePatch('ui-001-total.css', `${PATCH}.total { z-index: 2 }\n`)

    const { reviews } = readPrototypeReviews(workspaceRoot, slug)

    expect(reviews[0]?.stale).toBe(true)
    expect(reviews[0]?.staleReason).toContain(`${before} → ${after}`)
  })

  it('reports "fixed" on a file that has not changed as a record that disagrees with the disk', () => {
    const fingerprint = writePatch('ui-001-total.css', PATCH)
    writeReview('D-001-total.md', [
      '# D-001 the total is not pinned',
      '',
      'about: patch ui-001-total.css',
      `on: ${fingerprint}`,
      'status: fixed',
      'claim: it scrolls off screen',
    ])

    const { reviews } = readPrototypeReviews(workspaceRoot, slug)

    expect(reviews[0]?.stale).toBe(true)
    expect(reviews[0]?.staleReason).toContain('marked fixed, but patches/ui-001-total.css has not changed')
  })

  it('does not check the disk for a decision about the argument', () => {
    // `rebutted` and `accepted` are adjudications: nothing a file says can contradict them.
    writePatch('ui-001-total.css', PATCH)
    writeReview('D-001-total.md', [
      '# D-001 the total is not pinned',
      '',
      'about: patch ui-001-total.css',
      'on: 00000000',
      'status: rebutted',
      'claim: it scrolls off screen',
    ])

    expect(readPrototypeReviews(workspaceRoot, slug).reviews[0]?.stale).toBe(false)
  })

  it('reports a dispute it cannot act on, with the line to add', () => {
    const fingerprint = writePatch('ui-001-total.css', PATCH)
    writeReview('D-001-nothing.md', ['# D-001 something is off', '', 'status: open', 'claim: x'])
    writeReview('D-002-status.md', ['# D-002 x', '', 'about: page cart', 'claim: x'])
    writeReview('D-003-claim.md', ['# D-003 x', '', 'about: page cart', 'status: open'])
    writeReview('D-004-no-on.md', [
      '# D-004 x',
      '',
      'about: patch ui-001-total.css',
      'status: open',
      'claim: x',
    ])
    writeReview('D-005-on-page.md', [
      '# D-005 x',
      '',
      'about: page cart',
      'on: abcdef12',
      'status: open',
      'claim: x',
    ])
    writeReview('D-006-gone.md', [
      '# D-006 x',
      '',
      'about: patch ui-009-deleted.css',
      `on: ${fingerprint}`,
      'status: open',
      'claim: x',
    ])

    const issues = readPrototypeReviews(workspaceRoot, slug).issues.join('\n')

    expect(issues).toContain('no usable "about:" line')
    expect(issues).toContain('no usable "status:" line')
    expect(issues).toContain('no "claim:" line')
    expect(issues).toContain('a patch dispute needs "on:"')
    expect(issues).toContain('"on:" applies to a patch dispute only')
    expect(issues).toContain('which is not in this prototype')
  })

  it('reports two files claiming one id, and keeps the first', () => {
    writeReview('D-001-a.md', ['# D-001 first', '', 'about: page cart', 'status: open', 'claim: x'])
    writeReview('D-001-b.md', ['# D-001 second', '', 'about: page cart', 'status: open', 'claim: y'])

    const { reviews, issues } = readPrototypeReviews(workspaceRoot, slug)

    expect(reviews).toHaveLength(1)
    expect(reviews[0]?.claim).toBe('x')
    expect(issues.join('\n')).toContain('id D-001 is already used')
  })

  it('reads nothing at all when the prototype has no reviews', () => {
    expect(readPrototypeReviews(workspaceRoot, 'missing')).toEqual({ reviews: [], issues: [] })
  })
})
