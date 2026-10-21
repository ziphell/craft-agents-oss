import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPendingPlanExecution, saveSession } from '../../../shared/src/sessions/storage.ts'
import { ClaudeAgent } from '../../../shared/src/agent/claude-agent.ts'
import { PendingSteers } from '../../../shared/src/agent/backend/claude/pending-steers.ts'
import { AbortReason } from '../../../shared/src/agent/backend/types.ts'
import {
  SessionManager,
  createManagedSession,
} from './SessionManager.ts'

describe('mid-stream queue runtime invariants', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-midstream-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    mock.restore()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'mid-stream test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  it('always queues a mid-stream send, regardless of the provider', async () => {
    const managed = buildSession('always-queue')
    managed.isProcessing = true
    const redirect = mock(() => true)
    managed.agent = { redirect } as any
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))

    await sm.sendMessage(managed.id, 'plain text')

    expect(redirect).not.toHaveBeenCalled()
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messages.at(-1)!.isQueued).toBe(true)
    expect(events.find(e => e.type === 'user_message').status).toBe('queued')
  })

  it('sends a queued message now by stopping the turn and putting it first', async () => {
    const managed = buildSession('send-now')
    managed.isProcessing = true
    const forceAbort = mock(() => {})
    managed.agent = { forceAbort } as any
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))

    await sm.sendMessage(managed.id, 'first')
    await sm.sendMessage(managed.id, 'second')
    const [firstId, secondId] = managed.messages.map(m => m.id)

    // The renderer may send its own optimistic id; both ids must resolve.
    await expect(sm.sendQueuedMessageNow(managed.id, secondId)).resolves.toEqual({ sent: true })
    expect(forceAbort).toHaveBeenCalledWith(AbortReason.Redirect)
    expect(managed.messageQueue.map(q => q.messageId)).toEqual([secondId, firstId])
    // Still queued until the replay turns it into an accepted turn.
    expect(managed.messages.find(m => m.id === secondId)!.isQueued).toBe(true)
    // Silent interruption: no "Response interrupted" bubble.
    expect(events.find(e => e.type === 'interrupted')).toMatchObject({ sessionId: managed.id })
    expect(events.find(e => e.type === 'interrupted')!.message).toBeUndefined()

    await expect(sm.sendQueuedMessageNow(managed.id, 'missing')).resolves.toEqual({
      sent: false,
      reason: 'not-queued',
    })
    managed.isProcessing = false // Disarm the production Stop backstop timer.
    await expect(sm.sendQueuedMessageNow(managed.id, secondId)).resolves.toEqual({
      sent: false,
      reason: 'not-processing',
    })
  })

  it('keeps the message queued while a manual compaction owns the turn', async () => {
    const managed = buildSession('send-now-compacting')
    managed.isProcessing = true
    const forceAbort = mock(() => {})
    managed.agent = { forceAbort, isCompactionInFlight: () => true } as any
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}

    await sm.sendMessage(managed.id, 'wait for compaction')
    const messageId = managed.messages.at(-1)!.id
    await expect(sm.sendQueuedMessageNow(managed.id, messageId)).resolves.toEqual({
      sent: false,
      reason: 'compacting',
    })
    expect(forceAbort).not.toHaveBeenCalled()
    expect(managed.messageQueue).toHaveLength(1)
    managed.isProcessing = false
  })

  it('recovers distinct identical-text steers by identity without interrupting or duplicating', async () => {
    const managed = buildSession('recover')
    const payloads = ['a', 'b', 'c'].map(messageId => ({ message: 'same', messageId, optimisticMessageId: `optimistic-${messageId}` }))
    managed.messages = payloads.map(p => ({ id: p.messageId, content: p.message, role: 'user', timestamp: 1 }))
    ;(managed as any).acceptedSteers = new Map(payloads.map(p => [p.messageId, p]))
    ;(sm as any).persistSession = () => {}
    for (const p of payloads) await (sm as any).processEvent(managed, { type: 'steer_undelivered', message: p.message, messageId: p.messageId })
    expect(managed.messageQueue).toEqual(payloads)
    expect(managed.messages).toHaveLength(3)
    expect(managed.messages.every(m => m.isQueued)).toBe(true)
    expect(managed.wasInterrupted).not.toBe(true)
    await (sm as any).processEvent(managed, { type: 'steer_undelivered', message: 'same', messageId: 'a' })
    expect(managed.messageQueue).toHaveLength(3)
  })

  it('queues attachments and semantic options intact without calling a text-only redirect', async () => {
    const managed = buildSession('attachments')
    managed.isProcessing = true
    const redirect = mock(() => true)
    managed.agent = { redirect } as any
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const attachments = [{ name: 'photo.png', type: 'image', mimeType: 'image/png', base64: 'image-bytes' }] as any
    const storedAttachments = [{ id: 'file', name: 'photo.png', type: 'image', storedPath: '/tmp/photo.png' }] as any
    const options = { skillSlugs: ['image-skill'], hidden: true, optimisticMessageId: 'optimistic' }
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    await sm.sendMessage(managed.id, 'inspect image', attachments, storedAttachments, options)
    expect(redirect).not.toHaveBeenCalled()
    expect(managed.wasInterrupted).not.toBe(true)
    expect(managed.messageQueue[0]).toMatchObject({ attachments, storedAttachments, options, messageId: managed.messages[0]!.id })
    expect(managed.messages[0]!.isQueued).toBe(true)
    expect(events.find(e => e.type === 'user_message').status).toBe('queued')
    // Also prove the existing supported replay path receives the same objects.
    const replay = mock(async (..._args: unknown[]) => {})
    ;(sm as any).sendMessage = replay
    ;(sm as any).processNextQueuedMessage(managed.id)
    await new Promise<void>(resolve => setImmediate(resolve))
    const replayTurn = managed.messages[managed.messages.length - 1]!
    expect(replay.mock.calls[0]).toEqual([
      managed.id,
      'inspect image',
      attachments,
      storedAttachments,
      // The preview is gone, so the replay must not carry its optimistic id.
      { ...options, optimisticMessageId: undefined },
      replayTurn.id,
    ])
  })

  it('cancels one queued message and leaves the rest of the queue intact', async () => {
    const managed = buildSession('cancel-queued')
    const queued = [
      { message: 'first', messageId: 'm1', optimisticMessageId: 'o1' },
      { message: 'second', messageId: 'm2', optimisticMessageId: 'o2' },
    ]
    managed.messageQueue = queued
    managed.messages = queued.map((p, i) => ({
      id: p.messageId,
      role: 'user' as const,
      content: p.message,
      timestamp: i + 1,
      isQueued: true,
    }))
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))

    // The renderer sends its own optimistic id; both ids must resolve.
    await expect(sm.cancelQueuedMessage(managed.id, 'o2')).resolves.toEqual({ cancelled: true })
    expect(managed.messageQueue).toEqual([queued[0]])
    expect(managed.messages.map(m => m.id)).toEqual(['m1'])
    expect(events.find(e => e.type === 'queued_message_cancelled')).toMatchObject({
      messageId: 'm2',
      optimisticMessageId: 'o2',
    })

    // Unknown or already-replaying messages are a no-op.
    await expect(sm.cancelQueuedMessage(managed.id, 'missing')).resolves.toEqual({ cancelled: false })
  })

  it('cancels a stale queued row that has no queue entry', async () => {
    const managed = buildSession('cancel-stale')
    managed.messages = [
      { id: 'stale-1', role: 'user', content: 'orphaned queued text', timestamp: 1, isQueued: true },
    ]
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))

    await expect(sm.cancelQueuedMessage(managed.id, 'missing', 'orphaned queued text')).resolves.toEqual({
      cancelled: true,
    })
    expect(managed.messages).toEqual([])
    expect(events.find(e => e.type === 'queued_message_cancelled')).toMatchObject({ messageId: 'stale-1' })
  })

  it('matches a queued entry by text only when it is unambiguous', async () => {
    const managed = buildSession('cancel-by-text')
    managed.messageQueue = [
      { message: 'unique text', messageId: 'm1' },
      { message: 'same text', messageId: 'm2' },
      { message: 'same text', messageId: 'm3' },
    ]
    managed.messages = [
      { id: 'm1', role: 'user', content: 'unique text', timestamp: 1, isQueued: true },
      { id: 'm2', role: 'user', content: 'same text', timestamp: 2, isQueued: true },
      { id: 'm3', role: 'user', content: 'same text', timestamp: 3, isQueued: true },
    ]
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}

    await expect(sm.cancelQueuedMessage(managed.id, 'unknown', 'unique text')).resolves.toEqual({ cancelled: true })
    expect(managed.messageQueue.map(q => q.messageId)).toEqual(['m2', 'm3'])

    // Duplicate text is ambiguous — leave the queue alone and report failure.
    await expect(sm.cancelQueuedMessage(managed.id, 'unknown', 'same text')).resolves.toEqual({ cancelled: false })
    expect(managed.messageQueue.map(q => q.messageId)).toEqual(['m2', 'm3'])
  })

  it('reorders the queue and keeps the persisted transcript order in sync', async () => {
    const managed = buildSession('reorder-queue')
    managed.isProcessing = true
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))

    await sm.sendMessage(managed.id, 'first')
    await sm.sendMessage(managed.id, 'second')
    const [firstId, secondId] = managed.messages.map(m => m.id)

    await expect(sm.reorderQueuedMessage(managed.id, secondId, 0)).resolves.toEqual({ reordered: true })
    expect(managed.messageQueue.map(q => q.messageId)).toEqual([secondId, firstId])
    // Crash recovery re-queues from `messages`, so its order must match too.
    expect(managed.messages.map(m => m.id)).toEqual([secondId, firstId])
    expect(events.filter(e => e.type === 'queued_messages_state').at(-1)).toMatchObject({
      sessionId: managed.id,
      order: [{ messageId: secondId }, { messageId: firstId }],
    })

    // Unknown ids are a no-op.
    await expect(sm.reorderQueuedMessage(managed.id, 'missing', 0)).resolves.toEqual({ reordered: false })
  })

  it('reorders by the renderer optimistic id', async () => {
    const managed = buildSession('reorder-optimistic')
    managed.isProcessing = true
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))

    await sm.sendMessage(managed.id, 'first', undefined, undefined, { optimisticMessageId: 'opt-1' })
    await sm.sendMessage(managed.id, 'second', undefined, undefined, { optimisticMessageId: 'opt-2' })

    await expect(sm.reorderQueuedMessage(managed.id, 'opt-2', 0)).resolves.toEqual({ reordered: true })
    expect(managed.messageQueue.map(q => q.optimisticMessageId)).toEqual(['opt-2', 'opt-1'])
    expect(events.filter(e => e.type === 'queued_messages_state').at(-1)!.order[0]).toMatchObject({
      optimisticMessageId: 'opt-2',
    })
  })

  it('marks Accept & Compact ready only after a manual compaction success and preserves the fresh snapshot', async () => {
    const managed = buildSession('manual-compact-ready')
    managed.isProcessing = true
    managed.tokenUsage = { inputTokens: 419_000, outputTokens: 10, totalTokens: 419_010, contextTokens: 0, costUsd: 0 }
    await saveSession({ id: managed.id, workspaceRootPath: tmpRoot, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: managed.tokenUsage } as any)
    await sm.setPendingPlanExecution(managed.id, '/tmp/plan.md', 'draft')
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    ;(sm as any).persistSession = () => {}

    await (sm as any).processEvent(managed, { type: 'context_usage', contextUsage: { usedTokens: 12_000, limitTokens: 200_000, limitKind: 'compaction', isEstimate: true, isStale: false, canCompact: true } })
    await (sm as any).processEvent(managed, { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' })

    expect(getPendingPlanExecution(tmpRoot, managed.id)).toMatchObject({ awaitingCompaction: false, executionDispatched: false })
    expect(managed.tokenUsage.contextUsage?.usedTokens).toBe(12_000)
    expect(events.find(e => e.type === 'usage_update').tokenUsage.contextUsage.usedTokens).toBe(12_000)
    expect(events.find(e => e.type === 'info')).toMatchObject({ statusType: 'compaction_complete' })
    expect(await sm.markPendingPlanExecutionDispatched(managed.id)).toBe(false)
    managed.isProcessing = false
    expect(await sm.markPendingPlanExecutionDispatched(managed.id)).toBe(true)
    expect(await sm.markPendingPlanExecutionDispatched(managed.id)).toBe(false)
  })

  it('does not release pending plan execution for auto or failed compaction outcomes', async () => {
    for (const [id, event] of [
      ['auto-compact', { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'auto' }],
      ['failed-compact', { type: 'compaction_failed' }],
    ] as const) {
      const managed = buildSession(id)
      await saveSession({ id: managed.id, workspaceRootPath: tmpRoot, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as any)
      await sm.setPendingPlanExecution(managed.id, '/tmp/plan.md')
      ;(sm as any).persistSession = () => {}
      await (sm as any).processEvent(managed, event)
      managed.isProcessing = false
      expect(await sm.markPendingPlanExecutionDispatched(managed.id)).toBe(false)
      const pending = getPendingPlanExecution(tmpRoot, managed.id)
      if (id === 'auto-compact') expect(pending).toMatchObject({ awaitingCompaction: true, executionDispatched: false })
      else expect(pending).toBeNull()
    }
  })

  it('keeps the pending plan record while sending the /compact command that releases it', async () => {
    const managed = buildSession('send-compact')
    await saveSession({ id: managed.id, workspaceRootPath: tmpRoot, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as any)
    await sm.setPendingPlanExecution(managed.id, '/tmp/plan.md')
    const agent = {
      getModel: () => 'claude-sonnet-4-6',
      setAllSources: () => {},
      getSessionId: () => 'sdk-session',
      chat: async function* () {
        yield { type: 'context_usage', contextUsage: { usedTokens: 12_000, limitTokens: 200_000, limitKind: 'compaction', isEstimate: true, isStale: false, canCompact: true } }
        yield { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' }
        yield { type: 'complete' }
      },
    }
    ;(sm as any).getOrCreateAgent = async () => agent
    sm.setEventSink(() => {})
    await sm.sendMessage(managed.id, '/compact')
    expect(getPendingPlanExecution(tmpRoot, managed.id)).toMatchObject({ awaitingCompaction: false, executionDispatched: false })
  })

  it('the actual host sendMessage loop consumes Claude recovery before stopping at complete', async () => {
    const managed = buildSession('host-completion')
    managed.sdkSessionId = 'offline-sdk'
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.pendingSteers = new PendingSteers()
    agent.currentQuery = { interrupt: async () => {} }
    agent.currentQueryAbortController = new AbortController()
    agent.debug = () => {}
    agent.getModel = () => 'claude-sonnet-4-6'
    agent.setAllSources = () => {}
    agent.getSessionId = () => 'offline-sdk'
    agent.chat = agent.chatImpl.bind(agent)
    const acceptedIds: string[] = []
    agent.chatTurn = async function* () {
      for (const id of ['a', 'b', 'c']) {
        await sm.sendMessage(managed.id, 'same', undefined, undefined, { optimisticMessageId: `opt-${id}` })
        acceptedIds.push(managed.messages.at(-1)!.id)
      }
      yield { type: 'complete' }
    }
    managed.agent = agent
    ;(sm as any).getOrCreateAgent = async () => agent
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const stopped = mock(async () => { managed.isProcessing = false })
    ;(sm as any).onProcessingStopped = stopped
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    await sm.sendMessage(managed.id, 'initial')
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(managed.messageQueue.map(p => p.messageId)).toEqual(acceptedIds)
    expect(managed.messageQueue.map(p => p.optimisticMessageId)).toEqual(['opt-a', 'opt-b', 'opt-c'])
    expect(managed.messages.filter(m => m.role === 'user')).toHaveLength(4)
    expect(managed.wasInterrupted).not.toBe(true)
    expect(events.filter(e => e.type === 'user_message' && e.status === 'queued').map(e => e.message.id)).toEqual(acceptedIds)
  })

  it.each(['complete', 'error'])('ignores a trailing %s from a handed-off turn after a newer turn starts', async terminal => {
    const managed = buildSession('handoff-new-turn')
    managed.sdkSessionId = 'offline-sdk'
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.pendingSteers = new PendingSteers()
    agent.currentQuery = { interrupt: async () => {} }
    agent.currentQueryAbortController = new AbortController()
    agent.debug = () => {}
    agent.getModel = () => 'claude-sonnet-4-6'
    agent.setAllSources = () => {}
    agent.getSessionId = () => 'offline-sdk'
    agent.chat = agent.chatImpl.bind(agent)
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const starts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    let turn = 0
    agent.chatTurn = async function* () {
      const index = turn++
      starts[index]!.resolve()
      await gates[index]!.promise
      if (index === 0 && terminal === 'error') throw new Error('old query aborted')
      yield { type: 'complete' }
    }
    managed.agent = agent
    ;(sm as any).getOrCreateAgent = async () => agent
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const stopped = mock(async () => { managed.isProcessing = false })
    ;(sm as any).onProcessingStopped = stopped
    const first = sm.sendMessage(managed.id, 'first')
    await starts[0]!.promise
    ;(sm as any).recoverPendingSteers(managed)
    managed.isProcessing = false // The UI handoff callback pauses without waiting for the old SDK result.
    const second = sm.sendMessage(managed.id, 'second')
    await starts[1]!.promise
    gates[0]!.resolve()
    try {
      await first
      expect(stopped).not.toHaveBeenCalled()
      expect(managed.isProcessing).toBe(true)
    } finally {
      gates[1]!.resolve()
      await second
    }
    expect(stopped).toHaveBeenCalledTimes(1)
  })

  it('transfers handoff steers ahead of already queued later attachments', () => {
    const managed = buildSession('handoff-order')
    managed.messages = ['a', 'b', 'c'].map(id => ({ id, role: 'user', content: id, timestamp: 1 }))
    const payloads = ['a', 'c'].map(messageId => ({ message: messageId, messageId }))
    managed.acceptedSteers = new Map(payloads.map(p => [p.messageId, p]))
    managed.messageQueue = [{ message: 'b', messageId: 'b', attachments: [{ name: 'keep' }] as any }]
    managed.agent = { takePendingSteers: () => payloads } as any
    ;(sm as any).persistSession = () => {}
    ;(sm as any).recoverPendingSteers(managed)
    expect(managed.messageQueue.map(p => p.messageId)).toEqual(['a', 'b', 'c'])
    expect(managed.messageQueue[1]!.attachments).toEqual([{ name: 'keep' }] as any)
    expect(managed.wasInterrupted).not.toBe(true)
  })

  it('hard Stop visibly cancels accepted pending steers and rejects trailing recovery', async () => {
    const managed = buildSession('stop')
    managed.isProcessing = true
    managed.messages = [{ id: 'a', role: 'user', content: 'pending', timestamp: 1 }]
    const payload = { message: 'pending', messageId: 'a' }
    managed.acceptedSteers = new Map([['a', payload]])
    const forceAbort = mock(() => {})
    managed.agent = { takePendingSteers: () => [payload], forceAbort } as any
    ;(sm as any).persistSession = () => {}
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    await sm.cancelProcessing(managed.id)
    expect(forceAbort).toHaveBeenCalledTimes(1)
    expect(events.find(e => e.type === 'interrupted').queuedMessages).toEqual(['pending'])
    expect(managed.messages.some(m => m.id === 'a')).toBe(false)
    expect(managed.messageQueue).toEqual([])
    await (sm as any).processEvent(managed, { type: 'steer_undelivered', ...payload })
    expect(managed.messageQueue).toEqual([])
    managed.isProcessing = false // Disarm the production Stop backstop timer.
  })

  it('starts a fresh turn message after the prior final response instead of reusing the preview', async () => {
    const sessionId = 'queue-ordering'
    const managed = buildSession(sessionId)
    const priorFinalTimestamp = Date.now()
    managed.messages = [
      {
        id: 'initial-user',
        role: 'user',
        content: 'question',
        timestamp: priorFinalTimestamp - 200,
      },
      {
        id: 'queued-user',
        role: 'user',
        content: 'follow up',
        timestamp: priorFinalTimestamp - 100,
        isQueued: true,
      },
      {
        id: 'prior-answer',
        role: 'assistant',
        content: 'complete answer',
        timestamp: priorFinalTimestamp,
      },
    ]
    managed.messageQueue.push({
      message: 'follow up',
      messageId: 'queued-user',
      optimisticMessageId: 'optimistic-user',
    })

    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    ;(sm as unknown as { lastTimestamp: number }).lastTimestamp = priorFinalTimestamp
    ;(sm as unknown as { persistSession: () => void }).persistSession = () => {}
    const sendMessage = mock(async (..._args: unknown[]) => {})
    ;(sm as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage

    ;(sm as unknown as { processNextQueuedMessage: (id: string) => void })
      .processNextQueuedMessage(sessionId)
    await new Promise<void>(resolve => setImmediate(resolve))

    // The preview is gone; the turn is a fresh message appended after the answer.
    expect(managed.messages.find(message => message.id === 'queued-user')).toBeUndefined()
    const turn = managed.messages[managed.messages.length - 1]!
    expect(turn.role).toBe('user')
    expect(turn.content).toBe('follow up')
    expect(turn.timestamp).toBeGreaterThan(priorFinalTimestamp)
    expect(managed.messages.filter(m => m.role === 'user' && m.content === 'follow up')).toHaveLength(1)

    // Every window drops the preview row...
    const cancellations = events.filter(event => event.type === 'queued_message_cancelled')
    expect(cancellations).toHaveLength(1)
    expect(cancellations[0]).toMatchObject({
      messageId: 'queued-user',
      optimisticMessageId: 'optimistic-user',
    })

    // ...then the turn is announced as a normal accepted message. No optimistic
    // id: the preview no longer exists, so the renderer must append it.
    const acceptedEvent = events.find(event => event.type === 'user_message')
    expect(acceptedEvent?.status).toBe('accepted')
    expect(acceptedEvent?.message.id).toBe(turn.id)
    expect(acceptedEvent?.optimisticMessageId).toBeUndefined()

    const stateEvent = events.find(event => event.type === 'queued_messages_state')
    expect(stateEvent?.order).toEqual([])

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const call = sendMessage.mock.calls[0] as unknown[]
    expect((call[4] as { optimisticMessageId?: string } | undefined)?.optimisticMessageId).toBeUndefined()
    expect(call[5]).toBe(turn.id)
  })
})
