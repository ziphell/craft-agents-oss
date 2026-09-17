import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// `setSessionConnection` is the *explicit* switch path (user picked a model under
// another connection). Two rules are locked here:
//   1. It works after messages have been sent — the old "Cannot change connection
//      after session has started" guard trapped users in a provider for the rest
//      of a conversation.
//   2. It never touches the backend of a running turn: a mid-turn switch is
//      recorded and applied on the next send; an idle switch tears the old
//      provider's runtime down so the next send rebuilds from the new connection.

const CONNECTIONS: Record<string, unknown> = {
  'slug-A': { slug: 'slug-A', name: 'A', providerType: 'pi', models: ['pi/model-a'] },
  'slug-B': { slug: 'slug-B', name: 'B', providerType: 'pi', models: ['pi/model-b'] },
}

const realStorage = await import('@craft-agent/shared/config/storage')
mock.module('@craft-agent/shared/config/storage', () => ({
  ...realStorage,
  getLlmConnection: (slug: string) => CONNECTIONS[slug] ?? null,
}))

const { SessionManager, createManagedSession } = await import('./SessionManager.ts')

interface AgentStub {
  isProcessing: () => boolean
  dispose: () => void
  disposeForRestart?: () => Promise<void>
  setModel: (model: string) => void
}

function createAgentStub(isProcessing: boolean): AgentStub {
  return {
    isProcessing: () => isProcessing,
    dispose: () => { /* no-op */ },
    setModel: jest.fn(),
  }
}

describe('setSessionConnection (explicit switch)', () => {
  let tmpRoot: string
  let sm: InstanceType<typeof SessionManager>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-setconn-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function injectSession(
    id: string,
    opts: { llmConnection: string; agent?: AgentStub | null; isProcessing?: boolean; withMessages?: boolean },
  ) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: id, llmConnection: opts.llmConnection },
      workspace as never,
      { messagesLoaded: true },
    ) as unknown as {
      agent: AgentStub | null
      llmConnection?: string
      connectionLocked?: boolean
      isProcessing: boolean
      messages: unknown[]
      backendRuntimeSignature?: string
      backendRestartSignature?: string
    }
    if (opts.withMessages) {
      managed.messages.push({ id: 'm1', role: 'user', content: 'hi', timestamp: Date.now() })
    }
    managed.agent = opts.agent ?? null
    managed.isProcessing = opts.isProcessing ?? false
    // Stale signatures so the refresh helper actually reaches its drift branch
    // against the real (disk-resolved) config.
    managed.backendRuntimeSignature = '__stale_runtime__'
    managed.backendRestartSignature = '__stale_restart__'
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  it('switches a session that already has messages (no "session has started" refusal)', async () => {
    const managed = injectSession('with-messages', { llmConnection: 'slug-A', withMessages: true })

    await sm.setSessionConnection('with-messages', 'slug-B')

    expect(managed.llmConnection).toBe('slug-B')
    expect(managed.connectionLocked).toBe(true)
  })

  it('records a mid-turn switch without tearing down the running turn', async () => {
    const agent = createAgentStub(true)
    const managed = injectSession('mid-turn', {
      llmConnection: 'slug-A',
      agent,
      isProcessing: true,
      withMessages: true,
    })

    await sm.setSessionConnection('mid-turn', 'slug-B')

    expect(managed.llmConnection).toBe('slug-B')
    // The turn that is generating must finish on the provider it started with.
    expect(managed.agent).toBe(agent)
  })

  it('tears down the idle runtime so the next send rebuilds from the new connection', async () => {
    const agent = createAgentStub(false)
    const managed = injectSession('idle', { llmConnection: 'slug-A', agent, withMessages: true })

    await sm.setSessionConnection('idle', 'slug-B')

    expect(managed.llmConnection).toBe('slug-B')
    expect(managed.agent).toBeNull()
  })

  it('is a no-op on the runtime when the connection is unchanged', async () => {
    const agent = createAgentStub(false)
    const managed = injectSession('same-slug', { llmConnection: 'slug-A', agent })

    await sm.setSessionConnection('same-slug', 'slug-A')

    expect(managed.agent).toBe(agent)
  })

  it('rejects an unknown connection', async () => {
    injectSession('unknown', { llmConnection: 'slug-A' })

    await expect(sm.setSessionConnection('unknown', 'nope')).rejects.toThrow(/not found/)
  })
})

describe('updateSessionModel (model picks)', () => {
  let tmpRoot: string
  let sm: InstanceType<typeof SessionManager>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-setmodel-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function injectSession(
    id: string,
    opts: { llmConnection: string; agent?: AgentStub | null; isProcessing?: boolean },
  ) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: id, llmConnection: opts.llmConnection },
      workspace as never,
      { messagesLoaded: true },
    ) as unknown as {
      agent: AgentStub | null
      llmConnection?: string
      connectionLocked?: boolean
      isProcessing: boolean
      model?: string
    }
    managed.agent = opts.agent ?? null
    managed.isProcessing = opts.isProcessing ?? false
    managed.connectionLocked = true
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  it('pushes the model to the live agent even while a turn is generating (the turn already froze its own model)', async () => {
    const agent = createAgentStub(true)
    const managed = injectSession('model-mid-turn', {
      llmConnection: 'slug-A',
      agent,
      isProcessing: true,
    })

    await sm.updateSessionModel('model-mid-turn', 'ws_test', 'pi/model-a2', 'slug-A')

    expect(agent.setModel).toHaveBeenCalledWith('pi/model-a2')
    expect(managed.model).toBe('pi/model-a2')
  })

  it('pushes an idle model change to the live agent', async () => {
    const agent = createAgentStub(false)
    injectSession('model-idle', { llmConnection: 'slug-A', agent })

    await sm.updateSessionModel('model-idle', 'ws_test', 'pi/model-a2', 'slug-A')

    expect(agent.setModel).toHaveBeenCalledTimes(1)
    expect(agent.setModel).toHaveBeenCalledWith('pi/model-a2')
  })

  it('never pushes a model that belongs to another connection onto the current agent', async () => {
    const agent = createAgentStub(false)
    const managed = injectSession('model-other-connection', { llmConnection: 'slug-A', agent })

    await sm.updateSessionModel('model-other-connection', 'ws_test', 'pi/model-b', 'slug-B')

    expect(agent.setModel).not.toHaveBeenCalled()
    // The pick is recorded; the connection switch + next send apply it.
    expect(managed.model).toBe('pi/model-b')
  })
})
