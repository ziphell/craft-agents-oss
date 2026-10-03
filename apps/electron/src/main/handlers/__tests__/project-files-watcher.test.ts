import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RPC_CHANNELS } from '../../../shared/types'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

type HandlerFn = (ctx: { clientId: string }, ...args: any[]) => Promise<any> | any

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Stub workspace resolution BEFORE importing the handler so the watcher targets a
// temp directory instead of the user's real workspace config. Spread the real
// module so every other config export keeps working.
let tempRoot = ''
const realConfig = await import('@craft-agent/shared/config')
mock.module('@craft-agent/shared/config', () => ({
  ...realConfig,
  getWorkspaceByNameOrId: () => ({ id: 'ws-test', rootPath: tempRoot }),
}))

const { registerProjectFilesHandlers, cleanupProjectFilesWatchForClient } = await import(
  '@craft-agent/server-core/handlers/rpc'
)

describe('project files watcher', () => {
  const handlers = new Map<string, HandlerFn>()
  const pushed: Array<{ channel: string; target: any; args: any[] }> = []

  let projectsPath = ''

  beforeEach(() => {
    handlers.clear()
    pushed.length = 0

    tempRoot = mkdtempSync(join(tmpdir(), 'craft-project-files-watcher-'))
    projectsPath = join(tempRoot, 'projects')

    const server: RpcServer = {
      handle(channel, handler) {
        handlers.set(channel, handler as HandlerFn)
      },
      push(channel, target, ...args) {
        pushed.push({ channel, target, args })
      },
      async invokeClient() {
        return null
      },
      hasClientCapability() { return false },
      findClientsWithCapability() { return [] },
    }

    const deps = {
      platform: {
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      },
    } as unknown as HandlerDeps

    registerProjectFilesHandlers(server, deps)
  })

  afterEach(() => {
    cleanupProjectFilesWatchForClient('client-a')
    cleanupProjectFilesWatchForClient('client-b')
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('creates the projects folder and notifies only the watching client', async () => {
    const watch = handlers.get(RPC_CHANNELS.projects.WATCH_FILES)
    const unwatch = handlers.get(RPC_CHANNELS.projects.UNWATCH_FILES)
    expect(watch).toBeTruthy()
    expect(unwatch).toBeTruthy()

    await watch!({ clientId: 'client-a' })
    await wait(50)

    // The folder is a system-created container: WATCH must have created it.
    expect(existsSync(projectsPath)).toBe(true)

    writeFileSync(join(projectsPath, 'A-001-btn.css'), '.btn{}')
    await wait(300)

    const aEvents = pushed.filter((evt) => evt.target?.to === 'client' && evt.target?.clientId === 'client-a')
    const bEvents = pushed.filter((evt) => evt.target?.clientId === 'client-b')

    expect(aEvents.some((evt) => evt.channel === RPC_CHANNELS.projects.FILES_CHANGED && evt.args[0] === 'ws-test')).toBe(true)
    expect(bEvents.length).toBe(0)

    pushed.length = 0
    await unwatch!({ clientId: 'client-a' })

    writeFileSync(join(projectsPath, 'A-002-btn.css'), '.btn{}')
    await wait(300)

    expect(pushed.length).toBe(0)
  })

  it('disconnect cleanup removes the watcher and prevents further events', async () => {
    const watch = handlers.get(RPC_CHANNELS.projects.WATCH_FILES)
    expect(watch).toBeTruthy()

    await watch!({ clientId: 'client-a' })
    await wait(50)

    cleanupProjectFilesWatchForClient('client-a')
    pushed.length = 0

    writeFileSync(join(projectsPath, 'A-003-after-cleanup.css'), '.btn{}')
    await wait(300)

    expect(pushed.length).toBe(0)
  })
})
