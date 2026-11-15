import { describe, expect, it } from 'bun:test'
import { formatRunReport, type RunReportEntry } from './run-report.ts'

const one: RunReportEntry = {
  title: 'Quarterly review',
  slug: 'quarterly-review',
  runId: 'run-7',
  status: 'completed',
  done: 4,
  failed: 0,
  total: 5,
  orchestratorSessionId: 'orch-1',
}

describe('formatRunReport', () => {
  it('names the graph, its run and its tile — a verdict alone is unanswerable later', () => {
    const text = formatRunReport([one])
    expect(text).toContain('[task-finished]')
    expect(text).toContain('"Quarterly review" (quarterly-review:run-7) — completed')
    expect(text).toContain('4 done, of 5 nodes')
    expect(text).toContain('session orch-1')
  })

  it('counts failures and says which node failed first', () => {
    const text = formatRunReport([
      { ...one, status: 'failed', done: 2, failed: 1, firstFailure: 'Verify the totals' },
    ])
    expect(text).toContain('2 done, 1 failed, of 5 nodes')
    expect(text).toContain('First to fail: Verify the totals')
  })

  it('batches several graphs into one message', () => {
    const text = formatRunReport([one, { ...one, slug: 'b', runId: 'run-9', title: 'B' }])
    expect(text).toContain('2 task graphs you created have ended')
    expect(text).toContain('(b:run-9)')
  })

  it('appends the closing instructions once, and can leave them out', () => {
    expect(formatRunReport([one])).toContain('Do not re-run it')
    expect(formatRunReport([one], { instructions: false })).not.toContain('Do not re-run it')
  })

  it('leaves out what it does not know', () => {
    const text = formatRunReport([{ ...one, orchestratorSessionId: undefined }])
    expect(text).not.toContain('Its tile and results')
    expect(text).not.toContain('First to fail')
  })
})
