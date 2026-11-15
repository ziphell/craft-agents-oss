/**
 * The cache in `groupMessagesByTurnCached` exists so that `React.memo` on a
 * turn card means what it says: a turn object that is unchanged arrives as the
 * *same* object, so a streamed token re-renders only the turn it belongs to.
 *
 * What is pinned here is identity, not content: content parity with the uncached
 * function is covered by the grouping test suite.
 */

import { describe, it, expect } from 'bun:test'
import type { Message } from '@craft-agent/core'
import { groupMessagesByTurn, groupMessagesByTurnCached } from '../turn-utils'

function userMessage(id: string, timestamp: number, content = 'question'): Message {
  return { id, role: 'user', content, timestamp }
}

function assistantMessage(
  id: string,
  timestamp: number,
  content: string,
  overrides: Partial<Message> = {},
): Message {
  return { id, role: 'assistant', content, timestamp, ...overrides }
}

function toolMessage(id: string, timestamp: number, toolUseId: string): Message {
  return {
    id,
    role: 'tool',
    content: 'done',
    timestamp,
    toolName: 'Read',
    toolUseId,
    toolStatus: 'completed',
  }
}

/** One finished turn: question, a tool call, an answer. */
function finishedTurn(n: number, at: number): Message[] {
  return [
    userMessage(`u-${n}`, at, `question ${n}`),
    toolMessage(`tool-${n}`, at + 10, `tu-${n}`),
    assistantMessage(`a-${n}`, at + 20, `answer ${n}`),
  ]
}

describe('groupMessagesByTurnCached', () => {
  it('keeps the identity of turns whose messages did not change', () => {
    const finished = finishedTurn(1, 1_000)
    const open = [userMessage('u-2', 2_000), toolMessage('tool-2', 2_010, 'tu-2')]
    const first = groupMessagesByTurnCached([...finished, ...open], null)

    // Turn 2 keeps working: another tool result lands below the older turns.
    const grown = [...finished, ...open, toolMessage('tool-2b', 2_020, 'tu-2b')]
    const second = groupMessagesByTurnCached(grown, first)

    expect(second.turns.length).toBe(first.turns.length)
    // Everything above the open turn is untouched and keeps its identity.
    expect(second.turns[0]).toBe(first.turns[0])
    expect(second.turns[1]).toBe(first.turns[1])
    expect(second.turns[2]).toBe(first.turns[2])
    // The turn that grew is rebuilt.
    expect(second.turns[3]).not.toBe(first.turns[3])
  })

  it('rebuilds the open turn when its streaming message is replaced', () => {
    const messages = [...finishedTurn(1, 1_000), userMessage('u-2', 2_000)]
    const streaming = assistantMessage('a-2', 2_010, 'partial', { isStreaming: true })
    const first = groupMessagesByTurnCached([...messages, streaming], null)

    const nextDelta = { ...streaming, content: 'partial answer' }
    const second = groupMessagesByTurnCached([...messages, nextDelta], first)

    expect(second.turns[1]).toBe(first.turns[1])          // the finished turn
    expect(second.turns[3]).not.toBe(first.turns[3])      // the streaming one
  })

  it('rebuilds the final turn when the session stops processing', () => {
    // A turn that ends on a tool call is only completed by the fallback flag.
    const messages = [...finishedTurn(1, 1_000), userMessage('u-2', 2_000), toolMessage('tool-2', 2_010, 'tu-2')]
    const processing = groupMessagesByTurnCached(messages, null, { isSessionProcessing: true })
    const stopped = groupMessagesByTurnCached(messages, processing, { isSessionProcessing: false })

    expect(stopped.turns.length).toBe(processing.turns.length)
    const last = stopped.turns.length - 1
    // Everything before the open turn is reused …
    expect(stopped.turns[0]).toBe(processing.turns[0])
    // … and the open turn is not, because the flag changed its answer.
    expect(stopped.turns[last]).not.toBe(processing.turns[last])
  })

  it('does not reuse when an earlier message object is replaced', () => {
    const messages = [...finishedTurn(1, 1_000), ...finishedTurn(2, 2_000)]
    const first = groupMessagesByTurnCached(messages, null)

    const edited = messages.map(m => (m.id === 'u-1' ? { ...m, content: 'edited question' } : m))
    const second = groupMessagesByTurnCached(edited, first)

    expect(second.turns[0]).not.toBe(first.turns[0])
    expect(second.turns[3]).toBe(first.turns[3])
  })

  it('returns the same content as the uncached grouping', () => {
    const messages = [
      ...finishedTurn(1, 1_000),
      userMessage('u-2', 2_000),
      { ...assistantMessage('a-2', 2_010, 'still going', { isStreaming: true }) },
      { id: 'err-1', role: 'error' as const, content: 'boom', timestamp: 2_020 },
    ]
    const cached = groupMessagesByTurnCached(messages, null).turns
    expect(cached).toEqual(groupMessagesByTurn(messages))
  })

  it('ignores a previous grouping that belongs to another message list', () => {
    const first = groupMessagesByTurnCached(finishedTurn(1, 1_000), null)
    const other = groupMessagesByTurnCached(finishedTurn(7, 9_000), first)
    // Nothing matched by identity, so every turn is new — never the other
    // conversation's turns.
    expect(other.turns.some(t => first.turns.includes(t))).toBe(false)
  })
})
