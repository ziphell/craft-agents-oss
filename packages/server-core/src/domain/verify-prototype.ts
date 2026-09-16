/**
 * Run a prototype's acceptance checks.
 *
 * A requirement that carries `check:` lines can be answered mechanically, and that
 * is the entire reason for writing them as checks rather than as prose (plan
 * §20.7): an acceptance criterion only a person can judge is a criterion nobody
 * runs. This is what answers them — `selector` against the page on screen,
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
  composeContract,
  getPrototypeDistPath,
  listContractServices,
  loadContractService,
  resolveRequirementCoverage,
  type PrototypeCheck,
} from '@craft-agent/shared/prototypes'
import type { IBrowserPaneManager } from '../handlers/browser-pane-manager-interface'

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
  results: PrototypeCheckResult[]
  passed: number
  failed: number
  skipped: number
  /** Absolute path to `dist/acceptance.md`. */
  reportPath: string
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
): Promise<PrototypeVerification> {
  const coverage = resolveRequirementCoverage(workspaceRootPath, slug)
  const endpoints = contractEndpoints(workspaceRootPath, slug)

  // Read once, so every page check is answered about the same document.
  let page: string | null = null
  if (bpm && instanceId) {
    try {
      page = (await bpm.getInstanceAsync(instanceId))?.currentUrl ?? null
    } catch {
      page = null
    }
  }

  const results: PrototypeCheckResult[] = []
  for (const requirement of coverage.requirements) {
    for (const check of requirement.checks) {
      results.push(
        await runCheck(bpm, instanceId, page, requirement.id, requirement.title, check, endpoints),
      )
    }
  }

  const reportPath = join(getPrototypeDistPath(workspaceRootPath, slug), ACCEPTANCE_FILENAME)
  const verification: PrototypeVerification = {
    slug,
    page,
    results,
    passed: results.filter((result) => result.status === 'pass').length,
    failed: results.filter((result) => result.status === 'fail').length,
    skipped: results.filter((result) => result.status === 'skip').length,
    reportPath,
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
    const found = await bpm.evaluate(instanceId, `!!document.querySelector(${JSON.stringify(check.target)})`)
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
 * work — the same person, at the same moment.
 */
function buildAcceptanceDoc(verification: PrototypeVerification): string {
  const lines = [
    `# Acceptance — ${verification.slug}`,
    '',
    `${verification.passed} passed, ${verification.failed} failed, ${verification.skipped} skipped.`,
    verification.page
      ? `Page checks ran against \`${verification.page}\`.`
      : 'No page was open, so the page checks were skipped — that is "could not look", not "not there".',
    '',
  ]

  if (verification.results.length === 0) {
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

  lines.push(
    '| Requirement | Check | Status | Detail |',
    '| --- | --- | --- | --- |',
    ...verification.results.map(
      (result) =>
        `| \`${result.requirementId}\` | \`${result.kind}: ${result.target}\` | ${result.status} | ${result.detail} |`,
    ),
    '',
    'Run `prototype-verify` again to re-check; the checks come from `prd.md`, so editing that document is how they change.',
    '',
  )

  return lines.join('\n')
}
