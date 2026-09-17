/**
 * Run a prototype's acceptance checks.
 *
 * A requirement that carries `check:` lines can be answered mechanically, and that
 * is the entire reason for writing them as checks rather than as prose (plan
 * §20.7): an acceptance criterion only a person can judge is a criterion nobody
 * runs. This is what answers them — `selector` against the page the work is on
 * (which is not the tab on screen once a window has several: plan §22, 第十二轮),
 * `endpoint` against the contract.
 *
 * Three things it deliberately does **not** do:
 *
 * - **guess.** A check whose kind is not `selector` or `endpoint` never reaches
 *   here, because `requirements.ts` refuses to parse it — so nothing is quietly
 *   "passed" for lack of a way to look.
 * - **fail for want of a window.** With no page open, page checks are `skip`:
 *   "we could not look" is not "it is not there", and collapsing the two would
 *   make a verification worth running only once.
 * - **change anything but the report.** `dist/acceptance.md` is the record; a
 *   failing check leaves the prototype exactly as it was, because what to do about
 *   one is the reader's decision, not this function's.
 *
 * @see docs/prototype-workbench-plan.md §20.7
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  compareAcceptance,
  composeContract,
  getPrototypeDistPath,
  listContractServices,
  listPrototypePages,
  loadContractService,
  matchPrototypePage,
  readAcceptanceState,
  resolveRequirementCoverage,
  summarizeAcceptance,
  writeAcceptanceState,
  type AcceptanceDiff,
  type AcceptanceObservation,
  type AcceptanceSummary,
  type PrototypeCheck,
} from '@craft-agent/shared/prototypes'
import type { IBrowserPaneManager } from '../handlers/browser-pane-manager-interface'
import type { PrototypeTargetPage } from './apply-prototype'

export type PrototypeCheckStatus = 'pass' | 'fail' | 'skip'

export interface PrototypeCheckResult {
  requirementId: string
  requirementTitle: string
  kind: string
  target: string
  status: PrototypeCheckStatus
  /** Why, in the words a reader needs — a bare "fail" tells nobody anything. */
  detail: string
}

export interface PrototypeVerification {
  slug: string
  /** The address the page checks ran against, or null when none could run. */
  page: string | null
  /** The page a selector check should be disputed against (`about: page <name>`), or null. */
  pageName: string | null
  results: PrototypeCheckResult[]
  passed: number
  failed: number
  skipped: number
  /** Which run this is — the checks have run this many times. */
  round: number
  /** What changed against the round before, if there was one. */
  diff: AcceptanceDiff
  /** The round before, for the line that says what this one moved. */
  previous: AcceptanceSummary | null
  /** Absolute path to `dist/acceptance.md`. */
  reportPath: string
  /** Absolute path to `acceptance/state.json` — our memory, not part of the deliverable. */
  statePath: string
}

export const ACCEPTANCE_FILENAME = 'acceptance.md'

/**
 * Verify a prototype against its own PRD.
 *
 * `bpm` and `instanceId` are optional on purpose: the endpoint checks need no
 * browser at all, so a session that has never opened a page still gets an answer
 * for those, and a truthful `skip` for the rest.
 */
export async function verifyPrototype(
  bpm: IBrowserPaneManager | null,
  instanceId: string | null,
  workspaceRootPath: string,
  slug: string,
  /**
   * The tab to check — the conversation's tab, not the one on screen: the answer "is this
   * requirement on the page" is about the page the work is on, and the person reading another
   * tab of the window must not change it (plan §22, 第十二轮).
   */
  target?: PrototypeTargetPage | null,
): Promise<PrototypeVerification> {
  const coverage = resolveRequirementCoverage(workspaceRootPath, slug)
  const endpoints = contractEndpoints(workspaceRootPath, slug)

  // Read once, so every page check is answered about the same document.
  const page = target?.url ?? null

  const results: PrototypeCheckResult[] = []
  for (const requirement of coverage.requirements) {
    for (const check of requirement.checks) {
      results.push(
        await runCheck(bpm, instanceId, page, target?.id, requirement.id, requirement.title, check, endpoints),
      )
    }
  }

  // The run is recorded before the deliverable is written, because the deliverable says what changed
  // against the round before — and after this write, "the round before" is the round that just
  // happened.
  const previousState = readAcceptanceState(workspaceRootPath, slug)
  const previous = summarizeAcceptance(previousState)
  const observations: AcceptanceObservation[] = results.map((result) => ({
    requirementId: result.requirementId,
    kind: result.kind,
    target: result.target,
    status: result.status,
  }))
  const { state, diff } = compareAcceptance(previousState, observations, new Date().toISOString())
  const statePath = writeAcceptanceState(workspaceRootPath, slug, state)

  const reportPath = join(getPrototypeDistPath(workspaceRootPath, slug), ACCEPTANCE_FILENAME)
  const verification: PrototypeVerification = {
    slug,
    page,
    // The page *name*, so a failed selector check can be disputed the way the workbench names a page
    // (`about: page cart`) instead of by an address that changes between environments.
    pageName: matchPrototypePage(listPrototypePages(workspaceRootPath, slug), page),
    results,
    passed: results.filter((result) => result.status === 'pass').length,
    failed: results.filter((result) => result.status === 'fail').length,
    skipped: results.filter((result) => result.status === 'skip').length,
    round: state.round,
    diff,
    previous,
    reportPath,
    statePath,
  }

  mkdirSync(getPrototypeDistPath(workspaceRootPath, slug), { recursive: true })
  writeFileSync(reportPath, buildAcceptanceDoc(verification), 'utf-8')

  return verification
}

/** Every `METHOD /path` the contract declares, mapped to the service declaring it. */
function contractEndpoints(workspaceRootPath: string, slug: string): Map<string, string> {
  const endpoints = new Map<string, string>()

  for (const serviceSlug of listContractServices(workspaceRootPath, slug)) {
    const service = loadContractService(workspaceRootPath, slug, serviceSlug)
    for (const endpoint of composeContract(service).endpoints) {
      endpoints.set(`${endpoint.method.toUpperCase()} ${endpoint.path}`, serviceSlug)
    }
  }

  return endpoints
}

/** `get /api/cart` and `GET /api/cart` are the same endpoint; the path is not case-folded. */
function endpointKey(target: string): string {
  const [method, ...rest] = target.trim().split(/\s+/)
  return `${(method ?? '').toUpperCase()} ${rest.join(' ')}`
}

async function runCheck(
  bpm: IBrowserPaneManager | null,
  instanceId: string | null,
  page: string | null,
  tabId: string | undefined,
  requirementId: string,
  requirementTitle: string,
  check: PrototypeCheck,
  endpoints: Map<string, string>,
): Promise<PrototypeCheckResult> {
  const base = { requirementId, requirementTitle, kind: check.kind, target: check.target }

  if (check.kind === 'endpoint') {
    const service = endpoints.get(endpointKey(check.target))
    return service
      ? { ...base, status: 'pass', detail: `declared by service "${service}"` }
      : { ...base, status: 'fail', detail: 'no service in this prototype declares this endpoint' }
  }

  // A page check needs a page. Without one this is not a failure — see the note
  // at the top of the file.
  if (!bpm || !instanceId || !page) {
    return { ...base, status: 'skip', detail: 'no page was open to check against' }
  }

  try {
    const found = await bpm.evaluate(instanceId, `!!document.querySelector(${JSON.stringify(check.target)})`, tabId)
    return found === true
      ? { ...base, status: 'pass', detail: `found on ${page}` }
      : { ...base, status: 'fail', detail: `not on ${page}` }
  } catch (err) {
    // A page that cannot be evaluated is another "could not look": the window may
    // have been closed between reading its address and asking it a question.
    return {
      ...base,
      status: 'skip',
      detail: `could not evaluate: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * The written record, in `dist/` beside the other deliverables.
 *
 * In `dist/` rather than in `research/` because it *is* a deliverable: the checks
 * come from the PRD and the reader of `dist/` is the person who has to accept the
 * work — the same person, at the same moment. It says what changed since the round
 * before, because a count alone cannot be acted on: five red is an emergency if it
 * was zero this morning and a shrug if it was five then.
 */
function buildAcceptanceDoc(verification: PrototypeVerification): string {
  const lines = [
    `# Acceptance — ${verification.slug}`,
    '',
    `Round ${verification.round} — ${verification.passed} passed, ${verification.failed} failed, ${verification.skipped} skipped.`,
    verification.page
      ? `Page checks ran against \`${verification.page}\`.`
      : 'No page was open, so the page checks were skipped — that is "could not look", not "not there".',
    '',
  ]

  // With rounds behind it, an empty run means the PRD dropped the checks it had — and that is worth
  // saying, because a criterion that quietly disappeared is one nobody is verifying any more. It is
  // not the same as a prototype with nothing to check, which is "No checks yet" below.
  const droppedEveryCheck = verification.results.length === 0 && verification.diff.gone.length > 0

  if (verification.results.length === 0 && !droppedEveryCheck) {
    lines.push(
      'No checks yet. A requirement carries them as `check:` lines under its entry in `prd.md`:',
      '',
      '```md',
      '## R-001 A cart holds its line',
      'check: selector [data-cart-total]',
      'check: endpoint GET /api/cart',
      '```',
      '',
    )
    return lines.join('\n')
  }

  lines.push(...describeMovement(verification))

  if (droppedEveryCheck) {
    lines.push('No checks are declared any more — the ones that were are named above.', '')
    return lines.join('\n')
  }

  lines.push(
    '## Checks',
    '',
    '| Requirement | Check | Status | Detail |',
    '| --- | --- | --- | --- |',
    ...verification.results.map(
      (result) =>
        `| \`${result.requirementId}\` | \`${result.kind}: ${result.target}\` | ${result.status} | ${result.detail} |`,
    ),
    '',
  )

  // A failure is a question, not an instruction: nothing this command does changes the prototype.
  // What it can do is hand over the one thing the reader needs to argue with it — the target to
  // name in a review, spelled so it can be copied into the file (`reviews.ts`).
  const failures = verification.results.filter((result) => result.status === 'fail')
  if (failures.length > 0) {
    lines.push('## Arguing with a failure', '')
    lines.push(
      'Each failure is an objection nobody has written down yet. Record it under `reviews/` — one',
      'dispute per file, id first (`# D-001 <what is disputed>`), then `about:`, `status:` and `claim:`:',
      '',
      ...failures.map((result) => {
        const about = result.kind === 'endpoint' ? `endpoint ${result.target}` : `requirement ${result.requirementId}`
        const alternative =
          result.kind === 'endpoint' ? '' : ` (or \`about: page ${verification.pageName ?? '<page>'}\` when the page is where it went wrong)`
        return `- \`${result.requirementId}\` \`${result.kind}: ${result.target}\` → \`about: ${about}\`${alternative}`
      }),
      '',
      'A dispute filed against a patch needs `on:` as well — the fingerprint `prototype-status` prints',
      'for that patch, so a later reader can tell an argument about the current file from one about a',
      'version that no longer exists.',
      '',
    )
  }

  lines.push(
    'Run `prototype-verify` again to re-check; the checks come from `prd.md`, so editing that document is how they change.',
    '',
  )

  return lines.join('\n')
}

/** The diff section: what this round did to the last one, in the terms a reader acts on. */
function describeMovement(verification: PrototypeVerification): string[] {
  const { diff, previous } = verification
  if (!previous) {
    return ['## What moved', '', 'First round — there is nothing to compare it against yet.', '']
  }

  const lines = [`## What moved since round ${previous.round}`, '']
  const list = (label: string, keys: string[], note: string): void => {
    if (keys.length === 0) return
    lines.push(`- **${label}** — ${note}`)
    for (const key of keys) lines.push(`  - \`${key}\``)
  }

  list('Newly red', diff.newRed, 'it was not failing before: the change under review broke it')
  list('Still red', diff.stillRed, 'already failing last round — nobody has acted on it yet')
  list('No longer looked at', diff.notRun, 'it was failing and this run could not check it — not the same as fixed')
  list('Fixed', diff.fixed, 'it failed last round and passes now')
  list('No longer declared', diff.gone, 'the PRD does not carry this check any more')

  if (!lines.some((line) => line.startsWith('- **'))) {
    lines.push(`Nothing moved: the same result as round ${previous.round}.`)
  }
  lines.push('')
  return lines
}
