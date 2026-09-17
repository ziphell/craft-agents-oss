import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  ACCEPTANCE_STATE_FILENAME,
  acceptanceCheckKey,
  compareAcceptance,
  getPrototypeAcceptancePath,
  readAcceptanceState,
  summarizeAcceptance,
  writeAcceptanceState,
} from '..'

const AT = '2026-09-16T10:00:00.000Z'

function observation(requirementId: string, kind: string, target: string, status: 'pass' | 'fail' | 'skip') {
  return { requirementId, kind, target, status }
}

describe('compareAcceptance', () => {
  const selector = observation('R-001', 'selector', '[data-cart-total]', 'pass')
  const endpoint = observation('R-002', 'endpoint', 'GET /api/cart', 'pass')

  it('starts at round 1 and says nothing about movement it cannot know', () => {
    const { state, diff } = compareAcceptance(null, [selector, endpoint], AT)

    expect(state.round).toBe(1)
    expect(state.checks[acceptanceCheckKey(selector)]).toEqual({
      status: 'pass',
      requirement: 'R-001',
      at: AT,
    })
    expect(diff.newRed).toEqual([])
    expect(diff.fixed).toEqual([])
    expect(diff.stillRed).toEqual([])
    expect(diff.gone).toEqual([])
  })

  it('sorts every change into the action it asks for', () => {
    const first = compareAcceptance(
      null,
      [
        selector,
        endpoint,
        observation('R-003', 'selector', '[data-badge]', 'pass'),
        observation('R-004', 'selector', '[data-old]', 'fail'),
        observation('R-005', 'selector', '[data-skipped]', 'fail'),
        observation('R-006', 'selector', '[data-dropped]', 'pass'),
      ],
      AT,
    ).state

    const { state, diff } = compareAcceptance(
      first,
      [
        observation('R-001', 'selector', '[data-cart-total]', 'fail'),
        endpoint,
        observation('R-003', 'selector', '[data-badge]', 'pass'),
        observation('R-004', 'selector', '[data-old]', 'fail'),
        observation('R-005', 'selector', '[data-skipped]', 'skip'),
      ],
      '2026-09-16T11:00:00.000Z',
    )

    expect(state.round).toBe(2)
    expect(diff.newRed).toEqual(['selector: [data-cart-total]'])
    expect(diff.stillRed).toEqual(['selector: [data-old]'])
    expect(diff.notRun).toEqual(['selector: [data-skipped]'])
    expect(diff.fixed).toEqual([])
    expect(diff.gone).toEqual(['selector: [data-dropped]'])
  })

  it('counts a failure that passes as fixed, and stops counting it as red', () => {
    const first = compareAcceptance(null, [observation('R-002', 'endpoint', 'GET /api/cart', 'fail')], AT).state

    const { state, diff } = compareAcceptance(
      first,
      [observation('R-002', 'endpoint', 'GET /api/cart', 'pass')],
      AT,
    )

    expect(diff.fixed).toEqual(['endpoint: GET /api/cart'])
    expect(diff.newRed).toEqual([])
    expect(state.checks['endpoint: GET /api/cart']?.status).toBe('pass')
  })

  it('keys a check by the assertion, not by the requirement it is written under', () => {
    // Moving a `check:` line to another requirement is not a change in what is being verified, and
    // must not read as one — the check is the same check.
    const first = compareAcceptance(null, [observation('R-001', 'selector', '[data-total]', 'fail')], AT).state

    const { diff } = compareAcceptance(first, [observation('R-009', 'selector', '[data-total]', 'fail')], AT)

    expect(diff.stillRed).toEqual(['selector: [data-total]'])
    expect(diff.gone).toEqual([])
    expect(diff.newRed).toEqual([])
  })
})

describe('acceptance state on disk', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-acceptance-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('round-trips a run, and summarizes it the way a report reads it', () => {
    const { state } = compareAcceptance(
      null,
      [
        observation('R-001', 'selector', '[data-total]', 'pass'),
        observation('R-002', 'endpoint', 'GET /api/cart', 'fail'),
        observation('R-003', 'selector', '[data-badge]', 'skip'),
      ],
      AT,
    )

    const path = writeAcceptanceState(workspaceRoot, slug, state)
    expect(path).toBe(join(getPrototypeAcceptancePath(workspaceRoot, slug), ACCEPTANCE_STATE_FILENAME))

    const summary = summarizeAcceptance(readAcceptanceState(workspaceRoot, slug))
    expect(summary).toEqual({
      round: 1,
      at: AT,
      passed: 1,
      failed: 1,
      skipped: 1,
      red: ['endpoint: GET /api/cart'],
    })
  })

  it('reads "never run" as null rather than as an empty pass', () => {
    expect(readAcceptanceState(workspaceRoot, slug)).toBeNull()
    expect(summarizeAcceptance(null)).toBeNull()
  })

  it('keeps what it can read of a file it did not write, and drops the rest', () => {
    const dir = getPrototypeAcceptancePath(workspaceRoot, slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, ACCEPTANCE_STATE_FILENAME),
      JSON.stringify({
        round: 4,
        at: AT,
        checks: {
          'selector: [ok]': { status: 'pass', requirement: 'R-001', at: AT },
          'selector: [odd]': { status: 'banana', requirement: 'R-002', at: AT },
        },
      }),
      'utf-8',
    )

    const state = readAcceptanceState(workspaceRoot, slug)

    expect(state?.round).toBe(4)
    expect(Object.keys(state?.checks ?? {})).toEqual(['selector: [ok]'])
  })

  it('treats an unreadable record as no record at all', () => {
    const dir = getPrototypeAcceptancePath(workspaceRoot, slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ACCEPTANCE_STATE_FILENAME), '{ not json', 'utf-8')

    expect(readAcceptanceState(workspaceRoot, slug)).toBeNull()
  })
})
