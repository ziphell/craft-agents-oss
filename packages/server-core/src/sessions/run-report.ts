/**
 * What the assistant is told when a task **graph** it created ends.
 *
 * The sibling of `child-report.ts`, and deliberately a separate module rather than another branch
 * of it: a child conversation reports *what it said*, a graph reports *how it ended* — a verdict
 * and a node tally, with no last message to quote. One formatter serving both would have to be
 * told which kind it was holding, and would then be read by people wondering why.
 *
 * The title, the slug and the run id are all in here for one reason: the panel's card is not
 * where anyone looks. If the sentence does not say which graph and which run, "it failed" is
 * unanswerable two days later.
 */

/** How many characters of anything quoted are kept. */
const EXCERPT_LIMIT = 600

export interface RunReportEntry {
  /** The task's title, as the person sees it on the board. */
  title: string
  /** Its slug — the stable name, and what `task.yaml` is filed under. */
  slug: string
  runId: string
  /** How the run ended. `stopped` is a person's decision, not a failure. */
  status: 'completed' | 'failed' | 'stopped'
  /** Node tallies. `total` includes skipped nodes, so `done + failed + skipped <= total`. */
  done: number
  failed: number
  total: number
  /** The orchestrator session, so the assistant can point at the tile or read the result. */
  orchestratorSessionId?: string
  /** The failed node's title or id, when one failed. One name, not a list. */
  firstFailure?: string
}

export interface RunReportOptions {
  /** Append the closing instructions. Off when this block is merged with a child report. */
  instructions?: boolean
}

function trim(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > EXCERPT_LIMIT ? `${clean.slice(0, EXCERPT_LIMIT)}…` : clean
}

export function formatRunReport(entries: RunReportEntry[], options: RunReportOptions = {}): string {
  const lines: string[] = [
    entries.length === 1
      ? '[task-finished] A task graph you created has ended.'
      : `[task-finished] ${entries.length} task graphs you created have ended.`,
    '',
  ]

  for (const entry of entries) {
    lines.push(`- "${entry.title}" (${entry.slug}:${entry.runId}) — ${entry.status}`)
    const parts = [`${entry.done} done`]
    if (entry.failed > 0) parts.push(`${entry.failed} failed`)
    parts.push(`of ${entry.total} nodes`)
    lines.push(`  ${parts.join(', ')}`)
    if (entry.firstFailure) lines.push(`  First to fail: ${trim(entry.firstFailure)}`)
    if (entry.orchestratorSessionId) lines.push(`  Its tile and results: session ${entry.orchestratorSessionId}`)
  }

  if (options.instructions !== false) {
    lines.push(
      '',
      'Tell the person what the graph was for and how it ended, in one or two sentences, and say',
      'anything that needs a decision. Do not re-run it, do not repeat the node outputs in full,',
      'and do not start new work from this message.',
    )
  }

  return lines.join('\n')
}
