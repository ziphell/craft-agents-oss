import { RPC_CHANNELS, type BrowserPaneCreateOptions, type BrowserPaneTabAction, type BrowserEmptyStateLaunchPayload } from '../../shared/types'
import type { BrowserScreenshotOptions } from '../browser-pane-manager'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.browserPane.CREATE,
  RPC_CHANNELS.browserPane.DESTROY,
  RPC_CHANNELS.browserPane.LIST,
  RPC_CHANNELS.browserPane.NAVIGATE,
  RPC_CHANNELS.browserPane.GO_BACK,
  RPC_CHANNELS.browserPane.GO_FORWARD,
  RPC_CHANNELS.browserPane.RELOAD,
  RPC_CHANNELS.browserPane.STOP,
  RPC_CHANNELS.browserPane.FOCUS,
  RPC_CHANNELS.browserPane.TAB_ACTION,
  RPC_CHANNELS.browserPane.LAUNCH,
  RPC_CHANNELS.browserPane.SNAPSHOT,
  RPC_CHANNELS.browserPane.CLICK,
  RPC_CHANNELS.browserPane.FILL,
  RPC_CHANNELS.browserPane.SELECT,
  RPC_CHANNELS.browserPane.SCREENSHOT,
  RPC_CHANNELS.browserPane.EVALUATE,
  RPC_CHANNELS.browserPane.SCROLL,
] as const

export function registerBrowserHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { browserPaneManager, platform } = deps
  if (!browserPaneManager) return

  server.handle(RPC_CHANNELS.browserPane.CREATE, (ctx, input?: string | BrowserPaneCreateOptions) => {
    // Stamp the window with the requester's workspace so manual UI-opened
    // tabs stay scoped to the workspace where the user clicked. If
    // ctx.workspaceId is null (no workspace context — e.g. CLI / agent
    // harness), the window stays globally visible (legacy behavior).
    const workspaceId = ctx.workspaceId ?? null

    if (typeof input === 'string') {
      return browserPaneManager.createInstance(input, { workspaceId })
    }

    // Which window the caller gets:
    //
    // - an **explicit id** pins the instance id (internal machinery and tests) —
    //   the window it makes is the same kind as any other, carrying the caller's
    //   workspace;
    // - everything else lands in the workspace's **browser window** — the one
    //   window every conversation and the user work in (plan §22). Opening
    //   "a new browser" adds a tab to it rather than making a second window, and
    //   `bindToSessionId` only says which conversation is driving.
    // A window the caller pinned by id, as opposed to the workspace's own window.
    const pinnedWindowId = input?.id && !input?.bindToSessionId ? input.id : null

    // Was the window already up? Asked **before** it is resolved, because afterwards the
    // answer is always "yes" — including for the window this very call brings up.
    const windowWasOpen = input?.newTab
      && browserPaneManager.listInstances().some((info) =>
        pinnedWindowId ? info.id === pinnedWindowId : info.workspaceId === workspaceId,
      )

    const instanceId = pinnedWindowId
      ? browserPaneManager.createInstance(pinnedWindowId, { show: input?.show, workspaceId })
      : browserPaneManager.createForSession(input?.bindToSessionId ?? null, {
          show: input?.show ?? false,
          workspaceId,
        })

    // A tab is wanted, and the opener may know which prototype it is for: an overlay's
    // page is somebody else's address, so once the view loads it no URL says whose it
    // is, and only the caller can.
    //
    // Which tab the request is answered by depends on the intent:
    //
    // - **a prototype** lands *in* the window's own blank tab when this request is what
    //   brings the window up, so opening a prototype into a fresh window does not leave a
    //   tab behind that nobody asked for (第六轮修正);
    // - **"New tab"** means **another** tab as soon as the window is already up. A window
    //   somebody has is not the blank one it was constructed with, however empty its one
    //   tab still looks — reading it as untouched swallowed the request and nothing at all
    //   happened (plan §22, 用户报告). A request that *is* what opens the window still lands
    //   in that tab, which is what keeps a fresh window from coming up with two blank ones.
    if (input?.prototype) {
      browserPaneManager.createTab(instanceId, {
        prototype: input.prototype,
        activate: true,
        reuseUntouchedWindow: true,
      })
    } else if (input?.newTab) {
      browserPaneManager.createTab(instanceId, {
        activate: true,
        ...(windowWasOpen ? {} : { reuseUntouchedWindow: true }),
      })
    }

    return instanceId
  })

  server.handle(RPC_CHANNELS.browserPane.DESTROY, (_ctx, id: string) => {
    browserPaneManager.destroyInstance(id)
  })

  server.handle(RPC_CHANNELS.browserPane.LIST, () => {
    // Return all instances. Workspace isolation is enforced renderer-side
    // (filterInstancesForWorkspace), which knows BOTH the local workspace id
    // and the remote-mirror workspace id for the active workspace. A server-
    // side filter on ctx.workspaceId would miss remote-stamped tabs because
    // ctx.workspaceId is always the local id (set by updateClientWorkspace).
    return browserPaneManager.listInstances()
  })

  server.handle(RPC_CHANNELS.browserPane.NAVIGATE, async (_ctx, id: string, url: string) => {
    try {
      return await browserPaneManager.navigate(id, url)
    } catch (err) {
      platform.logger.error(`[browser-pane] navigate failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.GO_BACK, async (_ctx, id: string) => {
    try {
      return await browserPaneManager.goBack(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] goBack failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.GO_FORWARD, async (_ctx, id: string) => {
    try {
      return await browserPaneManager.goForward(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] goForward failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.RELOAD, (_ctx, id: string) => {
    browserPaneManager.reload(id)
  })

  server.handle(RPC_CHANNELS.browserPane.STOP, (_ctx, id: string) => {
    browserPaneManager.stop(id)
  })

  server.handle(RPC_CHANNELS.browserPane.FOCUS, (_ctx, id: string) => {
    browserPaneManager.focus(id)
  })

  /**
   * Manage one window's tabs from the main window's badge strip: switch, close,
   * add, or take a locked tab back.
   *
   * The renderer states which tab and which window; what a tab *is* (its
   * identity, its opener, the strip's geometry) is the manager's to decide, so
   * nothing about it is passed back the other way.
   */
  server.handle(
    RPC_CHANNELS.browserPane.TAB_ACTION,
    (_ctx, input: BrowserPaneTabAction) => {
      if (!input || !input.instanceId) return

      if (input.action === 'activate') {
        if (input.tabId) browserPaneManager.activateTab(input.instanceId, input.tabId)
        return
      }

      if (input.action === 'close') {
        if (input.tabId) browserPaneManager.closeTab(input.instanceId, input.tabId)
        return
      }

      if (input.action === 'release') {
        // Taking a locked tab back: the overlay is what holds it, so dropping the
        // overlay is the unlock (plan §22, 第九轮修正). No session named — whoever is
        // working there lets go.
        browserPaneManager.clearAgentControlForInstance(input.instanceId)
        return
      }

      // A tab a person asked for through the strip is theirs, which is what the
      // default already says (`belongsTo: null` — nobody's work asked for
      // it). Stated by leaving it out, so the two surfaces that add tabs (this one
      // and the toolbar's own `+`) cannot drift apart.
      browserPaneManager.createTab(input.instanceId, { activate: true })
    },
  )

  server.handle(RPC_CHANNELS.browserPane.LAUNCH, async (ctx, payload: BrowserEmptyStateLaunchPayload) => {
    try {
      return await browserPaneManager.handleEmptyStateLaunchFromRenderer(ctx.webContentsId!, payload)
    } catch (err) {
      platform.logger.error('[browser-pane] empty-state launch IPC failed:', err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SNAPSHOT, async (_ctx, id: string) => {
    try {
      return await browserPaneManager.getAccessibilitySnapshot(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] snapshot failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.CLICK, async (_ctx, id: string, ref: string) => {
    try {
      return await browserPaneManager.clickElement(id, ref)
    } catch (err) {
      platform.logger.error(`[browser-pane] click failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.FILL, async (_ctx, id: string, ref: string, value: string) => {
    try {
      return await browserPaneManager.fillElement(id, ref, value)
    } catch (err) {
      platform.logger.error(`[browser-pane] fill failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SELECT, async (_ctx, id: string, ref: string, value: string) => {
    try {
      return await browserPaneManager.selectOption(id, ref, value)
    } catch (err) {
      platform.logger.error(`[browser-pane] select failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SCREENSHOT, async (_ctx, id: string, options?: BrowserScreenshotOptions) => {
    try {
      const result = await browserPaneManager.screenshot(id, options)
      return {
        base64: result.imageBuffer.toString('base64'),
        imageFormat: result.imageFormat,
        metadata: result.metadata,
      }
    } catch (err) {
      platform.logger.error(`[browser-pane] screenshot failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.EVALUATE, async (_ctx, id: string, expression: string) => {
    try {
      return await browserPaneManager.evaluate(id, expression)
    } catch (err) {
      platform.logger.error(`[browser-pane] evaluate failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SCROLL, async (_ctx, id: string, direction: string, amount?: number) => {
    const validDirections = ['up', 'down', 'left', 'right']
    if (!validDirections.includes(direction)) {
      throw new Error(`Invalid scroll direction: ${direction}`)
    }
    try {
      return await browserPaneManager.scroll(id, direction as 'up' | 'down' | 'left' | 'right', amount)
    } catch (err) {
      platform.logger.error(`[browser-pane] scroll failed for ${id}:`, err)
      throw err
    }
  })

  // Forward browser events to all locally-connected renderers. Workspace
  // isolation is enforced renderer-side (filterInstancesForWorkspace), which
  // handles both the local workspace id and the remote-mirror workspace id.
  //
  // We can't route STATE_CHANGED to `{ to: 'workspace', workspaceId }` here
  // because the broadcast routing uses the client's transport-level workspaceId
  // (the local Craft Agents window's id, set by `updateClientWorkspace`),
  // while remote-bridged instances are stamped with the remote server's
  // workspaceId. The two never match, so a workspace-targeted broadcast would
  // silently fail to reach the renderer. Broadcast to all + filter in the
  // renderer is the contract that actually works in both local-only and
  // remote-mirror deployments.
  browserPaneManager.onStateChange((info) => {
    pushTyped(server, RPC_CHANNELS.browserPane.STATE_CHANGED, { to: 'all' }, info)
  })

  browserPaneManager.onRemoved((id) => {
    pushTyped(server, RPC_CHANNELS.browserPane.REMOVED, { to: 'all' }, id)
  })

  browserPaneManager.onInteracted((id) => {
    pushTyped(server, RPC_CHANNELS.browserPane.INTERACTED, { to: 'all' }, id)
  })
}
