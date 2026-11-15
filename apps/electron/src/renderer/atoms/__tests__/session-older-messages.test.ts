/**
 * Paged loading of a long conversation.
 *
 * A conversation is opened with only its newest page; scrolling up asks for the
 * page before the oldest message the renderer holds. What has to hold is that
 * walking backwards neither loses nor repeats a message, that a streamed message
 * arriving mid-fetch survives, and that an exhausted conversation stops asking.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import { SESSION_MESSAGE_PAGE_SIZE } from '@craft-agent/shared/sessions/message-page'
import type { Message, Session } from '../../../shared/types'
import { loadOlderSessionMessagesAtom, sessionAtomFamily } from '../sessions'

const SESSION_ID = 'session-1'

function msg(id: string, role: Message['role'] = 'user'): Message {
  return { id, role, content: `content:${id}`, timestamp: Number(id.replace(/\D/g, '')) || 0 }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    workspaceId: 'workspace-1',
    messages: [],
    permissionMode: 'ask',
    supportsBranching: true,
    ...overrides,
  } as Session
}

interface Call {
  sessionId: string
  limit?: number
  before?: string
}

describe('loadOlderSessionMessagesAtom', () => {
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
        getSessionMessages: async (sessionId: string, page?: { limit?: number; before?: string }) => {
          const call = { sessionId, limit: page?.limit, before: page?.before }
          calls.push(call)
          return reply(call)
        },
      },
    } as unknown as typeof window
    return calls
  }

  it('asks for the page before the oldest message it holds', async () => {
    const store = createStore()
    store.set(sessionAtomFamily(SESSION_ID), makeSession({
      messages: [msg('m-200'), msg('m-201')],
      messagesTruncated: true,
    }))

    const calls = stubApi(() => makeSession({
      messages: [msg('m-199')],
      messagesTruncated: true,
    }))

    const added = await store.set(loadOlderSessionMessagesAtom, SESSION_ID)

    expect(calls).toEqual([{ sessionId: SESSION_ID, limit: SESSION_MESSAGE_PAGE_SIZE, before: 'm-200' }])
    expect(added).toBe(1)
    expect(store.get(sessionAtomFamily(SESSION_ID))?.messages.map(m => m.id)).toEqual([
      'm-199', 'm-200', 'm-201',
    ])
  })

  it('keeps a message that streamed in while the page was in flight', async () => {
    const store = createStore()
    store.set(sessionAtomFamily(SESSION_ID), makeSession({
      messages: [msg('m-200'), msg('m-201')],
      messagesTruncated: true,
    }))

    stubApi(() => {
      // The stream appends while the request is out.
      store.set(sessionAtomFamily(SESSION_ID), makeSession({
        messages: [msg('m-200'), msg('m-201'), msg('m-202', 'assistant')],
        messagesTruncated: true,
      }))
      return makeSession({ messages: [msg('m-199')], messagesTruncated: true })
    })

    await store.set(loadOlderSessionMessagesAtom, SESSION_ID)

    expect(store.get(sessionAtomFamily(SESSION_ID))?.messages.map(m => m.id)).toEqual([
      'm-199', 'm-200', 'm-201', 'm-202',
    ])
  })

  it('does not duplicate messages the renderer already has', async () => {
    const store = createStore()
    store.set(sessionAtomFamily(SESSION_ID), makeSession({
      messages: [msg('m-200'), msg('m-201')],
      messagesTruncated: true,
    }))

    // A server that answers with an overlapping page (a stale cursor).
    stubApi(() => makeSession({
      messages: [msg('m-200'), msg('m-201')],
      messagesTruncated: true,
    }))

    const added = await store.set(loadOlderSessionMessagesAtom, SESSION_ID)

    expect(added).toBe(0)
    expect(store.get(sessionAtomFamily(SESSION_ID))?.messages.map(m => m.id)).toEqual(['m-200', 'm-201'])
  })

  it('stops asking when a page brings nothing new', async () => {
    const store = createStore()
    store.set(sessionAtomFamily(SESSION_ID), makeSession({
      messages: [msg('m-1')],
      messagesTruncated: true,
    }))
    stubApi(() => makeSession({ messages: [msg('m-1')], messagesTruncated: true }))

    const added = await store.set(loadOlderSessionMessagesAtom, SESSION_ID)

    expect(added).toBe(0)
    // Repeated fetches would otherwise loop forever from the scroll handler.
    expect(store.get(sessionAtomFamily(SESSION_ID))?.messagesTruncated).toBe(false)
  })

  it('clears the flag when the conversation is complete', async () => {
    const store = createStore()
    store.set(sessionAtomFamily(SESSION_ID), makeSession({
      messages: [msg('m-2')],
      messagesTruncated: true,
    }))
    stubApi(() => makeSession({ messages: [msg('m-1')], messagesTruncated: false }))

    await store.set(loadOlderSessionMessagesAtom, SESSION_ID)

    const session = store.get(sessionAtomFamily(SESSION_ID))
    expect(session?.messages.map(m => m.id)).toEqual(['m-1', 'm-2'])
    expect(session?.messagesTruncated).toBe(false)
  })

  it('does nothing when the whole conversation is already here', async () => {
    const store = createStore()
    store.set(sessionAtomFamily(SESSION_ID), makeSession({
      messages: [msg('m-1')],
      messagesTruncated: false,
    }))

    const calls = stubApi(() => makeSession({ messages: [msg('m-0')] }))

    expect(await store.set(loadOlderSessionMessagesAtom, SESSION_ID)).toBe(0)
    expect(calls).toEqual([])
  })
})
