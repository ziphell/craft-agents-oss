import { describe, expect, it } from 'bun:test'
import { handleComplete } from '../session'
import type { CompleteEvent, SessionState } from '../../types'
import type { Message } from '../../../../shared/types'

function completeEvent(): CompleteEvent {
  return { type: 'complete', sessionId: 's1' } as CompleteEvent
}

function makeState(messages: Message[]): SessionState {
  return {
    session: {
      id: 's1',
      workspaceId: 'w1',
      messages,
      lastMessageAt: Date.now(),
      isProcessing: true,
    } as any,
    streaming: { content: 'half a sentence', turnId: 't1' },
  }
}

describe('handleComplete — assistant text fail-safe', () => {
  it('finalizes a message whose text_complete never arrived', () => {
    // A dropped final event leaves the streamed text marked pending. `complete`
    // still arrives, and the turn must end with that text as its response
    // rather than keeping a live "Thinking…" row forever.
    const partial: Message = {
      id: 'm1',
      role: 'assistant',
      content: 'Here is the first half',
      timestamp: 1,
      isStreaming: true,
      isPending: true,
      turnId: 't1',
    }

    const { state } = handleComplete(makeState([partial]), completeEvent())

    expect(state.session.isProcessing).toBe(false)
    expect(state.streaming).toBeNull()
    expect(state.session.messages[0]).toMatchObject({
      id: 'm1',
      content: 'Here is the first half',
      isStreaming: false,
      isPending: false,
    })
  })

  it('leaves a finished message untouched', () => {
    const finished: Message = {
      id: 'm1',
      role: 'assistant',
      content: 'Done.',
      timestamp: 1,
      isStreaming: false,
      isPending: false,
    }

    const { state } = handleComplete(makeState([finished]), completeEvent())

    expect(state.session.messages[0]).toBe(finished)
  })

  it('keeps intermediate commentary intermediate so it stays an activity', () => {
    const commentary: Message = {
      id: 'm1',
      role: 'assistant',
      content: 'Checking the files…',
      timestamp: 1,
      isStreaming: true,
      isPending: true,
      isIntermediate: true,
      turnId: 't1',
    }

    const { state } = handleComplete(makeState([commentary]), completeEvent())

    expect(state.session.messages[0]).toMatchObject({
      isStreaming: false,
      isPending: false,
      isIntermediate: true,
    })
  })
})
