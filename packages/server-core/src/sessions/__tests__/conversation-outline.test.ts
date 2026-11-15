import { describe, expect, it } from 'bun:test'
import type { Message } from '@craft-agent/core'
import { listQuestions, QUESTION_PREVIEW_LIMIT } from '../conversation-outline'

function message(id: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { id, role, content, timestamp: Number(id.replace(/\D/g, '')) || 0, ...extra } as Message
}

describe('listQuestions', () => {
  it('lists the person\'s questions and nothing else', () => {
    const messages: Message[] = [
      message('m1', 'user', 'first question'),
      message('m2', 'assistant', 'an answer'),
      message('m3', 'tool', 'tool output'),
      message('m4', 'user', 'second question'),
      message('m5', 'info', 'a notice'),
    ]

    expect(listQuestions(messages)).toEqual([
      { id: 'm1', text: 'first question' },
      { id: 'm4', text: 'second question' },
    ])
  })

  it('skips hidden nudges and queued messages', () => {
    const messages: Message[] = [
      message('m1', 'user', 'real question'),
      message('m2', 'user', '[background-task-completed] nudge', { hidden: true }),
      message('m3', 'user', 'unsent draft', { isQueued: true }),
      message('m4', 'user', '   '),
    ]

    expect(listQuestions(messages).map(q => q.id)).toEqual(['m1'])
  })

  it('reads block content', () => {
    const messages: Message[] = [
      message('m1', 'user', [
        { type: 'text', text: 'look at' },
        { type: 'image' },
        { type: 'text', text: 'this screenshot' },
      ] as never),
    ]

    expect(listQuestions(messages)[0]?.text).toBe('look at\nthis screenshot')
  })

  it('truncates a long question to a preview', () => {
    const long = 'x'.repeat(QUESTION_PREVIEW_LIMIT + 200)
    const [question] = listQuestions([message('m1', 'user', long)])
    expect(question?.text).toHaveLength(QUESTION_PREVIEW_LIMIT)
  })

  it('keeps conversation order', () => {
    const messages = ['m1', 'm2', 'm3', 'm4'].map(id => message(id, 'user', id))
    expect(listQuestions(messages).map(q => q.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })
})
