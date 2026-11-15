import { describe, expect, it } from 'bun:test'
import { handleSessionMetadataChanged } from '../session'
import type { SessionMetadataChangedEvent, SessionState } from '../../types'

function makeState(taskAwaitingApproval?: number): SessionState {
  return {
    session: {
      id: 'orch-1',
      messages: [],
      lastMessageAt: Date.now(),
      ...(taskAwaitingApproval !== undefined ? { taskAwaitingApproval } : {}),
    } as any,
    streaming: null,
  }
}

const parked = (count: number): SessionMetadataChangedEvent => ({
  type: 'session_metadata_changed',
  sessionId: 'orch-1',
  changes: { taskAwaitingApproval: count },
})

describe('handleSessionMetadataChanged — gate parked', () => {
  it('merges the change and notifies on the rise into waiting', () => {
    const next = handleSessionMetadataChanged(makeState(), parked(1))

    expect(next.state.session.taskAwaitingApproval).toBe(1)
    expect(next.effects).toEqual([{ type: 'task_awaiting_approval' }])
  })

  it('notifies again when another gate parks, but never for a re-published count', () => {
    // A second gate parking is news; the same count arriving twice is a scheduling pass, not a
    // decision the person has to make twice.
    expect(handleSessionMetadataChanged(makeState(1), parked(2)).effects).toHaveLength(1)
    expect(handleSessionMetadataChanged(makeState(2), parked(2)).effects).toHaveLength(0)
    expect(handleSessionMetadataChanged(makeState(1), parked(0)).effects).toHaveLength(0)
  })

  it('leaves other metadata changes silent', () => {
    const next = handleSessionMetadataChanged(makeState(1), {
      type: 'session_metadata_changed',
      sessionId: 'orch-1',
      changes: { taskNodeCount: 4 },
    })

    expect(next.effects).toEqual([])
    expect(next.state.session.taskNodeCount).toBe(4)
  })
})
