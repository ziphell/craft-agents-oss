import { describe, expect, it } from 'bun:test'
import type { Message } from '../../../shared/types'
import { agentAttribution, isFromAgent, originOf, splitQueued, withoutAgentEnvelope } from '../agent-message'

/** A message shaped like the persisted ones, with only what these helpers read. */
function msg(over: Partial<Message> = {}): Message {
  return { id: 'm', role: 'user', content: 'hi', timestamp: 1, ...over } as Message
}

const ENVELOPE = (text: string) =>
  `[Message from session "261103-smart-vista" (Delegate test)]\n` +
  `Use send_agent_message with sessionId "261103-smart-vista" to reply.\n\n---\n\n${text}`

describe('origin', () => {
  it('defaults to the person, so rows written before the field existed still behave', () => {
    expect(originOf(msg())).toBe('user')
    expect(isFromAgent(msg())).toBe(false)
  })

  it('attributes a message to the conversation that sent it, by name then id', () => {
    expect(agentAttribution(msg({ origin: 'agent', fromSessionName: 'Delegate test' }))).toBe('Delegate test')
    expect(agentAttribution(msg({ origin: 'agent', fromSessionId: 's-1' }))).toBe('s-1')
    expect(agentAttribution(msg({ origin: 'user' }))).toBeNull()
  })
})

describe('withoutAgentEnvelope', () => {
  it('drops the addressing a person does not need, and keeps the message', () => {
    const m = msg({ origin: 'agent', fromSessionName: 'Delegate test', content: ENVELOPE('The total is 391.') })
    expect(withoutAgentEnvelope(m.content, m)).toBe('The total is 391.')
  })

  it('leaves a message that carries no envelope alone', () => {
    const m = msg({ origin: 'agent', fromSessionName: 'x', content: 'Plain reply.' })
    expect(withoutAgentEnvelope(m.content, m)).toBe('Plain reply.')
  })

  it('never rewrites what the person typed, even if it starts with a bracket', () => {
    const m = msg({ content: '[Message from session "x"] looks like an envelope but is mine' })
    expect(withoutAgentEnvelope(m.content, m)).toBe(m.content)
  })
})

describe('splitQueued', () => {
  it('keeps the person’s drafts apart from another conversation’s message', () => {
    const mine = msg({ id: 'a', isQueued: true, content: 'write the doc' })
    const incoming = msg({ id: 'b', isQueued: true, origin: 'agent', fromSessionName: 'Child', content: ENVELOPE('done') })

    const split = splitQueued([mine, incoming])

    expect(split.mine.map(m => (m as { id: string }).id)).toEqual(['a'])
    expect(split.fromAgents.map(m => (m as { id: string }).id)).toEqual(['b'])
  })

  it('excludes hidden nudges from both sides — nobody wrote them', () => {
    const split = splitQueued([
      msg({ id: 'nudge', isQueued: true, hidden: true, origin: 'system', content: '[child-task-finished] …' }),
      msg({ id: 'done', hidden: true, origin: 'system' }),
    ])
    expect(split.mine).toEqual([])
    expect(split.fromAgents).toEqual([])
  })

  it('ignores assistant turns and messages that already started', () => {
    const split = splitQueued([
      msg({ id: 'a1', role: 'assistant', isQueued: true }),
      msg({ id: 'u1' }),
    ])
    expect(split.mine).toEqual([])
  })
})
