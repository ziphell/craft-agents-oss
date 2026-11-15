import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'

// The CREATE handler resolves the workspace through the shared config barrel. Stand the workspace
// up on a tmp root (set per test) and mock the lookup — the handler never touches other config APIs
// on the create path, so a spread of the real module keeps everything else intact.
let workspaceRoot = ''
const realConfig = await import('@craft-agent/shared/config')
mock.module('@craft-agent/shared/config', () => ({
  ...realConfig,
  getWorkspaceByNameOrId: (nameOrId: string) => ({
    id: nameOrId,
    name: 'ws',
    slug: 'ws',
    rootPath: workspaceRoot,
  }),
}))

const { RPC_CHANNELS } = await import('@craft-agent/shared/protocol')
const { loadTaskSpec } = await import('@craft-agent/shared/tasks')
const { registerTasksHandlers } = await import('./tasks.ts')

function ctx(): RequestContext {
  return { clientId: 'c1', workspaceId: 'ws-1', webContentsId: 1 }
}

/**
 * Register the tasks handlers on a stub server. `sessionManager` is the minimum the create path
 * needs: mint the orchestrator (fresh path) or bind an existing tile (edit path), then apply the
 * reserved label.
 */
function createHarness() {
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
  const sessionManager = {
    createSession: async (_workspaceId: string, options: Record<string, unknown>) => ({ id: 'orch-1', ...options }),
    bindExistingSessionToTask: async () => true,
    applyTaskLabel: async () => ({ labelId: 'task' }),
    setSessionSources: async () => {},
  }
  registerTasksHandlers(server, { sessionManager } as unknown as HandlerDeps)
  const create = handlers.get(RPC_CHANNELS.tasks.CREATE)
  if (!create) throw new Error('tasks:create handler not registered')
  return create
}

const specYaml = (id: string) =>
  JSON.stringify({ id, title: `Task ${id}`, goal: 'Ship it', nodes: [{ id: 'n1', prompt: 'do it' }] })

describe('tasks:create origin plan (from)', () => {
  let create: HandlerFn

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'tasks-handler-'))
    create = createHarness()
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('records the plan a task was generated from as its spec `from`', async () => {
    const planPath = join(tmpdir(), 'cart.plan.md')
    const res = await create(ctx(), 'ws-1', { yaml: specYaml('from-task'), planPath })
    expect(res.slug).toBe('from-task')
    // Round-trips through storage: written portable, read back absolute.
    expect(loadTaskSpec(workspaceRoot, 'from-task')?.spec?.from).toBe(planPath)
  })

  it('writes no `from` when the caller supplies no plan (no default, no empty key)', async () => {
    await create(ctx(), 'ws-1', { yaml: specYaml('plain-task') })
    const spec = loadTaskSpec(workspaceRoot, 'plain-task')?.spec
    expect(spec?.from).toBeUndefined()
    expect(spec && 'from' in spec).toBe(false)
  })

  it('keeps the origin plan across an edit-mode save (attach path re-sends it)', async () => {
    const planPath = join(tmpdir(), 'cart.plan.md')
    await create(ctx(), 'ws-1', { yaml: specYaml('edit-task'), planPath })
    // An edit save re-sends the same planPath (the editor carries the loaded `from` back); the
    // attach path must persist it again, not drop it.
    await create(ctx(), 'ws-1', {
      yaml: specYaml('edit-task'),
      planPath,
      attachToExistingSession: 'sess-edit',
    })
    expect(loadTaskSpec(workspaceRoot, 'edit-task')?.spec?.from).toBe(planPath)
  })
})
