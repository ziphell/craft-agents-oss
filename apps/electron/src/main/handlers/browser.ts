import { statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { RPC_CHANNELS, type BrowserPaneCreateOptions, type BrowserPaneTabAction, type BrowserEmptyStateLaunchPayload, type BrowserStreamInput, type BrowserStreamStartRequest } from '../../shared/types'
import type { BrowserScreenshotOptions } from '../browser-pane-manager'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import { validateFilePath, getWorkspaceAllowedDirs } from '@craft-agent/server-core/handlers'
import { isBrowserUrl } from '@craft-agent/shared/utils/url-safety'
import { browserWorkspaceKey } from '@craft-agent/shared/config/client-config'
import { attachTweaksInjector } from '../tweaks-injector'
import type { HandlerDeps } from './handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.browserPane.CREATE,
  RPC_CHANNELS.browserPane.DESTROY,
  RPC_CHANNELS.browserPane.LIST,
  RPC_CHANNELS.browserPane.NAVIGATE,
  RPC_CHANNELS.browserPane.OPEN_FILE,
  RPC_CHANNELS.browserPane.OPEN_URL,
  RPC_CHANNELS.browserPane.GO_BACK,
  RPC_CHANNELS.browserPane.GO_FORWARD,
  RPC_CHANNELS.browserPane.RELOAD,
  RPC_CHANNELS.browserPane.STOP,
  RPC_CHANNELS.browserPane.FOCUS,
  RPC_CHANNELS.browserPane.TAB_ACTION,
  RPC_CHANNELS.browserPane.STREAM_START,
  RPC_CHANNELS.browserPane.STREAM_STOP,
  RPC_CHANNELS.browserPane.STREAM_INPUT,
  RPC_CHANNELS.browserPane.LAUNCH,
  RPC_CHANNELS.browserPane.SNAPSHOT,
  RPC_CHANNELS.browserPane.CLICK,
  RPC_CHANNELS.browserPane.FILL,
  RPC_CHANNELS.browserPane.SELECT,
  RPC_CHANNELS.browserPane.SCREENSHOT,
  RPC_CHANNELS.browserPane.EVALUATE,
  RPC_CHANNELS.browserPane.FETCH_RESOURCE,
  RPC_CHANNELS.browserPane.SCROLL,
] as const

export function registerBrowserHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { browserPaneManager, windowManager, platform } = deps
  if (!browserPaneManager) return

  // Tweaks ride the browser window this app already has: a tweak runs only in it, and only
  // while this app is running (the exported extension is the other carrier). Attached here
  // because this is where the workspace's window is created and where the pane manager's one
  // state-change callback already lives.
  const tweaksInjector = attachTweaksInjector(browserPaneManager)

  /**
   * The saved server this window is connected to, if it is a remote window.
   *
   * Browser windows are per workspace, and two servers may both own a workspace with the same id:
   * filing a hub's workspace under its connection keeps the two from sharing a window — and
   * keeps this window's tab strip from listing another server's tabs.
   */
  const serverScope = (webContentsId: number | null | undefined): string | null =>
    (webContentsId == null ? null : windowManager?.getRemoteForWindow(webContentsId)?.connectionId) ?? null

  // A viewer is told when its stream ends for a reason of its own — the tab or window went away.
  browserPaneManager.setViewStreamEndedHandler((clientId, streamId, reason) => {
    pushTyped(server, RPC_CHANNELS.browserPane.STREAM_ENDED, { to: 'client', clientId }, streamId, reason)
  })

  /**
   * The workspace's browser window, with a tab in it to work from.
   *
   * One place for the two rules a tab request carries, because three requests now ask for a
   * tab (create, a file opened as a page, and whatever comes next):
   *
   * - an **explicit id** pins the instance id (internal machinery and tests) — the window it
   *   makes is the same kind as any other, carrying the caller's workspace;
   * - everything else lands in the workspace's **browser window** — the one window every
   *   conversation and the user work in. Opening "a new browser" adds a tab to it rather than
   *   making a second window, and `bindToSessionId` only says which conversation is driving;
   * - **`newTab` means another tab** as soon as the window is already up. A window the
   *   person has seen is not the blank one it was constructed with, however empty its one
   *   tab still looks — reading it as untouched swallowed the request and nothing at all
   *   happened. A window nobody has seen yet (this request opened it, or a turn's control
   *   overlay did) still has only its birth tab, and the browser side takes that one.
   */
  const windowWithTab = (
    ctx: { workspaceId?: string | null; webContentsId?: number | null },
    input?: BrowserPaneCreateOptions,
    openAt?: string,
  ): string => {
    // Stamp the window with the requester's workspace so manual UI-opened
    // tabs stay scoped to the workspace where the user clicked. If
    // ctx.workspaceId is null (no workspace context — e.g. CLI / agent
    // harness), the window stays globally visible (legacy behavior). A remote
    // window's workspace is filed under its server, so two servers that both
    // call their workspace `ws-1` still get two windows.
    const workspaceId = browserWorkspaceKey(serverScope(ctx.webContentsId), ctx.workspaceId ?? null)

    // A window the caller pinned by id, as opposed to the workspace's own window.
    const pinnedWindowId = input?.id && !input?.bindToSessionId ? input.id : null

    const instanceId = pinnedWindowId
      ? browserPaneManager.createInstance(pinnedWindowId, {
          show: input?.show,
          workspaceId,
          ...(input?.profileId ? { profileId: input.profileId } : {}),
        })
      : browserPaneManager.createForSession(input?.bindToSessionId ?? null, {
          show: input?.show ?? false,
          workspaceId,
          ...(input?.profileId ? { profileId: input.profileId } : {}),
        })

    if (input?.newTab) {
      browserPaneManager.createTab(instanceId, {
        activate: true,
        // The browser side takes the birth tab only when the window has never been shown,
        // so a window the person has seen gets a real new tab and nowhere else does.
        reuseUntouchedWindow: true,
        // The tab reads as a page from the moment it is made, even though the caller loads the
        // address itself (see `openAt` / `openInWindow`).
        ...(openAt ? { address: openAt } : {}),
      })
    }

    // The workspace's window now exists, so this is the moment to give it the workspace's
    // tweaks. Everything after this rides state changes (navigations), inside the injector.
    tweaksInjector.request(instanceId)

    return instanceId
  }

  server.handle(RPC_CHANNELS.browserPane.CREATE, (ctx, input?: string | BrowserPaneCreateOptions) => {
    if (typeof input === 'string') {
      return browserPaneManager.createInstance(input, {
        workspaceId: browserWorkspaceKey(serverScope(ctx.webContentsId), ctx.workspaceId ?? null),
      })
    }

    return windowWithTab(ctx, input)
  })

  /**
   * The workspace's window, at this address, with a fresh tab brought to the front.
   *
   * One function because "open a file" and "open a link" are one gesture with two kinds of
   * address, and both must land the same way: a new tab, the window up, the person looking
   * at it. Brought up **before** the load, so an address that never arrives is still a tab the
   * person can see and reload rather than a failure that happened behind their back.
   */
  const openInWindow = async (ctx: { workspaceId?: string | null; webContentsId?: number | null }, url: string, sessionId?: string | null) => {
    // The address goes into the create, not only into the `navigate` that follows: the tab has to
    // read as a page from the moment it is made, or it would be treated as a new-tab page and take
    // the caret in the address bar before the page it was opened for has even started (`openAt`).
    // `navigate` still does the loading — it normalises and reports a failure — the tab is just told
    // where it is going first.
    //
    // `sessionId` is the conversation the link was clicked in: it is what picks the profile, so the
    // tab lands in the window that conversation already works in rather than in the workspace's
    // default one. No session (a sidebar or settings link) leaves the workspace's answer in charge.
    const instanceId = windowWithTab(ctx, {
      show: true,
      newTab: true,
      ...(sessionId ? { bindToSessionId: sessionId } : {}),
    }, url)
    browserPaneManager.focus(instanceId)
    await browserPaneManager.navigate(instanceId, url)
  }

  /**
   * A local file, opened in the workspace's browser window.
   *
   * Reached from the preview window's own "open in browser" button, not from a click on the file:
   * a click draws the HTML (the app shows it), and this is what opens the same file in a browser,
   * as a tab at its own address — an origin, relative references, scripts, all of it.
   *
   * A path rather than a URL, because turning one into the other is the part no renderer can
   * get right: a drive letter, a space, a `#` and a non-ASCII name each have their own way of
   * coming out wrong from a hand-built `file://` string, and none of them is reported when it
   * does. `pathToFileURL` is the one that knows, and it lives here.
   *
   * The path is put through the same gate every other way in (`validateFilePath`: absolute, and
   * inside the home directory, the temp directory, the workspace root or its working directory
   * — with sensitive names like `.ssh/`, `.env` and `*.pem` refused everywhere) — one click must
   * not be able to reach more than another. It is also what resolves `..` and symlinks, so the
   * tab's address is the file's real one, and it refuses a path that is not a **file**: a
   * directory has nothing to draw but a listing of somebody's disk.
   *
   * Said out loud, since this is where the answer is: the file opens **in the browser window**,
   * not in a frame inside this app. That is what makes it something the agent can keep working
   * on — `browser_tool` drives tabs (snapshot, click, screenshot, recording), and it cannot drive
   * a frame in our own renderer at all. Drawing HTML inside a message is `html-preview`'s job and
   * stays that way.
   */
  server.handle(RPC_CHANNELS.browserPane.OPEN_FILE, async (ctx, path: string, sessionId?: string | null) => {
    const workspaceId = ctx.workspaceId ?? windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    const filePath = await validateFilePath(path, getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }))
    const info = statSync(filePath, { throwIfNoEntry: false })
    if (!info?.isFile()) {
      throw new Error(`Not a file: ${path}`)
    }

    await openInWindow(ctx, pathToFileURL(filePath).href, sessionId)
  })

  /**
   * An address, opened in the workspace's browser window.
   *
   * This is where a clicked link lands by default, and the choice was made in the renderer
   * against the person's own setting (`openInAppBrowser`) — one decision, at the click, rather
   * than a second one here. What that setting cannot be allowed to mean is "put anything in a
   * window": only an address a browser can load is, so `isBrowserUrl` is asked here too rather
   * than trusted to the caller. `craftagents://` never arrives — deep links are the shell
   * opener's, which knows what they mean.
   */
  server.handle(RPC_CHANNELS.browserPane.OPEN_URL, async (ctx, url: string, sessionId?: string | null) => {
    if (!isBrowserUrl(url)) {
      throw new Error(`Only http and https links open in the browser window: ${url}`)
    }

    await openInWindow(ctx, url.trim(), sessionId)
  })

  server.handle(RPC_CHANNELS.browserPane.DESTROY, (_ctx, id: string) => {
    browserPaneManager.destroyInstance(id)
  })

  /**
   * Watch one tab from outside its window (docs/browser-view-streaming.md).
   *
   * Frames go to **the client that asked** and nobody else: a stream is a viewer's, not a
   * broadcast, and the page in it may be signed in. `streamStop` is the other half; the manager
   * also ends the stream when the tab or its window goes away.
   */
  server.handle(RPC_CHANNELS.browserPane.STREAM_START, async (ctx, input: BrowserStreamStartRequest) => {
    if (!input?.instanceId || !input?.tabId) {
      throw new Error('A browser window and a tab are required')
    }
    const clientId = ctx.clientId
    return await browserPaneManager.startViewStream(input.instanceId, input.tabId, clientId, (frame) => {
      pushTyped(server, RPC_CHANNELS.browserPane.STREAM_FRAME, { to: 'client', clientId }, frame)
    })
  })

  server.handle(RPC_CHANNELS.browserPane.STREAM_STOP, async (_ctx, streamId: string) => {
    await browserPaneManager.stopViewStream(streamId)
  })

  server.handle(RPC_CHANNELS.browserPane.STREAM_INPUT, async (_ctx, streamId: string, events: BrowserStreamInput[]) => {
    await browserPaneManager.dispatchStreamInput(streamId, Array.isArray(events) ? events : [])
  })

  server.handle(RPC_CHANNELS.browserPane.LIST, () => {
    // Return all instances; the renderer keeps only those of the workspace it shows
    // (`filterInstancesForWorkspace`, which files a remote window's workspace under its
    // server). Returning everything is what lets the same list serve a local window and a
    // remote one without the main process having to know which window is asking.
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
        // overlay is the unlock. No session named — whoever is
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

  server.handle(
    RPC_CHANNELS.browserPane.FETCH_RESOURCE,
    async (_ctx, id: string, url: string, options?: { referrer?: string; maxBytes?: number }) => {
      try {
        return await browserPaneManager.fetchResource(id, url, options)
      } catch (err) {
        platform.logger.error(`[browser-pane] fetch-resource failed for ${id}:`, err)
        throw err
      }
    },
  )

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

  // Forward browser events to all locally-connected renderers. The renderer keeps only the
  // windows of the workspace it shows — filed under its server when the window is remote — so
  // the same broadcast serves every window without the hub's own workspace id leaking into a
  // window on another hub.
  browserPaneManager.onStateChange((info) => {
    pushTyped(server, RPC_CHANNELS.browserPane.STATE_CHANGED, { to: 'all' }, info)
    // The tweaks carrier listens on the same subscription: the pane manager holds exactly
    // one callback, and this is the call site that owns it (see tweaks-injector.ts).
    tweaksInjector.handleStateChange(info)
  })

  browserPaneManager.onRemoved((id) => {
    pushTyped(server, RPC_CHANNELS.browserPane.REMOVED, { to: 'all' }, id)
  })

  browserPaneManager.onInteracted((id) => {
    pushTyped(server, RPC_CHANNELS.browserPane.INTERACTED, { to: 'all' }, id)
  })
}
