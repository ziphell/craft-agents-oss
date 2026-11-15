import { describe, expect, it } from 'bun:test'
import { SESSION_MESSAGE_PAGE_SIZE, takeMessagePage } from '../message-page'

function messages(count: number, prefix = 'm'): { id: string; role: string }[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, role: 'tool' }))
}

/** A tool-heavy turn: `question`, then `toolCount` assistant/tool messages. */
function heavyTurn(questionId: string, toolCount: number): { id: string; role: string }[] {
  return [
    { id: questionId, role: 'user' },
    ...Array.from({ length: toolCount }, (_, index) => ({ id: `${questionId}-tool-${index}`, role: 'tool' })),
  ]
}

describe('takeMessagePage', () => {
  it('returns the tail when asked for no cursor', () => {
    const page = takeMessagePage(messages(500), { limit: 100 })
    expect(page.messages).toHaveLength(100)
    expect(page.messages[0]!.id).toBe('m-400')
    expect(page.messages[99]!.id).toBe('m-499')
    expect(page.truncated).toBe(true)
  })

  it('walks backwards page by page without gaps or repeats', () => {
    const all = messages(450)
    const first = takeMessagePage(all, { limit: 200 })
    const second = takeMessagePage(all, { limit: 200, before: first.messages[0]!.id })
    const third = takeMessagePage(all, { limit: 200, before: second.messages[0]!.id })

    const ids = [...third.messages, ...second.messages, ...first.messages].map(m => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[0]).toBe('m-0')
    expect(ids[ids.length - 1]).toBe('m-449')
    expect(ids).toHaveLength(450)
    expect(third.truncated).toBe(false)
  })

  it('reports the whole conversation as one untruncated page', () => {
    const page = takeMessagePage(messages(12), { limit: 200 })
    expect(page.messages).toHaveLength(12)
    expect(page.truncated).toBe(false)
  })

  it('falls back to the tail when the cursor is gone', () => {
    const page = takeMessagePage(messages(300), { limit: 50, before: 'deleted-elsewhere' })
    expect(page.messages[0]!.id).toBe('m-250')
    expect(page.truncated).toBe(true)
  })

  it('extends back to include a named message, leaving no hole', () => {
    const all = messages(450)
    // The client holds from m-400 on; a hit sits at m-120.
    const page = takeMessagePage(all, { limit: 200, before: 'm-400', include: 'm-120' })
    expect(page.messages[0]!.id).toBe('m-120')
    expect(page.messages[page.messages.length - 1]!.id).toBe('m-399')
    expect(page.truncated).toBe(true)
  })

  it('ignores an include that is already inside the caller range', () => {
    const all = messages(450)
    const page = takeMessagePage(all, { limit: 50, before: 'm-400', include: 'm-380' })
    expect(page.messages).toHaveLength(50)
    expect(page.messages[0]!.id).toBe('m-350')
  })

  it('never opens a conversation below the question its turn started from', () => {
    // One turn of 500 messages, then a small one. Without the guarantee a
    // 200-message page is entirely inside the first turn.
    const conversation = [...heavyTurn('q-1', 500), ...heavyTurn('q-2', 10)]

    const plain = takeMessagePage(conversation, { limit: 200 })
    expect(plain.messages.some(message => message.id === 'q-2')).toBe(true)
    expect(plain.messages[0]!.id).not.toBe('q-1')

    const withQuestions = takeMessagePage(conversation, { limit: 200, minQuestions: 2 })
    expect(withQuestions.messages[0]!.id).toBe('q-1')
    // The page ends where the window ends either way.
    expect(withQuestions.messages[withQuestions.messages.length - 1]!.id).toBe(conversation[conversation.length - 1]!.id)
  })

  it('does not extend a page that already holds enough questions', () => {
    const conversation = [
      { id: 'q-1', role: 'user' },
      { id: 'q-2', role: 'user' },
      { id: 'q-3', role: 'user' },
      { id: 'q-4', role: 'user' },
    ]
    const page = takeMessagePage(conversation, { limit: 10, minQuestions: 2 })
    expect(page.messages.map(message => message.id)).toEqual(['q-1', 'q-2', 'q-3', 'q-4'])
  })

  it('includes everything when there are fewer questions than asked for', () => {
    const conversation = heavyTurn('q-1', 30)
    const page = takeMessagePage(conversation, { limit: 5, minQuestions: 3 })
    expect(page.messages).toHaveLength(conversation.length)
    expect(page.truncated).toBe(false)
  })

  it('defaults to the shared page size', () => {
    const page = takeMessagePage(messages(SESSION_MESSAGE_PAGE_SIZE + 10))
    expect(page.messages).toHaveLength(SESSION_MESSAGE_PAGE_SIZE)
    expect(page.truncated).toBe(true)
  })

  it('keeps an empty conversation empty rather than an empty page', () => {
    expect(takeMessagePage([])).toEqual({ messages: [], truncated: false })
  })

  it('never returns zero messages because of a bad limit', () => {
    const page = takeMessagePage(messages(5), { limit: 0 })
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]!.id).toBe('m-4')
  })
})
