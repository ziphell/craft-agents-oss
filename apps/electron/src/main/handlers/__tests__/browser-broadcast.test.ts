/**
 * Tests for browser handler broadcast + LIST.
 *
 * A browser window belongs to the workspace's own server now, so `LIST` is scoped to the
 * workspace the connection speaks for: a remote window asks its hub, a local window asks this
 * machine, and neither sees the other's windows. Broadcast events stay `to: "all"` — a state
 * change is small and the renderer still filters the strip by workspace (a device-driven pane
 * on this machine is filed under `hub:<connectionId>:<workspaceId>`).
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { BrowserInstanceInfo } from '@craft-agent/shared/protocol'

mock.module('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {} },
}))

type HandlerFn = (...args: unknown[]) => unknown
type Push = { channel: string; target: unknown; args: unknown[] }

interface Recorder {
  server: RpcServer
  handlers: Map<string, HandlerFn>
  pushes: Push[]
}

function makeServer(): Recorder {
  const handlers = new Map<string, HandlerFn>()
  const pushes: Push[] = []
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler as HandlerFn)
    },
    push(channel, target, ...args) {
      pushes.push({ channel, target, args })
    },
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  return { server, handlers, pushes }
}

function makeInstance(id: string, overrides?: Partial<BrowserInstanceInfo>): BrowserInstanceInfo {
  return {
    id,
    url: 'https://example.com',
    title: 'Example',
    favicon: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isVisible: true,
    agentControlActive: false,
    themeColor: null,
    workspaceId: null,
    ...overrides,
  }
}

function makeDeps(opts: {
  instances: BrowserInstanceInfo[]
  captureStateCb?: (cb: (info: BrowserInstanceInfo) => void) => void
  captureRemovedCb?: (cb: (id: string) => void) => void
  captureInteractedCb?: (cb: (id: string) => void) => void
}): HandlerDeps {
  return {
    sessionManager: {} as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: false,
      logger: console,
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
    windowManager: {} as HandlerDeps['windowManager'],
    browserPaneManager: {
      listInstances: () => opts.instances,
      onStateChange: (cb: (info: BrowserInstanceInfo) => void) => opts.captureStateCb?.(cb),
      onRemoved: (cb: (id: string) => void) => opts.captureRemovedCb?.(cb),
      onInteracted: (cb: (id: string) => void) => opts.captureInteractedCb?.(cb),
      setViewStreamEndedHandler: () => {},
    } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
  }
}

describe('browser handler — workspace filtering', () => {
  let recorder: Recorder

  beforeEach(() => {
    recorder = makeServer()
  })

  describe('STATE_CHANGED broadcast target', () => {
    it('always broadcasts to all renderers (workspace-aware-filtering happens in the renderer)', async () => {
      let captured: ((info: BrowserInstanceInfo) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureStateCb: (cb) => { captured = cb },
        }),
      )

      expect(captured).not.toBeNull()
      // Workspace-stamped instance broadcasts to all (renderer will filter).
      captured!(makeInstance('b-ws', { workspaceId: 'ws-1' }))
      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })

      // Unbound instance also broadcasts to all.
      captured!(makeInstance('b-unbound', { workspaceId: null }))
      expect(recorder.pushes).toHaveLength(2)
      expect(recorder.pushes[1].target).toEqual({ to: 'all' })
    })
  })

  describe('REMOVED / INTERACTED stay broadcast-to-all', () => {
    it('REMOVED uses { to: "all" } even when the entry was workspace-scoped', async () => {
      let captured: ((id: string) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureRemovedCb: (cb) => { captured = cb },
        }),
      )

      captured!('b-removed')

      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })
      // Payload is id-only — workspaces that never saw the entry simply no-op.
      expect(recorder.pushes[0].args).toEqual(['b-removed'])
    })

    it('INTERACTED uses { to: "all" }', async () => {
      let captured: ((id: string) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureInteractedCb: (cb) => { captured = cb },
        }),
      )

      captured!('b-interacted')

      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })
    })
  })

  describe('CREATE adds a tab when the caller asks for one', () => {
    function callCreate(input: unknown): unknown {
      const createChannel = Array.from(recorder.handlers.keys())
        .find((ch) => ch.endsWith(':create') && ch.includes('browser'))
      if (!createChannel) throw new Error('CREATE handler not registered')
      return recorder.handlers.get(createChannel)!({ clientId: 'c1', workspaceId: null, webContentsId: null }, input)
    }

    // "New tab" from the app's menu: no url and no identity to give a tab, so it has
    // nothing to say except that it wants one — and it is *a* tab, not one more tab,
    // because the window may not be up yet and a window that was not up already holds
    // the blank tab being asked for. Asking in two steps (create the window, then add
    // a tab to it) is what opened two blank tabs.
    it('asks for a tab to use, not for one more tab, when it has no url', async () => {
      const calls: string[] = []
      const { registerBrowserHandlers } = await import('../browser')
      const deps = makeDeps({ instances: [] })
      const manager = deps.browserPaneManager as unknown as Record<string, unknown>
      manager.createForSession = () => {
        calls.push('window')
        return 'browser-1'
      }
      manager.createTab = (id: string, options: unknown) => {
        calls.push(`tab:${id}:${JSON.stringify(options)}`)
        return 'tab-1'
      }
      registerBrowserHandlers(recorder.server, deps)

      callCreate({ show: true, newTab: true })

      expect(calls).toEqual(['window', 'tab:browser-1:{"activate":true,"reuseUntouchedWindow":true}'])
    })

    // The other half of the same rule, and the bug a person found: a window that is already
    // up may be somebody's, so "New tab" there must mean one **more** tab. Whether it does is
    // the browser side's call — it is the one that knows whether the person has ever seen the
    // window (`hasBeenShown`) — so the handler always asks for *a* tab and lets that rule run.
    it('asks for a tab to use, and lets the browser side decide about a blank one', async () => {
      const calls: string[] = []
      const { registerBrowserHandlers } = await import('../browser')
      const deps = makeDeps({ instances: [makeInstance('browser-1', { workspaceId: null })] })
      const manager = deps.browserPaneManager as unknown as Record<string, unknown>
      manager.createForSession = () => {
        calls.push('window')
        return 'browser-1'
      }
      manager.createTab = (id: string, options: unknown) => {
        calls.push(`tab:${id}:${JSON.stringify(options)}`)
        return 'tab-1'
      }
      registerBrowserHandlers(recorder.server, deps)

      callCreate({ show: true, newTab: true })

      expect(calls).toEqual(['window', 'tab:browser-1:{"activate":true,"reuseUntouchedWindow":true}'])
    })

    // A create that pins its own window id and asks for no new tab makes only that window.
    it('makes only the window when the caller pinned an id and asked for no tab', async () => {
      const calls: string[] = []
      const { registerBrowserHandlers } = await import('../browser')
      const deps = makeDeps({ instances: [] })
      const manager = deps.browserPaneManager as unknown as Record<string, unknown>
      manager.createInstance = (id: string) => {
        calls.push(`window:${id}`)
        return id
      }
      manager.createTab = () => {
        calls.push('tab')
        return 'tab-1'
      }
      registerBrowserHandlers(recorder.server, deps)

      callCreate({ id: 'plain-1', show: true })

      expect(calls).toEqual(['window:plain-1'])
    })
  })

  describe('TAB_ACTION', () => {
    function callTabAction(input: unknown): void {
      const channel = Array.from(recorder.handlers.keys())
        .find((ch) => ch.endsWith(':tab-action') && ch.includes('browser'))
      if (!channel) throw new Error('TAB_ACTION handler not registered')
      recorder.handlers.get(channel)!({ clientId: 'c1', workspaceId: null, webContentsId: null }, input)
    }

    function makeManager(calls: string[]): Record<string, unknown> {
      return {
        activateTab: (instanceId: string, tabId: string) => { calls.push(`activate:${instanceId}:${tabId}`) },
        closeTab: (instanceId: string, tabId: string) => { calls.push(`close:${instanceId}:${tabId}`) },
        createTab: (instanceId: string, options?: unknown) => {
          calls.push(`new:${instanceId}:${JSON.stringify(options)}`)
          return 'tab-2'
        },
      }
    }

    // One channel, three actions — the three buttons the badge strip draws sit
    // together and address the same window.
    it('routes each action to the manager, naming the window', async () => {
      const calls: string[] = []
      const { registerBrowserHandlers } = await import('../browser')
      const deps = makeDeps({ instances: [] })
      Object.assign(deps.browserPaneManager as unknown as Record<string, unknown>, makeManager(calls))
      registerBrowserHandlers(recorder.server, deps)

      callTabAction({ instanceId: 'browser-1', action: 'activate', tabId: 'tab-1' })
      callTabAction({ instanceId: 'browser-1', action: 'close', tabId: 'tab-2' })
      callTabAction({ instanceId: 'browser-1', action: 'new' })

      expect(calls).toEqual([
        'activate:browser-1:tab-1',
        'close:browser-1:tab-2',
        // A tab added from the main window is a person's, which is what "no session
        // asked for it" means — stated by leaving `belongsTo` out.
        'new:browser-1:{"activate":true}',
      ])
    })

    // The target is the whole point: an action with no window, or a tab action
    // with no tab, would otherwise land on whatever happened to be in front.
    it('does nothing when the target is not named', async () => {
      const calls: string[] = []
      const { registerBrowserHandlers } = await import('../browser')
      const deps = makeDeps({ instances: [] })
      Object.assign(deps.browserPaneManager as unknown as Record<string, unknown>, makeManager(calls))
      registerBrowserHandlers(recorder.server, deps)

      callTabAction({ action: 'new' })
      callTabAction({ instanceId: 'browser-1', action: 'activate' })
      callTabAction({ instanceId: 'browser-1', action: 'close' })
      callTabAction(undefined)

      expect(calls).toEqual([])
    })
  })

  describe('LIST handler', () => {
    function callListHandler(workspaceId: string | null): BrowserInstanceInfo[] {
      const listChannel = Array.from(recorder.handlers.keys())
        .find((ch) => ch.endsWith(':list') && ch.includes('browser'))
      if (!listChannel) throw new Error('LIST handler not registered')
      const handler = recorder.handlers.get(listChannel)!
      return handler({ clientId: 'c1', workspaceId, webContentsId: null }) as BrowserInstanceInfo[]
    }

    it('asks the manager for the workspace this connection speaks for', async () => {
      const asked: Array<string | null | undefined> = []
      const { registerBrowserHandlers } = await import('../browser')
      const deps = makeDeps({ instances: [] })
      ;(deps.browserPaneManager as unknown as Record<string, unknown>).listInstances =
        (workspaceId?: string | null) => {
          asked.push(workspaceId)
          return []
        }
      registerBrowserHandlers(recorder.server, deps)

      // Registration itself may prime the manager; the calls under test are the ones after it.
      asked.length = 0
      callListHandler('ws-1')
      callListHandler(null)

      expect(asked).toEqual(['ws-1', null])
    })

    it('answers with the workspace windows and the unbound ones', async () => {
      const instances = [
        makeInstance('local-tab', { workspaceId: 'local-ws' }),
        makeInstance('other-tab', { workspaceId: 'other-ws' }),
        makeInstance('unbound', { workspaceId: null }),
      ]
      const { registerBrowserHandlers } = await import('../browser')
      const deps = makeDeps({ instances })
      ;(deps.browserPaneManager as unknown as Record<string, unknown>).listInstances =
        (workspaceId?: string | null) => (workspaceId
          ? instances.filter((i) => !i.workspaceId || i.workspaceId === workspaceId)
          : instances)
      registerBrowserHandlers(recorder.server, deps)

      expect(callListHandler('local-ws').map((i) => i.id).sort()).toEqual(['local-tab', 'unbound'])
      expect(callListHandler(null).map((i) => i.id).sort()).toEqual([
        'local-tab',
        'other-tab',
        'unbound',
      ])
    })
  })
})

describe('browser handler — the profile a link opens in', () => {
  /**
   * A link clicked in a conversation belongs to that conversation: it must land in the
   * window its `browser_tool` commands work in, whose profile it is. A link with no
   * conversation behind it (sidebar, settings) keeps the workspace's default profile.
   */
  async function openUrl(incoming: unknown[]): Promise<string[]> {
    const calls: string[] = []
    const recorder = makeServer()
    const { registerBrowserHandlers } = await import('../browser')
    const deps = makeDeps({ instances: [] })
    registerBrowserHandlers(recorder.server, {
      ...deps,
      browserPaneManager: {
        listInstances: () => [],
        onStateChange: () => {},
        onRemoved: () => {},
        onInteracted: () => {},
        setViewStreamEndedHandler: () => {},
        createForSession: (sessionId: string | null) => {
          calls.push(sessionId ?? 'no-session')
          return 'instance-1'
        },
        createTab: () => 'tab-1',
        focus: () => {},
        navigate: async () => ({ url: 'https://example.com', title: 'Example' }),
        getActiveTabId: () => 'tab-1',
      } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
    })

    await recorder.handlers.get('browser-pane:open-url')!({ workspaceId: 'ws-1' }, 'https://example.com', ...incoming)
    return calls
  }

  it("opens a link from a conversation in that conversation's window", async () => {
    expect(await openUrl(['sess-1'])).toEqual(['sess-1'])
  })

  it('falls back to the workspace window when no conversation is behind the click', async () => {
    expect(await openUrl([])).toEqual(['no-session'])
  })
})

describe('browser handler — a page opened for a remote client', () => {
  /**
   * A person at a thin client is not in front of the hub's screen: the window must not pop up
   * there, and the caller needs the tab back so its viewer can watch it.
   */
  it('opens on the server without showing a window there, and names the tab to watch', async () => {
    const shows: boolean[] = []
    let focused = 0
    const recorder = makeServer()
    recorder.server.isLocalClient = () => false

    const { registerBrowserHandlers } = await import('../browser')
    const deps = makeDeps({ instances: [] })
    registerBrowserHandlers(recorder.server, {
      ...deps,
      browserPaneManager: {
        listInstances: () => [],
        onStateChange: () => {},
        onRemoved: () => {},
        onInteracted: () => {},
        setViewStreamEndedHandler: () => {},
        createForSession: (_sessionId: string | null, options?: { show?: boolean }) => {
          shows.push(!!options?.show)
          return 'instance-1'
        },
        createTab: () => 'tab-1',
        focus: () => { focused += 1 },
        navigate: async () => ({ url: 'https://example.com', title: 'Example' }),
        getActiveTabId: () => 'tab-1',
      } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
    })

    const opened = await recorder.handlers.get('browser-pane:open-url')!(
      { clientId: 'thin-client', workspaceId: 'ws-1' },
      'https://example.com',
    )

    expect(opened).toEqual({ instanceId: 'instance-1', tabId: 'tab-1' })
    expect(shows).toEqual([false])
    expect(focused).toBe(0)
  })
})

describe('browser handler — the workspace a file opens in', () => {
  /**
   * A thin client's `webContentsId` belongs to its own process. Inferring this machine's
   * window→workspace map from it can land on an unrelated local window, which would check the
   * path against — and stamp the new tab with — that window's workspace. A request from a
   * remote client must never borrow a local window's workspace; a local one still may.
   */
  async function openFile(opts: {
    clientId: string
    workspaceId: string | null
    isLocal: boolean
  }): Promise<{ lookedUp: number[]; stamped: Array<string | null | undefined> }> {
    const lookedUp: number[] = []
    const stamped: Array<string | null | undefined> = []
    const recorder = makeServer()
    recorder.server.isLocalClient = () => opts.isLocal

    const { registerBrowserHandlers } = await import('../browser')
    const deps = makeDeps({ instances: [] })
    registerBrowserHandlers(recorder.server, {
      ...deps,
      windowManager: {
        getWorkspaceForWindow: (webContentsId: number) => {
          lookedUp.push(webContentsId)
          return 'local-ws'
        },
      } as unknown as HandlerDeps['windowManager'],
      browserPaneManager: {
        listInstances: () => [],
        onStateChange: () => {},
        onRemoved: () => {},
        onInteracted: () => {},
        setViewStreamEndedHandler: () => {},
        createForSession: (_sessionId: string | null, options?: { workspaceId?: string | null }) => {
          stamped.push(options?.workspaceId)
          return 'instance-1'
        },
        createTab: () => 'tab-1',
        focus: () => {},
        navigate: async () => ({ url: 'https://example.com', title: 'Example' }),
        getActiveTabId: () => 'tab-1',
      } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
    })

    const file = join(tmpdir(), `craft-open-file-${process.pid}-${Math.random().toString(36).slice(2)}.html`)
    writeFileSync(file, '<p>hi</p>')
    try {
      await recorder.handlers.get('browser-pane:open-file')!(
        { clientId: opts.clientId, workspaceId: opts.workspaceId, webContentsId: 7 },
        file,
      )
    } finally {
      rmSync(file, { force: true })
    }
    return { lookedUp, stamped }
  }

  it('never infers a local window for a remote client', async () => {
    const { lookedUp, stamped } = await openFile({ clientId: 'thin-client', workspaceId: null, isLocal: false })
    expect(lookedUp).toEqual([])
    expect(stamped).toEqual([null])
  })

  it("uses the remote request's own workspace as given", async () => {
    const { lookedUp, stamped } = await openFile({ clientId: 'thin-client', workspaceId: 'ws-remote', isLocal: false })
    expect(lookedUp).toEqual([])
    expect(stamped).toEqual(['ws-remote'])
  })

  it("still infers the workspace of this machine's own window", async () => {
    const { lookedUp, stamped } = await openFile({ clientId: 'local-window', workspaceId: null, isLocal: true })
    expect(lookedUp).toEqual([7])
    expect(stamped).toEqual(['local-ws'])
  })
})
