import { describe, expect, it } from 'bun:test'
import { formatChildReport } from './child-report.ts'

/**
 * The text that decides whether the assistant *narrates* the result or parrots the quote.
 */

const one = {
  name: 'Release notes',
  workspaceName: 'Alpha',
  sessionId: 's-1',
  status: 'completed',
  lastText: 'Wrote the notes and checked them against the changelog.',
}

describe('formatChildReport', () => {
  it('names the task, the workspace and the conversation', () => {
    const text = formatChildReport([one])
    expect(text).toContain('"Release notes" in Alpha')
    expect(text).toContain('completed')
    expect(text).toContain('session s-1')
  })

  it('quotes the final message so the assistant has something to say', () => {
    expect(formatChildReport([one])).toContain('Wrote the notes')
  })

  it('says so when a task ended without a message, instead of quoting nothing', () => {
    const text = formatChildReport([{ ...one, status: 'failed', lastText: undefined }])
    expect(text).toContain('failed')
    expect(text).toContain('without a final message')
  })

  it('counts them when several come back at once', () => {
    expect(formatChildReport([one, { ...one, sessionId: 's-2' }]))
      .toContain('2 tasks you started have ended')
  })

  it('forbids the three things that would make it worse than silence', () => {
    const text = formatChildReport([one])
    expect(text).toMatch(/Do not repeat the quotes in full/i)
    expect(text).toMatch(/do not re-dispatch/i)
    expect(text).toMatch(/do not start new tasks/i)
  })

  it('caps a long answer so one task cannot flood the conversation', () => {
    const text = formatChildReport([{ ...one, lastText: 'x'.repeat(5000) }])
    expect(text.length).toBeLessThan(1500)
    expect(text).toContain('…')
  })
})
