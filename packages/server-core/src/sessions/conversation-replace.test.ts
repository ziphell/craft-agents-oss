/**
 * `/replace`: the server side of a conversation swap, on a real session folder.
 *
 * The storage helpers are covered in `@craft-agent/shared/sessions`; this test
 * covers the SessionManager glue — idle guard, archiving, per-stretch reset and
 * the one broadcast — because that is what the renderer calls.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getConversationFilePath, getSessionFilePath, saveSession } from '../../../shared/src/sessions/index.ts'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('conversation replace', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-replace-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  async function seedSession(id: string) {
    const workspace = { id: 'ws-test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id, name: 'replace test' }, workspace as never, {
      messagesLoaded: true,
    })
    managed.messages = [
      { id: 'm1', role: 'user', content: 'hello', timestamp: Date.now() } as never,
      { id: 'm2', role: 'assistant', content: 'hi', timestamp: Date.now() } as never,
    ]
    managed.sdkSessionId = 'sdk-old'
    managed.conversationId = id
    managed.conversationStartedAt = Date.now()
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)

    await saveSession({
      id,
      workspaceRootPath: tmpRoot,
      createdAt: managed.createdAt ?? Date.now(),
      lastUsedAt: Date.now(),
      conversationId: id,
      conversationStartedAt: managed.conversationStartedAt,
      sdkSessionId: 'sdk-old',
      messages: [
        { id: 'm1', type: 'user', content: 'hello', timestamp: Date.now() },
        { id: 'm2', type: 'assistant', content: 'hi', timestamp: Date.now() },
      ],
      tokenUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10, contextTokens: 10, costUsd: 0 },
    } as never)

    return managed
  }

  it('archives the live conversation, resets the stretch and broadcasts once', async () => {
    const id = 'replace-1'
    const managed = await seedSession(id)
    const events: Array<{ type: string }> = []
    sm.setEventSink((_channel, _target, event) => events.push(event as { type: string }))

    const result = await sm.startNewConversation(id)

    expect(result.previousMessageCount).toBe(2)
    expect(result.previousConversationId).toBe(id)
    expect(result.conversation.id).not.toBe(id)

    // Old transcript is on disk under its own id; the live file is a fresh one.
    expect(existsSync(getConversationFilePath(tmpRoot, id, id))).toBe(true)
    expect(existsSync(getSessionFilePath(tmpRoot, id))).toBe(true)

    expect(managed.messages).toEqual([])
    expect(managed.sdkSessionId).toBeUndefined()
    expect(managed.conversationId).toBe(result.conversation.id)
    expect(managed.tokenUsage?.totalTokens).toBe(0)

    expect(events.filter(e => e.type === 'conversation_changed')).toHaveLength(1)
  })

  it('is a no-op on an empty conversation', async () => {
    const id = 'replace-empty'
    const workspace = { id: 'ws-test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id, name: 'empty' }, workspace as never, { messagesLoaded: true })
    managed.conversationId = id
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    const events: Array<{ type: string }> = []
    sm.setEventSink((_channel, _target, event) => events.push(event as { type: string }))

    const result = await sm.startNewConversation(id)

    expect(result.previousMessageCount).toBe(0)
    expect(result.conversation.id).toBe(id)
    expect(events).toHaveLength(0)
  })

  it('refuses while a turn is running', async () => {
    const id = 'replace-busy'
    const managed = await seedSession(id)
    managed.isProcessing = true

    await expect(sm.startNewConversation(id)).rejects.toMatchObject({
      code: 'CONVERSATION_UNAVAILABLE',
    })
    managed.isProcessing = false
  })

  it('switches back to the archived stretch with its own SDK session', async () => {
    const id = 'replace-2'
    const managed = await seedSession(id)
    await sm.startNewConversation(id)

    const restored = await sm.switchConversation(id, id)

    expect(restored.messageCount).toBe(2)
    expect(managed.messages.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(managed.sdkSessionId).toBe('sdk-old')
    expect(managed.conversationId).toBe(id)
  })
})
