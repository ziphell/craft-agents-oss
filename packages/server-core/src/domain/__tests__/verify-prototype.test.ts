/**
 * The acceptance runner (plan §20.7) — `verifyPrototype`.
 *
 * The one core piece that had no test, and the reason is worth naming: the *page* half of it needs a
 * real window, so the whole function was left to "type-checked and exercised through the command".
 * What that misses is the half that needs no browser at all — the endpoint checks, the round record,
 * and the diff a reader acts on ("five red is an emergency if it was zero this morning"). Those are
 * exactly the parts where being wrong is quiet: a check that reported `skip` as `fail` would make a
 * run nobody could look at read as a broken prototype, and a round that compared against itself
 * would report nothing moved for ever.
 *
 * The window is faked here rather than opened: a `page(answer)` stub answers the one question the
 * runner asks a page ("is that selector there?"). A throw is its own case, because a window that
 * closed between reading its address and asking it a question must be "could not look".
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  getPrototypeDirPath,
  getPrototypeDistPath,
  getPrototypeServicesPath,
  readAcceptanceState,
  setPrototypeBaseUrlResolver,
  writePrototypeConfig,
} from '@craft-agent/shared/prototypes'
import { ACCEPTANCE_FILENAME, verifyPrototype, type PrototypeVerification } from '../verify-prototype'
import type { IBrowserPaneManager } from '../../handlers/browser-pane-manager-interface'

const SLUG = 'checkout-flow'
const PAGE_URL = 'http://checkout-flow-abc123ab.localhost/cart.html'

let workspaceRoot = ''

beforeEach(() => {
  // A page of ours has no address of its own — the host gives it one — so without a resolver the
  // runner cannot name the page a failed check belongs to, and the advice it hands over degrades to
  // `about: page <page>`. The app installs this; the test has to as well.
  setPrototypeBaseUrlResolver((_workspaceRootPath, slug) => `http://${slug}-abc123ab.localhost`)
})

afterEach(() => {
  // Process-global: leaving one installed would leak into every later test in the process.
  setPrototypeBaseUrlResolver(null)
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  workspaceRoot = ''
})

/** A prototype with one page, and a PRD carrying whatever checks the test is about. */
function makePrototype(prd: string): void {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-verify-'))
  const dir = getPrototypeDirPath(workspaceRoot, SLUG)
  mkdirSync(join(dir, 'patches'), { recursive: true })
  writePrototypeConfig(workspaceRoot, SLUG, { pages: [{ name: 'cart', kind: 'scratch', entry: true }] })
  writeFileSync(join(dir, 'cart.html'), '<!doctype html><html><body>cart</body></html>', 'utf-8')
  writePrd(prd)
}

/** Rewrite the PRD — how a requirement's checks change between rounds. */
function writePrd(prd: string): void {
  writeFileSync(join(getPrototypeDirPath(workspaceRoot, SLUG), 'PRD.md'), prd, 'utf-8')
}

/** A service whose contract declares exactly these `[method, path]` pairs. */
function declareEndpoints(endpoints: Array<[string, string]>): void {
  const pathsDir = join(getPrototypeServicesPath(workspaceRoot, SLUG), 'checkout-api', 'paths')
  mkdirSync(pathsDir, { recursive: true })
  const items = endpoints
    .map(([method, path]) => `  ${path}:\n    ${method.toLowerCase()}:\n      responses:\n        '200': { description: OK }\n`)
    .join('')
  writeFileSync(join(pathsDir, 'orders.yaml'), `paths:\n${items}`, 'utf-8')
}

/** Take the contract away, the way a requirement losing its endpoint does. */
function removeServices(): void {
  rmSync(getPrototypeServicesPath(workspaceRoot, SLUG), { recursive: true, force: true })
}

/** A window that answers one question: is that selector on the page? */
function pageWith(answer: boolean | Error): IBrowserPaneManager {
  return {
    evaluate: async () => {
      if (answer instanceof Error) throw answer
      return answer
    },
  } as unknown as IBrowserPaneManager
}

const run = (): Promise<PrototypeVerification> => verifyPrototype(null, null, workspaceRoot, SLUG, null)

const runOnPage = (bpm: IBrowserPaneManager): Promise<PrototypeVerification> =>
  verifyPrototype(bpm, 'tab-1', workspaceRoot, SLUG, { id: 'tab-1', url: PAGE_URL })

const report = (): string => readFileSync(join(getPrototypeDistPath(workspaceRoot, SLUG), ACCEPTANCE_FILENAME), 'utf-8')

describe('verifyPrototype', () => {
  it('answers an endpoint check from the contract, folding the method but not the path', async () => {
    makePrototype('## R-001 A cart holds its line\ncheck: endpoint get /api/cart\ncheck: endpoint GET /api/orders\n')
    declareEndpoints([['GET', '/api/cart']])

    const verification = await run()

    expect(verification.results).toEqual([
      {
        requirementId: 'R-001',
        requirementTitle: 'A cart holds its line',
        kind: 'endpoint',
        target: 'get /api/cart',
        status: 'pass',
        detail: 'declared by service "checkout-api"',
      },
      {
        requirementId: 'R-001',
        requirementTitle: 'A cart holds its line',
        kind: 'endpoint',
        target: 'GET /api/orders',
        status: 'fail',
        detail: 'no service in this prototype declares this endpoint',
      },
    ])
    expect(verification.passed).toBe(1)
    expect(verification.failed).toBe(1)
    expect(verification.round).toBe(1)
  })

  /**
   * "We could not look" is not "it is not there". Collapsing the two would make a verification worth
   * running only once, and would report a prototype as broken because nobody had a window open.
   */
  it('skips a page check with no window, and does not call it a failure', async () => {
    makePrototype('## R-002 The total is on the page\ncheck: selector [data-cart-total]\n')

    const verification = await run()

    expect(verification.results).toHaveLength(1)
    expect(verification.results[0]?.status).toBe('skip')
    expect(verification.results[0]?.detail).toBe('no page was open to check against')
    expect(verification.failed).toBe(0)
    expect(verification.skipped).toBe(1)
    expect(verification.page).toBeNull()
  })

  it('runs a page check against the page the work is on, and names it', async () => {
    makePrototype('## R-002 The total is on the page\ncheck: selector [data-cart-total]\n')

    const found = await runOnPage(pageWith(true))
    expect(found.results[0]?.status).toBe('pass')
    expect(found.results[0]?.detail).toBe(`found on ${PAGE_URL}`)
    expect(found.page).toBe(PAGE_URL)
    // The page's *name*, so a failure can be disputed as `about: page cart` rather than by an
    // address that changes between environments.
    expect(found.pageName).toBe('cart')

    const missing = await runOnPage(pageWith(false))
    expect(missing.results[0]?.status).toBe('fail')
    expect(missing.results[0]?.detail).toBe(`not on ${PAGE_URL}`)
  })

  it('skips rather than fails when the page cannot be evaluated', async () => {
    makePrototype('## R-002 The total is on the page\ncheck: selector [data-cart-total]\n')

    const verification = await runOnPage(pageWith(new Error('the window was closed')))

    expect(verification.results[0]?.status).toBe('skip')
    expect(verification.results[0]?.detail).toContain('could not evaluate: the window was closed')
    expect(verification.failed).toBe(0)
  })

  /**
   * The record and the diff, across three rounds — the shape a reader actually acts on: what broke,
   * what is still broken, what was fixed, and what nobody can look at any more.
   */
  it('records each round, and says what moved against the one before', async () => {
    makePrototype(
      '## R-001 The cart is priced by the service\ncheck: endpoint GET /api/cart\n\n' +
        '## R-002 The total is on the page\ncheck: selector [data-cart-total]\n',
    )
    declareEndpoints([['GET', '/api/cart']])

    // Round 1: the endpoint is declared, the page says the total is not there.
    const first = await runOnPage(pageWith(false))
    expect(first.round).toBe(1)
    expect(first.diff.newRed).toEqual(['selector: [data-cart-total]'])
    expect(report()).toContain('First round — there is nothing to compare it against yet.')

    // Round 2: nothing can look at the page any more. That is *not* a fix, and the report says so.
    const second = await run()
    expect(second.round).toBe(2)
    expect(second.failed).toBe(0)
    expect(second.diff.notRun).toEqual(['selector: [data-cart-total]'])
    expect(second.diff.fixed).toEqual([])
    expect(report()).toContain('**No longer looked at**')
    expect(report()).toContain('not the same as fixed')

    // Round 3: the contract loses the endpoint (newly red) and the page can be looked at again,
    // where the total is now there (fixed against round 1, not against round 2).
    removeServices()
    const third = await runOnPage(pageWith(true))
    expect(third.round).toBe(3)
    expect(third.diff.newRed).toEqual(['endpoint: GET /api/cart'])
    expect(report()).toContain('**Newly red**')

    // The record is the state file, not the report: round 3 is what the next run compares against.
    const state = readAcceptanceState(workspaceRoot, SLUG)
    expect(state?.round).toBe(3)
    expect(state?.checks['endpoint: GET /api/cart']?.status).toBe('fail')
    expect(state?.checks['selector: [data-cart-total]']?.status).toBe('pass')
  })

  it('counts a still-red check as still red rather than as newly broken', async () => {
    makePrototype('## R-001 The cart is priced by the service\ncheck: endpoint GET /api/cart\n')
    declareEndpoints([['GET', '/api/orders']])

    await run()
    const second = await run()

    expect(second.diff.newRed).toEqual([])
    expect(second.diff.stillRed).toEqual(['endpoint: GET /api/cart'])
    expect(report()).toContain('**Still red**')
  })

  it('names a check the PRD stopped declaring', async () => {
    makePrototype('## R-001 The cart is priced by the service\ncheck: endpoint GET /api/cart\n')
    declareEndpoints([['GET', '/api/cart']])
    await run()

    // The requirement stays; what it was checked by does not.
    writePrd('## R-001 The cart is priced by the service\n')
    const second = await run()

    expect(second.diff.gone).toEqual(['endpoint: GET /api/cart'])
    expect(report()).toContain('**No longer declared**')
  })

  /**
   * A failure is a question, not an instruction: the run changes nothing but its own report, and
   * what it hands over is the one thing a reader needs to argue with it — the target to name.
   */
  it('hands over how to argue with a failure, and changes nothing else', async () => {
    makePrototype('## R-002 The total is on the page\ncheck: selector [data-cart-total]\n')

    await runOnPage(pageWith(false))

    expect(report()).toContain('## Arguing with a failure')
    expect(report()).toContain('`about: requirement R-002`')
    expect(report()).toContain('`about: page cart`')
    // The prototype itself: the page and the PRD are exactly as they were.
    expect(readFileSync(join(getPrototypeDirPath(workspaceRoot, SLUG), 'cart.html'), 'utf-8')).toContain('cart')
  })

  it('says what a check line looks like when the PRD carries none', async () => {
    makePrototype('## R-001 A cart holds its line\n')

    const verification = await run()

    expect(verification.results).toEqual([])
    expect(verification.round).toBe(1)
    expect(report()).toContain('No checks yet.')
    expect(report()).toContain('check: endpoint GET /api/cart')
  })

  /**
   * The two empty runs are different answers, and a PRD that never carried a check must not be told
   * that the ones it had disappeared.
   */
  it('keeps the two kinds of empty run apart', async () => {
    makePrototype('## R-001 A cart holds its line\n')

    await run()
    const second = await run()

    expect(second.round).toBe(2)
    expect(second.diff.gone).toEqual([])
    expect(report()).toContain('No checks yet.')
    expect(report()).not.toContain('No checks are declared any more')
  })
})
