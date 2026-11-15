import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'

/**
 * Craft Bot's handlers, tested for the things that would be expensive to get wrong:
 * the conversation is per workspace and created exactly once, a task really is a child session,
 * a result is the session's own last answer, and a grant lands on the target.
 */

const WORKSPACES: Record<string, { id: string; name: string; slug: string; rootPath: string }> = {
  'ws-main': { id: 'ws-main', name: 'Main', slug: 'main', rootPath: '/tmp/main' },
  'ws-open': { id: 'ws-open', name: 'Open', slug: 'open', rootPath: '/tmp/open' },
  'ws-closed': { id: 'ws-closed', name: 'Closed', slug: 'closed', rootPath: '/tmp/closed' },
}

const realConfig = await import('@craft-agent/shared/config')
mock.module('@craft-agent/shared/config', () => ({
  ...realConfig,
  getWorkspaceByNameOrId: (nameOrId: string) => WORKSPACES[nameOrId] ?? null,
}))

const realWorkspaces = await import('@craft-agent/shared/workspaces')
mock.module('@craft-agent/shared/workspaces', () => ({
  ...realWorkspaces,
  loadWorkspaceConfig: (rootPath: string) => ({ id: 'x', name: 'x', slug: 'x', rootPath }),
}))

// Task graphs: `bot:tasks` matches them by `task.yaml`'s `created_by`, so the fixture is a tiny
// in-memory tasks directory rather than a real scan.
const TASK_SPECS: Record<string, Array<Record<string, unknown>>> = {}
const realTasks = await import('@craft-agent/shared/tasks')
mock.module('@craft-agent/shared/tasks', () => ({
  ...realTasks,
  listTaskSlugs: (root: string) => (TASK_SPECS[root] ?? []).map(t => t.id as string),
  loadTaskSpec: (root: string, slug: string) => {
    const spec = (TASK_SPECS[root] ?? []).find(t => t.id === slug)
    return spec ? { valid: true, errors: [], warnings: [], spec } : null
  },
}))

// The creations index is a scan of the filesystem; this test is about what the panel is told, so it
// answers with a fixed snapshot and counts how often it was asked.
let scanCount = 0
const CREATIONS_SNAPSHOT = {
  creations: [
    { path: '/tmp/notes.md', title: 'notes.md', format: 'md', exists: true, origins: [{ sessionId: 'child' }] },
    { path: '/tmp/spec.pdf', title: 'spec.pdf', format: 'pdf', exists: true, origins: [{ sessionId: 'child' }] },
    { path: '/tmp/other.md', title: 'other.md', format: 'md', exists: true, origins: [{ sessionId: 'someone-else' }] },
  ],
}
mock.module('@craft-agent/shared/creations', () => ({
  createCreationsCache: () => ({ version: 5, sessions: new Map() }),
  refreshCreations: async () => {
    scanCount++
    return CREATIONS_SNAPSHOT
  },
}))

const { RPC_CHANNELS } = await import('@craft-agent/shared/protocol')
const { registerBotHandlers } = await import('./bot.ts')

function ctx(workspaceId = 'ws-main'): RequestContext {
  return { clientId: 'c1', workspaceId, webContentsId: 1 }
}

interface Created {
  workspaceId: string
  options: Record<string, unknown>
}

function createHarness(existing: Array<Record<string, unknown>> = []) {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
    hasClientCapability() {
      return false
    },
    findClientsWithCapability() {
      return []
    },
  }

  const created: Created[] = []
  const sent: Array<{ sessionId: string; message: string }> = []
  const hiddenCalls: Array<{ sessionId: string; hidden: boolean }> = []
  /** How often a conversation turn was cancelled — a graph must never take this path. */
  let cancelledCalls = 0
  const sessions = [...existing]

  const sessionManager = {
    getSessions: (workspaceId?: string) =>
      workspaceId ? sessions.filter(s => s.workspaceId === workspaceId) : sessions,
    getSession: async (id: string) => sessions.find(s => s.id === id) ?? null,
    createSession: async (workspaceId: string, options: Record<string, unknown>) => {
      const session = {
        id: `s-${created.length + 1}`,
        workspaceId,
        workspaceName: WORKSPACES[workspaceId]?.name ?? workspaceId,
        createdAt: 1000 + created.length,
        isProcessing: false,
        ...options,
      }
      created.push({ workspaceId, options })
      sessions.push(session)
      return session
    },
    sendMessage: async (sessionId: string, message: string) => {
      sent.push({ sessionId, message })
    },
    cancelProcessing: async () => {
      cancelledCalls++
    },
    setSessionHidden: async (sessionId: string, hidden: boolean) => {
      hiddenCalls.push({ sessionId, hidden })
      const session = sessions.find(s => s.id === sessionId)
      if (session) session.hidden = hidden
    },
  }

  registerBotHandlers(server, { sessionManager } as unknown as HandlerDeps)

  return {
    created,
    sent,
    hiddenCalls,
    sessions,
    cancelledCalls: () => cancelledCalls,
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)!(ctx(), ...args),
    callFrom: (workspaceId: string, channel: string, ...args: unknown[]) =>
      handlers.get(channel)!(ctx(workspaceId), ...args),
  }
}

/** A message list shaped like the one `getSession()` answers with. */
function messages(...items: Array<{ role: string; content: string; isThinking?: boolean }>) {
  return items.map((m, i) => ({ id: `m${i}`, timestamp: i, ...m }))
}

beforeEach(() => {
  scanCount = 0
})

describe('bot:session', () => {
  it('belongs to the window’s workspace and inherits its settings', async () => {
    const h = createHarness()
    const session = await h.call(RPC_CHANNELS.bot.SESSION)

    expect(session).toMatchObject({ workspaceId: 'ws-main', workspaceName: 'Main' })
    expect(h.created).toHaveLength(1)
    expect(h.created[0].workspaceId).toBe('ws-main')
    // Hidden from the session list: the assistant is not one of your tasks.
    expect(h.created[0].options).toMatchObject({ role: 'bot', permissionMode: 'ask', hidden: true })
  })

  it('reuses the newest assistant conversation in that workspace', async () => {
    const h = createHarness([
      { id: 'older', workspaceId: 'ws-main', role: 'bot', createdAt: 1, lastMessageAt: 1 },
      { id: 'newer', workspaceId: 'ws-main', role: 'bot', createdAt: 2, lastMessageAt: 9 },
      { id: 'ordinary', workspaceId: 'ws-main', createdAt: 3, lastMessageAt: 20 },
    ])
    expect(await h.call(RPC_CHANNELS.bot.SESSION)).toMatchObject({ sessionId: 'newer' })
    expect(h.created).toHaveLength(0)
    // An older conversation created before the role was hidden is put back on first open, once.
    expect(h.hiddenCalls).toEqual([{ sessionId: 'newer', hidden: true }])
  })

  it('creates exactly one when the panel asks twice at once', async () => {
    // The panel opens with an effect that can run twice; both calls used to create a session.
    const h = createHarness()
    const [a, b] = await Promise.all([
      h.call(RPC_CHANNELS.bot.SESSION),
      h.call(RPC_CHANNELS.bot.SESSION),
    ])
    expect(a).toMatchObject({ sessionId: b.sessionId })
    expect(h.created).toHaveLength(1)
  })

  it('answers per workspace, so two windows do not share one assistant', async () => {
    const h = createHarness()
    const main = await h.call(RPC_CHANNELS.bot.SESSION)
    const other = await h.callFrom('ws-open', RPC_CHANNELS.bot.SESSION)
    expect(main.workspaceId).toBe('ws-main')
    expect(other.workspaceId).toBe('ws-open')
    expect(main.sessionId).not.toBe(other.sessionId)
  })

  it('refuses a window with no workspace rather than guessing one', async () => {
    const h = createHarness()
    const handlers = h.call
    expect(handlers).toBeDefined()
    await expect(
      h.callFrom('', RPC_CHANNELS.bot.SESSION),
    ).rejects.toThrow(/needs a workspace/i)
    expect(h.created).toHaveLength(0)
  })
})

describe('bot:tasks', () => {
  it('lists the children of this conversation, across workspaces, and nothing else', async () => {
    const h = createHarness([
      { id: 'bot-1', workspaceId: 'ws-main', role: 'bot' },
      { id: 'child-open', workspaceId: 'ws-open', parentSessionId: 'bot-1', createdAt: 10, isProcessing: true },
      { id: 'child-other', workspaceId: 'ws-closed', workspaceName: 'Closed', parentSessionId: 'bot-1', createdAt: 20, isProcessing: false },
      { id: 'someone-else', workspaceId: 'ws-closed', createdAt: 30 },
    ])

    const tasks = await h.call(RPC_CHANNELS.bot.TASKS, 'bot-1')

    expect(tasks.map((t: { sessionId: string }) => t.sessionId)).toEqual(['child-other', 'child-open'])
    expect(tasks[0].workspaceName).toBe('Closed')
    expect(tasks[1].state).toBe('running')
    expect(tasks.every((t: { kind: string }) => t.kind === 'session')).toBe(true)
  })

  it('answers nothing when it is not told which conversation', async () => {
    const h = createHarness([{ id: 'child', workspaceId: 'ws-open', parentSessionId: 'bot-1' }])
    expect(await h.call(RPC_CHANNELS.bot.TASKS)).toEqual([])
  })

  it('adds the task graphs this conversation created, and only those', async () => {
    TASK_SPECS['/tmp/main'] = [
      { id: 'mine', title: 'Mine', created_by: 'bot-1' },
      { id: 'theirs', title: 'Theirs', created_by: 'someone-else' },
      { id: 'by-hand', title: 'By hand' },
    ]
    const h = createHarness([
      { id: 'bot-1', workspaceId: 'ws-main', role: 'bot' },
      { id: 'orch-mine', workspaceId: 'ws-main', taskSlug: 'mine', createdAt: 5 },
      { id: 'orch-theirs', workspaceId: 'ws-main', taskSlug: 'theirs', createdAt: 6 },
      { id: 'orch-hand', workspaceId: 'ws-main', taskSlug: 'by-hand', createdAt: 7 },
    ])

    const tasks = await h.call(RPC_CHANNELS.bot.TASKS, 'bot-1')
    expect(tasks.map((t: { slug?: string }) => t.slug)).toEqual(['mine'])
    expect(tasks[0]).toMatchObject({ kind: 'task', sessionId: 'orch-mine', name: 'Mine', state: 'idle' })
    TASK_SPECS['/tmp/main'] = []
  })

  it('skips a graph whose tile is gone, rather than offering a dead end', async () => {
    TASK_SPECS['/tmp/main'] = [{ id: 'orphan', title: 'Orphan', created_by: 'bot-1' }]
    const h = createHarness([{ id: 'bot-1', workspaceId: 'ws-main', role: 'bot' }])
    expect(await h.call(RPC_CHANNELS.bot.TASKS, 'bot-1')).toEqual([])
    TASK_SPECS['/tmp/main'] = []
  })

  it('stops a graph by its run, not by cancelling a conversation turn', async () => {
    const h = createHarness([
      { id: 'orch-1', workspaceId: 'ws-main', taskSlug: 'mine' },
    ])
    await h.call(RPC_CHANNELS.bot.CANCEL, 'orch-1', 'mine', 'run-1')
    expect(h.cancelledCalls()).toBe(0)
    // A conversation still takes the old path.
    await h.call(RPC_CHANNELS.bot.CANCEL, 'orch-1')
    expect(h.cancelledCalls()).toBe(1)
  })
})

describe('bot:result', () => {  it('answers the last thing the session said, skipping thinking', async () => {
    const h = createHarness([
      {
        id: 'child',
        workspaceId: 'ws-open',
        parentSessionId: 'bot-1',
        isProcessing: false,
        messages: messages(
          { role: 'user', content: 'go' },
          { role: 'assistant', content: 'first answer' },
          { role: 'assistant', content: 'reasoning…', isThinking: true },
        ),
      },
    ])

    const result = await h.call(RPC_CHANNELS.bot.RESULT, 'child')
    expect(result.lastText).toBe('first answer')
    expect(result.isProcessing).toBe(false)
  })
})

describe('bot:result artifacts', () => {
  const child = {
    id: 'child',
    workspaceId: 'ws-open',
    parentSessionId: 'bot-1',
    isProcessing: false,
    lastMessageAt: 100,
    messages: messages({ role: 'assistant', content: 'wrote two files' }),
  }

  it('lists what that session wrote, and nothing another session wrote', async () => {
    const h = createHarness([child, { id: 'bot-1', workspaceId: 'ws-main', role: 'bot' }])
    const result = await h.call(RPC_CHANNELS.bot.RESULT, 'child')
    expect(result.artifacts?.map((a: { title: string }) => a.title)).toEqual(['notes.md', 'spec.pdf'])

    // The cache is keyed by the task's own `lastMessageAt`, so a second read of a card that has not
    // moved is a map lookup rather than another scan of the workspace.
    await h.call(RPC_CHANNELS.bot.RESULT, 'child')
    expect(scanCount).toBe(1)
  })
})
