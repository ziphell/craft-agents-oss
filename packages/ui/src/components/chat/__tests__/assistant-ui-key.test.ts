import { describe, expect, it } from 'bun:test'
import { getAssistantTurnUiKey, type AssistantTurn } from '../turn-utils'

function makeAssistantTurn(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    type: 'assistant',
    turnId: 'pi-turn-1',
    activities: [],
    response: undefined,
    intent: undefined,
    isStreaming: false,
    isComplete: true,
    timestamp: 123,
    ...overrides,
  }
}

describe('getAssistantTurnUiKey', () => {
  it('uses response message id when available', () => {
    const turn = makeAssistantTurn({
      response: {
        text: 'Done',
        isStreaming: false,
        messageId: 'msg-final-1',
      },
    })

    expect(getAssistantTurnUiKey(turn, 0)).toBe('assistant:msg:msg-final-1')
  })

  it('disambiguates split cards with same turnId/timestamp by their first activity', () => {
    const turnA = makeAssistantTurn({
      turnId: 'pi-turn-1',
      timestamp: 555,
      activities: [{ id: 'act-a', type: 'tool', status: 'completed', timestamp: 555 } as never],
    })
    const turnB = makeAssistantTurn({
      turnId: 'pi-turn-1',
      timestamp: 555,
      activities: [{ id: 'act-b', type: 'tool', status: 'completed', timestamp: 556 } as never],
    })

    expect(getAssistantTurnUiKey(turnA, 2)).not.toBe(getAssistantTurnUiKey(turnB, 3))
    expect(getAssistantTurnUiKey(turnA, 2)).toBe('assistant:turn:pi-turn-1:555:act-a')
  })

  it('keeps the same key when older turns are prepended above it', () => {
    // Expansion state is remembered by this key. Loading an older page shifts
    // every index, so a positional key would hand a turn someone else's card.
    const turn = makeAssistantTurn({
      turnId: 'pi-turn-9',
      timestamp: 900,
      activities: [{ id: 'act-z', type: 'tool', status: 'running', timestamp: 900 } as never],
    })

    expect(getAssistantTurnUiKey(turn, 12)).toBe(getAssistantTurnUiKey(turn, 40))
    expect(getAssistantTurnUiKey(turn, 12)).toBe('assistant:turn:pi-turn-9:900:act-z')
  })

  it('falls back to the index only for a turn with no answer and no activity', () => {
    const turn = makeAssistantTurn({ turnId: 'pi-turn-1', timestamp: 555, activities: [] })
    expect(getAssistantTurnUiKey(turn, 2)).toBe('assistant:turn:pi-turn-1:555:2')
  })
})
