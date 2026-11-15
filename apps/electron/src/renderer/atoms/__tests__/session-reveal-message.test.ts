/**
 * Opening a search hit that sits outside the loaded page.
 *
 * Search is answered by the server over the whole history, so a hit can point at
 * a message this client has never carried. Revealing it must load the page that
 * ends where the current window begins — a conversation with a hole in it would
 * read as if turns had been deleted.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { Message, Session } from '../../../shared/types'
import { revealSessionMessageAtom, sessionAtomFamily } from '../sessions'

const SESSION_ID = 'session-1'

function msg(id: string): Message {
  return { id, role: 'user', content: `content:${id}`, timestamp: Number(id.replace(/\D/g, '')) || 0 }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    workspaceId: 'workspace-1',
    messages: [],
    permissionMode: 'ask',
    supportingBranching: true,
    ...overrides,
  } as unknown as Session
}

interface Call {
  sessionId: string
  before?: string
  include?: string
}

describe('revealSessionMessageAtom', () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    if (originalWindow) {
      globalThis.window = originalWindow
    } else {
      // @ts-expect-error test cleanup for window shim
      delete globalThis.window
    }
  })

  function stubApi(reply: (call: Call) => Session | null): Call[] {
    const calls: Call[] = []
    globalThis.window = {
      electronAPI: {
        getSessionMessages: async (sessionId: string, page?: { before?: string; include?: string }) => {
          const call = { sessionId, before: page?.before, include: page?.include }
          calls.push(call)
          return reply(call)
        },
      },
    } as unknown as typeof window
    return calls
  }

  it('does nothing when the message is already loaded', async () => {
    const store = createStore()
    store.set(sessionAtomFamily(SESSION_ID), makeSession({ messages: [msg('m-1'), msg('m-2')] }))
    const calls = stubApi(() => null)

    expect(await store.set(revealSessionMessageAtom, SESSION_ID, 'm-2')).toBe(true)
    expect(calls).toEqual([])
  })

  it('loads a page that ends where the window starts and reaches the hit', async () => {
    const store = createStore()
    store.set(sessionAtomFamily(SESSION_ID), makeSession({
      messages: [msg('m-200'), msg('m-201')],
      messagesTruncated: true,
    }))

    const calls = stubApi(() => makeSession({
      messages: [msg('m-120'), msg('m-121'), msg('m-199')],
      messagesTruncated: true,
    }))

    expect(await store.set(revealSessionMessageAtom, SESSION_ID, 'm-120')).toBe(true)
    expect(calls).toEqual([{ sessionId: SESSION_ID, before: 'm-200', include: 'm-120' }])

    expect(store.get(sessionAtomFamily(SESSION_ID))?.messages.map(m => m.id)).toEqual([
      'm-120', 'm-121', 'm-199', 'm-200', 'm-201',
    ])
  })

  it('reports false when the page arrives without the message', async () => {
    const store = createStore()
    store.set(sessionAtomFamily(SESSION_ID), makeSession({
      messages: [msg('m-200')],
      messagesTruncated: true,
    }))

    stubApi(() => makeSession({ messages: [msg('m-150')], messagesTruncated: true }))

    expect(await store.set(revealSessionMessageAtom, SESSION_ID, 'm-gone')).toBe(false)
    // What did arrive is kept: the fetch was about a place in the conversation.
    expect(store.get(sessionAtomFamily(SESSION_ID))?.messages.map(m => m.id)).toEqual(['m-150', 'm-200'])
  })

  it('collapses a burst of jumps to the same hit into one request', async () => {
    const store = createStore()
    store.set(sessionAtomFamily(SESSION_ID), makeSession({
      messages: [msg('m-200')],
      messagesTruncated: true,
    }))

    const calls = stubApi(() => makeSession({ messages: [msg('m-120')], messagesTruncated: true }))

    const results = await Promise.all([
      store.set(revealSessionMessageAtom, SESSION_ID, 'm-120'),
      store.set(revealSessionMessageAtom, SESSION_ID, 'm-120'),
    ])

    expect(results).toEqual([true, true])
    expect(calls).toHaveLength(1)
  })
})
