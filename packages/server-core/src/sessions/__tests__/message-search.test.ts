import { describe, expect, it } from 'bun:test'
import type { Message } from '@craft-agent/core'
import { countOccurrences, searchableText, searchMessages } from '../message-search'

function message(id: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { id, role, content, timestamp: Number(id.replace(/\D/g, '')) || 0, ...extra } as Message
}

describe('searchableText', () => {
  it('reads a user message, including block content', () => {
    expect(searchableText(message('m1', 'user', 'hello there'))).toBe('hello there')
    expect(searchableText(message('m2', 'user', [
      { type: 'text', text: 'first' },
      { type: 'image' },
      { type: 'text', text: 'second' },
    ] as never))).toBe('first\nsecond')
  })

  it('skips messages the transcript never shows', () => {
    expect(searchableText(message('m1', 'user', 'nudge', { hidden: true }))).toBe('')
    expect(searchableText(message('m2', 'user', 'queued text', { isQueued: true }))).toBe('')
  })

  it('reads only the assistant message that ended a turn', () => {
    expect(searchableText(message('m1', 'assistant', 'the answer'))).toBe('the answer')
    expect(searchableText(message('m2', 'assistant', 'thinking out loud', { isIntermediate: true }))).toBe('')
    expect(searchableText(message('m3', 'assistant', 'still typing', { isPending: true }))).toBe('')
  })

  it('reads system notices but not tool output', () => {
    expect(searchableText(message('m1', 'error', 'it broke'))).toBe('it broke')
    expect(searchableText(message('m2', 'tool', 'file contents'))).toBe('')
    expect(searchableText(message('m3', 'plan', '# Plan'))).toBe('')
  })
})

describe('countOccurrences', () => {
  it('counts non-overlapping, case-insensitively', () => {
    expect(countOccurrences('aaa', 'aa')).toBe(1)
    expect(countOccurrences('Hello hello HELLO', 'hello')).toBe(3)
    expect(countOccurrences('nothing here', 'zzz')).toBe(0)
    expect(countOccurrences('anything', '')).toBe(0)
  })
})

describe('searchMessages', () => {
  const conversation: Message[] = [
    message('m1', 'user', 'How do I make the chat panel scroll to the bottom?'),
    message('m2', 'tool', 'scroll to the bottom'),
    message('m3', 'assistant', 'You pin the viewport to scroll to the bottom on mount.'),
    message('m4', 'user', 'And search?'),
    message('m5', 'assistant', 'Search covers the scroll to the bottom case too.', { isIntermediate: true }),
    message('m6', 'assistant', 'Search reads the whole history.', {}),
  ]

  it('finds matches in messages regardless of where they sit', () => {
    const result = searchMessages(conversation, 'scroll to the bottom')
    expect(result.hits.map(hit => hit.id)).toEqual(['m1', 'm3'])
    expect(result.total).toBe(2)
    expect(result.limited).toBe(false)
  })

  it('counts each occurrence and reports conversation order', () => {
    const result = searchMessages(conversation, 'search')
    expect(result.hits.map(hit => ({ id: hit.id, count: hit.count }))).toEqual([
      { id: 'm4', count: 1 },
      { id: 'm6', count: 1 },
    ])
    expect(result.hits[0]!.index).toBeLessThan(result.hits[1]!.index)
  })

  it('does not count text that is not rendered', () => {
    // The tool message and the intermediate assistant message both contain the
    // phrase; neither is prose the reader sees as text.
    const result = searchMessages(conversation, 'scroll to the bottom')
    expect(result.hits.map(hit => hit.id)).not.toContain('m2')
    expect(result.hits.map(hit => hit.id)).not.toContain('m5')
  })

  it('is case-insensitive and trims the query', () => {
    expect(searchMessages(conversation, '  SEARCH  ').total).toBe(2)
  })

  it('returns nothing for an empty query', () => {
    expect(searchMessages(conversation, '   ')).toEqual({ total: 0, hits: [], limited: false })
  })

  it('caps the hit list but keeps the total exact', () => {
    const many = Array.from({ length: 10 }, (_, index) => message(`m${index}`, 'user', 'needle'))
    const result = searchMessages(many, 'needle', 4)
    expect(result.hits).toHaveLength(4)
    expect(result.total).toBe(10)
    expect(result.limited).toBe(true)
  })
})
