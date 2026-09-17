/**
 * Prototype acceptance state — what the checks answered last time.
 *
 * `dist/acceptance.md` says what happened **this** run and is overwritten every time, which makes
 * the one question a re-run is for unanswerable: is this newly red, or has it been red all along?
 * A count answers neither — five red is an emergency if it was zero, and a shrug if it was five.
 *
 * So the run leaves a record beside the prototype (`acceptance/state.json`), and the next run
 * compares against it. Three facts come out of that comparison, and each is a distinct thing to do:
 *
 * - **newly red** — something that passed (or was never checked) fails now: the change just broke it;
 * - **still red** — it was already failing: nobody has acted on it yet;
 * - **fixed** — it failed and passes now.
 *
 * A "round" here is **a verification that actually ran**, not a version of the prototype: the
 * counter goes up every time the checks are answered, and the diff is what says whether anything
 * moved. That is the same reasoning as the frames' timestamps and the anchors' fingerprints — record
 * the fact, derive the meaning — rather than keeping a version number nobody can tie to a change.
 *
 * Never delivered: `dist/` is the package, this is our memory. Like `anchors/`, only the tool that
 * ran the checks writes it (`prototype-verify`), and the agent is refused a hand-written one — a
 * record of a run that did not happen is worse than no record.
 *
 * @see docs/prototype-workbench-plan.md §20.7, §3.7
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getPrototypeAcceptancePath } from './storage.ts'

// Re-exported so a caller reading the state never needs a second import, like `research.ts` does
// for the directory it reads.
export { getPrototypeAcceptancePath }

export const ACCEPTANCE_STATE_FILENAME = 'state.json'

export type AcceptanceCheckStatus = 'pass' | 'fail' | 'skip'

/** One check, as the last run answered it. */
export interface AcceptanceCheckRecord {
  status: AcceptanceCheckStatus
  /** The requirement it sits under, for a reader — the key is the assertion itself. */
  requirement: string
  /** ISO timestamp of the run that answered it. */
  at: string
}

export interface AcceptanceState {
  /** How many times the checks have been run. A round is a run. */
  round: number
  /** ISO timestamp of the latest run. */
  at: string
  /**
   * Keyed `${kind}: ${target}` — the assertion, not where it is written. A check moved from one
   * requirement to another is the same check, and moving it must not read as "fixed".
   */
  checks: Record<string, AcceptanceCheckRecord>
}

/** One answered check, as the runner produces it. */
export interface AcceptanceObservation {
  requirementId: string
  kind: string
  target: string
  status: AcceptanceCheckStatus
}

export interface AcceptanceDiff {
  /** The round this diff produced. */
  round: number
  /** Failed before, passes now — the first thing to read. */
  fixed: string[]
  /** Not failing before (or never seen), failing now: the change under review broke it. */
  newRed: string[]
  /** Failing before and failing now: still nobody's. */
  stillRed: string[]
  /** Failing before, and this run could not look (`skip`) — "not verified" is not "fixed". */
  notRun: string[]
  /** The PRD no longer declares it: deleted, or reworded past recognition. */
  gone: string[]
}

/** `${kind}: ${target}` — the one spelling shared by the state file and the diff. */
export function acceptanceCheckKey(check: { kind: string; target: string }): string {
  return `${check.kind}: ${check.target}`
}

export interface AcceptanceComparison {
  /** The record to write: this run, plus the round that produced it. */
  state: AcceptanceState
  diff: AcceptanceDiff
}

/**
 * Compare a run against the last one, and say what to write.
 *
 * Pure: the caller writes the file (`writeAcceptanceState`), so the comparison can be tested and
 * re-read without touching the disk.
 */
export function compareAcceptance(
  previous: AcceptanceState | null,
  results: readonly AcceptanceObservation[],
  at: string,
): AcceptanceComparison {
  const checks: Record<string, AcceptanceCheckRecord> = {}
  const diff: AcceptanceDiff = {
    round: (previous?.round ?? 0) + 1,
    fixed: [],
    newRed: [],
    stillRed: [],
    notRun: [],
    gone: [],
  }

  const seen = new Set<string>()
  for (const result of results) {
    const key = acceptanceCheckKey(result)
    seen.add(key)
    checks[key] = { status: result.status, requirement: result.requirementId, at }

    const before = previous?.checks[key]?.status
    if (result.status === 'fail') {
      if (before === 'fail') diff.stillRed.push(key)
      else diff.newRed.push(key)
    } else if (result.status === 'skip') {
      // Only worth naming when it *was* red: a skip that follows a skip says nothing new, and
      // listing it would bury the one line that matters — "we no longer know".
      if (before === 'fail') diff.notRun.push(key)
    } else if (before === 'fail') {
      diff.fixed.push(key)
    }
  }

  for (const key of Object.keys(previous?.checks ?? {})) {
    if (!seen.has(key)) diff.gone.push(key)
  }

  return { state: { round: diff.round, at, checks }, diff }
}

/** Read the record of the last run, or null when the checks have never run here. */
export function readAcceptanceState(workspaceRootPath: string, slug: string): AcceptanceState | null {
  const path = join(getPrototypeAcceptancePath(workspaceRootPath, slug), ACCEPTANCE_STATE_FILENAME)
  if (!existsSync(path)) return null

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AcceptanceState>
    if (typeof parsed?.round !== 'number' || typeof parsed?.checks !== 'object' || parsed.checks === null) {
      return null
    }
    // A file written by hand (or by an older shape) is read for what it does say rather than
    // trusted: the checks are re-read one by one and anything unrecognisable is dropped.
    const checks: Record<string, AcceptanceCheckRecord> = {}
    for (const [key, value] of Object.entries(parsed.checks as Record<string, AcceptanceCheckRecord>)) {
      const status = value?.status
      if (status !== 'pass' && status !== 'fail' && status !== 'skip') continue
      checks[key] = {
        status,
        requirement: typeof value?.requirement === 'string' ? value.requirement : '',
        at: typeof value?.at === 'string' ? value.at : '',
      }
    }
    return { round: parsed.round, at: typeof parsed.at === 'string' ? parsed.at : '', checks }
  } catch {
    return null
  }
}

/** Write the record of a run. The directory is created on first use, like `anchors/`. */
export function writeAcceptanceState(workspaceRootPath: string, slug: string, state: AcceptanceState): string {
  const dir = getPrototypeAcceptancePath(workspaceRootPath, slug)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, ACCEPTANCE_STATE_FILENAME)
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
  return path
}

export interface AcceptanceSummary {
  round: number
  at: string
  passed: number
  failed: number
  skipped: number
  /** The failing checks, in key order — what a reader has to do something about. */
  red: string[]
}

/** What the last run left, in the shape a report or a prompt wants it. */
export function summarizeAcceptance(state: AcceptanceState | null): AcceptanceSummary | null {
  if (!state) return null

  const records = Object.values(state.checks)
  const red = Object.entries(state.checks)
    .filter(([, record]) => record.status === 'fail')
    .map(([key]) => key)
    .sort()

  return {
    round: state.round,
    at: state.at,
    passed: records.filter((record) => record.status === 'pass').length,
    failed: red.length,
    skipped: records.filter((record) => record.status === 'skip').length,
    red,
  }
}
