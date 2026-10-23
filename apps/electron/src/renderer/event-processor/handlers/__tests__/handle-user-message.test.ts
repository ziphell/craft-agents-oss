import { describe, expect, it } from 'bun:test'
import { groupMessagesByTurn } from '@craft-agent/ui/chat/turn-utils'
import { handleComplete, handleQueuedMessageCancelled, handleQueuedMessagesState, handleUserMessage } from '../session'
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

function acceptedEvent(timestamp = 300): UserMessageEvent {
  return {
    type: 'user_message',
    sessionId: 'session-1',
    message: {
      id: 'backend-turn',
      role: 'user',
      content: 'follow up',
      timestamp,
    },
    status: 'accepted',
  }
}

describe('handleUserMessage queued replay', () => {
  it('adds the replayed turn as a new message even when the text matches an older one', () => {
    const state = makeState([
      { id: 'older-same-text', role: 'user', content: 'follow up', timestamp: 100 },
      { id: 'prior-answer', role: 'assistant', content: 'answer', timestamp: 200 },
    ])

    const next = handleUserMessage(state, acceptedEvent())
    const messages = next.state.session.messages

    expect(messages.map(m => m.id)).toEqual(['older-same-text', 'prior-answer', 'backend-turn'])
    // The older identical message is untouched.
    expect(messages[0]!.timestamp).toBe(100)
  })

  it('places the replayed turn after the completed prior answer', () => {
    const state = makeState([
      { id: 'initial-user', role: 'user', content: 'question', timestamp: 100 },
      { id: 'prior-answer', role: 'assistant', content: 'complete answer', timestamp: 250 },
    ])

    const next = handleUserMessage(state, acceptedEvent(300))
    const turns = groupMessagesByTurn(next.state.session.messages)

    expect(turns.map(turn => turn.type)).toEqual(['user', 'assistant', 'user'])
    const assistantTurn = turns[1]
    expect(assistantTurn?.type).toBe('assistant')
    if (assistantTurn?.type === 'assistant') {
      expect(assistantTurn.response?.text).toBe('complete answer')
    }
  })

  it('ignores a late queued event after the turn message is accepted', () => {
    const state = makeState([
      {
        id: 'backend-turn',
        role: 'user',
        content: 'follow up',
        timestamp: 300,
        isQueued: false,
      },
    ])
    const lateQueuedEvent: UserMessageEvent = {
      ...acceptedEvent(),
      status: 'queued',
    }

    const next = handleUserMessage(state, lateQueuedEvent)

    expect(next.state).toBe(state)
    expect(next.state.session.messages[0]?.timestamp).toBe(300)
    expect(next.state.session.messages[0]?.isQueued).toBe(false)
  })

  it('keeps the session processing when a mid-turn send is queued', () => {
    const state = makeState([
      { id: 'initial-user', role: 'user', content: 'question', timestamp: 100 },
      {
        id: 'optimistic-follow-up',
        role: 'user',
        content: 'queued while streaming',
        timestamp: 120,
        isPending: true,
        isQueued: true,
      },
    ])
    const queuedEvent: UserMessageEvent = {
      type: 'user_message',
      sessionId: 'session-1',
      message: {
        id: 'backend-follow-up',
        role: 'user',
        content: 'queued while streaming',
        timestamp: 130,
      },
      status: 'queued',
      optimisticMessageId: 'optimistic-follow-up',
    }

    const next = handleUserMessage(state, queuedEvent)

    // Queueing does not end the running turn: clearing this flag hid the
    // streaming indicator, Stop and Send-now while the backend kept working.
    expect(next.state.session.isProcessing).toBe(true)
    const queued = next.state.session.messages.find(m => m.id === 'optimistic-follow-up')!
    expect(queued.isQueued).toBe(true)
    expect(queued.isPending).toBe(false)
  })

  it('does not clear processing when a queued event follows an already-unqueued bubble', () => {
    const state = makeState([
      {
        id: 'optimistic-follow-up',
        role: 'user',
        content: 'resend after idle',
        timestamp: 120,
        isQueued: false,
      },
    ])
    const queuedEvent: UserMessageEvent = {
      type: 'user_message',
      sessionId: 'session-1',
      message: {
        id: 'backend-follow-up',
        role: 'user',
        content: 'resend after idle',
        timestamp: 130,
      },
      status: 'queued',
      optimisticMessageId: 'optimistic-follow-up',
    }

    const next = handleUserMessage(state, queuedEvent)

    expect(next.state.session.isProcessing).toBe(true)
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

describe('handleQueuedMessagesState', () => {
  it('reorders only the queued entries and leaves the rest in place', () => {
    const state = makeState([
      { id: 'prior-answer', role: 'assistant', content: 'answer', timestamp: 100 },
      { id: 'q1', role: 'user', content: 'first', timestamp: 110, isQueued: true },
      { id: 'q2', role: 'user', content: 'second', timestamp: 120, isQueued: true },
    ])

    const next = handleQueuedMessagesState(state, {
      type: 'queued_messages_state',
      sessionId: 'session-1',
      order: [{ messageId: 'q2' }, { messageId: 'q1' }],
    })

    expect(next.state.session.messages.map(m => m.id)).toEqual(['prior-answer', 'q2', 'q1'])
  })

  it('matches the optimistic id and unqueues messages absent from the state', () => {
    const state = makeState([
      { id: 'optimistic-1', role: 'user', content: 'first', timestamp: 110, isQueued: true },
      { id: 'q2', role: 'user', content: 'second', timestamp: 120, isQueued: true },
      { id: 'q3', role: 'user', content: 'late arrival', timestamp: 130, isQueued: true },
    ])

    const next = handleQueuedMessagesState(state, {
      type: 'queued_messages_state',
      sessionId: 'session-1',
      order: [
        { messageId: 'backend-2', optimisticMessageId: 'q2' },
        { messageId: 'backend-1', optimisticMessageId: 'optimistic-1' },
      ],
    })

    const messages = next.state.session.messages
    expect(messages.map(m => m.id)).toEqual(['q2', 'optimistic-1', 'q3'])
    // Not in the authoritative queue => it has been sent; show it in the transcript.
    expect(messages.find(m => m.id === 'q3')?.isQueued).toBe(false)
    expect(messages.find(m => m.id === 'q2')?.isQueued).toBe(true)
  })

  it('clears a ghost queued flag when the state is empty', () => {
    const state = makeState([
      { id: 'ghost', role: 'user', content: 'already sent', timestamp: 110, isQueued: true },
    ])

    const next = handleQueuedMessagesState(state, {
      type: 'queued_messages_state',
      sessionId: 'session-1',
      order: [],
    })

    expect(next.state.session.messages[0]?.isQueued).toBe(false)
  })
})

describe('handleComplete queued state', () => {
  it('leaves queued bubbles queued so the rest of the queue is not reported as sent', () => {
    const state = makeState([
      { id: 'initial-user', role: 'user', content: 'question', timestamp: 100 },
      { id: 'optimistic-follow-up', role: 'user', content: 'queued', timestamp: 150, isQueued: true },
      { id: 'prior-answer', role: 'assistant', content: 'complete answer', timestamp: 200 },
    ])

    const event: CompleteEvent = { type: 'complete', sessionId: 'session-1' }
    const next = handleComplete(state, event)
    const queued = next.state.session.messages.find(m => m.id === 'optimistic-follow-up')!

    // Replays leave the queue as a separate accepted turn, never by
    // unqueueing the preview here.
    expect(queued.isQueued).toBe(true)
    expect(queued.timestamp).toBe(150)
  })
})
