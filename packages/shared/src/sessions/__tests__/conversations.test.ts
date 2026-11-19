/**
 * Conversation stretches: one live `session.jsonl` per session folder, the rest
 * archived under `conversations/`. Both `/new` and "switch back" are the same
 * file swap, so the tests drive the storage helpers directly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { StoredSession } from '../types.ts'
import {
  archiveLiveConversation,
  createSession,
  generateConversationId,
  getConversationFilePath,
  getLiveConversationId,
  getSessionFilePath,
  listConversations,
  loadSession,
  promoteArchivedConversation,
  saveSession,
} from '../storage.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-conversations-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function userMessage(id: string, content: string): StoredSession['messages'][number] {
  return { id, type: 'user', content, timestamp: Date.now() }
}

async function createLiveSession(name: string): Promise<StoredSession> {
  const config = await createSession(root, { name })
  const stored = loadSession(root, config.id)
  if (!stored) throw new Error('session was not created')
  stored.messages = [userMessage('m1', 'first question')]
  stored.sdkSessionId = 'sdk-first'
  await saveSession(stored)
  return stored
}

describe('conversation stretches', () => {
  it('starts the first stretch on the session id and archives it under that name', async () => {
    const stored = await createLiveSession('kept')

    expect(stored.conversationId).toBe(stored.id)
    expect(getLiveConversationId(root, stored.id)).toBe(stored.id)

    const archivedId = archiveLiveConversation(root, stored.id)

    expect(archivedId).toBe(stored.id)
    expect(existsSync(getSessionFilePath(root, stored.id))).toBe(false)
    expect(existsSync(getConversationFilePath(root, stored.id, stored.id))).toBe(true)
  })

  it('lists the live stretch and the archived ones, newest first', async () => {
    const stored = await createLiveSession('kept')

    archiveLiveConversation(root, stored.id)

    const nextId = generateConversationId(Date.now() + 1000)
    await saveSession({
      ...stored,
      conversationId: nextId,
      conversationStartedAt: Date.now() + 1000,
      messages: [],
      sdkSessionId: undefined,
    } as StoredSession)

    const summaries = listConversations(root, stored.id)
    expect(summaries).toHaveLength(2)
    expect(summaries[0]?.id).toBe(nextId)
    expect(summaries[0]?.isLive).toBe(true)
    expect(summaries[1]?.id).toBe(stored.id)
    expect(summaries[1]?.isLive).toBe(false)
    expect(summaries[1]?.messageCount).toBe(1)
  })

  it('promotes an archived stretch back with its own messages and SDK session', async () => {
    const stored = await createLiveSession('kept')
    archiveLiveConversation(root, stored.id)

    const nextId = generateConversationId(Date.now() + 1000)
    await saveSession({
      ...stored,
      conversationId: nextId,
      conversationStartedAt: Date.now() + 1000,
      messages: [userMessage('m2', 'second question')],
      sdkSessionId: 'sdk-second',
    } as StoredSession)

    archiveLiveConversation(root, stored.id)
    expect(promoteArchivedConversation(root, stored.id, stored.id)).toBe(true)

    const restored = loadSession(root, stored.id)
    expect(restored?.messages.map(m => m.content)).toEqual(['first question'])
    expect(restored?.sdkSessionId).toBe('sdk-first')
    expect(getLiveConversationId(root, stored.id)).toBe(stored.id)
  })

  it('restores the newest archive when a swap was interrupted', async () => {
    const stored = await createLiveSession('kept')
    archiveLiveConversation(root, stored.id)

    // Crash boundary: the live file was renamed out and nothing was renamed in.
    expect(existsSync(getSessionFilePath(root, stored.id))).toBe(false)

    const recovered = loadSession(root, stored.id)
    expect(recovered?.sdkSessionId).toBe('sdk-first')
    expect(existsSync(getSessionFilePath(root, stored.id))).toBe(true)
  })

  it('refuses to promote while a live conversation still exists', async () => {
    const stored = await createLiveSession('kept')
    archiveLiveConversation(root, stored.id)
    await saveSession({ ...stored, messages: [] } as StoredSession)

    expect(() => promoteArchivedConversation(root, stored.id, stored.id)).toThrow(/live conversation/)
  })
})
