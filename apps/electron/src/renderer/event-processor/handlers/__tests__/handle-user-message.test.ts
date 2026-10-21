import { describe, expect, it } from 'bun:test'
import { groupMessagesByTurn } from '@craft-agent/ui/chat/turn-utils'
import { handleComplete, handleQueuedMessageCancelled, handleUserMessage } from '../session'
import type { CompleteEvent, SessionState, UserMessageEvent } from '../../types'

function makeState(messages: any[]): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: 0,
      isProcessing: true,
    } as any,
    streaming: null,
  }
}

function processingEvent(timestamp: number): UserMessageEvent {
  return {
    type: 'user_message',
    sessionId: 'session-1',
    message: {
      id: 'backend-follow-up',
      role: 'user',
      content: 'follow up',
      timestamp,
    },
    status: 'processing',
    optimisticMessageId: 'optimistic-follow-up',
  }
}

describe('handleUserMessage queued replay', () => {
  it('applies the canonical replay timestamp without replacing the optimistic id', () => {
    const state = makeState([
      {
        id: 'optimistic-follow-up',
        role: 'user',
        content: 'follow up',
        timestamp: 200,
        isPending: false,
        isQueued: true,
      },
    ])

    const next = handleUserMessage(state, processingEvent(300))
    const message = next.state.session.messages[0]

    expect(message.id).toBe('optimistic-follow-up')
    expect(message.timestamp).toBe(300)
    expect(message.isPending).toBe(false)
    expect(message.isQueued).toBe(false)
  })

  it('keeps the completed prior answer above the replayed message in live grouping', () => {
    const state = makeState([
      { id: 'initial-user', role: 'user', content: 'question', timestamp: 100 },
      {
        id: 'optimistic-follow-up',
        role: 'user',
        content: 'follow up',
        timestamp: 200,
        isQueued: true,
      },
      {
        id: 'prior-answer',
        role: 'assistant',
        content: 'complete answer',
        timestamp: 250,
      },
    ])

    const next = handleUserMessage(state, processingEvent(300))
    const turns = groupMessagesByTurn(next.state.session.messages)

    expect(turns.map(turn => turn.type)).toEqual(['user', 'assistant', 'user'])
    const assistantTurn = turns[1]
    expect(assistantTurn?.type).toBe('assistant')
    if (assistantTurn?.type === 'assistant') {
      expect(assistantTurn.response?.text).toBe('complete answer')
    }
  })

  it('ignores a late queued event after the message is already processing', () => {
    const state = makeState([
      {
        id: 'optimistic-follow-up',
        role: 'user',
        content: 'follow up',
        timestamp: 300,
        isQueued: false,
      },
    ])
    const lateQueuedEvent: UserMessageEvent = {
      ...processingEvent(200),
      status: 'queued',
    }

    const next = handleUserMessage(state, lateQueuedEvent)

    expect(next.state).toBe(state)
    expect(next.state.session.messages[0]?.timestamp).toBe(300)
    expect(next.state.session.messages[0]?.isQueued).toBe(false)
  })
})

describe('handleQueuedMessageCancelled', () => {
  it('removes the queued bubble by either the optimistic or canonical id', () => {
    const state = makeState([
      { id: 'optimistic-follow-up', role: 'user', content: 'queued', timestamp: 100, isQueued: true },
      { id: 'prior-answer', role: 'assistant', content: 'answer', timestamp: 200 },
    ])

    const next = handleQueuedMessageCancelled(state, {
      type: 'queued_message_cancelled',
      sessionId: 'session-1',
      messageId: 'backend-follow-up',
      optimisticMessageId: 'optimistic-follow-up',
    })

    expect(next.state.session.messages.map(m => m.id)).toEqual(['prior-answer'])
  })
})

describe('handleComplete queued re-stamp', () => {
  it('moves queued bubbles after the finished turn when clearing isQueued', () => {
    const state = makeState([
      { id: 'initial-user', role: 'user', content: 'question', timestamp: 100 },
      { id: 'optimistic-follow-up', role: 'user', content: 'queued', timestamp: 150, isQueued: true },
      { id: 'prior-answer', role: 'assistant', content: 'complete answer', timestamp: 200 },
    ])

    const event: CompleteEvent = { type: 'complete', sessionId: 'session-1' }
    const next = handleComplete(state, event)
    const queued = next.state.session.messages.find(m => m.id === 'optimistic-follow-up')!

    expect(queued.isQueued).toBe(false)
    expect(queued.timestamp).toBeGreaterThan(200)
  })
})
