import { describe, expect, it } from 'bun:test'
import { handleThinkingComplete } from '../text'
import type { SessionState, ThinkingCompleteEvent } from '../../types'

function makeState(messages: any[] = []): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: Date.now(),
    } as any,
    streaming: null,
  }
}

describe('handleThinkingComplete', () => {
  it('appends reasoning as an intermediate message flagged with isThinking', () => {
    const state = makeState()

    const event: ThinkingCompleteEvent = {
      type: 'thinking_complete',
      sessionId: 'session-1',
      text: '**Plan:** read the file, then run the tests.',
      turnId: 'pi-turn-1__think0',
      messageId: 'msg-think-1',
      timestamp: 200,
    }

    const next = handleThinkingComplete(state, event)
    const msg = next.session.messages[0] as any

    expect(next.session.messages).toHaveLength(1)
    expect(msg).toMatchObject({
      id: 'msg-think-1',
      role: 'assistant',
      content: event.text,
      timestamp: 200,
      isIntermediate: true,
      isThinking: true,
      isStreaming: false,
      isPending: false,
      turnId: event.turnId,
    })
    // Reasoning must never take over the streaming slot used by text.
    expect(next.streaming).toBeNull()
  })

  it('ignores a re-delivered event with the same message id', () => {
    const state = makeState([
      {
        id: 'msg-think-1',
        role: 'assistant',
        content: 'already here',
        isIntermediate: true,
        isThinking: true,
        timestamp: 100,
      },
    ])

    const next = handleThinkingComplete(state, {
      type: 'thinking_complete',
      sessionId: 'session-1',
      text: 'already here',
      messageId: 'msg-think-1',
      timestamp: 200,
    })

    expect(next).toBe(state)
    expect(next.session.messages).toHaveLength(1)
  })
})
