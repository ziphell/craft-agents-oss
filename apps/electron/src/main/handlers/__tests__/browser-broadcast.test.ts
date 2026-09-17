/**
 * Tests for browser handler broadcast + LIST.
 *
 * Workspace isolation contract: enforced renderer-side via
 * filterInstancesForWorkspace (which handles both the local and remote-mirror
 * workspace ids). The server-side handler broadcasts every event to all
 * locally-connected renderers and returns the full instance list from LIST.
 *
 * The reason: a renderer's transport-level workspaceId is always the *local*
 * Craft Agents window's id (set by updateClientWorkspace), but remote-bridged
 * tabs are stamped with the *remote* server's workspaceId. A workspace-scoped
 * broadcast or LIST filter would silently drop those events because the two
 * ids never match. The renderer knows both ids and filters correctly.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
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

  describe('CREATE for a prototype', () => {
    function callCreate(input: unknown): unknown {
      const createChannel = Array.from(recorder.handlers.keys())
        .find((ch) => ch.endsWith(':create') && ch.includes('browser'))
      if (!createChannel) throw new Error('CREATE handler not registered')
      return recorder.handlers.get(createChannel)!({ clientId: 'c1', workspaceId: null, webContentsId: null }, input)
    }

    /**
     * The panel's Open and the prototype page's Open both come through here. They
     * used to re-point whatever tab the session's window was showing; now they
     * add a tab, so opening a second prototype does not replace the first
     * (plan §22). Which tab it lands in — a fresh window's own blank tab, or a
     * new one — is the manager's rule, not this handler's, which is what
     * `reuseUntouchedWindow` says out loud.
     */
    it('adds a tab for the prototype instead of re-pointing the tab on screen', async () => {
      const calls: string[] = []
      const { registerBrowserHandlers } = await import('../browser')
      const deps = makeDeps({ instances: [] })
      const manager = deps.browserPaneManager as unknown as Record<string, unknown>
      manager.createForSession = (sessionId: string) => {
        calls.push(`window:${sessionId}`)
        return 'browser-1'
      }
      manager.createTab = (id: string, options: unknown) => {
        calls.push(`tab:${id}:${JSON.stringify(options)}`)
        return 'tab-1'
      }
      registerBrowserHandlers(recorder.server, deps)

      const returned = callCreate({
        show: true,
        bindToSessionId: 'session-1',
        prototype: { slug: 'checkout-flow', origin: 'http://checkout-flow-1a2b.localhost' },
      })

      expect(returned).toBe('browser-1')
      expect(calls).toEqual([
        'window:session-1',
        'tab:browser-1:{"prototype":{"slug":"checkout-flow","origin":"http://checkout-flow-1a2b.localhost"},"activate":true,"reuseUntouchedWindow":true}',
      ])
    })

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
    // up is one somebody has, so "New tab" there means one **more** tab. Reading its single
    // untouched blank tab as "untouched" reused it, and since there was nothing to load, the
    // click did nothing at all (plan §22, 用户报告).
    it('asks for one more tab when the window is already up', async () => {
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

      expect(calls).toEqual(['window', 'tab:browser-1:{"activate":true}'])
    })

    // An ordinary browser window is not a prototype's, so nothing is said about it.
    it('says nothing about a prototype when the caller named none', async () => {
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

    it('returns ALL instances regardless of ctx.workspaceId (renderer filters)', async () => {
      // The server-side filter is intentionally absent: ctx.workspaceId is the
      // local Craft Agents window's workspace id, but remote-bridged tabs are
      // stamped with the remote server's workspace id. Filtering here would
      // hide those tabs. The renderer applies filterInstancesForWorkspace,
      // which accepts both ids.
      const instances = [
        makeInstance('local-tab', { workspaceId: 'local-ws' }),
        makeInstance('remote-tab', { workspaceId: 'remote-ws' }),
        makeInstance('unbound', { workspaceId: null }),
      ]
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({ instances }))

      expect(callListHandler('local-ws').map((i) => i.id).sort()).toEqual([
        'local-tab',
        'remote-tab',
        'unbound',
      ])
      expect(callListHandler(null).map((i) => i.id).sort()).toEqual([
        'local-tab',
        'remote-tab',
        'unbound',
      ])
    })
  })
})
