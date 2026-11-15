import { describe, expect, it } from 'bun:test'
import { referenceReadiness } from '../canvas-readiness'

describe('reference readiness', () => {
  it('is ready when the file exists and no task is running', () => {
    expect(referenceReadiness({ src: 'assets/a.png' }, { task: null, artifact: true })).toBe('ready')
  })

  it('is missing when the card has no file or the file is gone', () => {
    expect(referenceReadiness({}, { task: null, artifact: false })).toBe('missing')
    expect(referenceReadiness({ src: 'assets/a.png' }, { task: null, artifact: false })).toBe('missing')
  })

  it('is pending while the card is queued or running', () => {
    expect(referenceReadiness({ src: 'a.png' }, { task: { status: 'queued' }, artifact: false })).toBe('pending')
    expect(referenceReadiness({ src: 'a.png' }, { task: { status: 'running' }, artifact: false })).toBe('pending')
  })

  it('is failed for a task that ended without a file', () => {
    for (const status of ['failed', 'submission_unknown', 'cancelled']) {
      expect(referenceReadiness({ src: 'a.png' }, { task: { status }, artifact: false })).toBe('failed')
    }
  })
})
