/**
 * Tests for BrowserPaneManager.
 *
 * Mocks Electron BrowserWindow and session modules to validate lifecycle,
 * session binding, and navigation behavior.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { pickCommandTarget, whyTabIsLocked } from '@craft-agent/server-core/domain'
import type { BrowserTabSummary } from '@craft-agent/shared/protocol'

const createdWindows: any[] = []
let toolbarLoadFailuresRemaining = 0
/**
 * When set, the next `browser-empty-state.html` load throws it. Lets tests drive
 * the create-time empty-state fallback (see the fallback tests near the top).
 */
let emptyStateLoadError: Error | null = null
const mockShellOpenExternal = mock(async () => {})
const mockIpcMainHandle = mock(() => {})

function maybeFailEmptyStateLoad(target: string): void {
  if (emptyStateLoadError && target.includes('browser-empty-state.html')) {
    const error = emptyStateLoadError
    emptyStateLoadError = null
    throw error
  }
}

function createMockWebContents() {
  const listeners: Record<string, Function[]> = {}
  let currentUrl = 'about:blank'
  return {
    userAgent: 'Mock Chrome Electron/99.0.0',
    session: {},
    isDestroyed: mock(() => false),
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    loadURL: mock(async (url: string) => {
      currentUrl = url
      maybeFailEmptyStateLoad(url)
      const isToolbarUrl = typeof url === 'string' && url.includes('browser-toolbar.html')
      if (isToolbarUrl && toolbarLoadFailuresRemaining > 0) {
        toolbarLoadFailuresRemaining--
        throw new Error('mock toolbar load failure')
      }
    }),
    loadFile: mock(async (path: string, _opts?: unknown) => {
      maybeFailEmptyStateLoad(path)
      if (toolbarLoadFailuresRemaining > 0) {
        toolbarLoadFailuresRemaining--
        throw new Error('mock toolbar load failure')
      }
    }),
    getTitle: mock(() => 'Test Page'),
    getURL: mock(() => currentUrl),
    canGoBack: mock(() => false),
    canGoForward: mock(() => false),
    goBack: mock(() => {}),
    goForward: mock(() => {}),
    reload: mock(() => {}),
    stop: mock(() => {}),
    setUserAgent: mock(() => {}),
    setBackgroundColor: mock(() => {}),
    setBackgroundThrottling: mock((_allowed: boolean) => {}),
    capturePage: mock(async () => {
      const img = {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1800 }),
        resize: (_opts: any) => img,
        toPNG: () => Buffer.from('fake-png'),
        toJPEG: (_quality: number) => Buffer.from('fake-jpeg'),
      }
      return img
    }),
    executeJavaScript: mock(async (expr: string) => eval(expr)),
    focus: mock(() => {}),
    setWindowOpenHandler: mock((_handler: any) => {}),
    send: mock((_channel: string, _payload?: unknown) => {}),
    debugger: {
      attach: mock(() => {}),
      detach: mock(() => {}),
      sendCommand: mock(async () => ({ nodes: [] })),
      on: mock(() => {}),
    },
    _listeners: listeners,
    _emit: (event: string, ...args: any[]) => {
      for (const cb of listeners[event] || []) cb({}, ...args)
    },
  }
}

function createMockBrowserView() {
  const webContents = createMockWebContents()
  return {
    webContents,
    setBounds: mock(() => {}),
    setAutoResize: mock(() => {}),
  }
}

function createMockWindow(opts?: { width?: number; height?: number; minWidth?: number; minHeight?: number }) {
  const listeners: Record<string, Function[]> = {}
  const webContents = createMockWebContents()
  let contentWidth = opts?.width ?? 1200
  let contentHeight = opts?.height ?? 900
  const minWidth = opts?.minWidth ?? 0
  const minHeight = opts?.minHeight ?? 0

  const win = {
    webContents,
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    once: (event: string, cb: Function) => {
      const wrapped = (...args: any[]) => {
        listeners[event] = (listeners[event] || []).filter(fn => fn !== wrapped)
        cb(...args)
      }
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(wrapped)
    },
    _emit: (event: string, ...args: any[]) => {
      for (const cb of listeners[event] || []) cb(...args)
    },
    isDestroyed: mock(() => false),
    isMinimized: mock(() => false),
    restore: mock(() => {}),
    show: mock(() => {}),
    showInactive: mock(() => {}),
    setWindowButtonVisibility: mock((_visible: boolean) => {}),
    hide: mock(() => {
      win._emit('hide')
    }),
    focus: mock(() => {}),
    destroy: mock(() => {
      win._emit('closed')
    }),
    setBrowserView: mock((_view: any) => {}),
    addBrowserView: mock((_view: any) => {}),
    setTopBrowserView: mock((_view: any) => {}),
    getContentSize: mock(() => [contentWidth, contentHeight]),
    setContentSize: mock((width: number, height: number) => {
      contentWidth = Math.max(minWidth, Math.floor(width))
      contentHeight = Math.max(minHeight, Math.floor(height))
    }),
    loadURL: mock(async (_url: string) => {}),
  }
  createdWindows.push(win)
  return win
}

mock.module('electron', () => ({
  app: {
    getPath: mock((name: string) => name === 'downloads' ? '/tmp/mock-downloads' : `/tmp/mock-${name}`),
  },
  BrowserWindow: class MockBrowserWindow {
    webContents: any
    constructor(opts?: any) {
      const win = createMockWindow(opts)
      this.webContents = win.webContents
      Object.assign(this, win)
    }
  },
  BrowserView: class MockBrowserView {
    webContents: any
    constructor(_opts?: any) {
      const view = createMockBrowserView()
      this.webContents = view.webContents
      Object.assign(this, view)
    }
  },
  ipcMain: {
    handle: mockIpcMainHandle,
  },
  // The pane manager reaches `video-frames` (importing a recording), which asks
  // the user for a file. Without this export the whole file fails to load, so the
  // tests below would silently not run at all.
  dialog: {
    showOpenDialog: mock(async () => ({ canceled: true, filePaths: [] })),
  },
  Menu: {
    buildFromTemplate: mock(() => ({
      popup: mock(() => {}),
    })),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
  },
  shell: {
    openExternal: mockShellOpenExternal,
  },
  session: {
    fromPartition: mock(() => ({
      setPermissionCheckHandler: mock(() => {}),
      setPermissionRequestHandler: mock(() => {}),
      webRequest: {
        onBeforeRequest: mock((_cb: any) => {}),
        onCompleted: mock((_cb: any) => {}),
        onErrorOccurred: mock((_cb: any) => {}),
      },
      on: mock((_event: string, _cb: any) => {}),
    })),
  },
}))

mock.module('../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
    sessionLog: stubLog,
    handlerLog: stubLog,
    windowLog: stubLog,
    agentLog: stubLog,
    searchLog: stubLog,
    isDebugMode: false,
    getLogFilePath: () => '/tmp/main.log',
  }
})

mock.module('../browser-cdp', () => ({
  BrowserCDP: class MockBrowserCDP {
    detach = mock(() => {})
    getAccessibilitySnapshot = mock(async () => ({
      url: 'https://example.com',
      title: 'Example',
      nodes: [],
    }))
    clickElement = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    fillElement = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    selectOption = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    renderTemporaryOverlay = mock(async () => {})
    clearTemporaryOverlay = mock(async () => {})
    getViewportMetrics = mock(async () => ({ width: 1200, height: 900, dpr: 2, scrollX: 0, scrollY: 0 }))
    getElementGeometry = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    getElementGeometryBySelector = mock(async () => ({
      ref: 'selector:div.card',
      box: { x: 5, y: 5, width: 20, height: 20 },
      clickPoint: { x: 15, y: 15 },
    }))
  },
}))

const { BrowserPaneManager } = await import('../browser-pane-manager')

/**
 * The page a window is showing.
 *
 * A window's address, title, view, CDP session and prototype belong to its *tabs*
 * now, so a test that used to say `page(instance).pageView` says `page(instance).pageView`:
 * exactly the migration the manager itself went through. These tests drive a
 * single-tab window, so "the page" is its first tab.
 */
function page(instance: any): any {
  return instance.tabs[0]
}

/**
 * One page as `listTabs` reports it — the observation half filled with what a
 * plain page has, the declaration half with `'user'` (which is what the manager's
 * default is). Tests override only the field they are about.
 */
function tabSummary(overrides: Partial<BrowserTabSummary> & { id: string }): BrowserTabSummary {
  return {
    url: 'about:blank',
    title: 'New Tab',
    favicon: null,
    isLoading: false,
    active: false,
    prototype: null,
    prototypePage: null,
    disposition: null,
    openedBySessionId: null,
    driverSessionId: null,
    cursorOf: null,
    lockedBy: null,
    ...overrides,
  }
}

describe('BrowserPaneManager', () => {
  let manager: InstanceType<typeof BrowserPaneManager>

  beforeEach(() => {
    createdWindows.length = 0
    toolbarLoadFailuresRemaining = 0
    emptyStateLoadError = null
    mockShellOpenExternal.mockClear()
    mockIpcMainHandle.mockClear()
    manager = new BrowserPaneManager()
  })

  /**
   * Give a window a driver.
   *
   * The production way to take a lease is a command — `createForSession` resolves the
   * workspace's window and renews it — but a test names the window it is about, so the
   * lease is written directly. It is the same field a command writes, and the only
   * kind of claim a window carries now: a lease, never an owner (plan §22).
   */
  function drive(id: string, sessionId: string): void {
    const instance = (manager as any).instances.get(id)
    if (!instance) throw new Error(`no instance ${id}`)
    instance.boundSessionId = sessionId
  }

  /**
   * Creating a window and pointing it somewhere in the same breath aborts the
   * empty-state load. Forcing `about:blank` in that case would abort the
   * navigation the caller asked for, and the failure would be reported against
   * `about:blank` — so a navigation that actually succeeded looks broken.
   */
  it('does not hijack a navigation that aborted the empty-state load', async () => {
    emptyStateLoadError = Object.assign(
      new Error("ERR_ABORTED (-3) loading 'browser-empty-state.html'"),
      { code: 'ERR_ABORTED' },
    )

    manager.createInstance('empty-state-aborted')
    const instance = (manager as any).instances.get('empty-state-aborted')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(page(instance).pageView.webContents.loadURL).not.toHaveBeenCalledWith('about:blank')
  })

  // …while a genuine failure still gets the fallback, so the blank window case
  // does not regress into showing nothing.
  it('still falls back to about:blank when the empty state fails for another reason', async () => {
    emptyStateLoadError = new Error('mock empty-state failure')

    manager.createInstance('empty-state-broken')
    const instance = (manager as any).instances.get('empty-state-broken')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(page(instance).pageView.webContents.loadURL).toHaveBeenCalledWith('about:blank')
  })

  it('creates and lists instances', () => {
    const id = manager.createInstance('test-1')
    const list = manager.listInstances()
    expect(id).toBe('test-1')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('test-1')
    expect(list[0].agentControlActive).toBe(false)
  })

  it('is idempotent when explicit ID already exists', () => {
    const first = manager.createInstance('same-id')
    const second = manager.createInstance('same-id')
    expect(first).toBe('same-id')
    expect(second).toBe('same-id')
    expect(manager.listInstances()).toHaveLength(1)
  })

  // Every request for a window of its own becomes a page beside the one that asked,
  // whatever asked: a link, a scripted popup, a link on a prototype's own document
  // (plan §22). There is no second-window path left.
  it('opens a window request as a page beside the one that asked for it', () => {
    manager.createInstance('window-open-link')
    const instance = (manager as any).instances.get('window-open-link')
    const origin = instance.tabs[0].id
    const openHandler = page(instance).pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    const result = openHandler({
      url: 'https://accounts.google.com/o/oauth2/v2/auth',
      // What Chromium reports for a scripted `window.open` with features.
      disposition: 'new-window',
      frameName: 'oauth-popup',
    })

    expect(result).toEqual({ action: 'deny' })
    expect(instance.tabs).toHaveLength(2)
    expect(instance.tabs[1].disposition).toBe('popup')
    // The new page loads the address the link asked for, and is the one on screen: a
    // link is clicked in order to be looked at.
    expect(instance.tabs[1].pageView.webContents.loadURL).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth')
    expect(instance.activeTabId).toBe(instance.tabs[1].id)
    expect(manager.listTabs('window-open-link')[1]!.id).not.toBe(origin)
    // Nobody owned the page it came from, so nobody owns this one: no owner is invented
    // for a page that merely appeared (plan §22, 第十一轮).
    expect(instance.tabs[1].openedBySessionId).toBeNull()
    expect(instance.tabs[1].cursorOf).toBeNull()
    expect(instance.tabs[1].driverSessionId).toBeNull()
  })

  // A page derived from a task's page joins that task (plan §22, 第十一轮). It inherits the
  // group and nothing else: the person following a link inside the agent's page must not
  // retarget the agent's next command, and must not make the window claim the agent is
  // driving the new page.
  it('gives a derived page its parent task, but not its cursor or lease', () => {
    manager.createInstance('window-open-inherit')
    drive('window-open-inherit', 'session-a')
    const instance = (manager as any).instances.get('window-open-inherit')
    const parentId = manager.createTab('window-open-inherit', {
      url: 'https://app.example.com/',
      openedBySessionId: 'session-a',
    })
    const parent = instance.tabs.find((tab: any) => tab.id === parentId)
    const openHandler = parent.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    openHandler({ url: 'https://docs.example.com/', disposition: 'foreground-tab', frameName: '' })

    const derived = instance.tabs.find((tab: any) => tab.id !== parentId)
    expect(derived?.openedBySessionId).toBe('session-a')
    expect(derived?.cursorOf).toBeNull()
    expect(derived?.driverSessionId).toBeNull()
    // The parent is still the page that conversation works from.
    expect(parent.cursorOf).toBe('session-a')
  })

  it('puts the new page right after the page it came from', () => {
    manager.createInstance('window-open-order')
    const instance = (manager as any).instances.get('window-open-order')
    // Two ordinary pages first, so "beside" and "at the end" are different answers.
    instance.tabs[0].currentUrl = 'https://first.example.com/'
    const first = instance.tabs[0].id
    manager.createTab('window-open-order', { url: 'https://second.example.com/' })
    const second = instance.tabs[1].id
    manager.activateTab('window-open-order', first)

    const openHandler = page(instance).pageView.webContents.setWindowOpenHandler.mock.calls[0][0]
    openHandler({ url: 'https://third.example.com/', disposition: 'foreground-tab', frameName: '' })

    // Between the two, not after them: "beside the page that asked" is the whole point.
    const order = manager.listTabs('window-open-order').map((tab) => tab.id)
    expect(order).toHaveLength(3)
    expect(order[0]).toBe(first)
    expect(order[2]).toBe(second)
    expect(instance.tabs[1].disposition).toBe('link')
    expect(instance.tabs[1].pageView.webContents.loadURL).toHaveBeenCalledWith('https://third.example.com/')
  })

  it('leaves a background window request in the background', () => {
    manager.createInstance('window-open-bg')
    const instance = (manager as any).instances.get('window-open-bg')
    const before = instance.activeTabId
    const openHandler = page(instance).pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    openHandler({ url: 'https://background.example.com/', disposition: 'background-tab', frameName: '' })

    expect(instance.tabs).toHaveLength(2)
    expect(instance.activeTabId).toBe(before)
  })

  it('refuses a window request that is not a web address', () => {
    manager.createInstance('window-open-scheme')
    const instance = (manager as any).instances.get('window-open-scheme')
    const openHandler = page(instance).pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    expect(openHandler({ url: 'file:///etc/passwd', disposition: 'foreground-tab', frameName: '' })).toEqual({ action: 'deny' })
    expect(openHandler({ url: 'not a url', disposition: 'foreground-tab', frameName: '' })).toEqual({ action: 'deny' })
    expect(instance.tabs).toHaveLength(1)
  })

  it('denies app deep-link popups and forwards to deep-link handler', async () => {
    manager.createInstance('popup-deeplink')
    const instance = (manager as any).instances.get('popup-deeplink')
    const openHandler = page(instance).pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    const result = openHandler({
      url: 'craftagents://settings',
      disposition: 'new-window',
      frameName: '',
    })

    expect(result).toEqual({ action: 'deny' })
    await Bun.sleep(0)
    expect(mockShellOpenExternal).toHaveBeenCalledWith('craftagents://settings')
  })

  it('destroys instances', () => {
    manager.createInstance('d1')
    manager.destroyInstance('d1')
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('destroys instance via toolbar destroy IPC handler', async () => {
    manager.createInstance('d-ipc-destroy')
    manager.registerToolbarIpc()

    const destroyRegistration = (
      mockIpcMainHandle.mock.calls as unknown as Array<[
        string,
        (_event: unknown, instanceId: string) => Promise<void>,
      ]>
    ).find(([channel]) => channel === 'browser-toolbar:destroy')

    expect(destroyRegistration).toBeTruthy()
    if (!destroyRegistration) throw new Error('Expected browser-toolbar:destroy IPC registration')

    const [, destroyHandler] = destroyRegistration
    await destroyHandler({}, 'd-ipc-destroy')

    expect(manager.listInstances()).toHaveLength(0)
  })

  it('emits removed callback exactly once when destroy triggers closed', () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))

    manager.createInstance('d-removed-once')
    manager.destroyInstance('d-removed-once')

    expect(removed).toEqual(['d-removed-once'])
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('ignores late state events after instance was removed', () => {
    const states: string[] = []
    manager.onStateChange((info) => states.push(info.id))

    manager.createInstance('d-late-state')
    const instance = (manager as any).instances.get('d-late-state')
    states.length = 0

    manager.destroyInstance('d-late-state')
    const countAfterDestroy = states.length

    instance.window._emit('hide')
    instance.window._emit('show')

    expect(states.length).toBe(countAfterDestroy)
  })

  it('holds a lease on a window, and lets it go without touching the window', () => {
    manager.createInstance('b1')
    drive('b1', 'session-abc')
    expect(manager.listInstances()[0].boundSessionId).toBe('session-abc')

    manager.unbindAllForSession('session-abc')
    expect(manager.listInstances()[0].boundSessionId).toBeNull()
    // Releasing is not closing: the window is still there for the next turn.
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('createForSession resolves the same window, and the caller becomes its driver', () => {
    const id1 = manager.createForSession('sess-1')
    const id2 = manager.createForSession('sess-1')
    const info = manager.listInstances()[0]

    expect(id1).toBe(id2)
    expect(info.boundSessionId).toBe('sess-1')
    // The window is the workspace's (plan §22): `sess-1` holds a lease on it and
    // nothing more, so it is not what says whether the window is a session's.
    expect(info.isWorkspaceWindow).toBe(true)
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('getOrCreateForSession reuses existing instance', () => {
    const id1 = manager.getOrCreateForSession('sess-1')
    const id2 = manager.getOrCreateForSession('sess-1')
    expect(id1).toBe(id2)
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('createForSession does not adopt a manually opened window', () => {
    // A window of one's own is not the workspace's, so a session opening a browser
    // gets the workspace's window instead of taking the manual one over (plan §22).
    manager.createInstance('manual-1')

    const id = manager.createForSession('sess-reuse')

    expect(id).not.toBe('manual-1')
    expect(manager.listInstances()).toHaveLength(2)
    const manual = manager.listInstances().find((i) => i.id === 'manual-1')
    expect(manual?.isWorkspaceWindow).toBe(false)
    expect(manual?.boundSessionId).toBeNull()
  })

  describe('workspaceId stamping', () => {
    it('createForSession with workspaceId stamps the field on a new instance', () => {
      const id = manager.createForSession('sess-ws', { workspaceId: 'ws-alpha' })
      const info = manager.listInstances().find((i) => i.id === id)
      expect(info?.workspaceId).toBe('ws-alpha')
    })

    it('createForSession without workspaceId defaults to null', () => {
      const id = manager.createForSession('sess-plain')
      const info = manager.listInstances().find((i) => i.id === id)
      expect(info?.workspaceId).toBeNull()
    })

    it('manual createInstance with no options leaves workspaceId null (unbound window)', () => {
      manager.createInstance('manual-ws')
      const info = manager.listInstances().find((i) => i.id === 'manual-ws')
      expect(info?.workspaceId).toBeNull()
    })

    it('manual createInstance accepts workspaceId option (TopBar manual open)', () => {
      // The browser-pane CREATE handler passes ctx.workspaceId so TopBar-
      // opened windows stay scoped to the workspace the user clicked from,
      // rather than being broadcast to every workspace.
      manager.createInstance('manual-scoped', { workspaceId: 'ws-toolbar' })
      const info = manager.listInstances().find((i) => i.id === 'manual-scoped')
      expect(info?.workspaceId).toBe('ws-toolbar')
    })

    it('setAgentControl backfills workspaceId when previously null', () => {
      // Legacy path: instance was created without a workspace, then the overlay
      // path supplies it. Backfill should stamp it.
      manager.createInstance('legacy-overlay')
      drive('legacy-overlay', 'sess-legacy')
      manager.setAgentControl('sess-legacy', { displayName: 'browser_navigate' }, { workspaceId: 'ws-delta' })

      const info = manager.listInstances().find((i) => i.id === 'legacy-overlay')
      expect(info?.workspaceId).toBe('ws-delta')
    })

    it('toInfo emits workspaceId on the DTO', () => {
      const id = manager.createForSession('sess-dto', { workspaceId: 'ws-epsilon' })
      const dto = manager.listInstances().find((i) => i.id === id)
      expect(dto).toBeDefined()
      expect(dto).toHaveProperty('workspaceId', 'ws-epsilon')
    })

    /**
     * One window per workspace, shared by every conversation in it and by the user
     * (plan §22). What used to be "which session owns this window" is now the lease
     * `boundSessionId` holds, and what used to be "reuse a window from the last
     * turn" is simply "the workspace has one window".
     */
    describe("the workspace's browser window", () => {
      const instanceInfo = (id: string) => manager.listInstances().find((item) => item.id === id)

      it('gives every session in a workspace the same window', () => {
        const first = manager.createForSession('sess-a1', { workspaceId: 'ws-a' })

        expect(manager.createForSession('sess-a2', { workspaceId: 'ws-a' })).toBe(first)
        expect(manager.listInstances()).toHaveLength(1)
      })

      it('hands the lease to whoever asks last, and keeps the window between turns', () => {
        const shared = manager.createForSession('sess-a1', { workspaceId: 'ws-a' })
        expect(instanceInfo(shared)?.boundSessionId).toBe('sess-a1')

        // A second conversation takes its turn at the wheel: the window is shared,
        // not owned.
        manager.createForSession('sess-a2', { workspaceId: 'ws-a' })
        expect(instanceInfo(shared)?.boundSessionId).toBe('sess-a2')

        // A turn ending releases the lease, not the window.
        manager.unbindAllForSession('sess-a2')
        expect(instanceInfo(shared)?.boundSessionId).toBeNull()
        expect(manager.listInstances()).toHaveLength(1)
        // Still the workspace's window — nothing about it was demoted or handed over.
        expect(instanceInfo(shared)?.isWorkspaceWindow).toBe(true)

        // And the next turn picks the same window back up.
        expect(manager.createForSession('sess-a2', { workspaceId: 'ws-a' })).toBe(shared)
      })

      it('keeps two workspaces apart', () => {
        const a = manager.createForSession('sess-a', { workspaceId: 'ws-a' })
        const b = manager.createForSession('sess-b', { workspaceId: 'ws-b' })

        expect(b).not.toBe(a)
        expect(manager.listInstances()).toHaveLength(2)
        expect(instanceInfo(a)?.workspaceId).toBe('ws-a')
        expect(instanceInfo(b)?.workspaceId).toBe('ws-b')
        expect(instanceInfo(a)?.boundSessionId).toBe('sess-a')
      })

      it('opens a hand-opened page in the same window without taking the lease', () => {
        const shared = manager.createForSession('sess-a', { workspaceId: 'ws-a' })

        // The user's own "+": nobody is at the wheel, and whoever was keeps it —
        // the person clicking around did not stop a conversation.
        expect(manager.createForSession(null, { workspaceId: 'ws-a' })).toBe(shared)
        expect(instanceInfo(shared)?.boundSessionId).toBe('sess-a')
      })

      it('is never destroyed by a session being torn down', () => {
        const shared = manager.createForSession('sess-a', { workspaceId: 'ws-a' })

        manager.destroyForSession('sess-a')

        expect(manager.listInstances().map((item) => item.id)).toEqual([shared])
        expect(instanceInfo(shared)?.boundSessionId).toBeNull()
      })

      it('belongs to its workspace rather than to whoever opened it', () => {
        const shared = manager.createForSession('sess-a', { workspaceId: 'ws-a' })
        manager.unbindAllForSession('sess-a')

        // Nothing on the window remembers `sess-a`: it is the workspace's, and the
        // conversation that opened it leaves no trace once its turn is over.
        expect(instanceInfo(shared)?.isWorkspaceWindow).toBe(true)
        expect(instanceInfo(shared)?.boundSessionId).toBeNull()
      })
    })
    // Two facts live here and they are not the same one: the **cursor** (`cursorOf`) is the
    // page a conversation works from — sticky, named, where its unnamed commands go — and
    // the **lease** (`driverSessionId`) is the last page a command actually reached, which
    // the turn ending sweeps away (plan §22, 第九轮修正 / 第十轮).
    describe('which page is being driven', () => {
      const tabsOf = (id: string) => manager.listTabs(id)
      const driverOf = (id: string, tabId: string) =>
        tabsOf(id).find((tab) => tab.id === tabId)?.driverSessionId
      const cursorOf = (id: string, tabId: string) =>
        tabsOf(id).find((tab) => tab.id === tabId)?.cursorOf

      /** The window in use, so adding a page adds one beside the page on screen. */
      function usedWindow(id: string, sessionId: string): any {
        const instanceId = manager.createForSession(sessionId, { workspaceId: 'ws-a' })
        const instance = (manager as any).instances.get(instanceId)
        instance.tabs[0].currentUrl = `https://${id}.example.com/`
        return instance
      }

      /**
       * One command, as `SessionManager` runs it: resolve the window, resolve the page it
       * acts on (the same rule — `pickCommandTarget`), then record that page as the one
       * this conversation works from. Two steps, because resolving a window no longer says
       * which page the command is about — and recording it does **not** move the window
       * (plan §22, 第十二轮): the target is what the next command is told, not what the
       * person is shown.
       */
      function command(sessionId: string, tabId?: string): { instanceId: string; tabId?: string } {
        const instanceId = manager.createForSession(sessionId, { workspaceId: 'ws-a' })
        const target = tabId ?? pickCommandTarget(tabsOf(instanceId), sessionId)?.tab.id
        if (target) manager.setSessionPage(instanceId, target, sessionId)
        return { instanceId, tabId: target }
      }

      it('records the driver on the page a command reached, and releases it when the turn ends', () => {
        const { instanceId } = command('sess-a')
        const first = tabsOf(instanceId)[0]!.id

        // A command: the conversation resolves its window, then the page it works from —
        // with none yet, that is the page on screen.
        command('sess-b')
        expect(driverOf(instanceId, first)).toBe('sess-b')
        expect(cursorOf(instanceId, first)).toBe('sess-b')

        manager.unbindAllForSession('sess-b')
        expect(driverOf(instanceId, first)).toBeNull()
        // A lease, not a cursor: the turn ending takes the lease and leaves the page as the
        // one this conversation works from.
        expect(cursorOf(instanceId, first)).toBe('sess-b')
      })

      // The rule the cursor exists for: a command lands on the conversation's own page, not
      // on whatever the person is looking at (plan §22, 第十轮).
      it('lands on the page the conversation works from, not the one on screen', () => {
        const instance = usedWindow('first', 'sess-a')
        const instanceId = instance.id
        const first = instance.tabs[0].id
        command('sess-a')
        expect(cursorOf(instanceId, first)).toBe('sess-a')

        // The person switches to a page of their own, and the conversation runs a command.
        const other = manager.createTab(instanceId, { url: 'https://other.example.com/' })
        command('sess-a')

        // The window is left where the person put it — that is the half of this that used to
        // be wrong: the command's page is what the *next* command is told, not what they are
        // shown (第十二轮).
        expect(instance.activeTabId).toBe(other)
        expect(driverOf(instanceId, first)).toBe('sess-a')
        expect(cursorOf(instanceId, first)).toBe('sess-a')
        expect(driverOf(instanceId, other)).toBeNull()
        expect(cursorOf(instanceId, other)).toBeNull()
      })

      // …and it *acts* there: the page is named to the manager, so a command works on the
      // conversation's page and the window does not move (plan §22, 第十二轮).
      it('acts on the page it is given, without moving the window', async () => {
        const instance = usedWindow('first', 'sess-a')
        const instanceId = instance.id
        const mine = instance.tabs[0]
        const persons = manager.createTab(instanceId, { url: 'https://person.example.com/' })
        expect(instance.activeTabId).toBe(persons)

        await manager.navigate(instanceId, 'https://work.example.com/', mine.id)

        expect(mine.pageView.webContents.loadURL).toHaveBeenCalledWith('https://work.example.com/')
        expect(instance.activeTabId).toBe(persons)

        // A page that is gone is an error rather than a slide onto the page on screen: the
        // named page was the whole point of the command.
        expect(() => manager.reload(instanceId, 'tab-that-never-was')).toThrow(/no page/)
      })

      /**
       * A capability call as the remote bridge sends it — the wire the routing has to survive,
       * because the manager on the other end is one shared instance and the page is not in the
       * arguments (plan §22, 第十二轮).
       */
      async function invoke(req: {
        method: string
        args: unknown[]
        tabId?: string
      }): Promise<unknown> {
        manager.registerCapabilityIpc()
        const registration = (
          mockIpcMainHandle.mock.calls as unknown as Array<
            [string, (_event: unknown, request: unknown) => Promise<unknown>]
          >
        ).find(([channel]) => channel === '__browser:invoke')
        if (!registration) throw new Error('Expected __browser:invoke IPC registration')
        return await registration[1]({}, { v: 1, sessionId: 'sess-a', workspaceId: 'ws-a', ...req })
      }

      it('takes the page off the request when it comes from the bridge', async () => {
        const instance = usedWindow('first', 'sess-a')
        const instanceId = instance.id
        const mine = instance.tabs[0]
        const persons = manager.createTab(instanceId, { url: 'https://person.example.com/' })

        await invoke({ method: 'navigate', args: [instanceId, 'https://work.example.com/'], tabId: mine.id })

        expect(mine.pageView.webContents.loadURL).toHaveBeenCalledWith('https://work.example.com/')
        expect(instance.activeTabId).toBe(persons)
      })

      // A request that names no page still means the page on screen: that is what the person's
      // own toolbar calls mean, and it is the only reading that does not make every caller
      // resolve a page it has no opinion about.
      it('falls back to the page on screen when the request names none', async () => {
        const instance = usedWindow('first', 'sess-a')
        const instanceId = instance.id
        const personsId = manager.createTab(instanceId, { url: 'https://person.example.com/' })
        const persons = instance.tabs.find((tab: any) => tab.id === personsId)

        await invoke({ method: 'navigate', args: [instanceId, 'https://work.example.com/'] })

        expect(persons.pageView.webContents.loadURL).toHaveBeenCalledWith('https://work.example.com/')
      })

      /**
       * The page lock names the **caller**, in the id the caller knows itself by.
       *
       * The bridge is where that can go wrong: the manager writes down whatever identity
       * the request carries, and the agent reads `lockedBy` back and compares it with its
       * own session id — two spellings of one conversation would make it refuse its own
       * page as somebody else's (plan §22, 第九轮).
       */
      it('locks the page for the bridge caller, under the id that caller uses', async () => {
        const instance = usedWindow('lock', 'sess-a')
        const instanceId = instance.id
        const tabId = instance.tabs[0].id

        await invoke({ method: 'setAgentControl', args: ['sess-a', { displayName: 'Click' }] })
        await invoke({ method: 'setSessionPage', args: [instanceId, tabId, 'sess-a'] })

        const locked = manager.listTabs(instanceId).find((tab) => tab.id === tabId)!
        expect(locked.lockedBy).toBe('sess-a')
        // The conversation holding it is not told its own page is busy…
        expect(whyTabIsLocked(locked, 'sess-a')).toBeNull()
        // …while another one is, which is what the lock is for.
        expect(whyTabIsLocked(locked, 'sess-b')).toContain('locked')
      })

      it('a conversation keeps driving its page after another one takes the window', () => {
        // The lease is per page, so the window changing hands does not erase the fact
        // that a page is mid-work — the conversation's own pages stay its own until its
        // turn ends.
        const instance = usedWindow('first', 'sess-a')
        const instanceId = instance.id
        const first = instance.tabs[0].id

        command('sess-a')
        const second = manager.createTab(instanceId, {
          url: 'https://second.example.com/',
          openedBySessionId: 'sess-a',
        })
        expect(driverOf(instanceId, first)).toBe('sess-a')
        expect(driverOf(instanceId, second)).toBe('sess-a')

        // Another conversation's command takes the window, and — having no page of its own
        // — the page on screen.
        command('sess-b')
        expect(driverOf(instanceId, second)).toBe('sess-b')
        expect(driverOf(instanceId, first)).toBe('sess-a')

        // And the first conversation's turn ending clears *its* page, wherever the
        // window's lease has got to since.
        manager.unbindAllForSession('sess-a')
        expect(driverOf(instanceId, first)).toBeNull()
        expect(driverOf(instanceId, second)).toBe('sess-b')
      })

      it('lets a page the reader is not looking at stay idle', () => {
        const instance = usedWindow('first', 'sess-a')
        const idle = manager.createTab(instance.id, { url: 'https://idle.example.com/', activate: false })

        command('sess-a')

        expect(driverOf(instance.id, idle)).toBeNull()
        expect(cursorOf(instance.id, idle)).toBeNull()
      })
    })
  })

  it('navigate normalizes hostnames to https', async () => {
    manager.createInstance('nav-1')
    await manager.navigate('nav-1', 'example.com')
    const instance = (manager as any).instances.get('nav-1')
    expect(page(instance).pageView.webContents.loadURL).toHaveBeenCalledWith('https://example.com')
  })

  it('navigate treats plain text as search query', async () => {
    manager.createInstance('nav-2')
    await manager.navigate('nav-2', 'craft agents browser tools')
    const instance = (manager as any).instances.get('nav-2')
    expect(page(instance).pageView.webContents.loadURL).toHaveBeenCalledWith(
      'https://duckduckgo.com/?q=craft%20agents%20browser%20tools'
    )
  })

  /**
   * Electron hands an abort to whichever `loadURL` promise is *current*, so
   * creating a window (which loads the empty state) and pointing it somewhere in
   * the same breath makes a **successful** navigation reject with the *previous*
   * document's abort. Reported as a failure it says "navigate failed" about a page
   * that is already on screen — and the fields that would identify it are empty in
   * practice (`{"errno":-3,"code":"","url":"file:///…/browser-empty-state.html"}`),
   * so `errno` is what we match on.
   */
  it('does not report a navigation as failed when it aborted an earlier load', async () => {
    manager.createInstance('nav-superseded')
    const instance = (manager as any).instances.get('nav-superseded')
    page(instance).currentUrl = 'https://example.com'
    page(instance).title = 'Example'
    page(instance).pageView.webContents.loadURL = mock(async () => {
      throw Object.assign(new Error("ERR_ABORTED (-3) loading 'browser-empty-state.html'"), {
        errno: -3,
        code: '',
        url: 'file:///C:/app/dist/renderer/browser-empty-state.html',
      })
    })

    const result = await manager.navigate('nav-superseded', 'https://example.com')

    expect(result).toEqual({ url: 'https://example.com', title: 'Example' })
  })

  // …but an abort of the URL we asked for means we are not there, and a failure
  // that is not an abort stays a failure.
  it('still fails when the aborted load was the one it asked for', async () => {
    manager.createInstance('nav-aborted-self')
    const instance = (manager as any).instances.get('nav-aborted-self')
    page(instance).pageView.webContents.loadURL = mock(async () => {
      throw Object.assign(new Error('ERR_ABORTED (-3) loading'), {
        errno: -3,
        code: '',
        url: 'https://example.com',
      })
    })

    await expect(manager.navigate('nav-aborted-self', 'https://example.com')).rejects.toThrow('ERR_ABORTED')
  })

  it('still fails on a load error that is not an abort', async () => {
    manager.createInstance('nav-broken')
    const instance = (manager as any).instances.get('nav-broken')
    page(instance).pageView.webContents.loadURL = mock(async () => {
      throw Object.assign(new Error('ERR_NAME_NOT_RESOLVED'), { errno: -105, code: 'ERR_NAME_NOT_RESOLVED' })
    })

    await expect(manager.navigate('nav-broken', 'https://nope.invalid')).rejects.toThrow('ERR_NAME_NOT_RESOLVED')
  })

  it('clears navigation timeout timer on success', async () => {
    manager.createInstance('nav-timeout')

    const originalClearTimeout = globalThis.clearTimeout
    const clearTimeoutSpy = mock((handle: Parameters<typeof clearTimeout>[0]) => originalClearTimeout(handle))
    ;(globalThis as any).clearTimeout = clearTimeoutSpy

    try {
      await manager.navigate('nav-timeout', 'https://example.com')
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(0)
    } finally {
      ;(globalThis as any).clearTimeout = originalClearTimeout
    }
  })

  it('focus brings the instance window to front', () => {
    manager.createInstance('f1')
    manager.focus('f1')

    const instance = (manager as any).instances.get('f1')
    instance.window._emit('ready-to-show')

    expect(instance.window.show).toHaveBeenCalled()
    expect(instance.window.focus).toHaveBeenCalled()
  })

  it('dedupes repeated focus calls before ready-to-show', () => {
    manager.createInstance('f2')

    manager.focus('f2')
    manager.focus('f2')
    manager.focus('f2')

    const instance = (manager as any).instances.get('f2')
    instance.window._emit('ready-to-show')

    expect(instance.window.show.mock.calls.length).toBe(1)
    expect(instance.window.focus.mock.calls.length).toBe(1)
  })

  it('cancels deferred pre-ready focus when hide happens first', () => {
    manager.createInstance('f-hide-race')

    manager.focus('f-hide-race')
    manager.hide('f-hide-race')

    const instance = (manager as any).instances.get('f-hide-race')
    const showCallsBeforeReady = instance.window.show.mock.calls.length
    const focusCallsBeforeReady = instance.window.focus.mock.calls.length

    instance.window._emit('ready-to-show')

    expect(instance.window.show.mock.calls.length).toBe(showCallsBeforeReady)
    expect(instance.window.focus.mock.calls.length).toBe(focusCallsBeforeReady)
  })

  it('user close hides window and keeps instance alive', () => {
    manager.createInstance('h1')
    const instance = (manager as any).instances.get('h1')

    const closeEvent = { preventDefault: mock(() => {}) }
    instance.window._emit('close', closeEvent)

    expect(closeEvent.preventDefault).toHaveBeenCalled()
    expect(instance.window.hide).toHaveBeenCalled()
    expect(manager.listInstances()).toHaveLength(1)
    expect(manager.listInstances()[0].isVisible).toBe(false)
  })

  it('does not intercept close when destroy is explicit', () => {
    manager.createInstance('h-explicit-destroy')
    const instance = (manager as any).instances.get('h-explicit-destroy')

    ;(manager as any).destroyingIds.add('h-explicit-destroy')

    const closeEvent = { preventDefault: mock(() => {}) }
    instance.window._emit('close', closeEvent)

    expect(closeEvent.preventDefault).not.toHaveBeenCalled()
    expect(instance.window.hide).not.toHaveBeenCalled()
  })

  it('still destroys instance when cleanup throws', () => {
    manager.createInstance('destroy-cleanup-throw')
    const instance = (manager as any).instances.get('destroy-cleanup-throw')

    ;(manager as any).updateNativeOverlayState = () => {
      throw new Error('mock overlay cleanup failure')
    }

    expect(() => manager.destroyInstance('destroy-cleanup-throw')).not.toThrow()
    expect(instance.window.destroy).toHaveBeenCalledTimes(1)
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('emits removed callback when window closes', () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))
    manager.createInstance('r1')

    const instance = (manager as any).instances.get('r1')
    instance.window._emit('closed')

    expect(removed).toEqual(['r1'])
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('retries toolbar load and recovers', async () => {
    toolbarLoadFailuresRemaining = 2
    manager.createInstance('retry-toolbar')

    await Bun.sleep(1400)

    const toolbarWindow = createdWindows[0]
    const fileAttempts = toolbarWindow.webContents.loadFile.mock.calls.length
    const toolbarUrlAttempts = toolbarWindow.webContents.loadURL.mock.calls
      .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length
    const totalAttempts = fileAttempts + toolbarUrlAttempts

    expect(totalAttempts).toBe(3)
    expect(toolbarWindow.webContents.loadURL).not.toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
  })

  it('loads toolbar fallback page after retry exhaustion', async () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('fallback-toolbar')

    await Bun.sleep(3200)

    const toolbarWindow = createdWindows[0]
    const fileAttempts = toolbarWindow.webContents.loadFile.mock.calls.length
    const toolbarUrlAttempts = toolbarWindow.webContents.loadURL.mock.calls
      .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length
    const totalAttempts = fileAttempts + toolbarUrlAttempts

    expect(totalAttempts).toBe(5)
    expect(toolbarWindow.webContents.loadURL).toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
  })

  it('captures and filters console entries', () => {
    manager.createInstance('console-1')
    const instance = (manager as any).instances.get('console-1')

    page(instance).pageView.webContents._emit('console-message', 2, 'warn message')
    page(instance).pageView.webContents._emit('console-message', 3, 'error message')

    const allEntries = manager.getConsoleLogs('console-1', { level: 'all', limit: 10 })
    expect(allEntries).toHaveLength(2)

    const warnEntries = manager.getConsoleLogs('console-1', { level: 'warn', limit: 10 })
    expect(warnEntries).toHaveLength(1)
    expect(warnEntries[0].message).toBe('warn message')
  })

  it('applies observer theme signal and skips regular console logging for it', () => {
    manager.createInstance('theme-signal')
    const instance = (manager as any).instances.get('theme-signal')
    page(instance).themeObserverToken = 'tok-1'

    page(instance).pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-1:#123456')

    expect(manager.listInstances().find(i => i.id === 'theme-signal')?.themeColor).toBe('#123456')
    expect(manager.getConsoleLogs('theme-signal', { level: 'all', limit: 10 })).toHaveLength(0)
  })

  it('dedupes repeated observer theme signals', () => {
    manager.createInstance('theme-dedupe')
    const instance = (manager as any).instances.get('theme-dedupe')
    page(instance).themeObserverToken = 'tok-2'

    page(instance).pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-2:#445566')
    const sendCallsAfterFirst = instance.window.webContents.send.mock.calls.length

    page(instance).pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-2:#445566')
    const sendCallsAfterSecond = instance.window.webContents.send.mock.calls.length

    expect(sendCallsAfterSecond).toBe(sendCallsAfterFirst)
  })

  it('ignores observer theme signals from stale token', () => {
    manager.createInstance('theme-stale-token')
    const instance = (manager as any).instances.get('theme-stale-token')
    page(instance).themeObserverToken = 'tok-current'
    page(instance).themeColor = '#aaaaaa'

    page(instance).pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-old:#bbccdd')

    expect(manager.listInstances().find(i => i.id === 'theme-stale-token')?.themeColor).toBe('#aaaaaa')
  })

  it('clears theme on explicit null sentinel signal', () => {
    manager.createInstance('theme-null')
    const instance = (manager as any).instances.get('theme-null')
    page(instance).themeObserverToken = 'tok-null'

    page(instance).pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-null:#223344')
    expect(manager.listInstances().find(i => i.id === 'theme-null')?.themeColor).toBe('#223344')

    page(instance).pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-null:__NULL__')
    expect(manager.listInstances().find(i => i.id === 'theme-null')?.themeColor).toBeNull()
  })

  // The chrome draws the app's colours, not the page's, so the state it gets is about
  // the page (address, title, back/forward, picker, pages) and never about how the page
  // looks. The page's own colour is still measured — the top bar's chip uses it — and
  // that is a different test (the theme-signal ones above).
  it('replays toolbar state when window is shown', () => {
    manager.createInstance('theme-show-replay')
    const instance = (manager as any).instances.get('theme-show-replay')

    page(instance).currentUrl = 'https://example.com'
    page(instance).title = 'Example'
    page(instance).canGoBack = true
    page(instance).canGoForward = false

    const sendsBeforeShow = instance.toolbarView.webContents.send.mock.calls.length
    instance.window._emit('show')

    const sendCallsAfterShow = instance.toolbarView.webContents.send.mock.calls.slice(sendsBeforeShow)
    expect(sendCallsAfterShow).toContainEqual([
      'browser-toolbar:state-update',
      {
        url: 'https://example.com',
        title: 'Example',
        isLoading: false,
        canGoBack: true,
        canGoForward: false,
        // No resolver is installed here, and nothing is bound: the toolbar's
        // prototype actions have nothing to act on.
        prototypeSlug: null,
        // The picker is off, and the window has one page — which the rail draws and
        // the bar leaves alone.
        picking: false,
        tabs: [
          tabSummary({ id: instance.tabs[0].id, url: 'https://example.com', title: 'Example', active: true }),
        ],
        // Nothing opened these pages through a conversation, so there is no group to
        // name — the rail draws no headers for a window that is all one person's.
        sessionLabels: {},
      },
    ])
  })

  it('replays full toolbar state when toolbar renderer finishes loading', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-finish-load-replay')
    const instance = (manager as any).instances.get('toolbar-finish-load-replay')

    page(instance).currentUrl = 'https://craft.do'
    page(instance).title = 'Craft'
    page(instance).isLoading = true
    page(instance).canGoBack = true
    page(instance).canGoForward = true

    instance.toolbarView.webContents.getURL = mock(() => 'http://localhost:5173/browser-toolbar.html?instanceId=toolbar-finish-load-replay')

    const sendsBeforeFinishLoad = instance.toolbarView.webContents.send.mock.calls.length
    instance.toolbarView.webContents._emit('did-finish-load')

    const sendCallsAfterFinishLoad = instance.toolbarView.webContents.send.mock.calls.slice(sendsBeforeFinishLoad)
    expect(sendCallsAfterFinishLoad).toContainEqual([
      'browser-toolbar:state-update',
      {
        url: 'https://craft.do',
        title: 'Craft',
        isLoading: true,
        canGoBack: true,
        canGoForward: true,
        prototypeSlug: null,
        picking: false,
        tabs: [
          tabSummary({ id: instance.tabs[0].id, url: 'https://craft.do', title: 'Craft', isLoading: true, active: true }),
        ],
        sessionLabels: {},
      },
    ])
  })

  /**
   * The window is an app surface: what it is working on is the prototype, and
   * the address bar is where that is said. An overlay renders a third-party page,
   * so without this the bar would describe the site instead of the work.
   */
  describe('the address bar names the prototype', () => {
    const ORIGIN = 'http://checkout-flow-abc123ab.localhost:41234'

    /** The last toolbar state pushed to a window. */
    function lastToolbarState(instance: any): { url: string; prototypeSlug: string | null } {
      const calls = instance.toolbarView.webContents.send.mock.calls.filter(
        (call: unknown[]) => call[0] === 'browser-toolbar:state-update',
      )
      return calls[calls.length - 1]?.[1]
    }

    /**
     * Stands in for the server's own label→prototype map plus `pageOfPrototypeUrl`:
     * the root names the prototype (`page: null`), `/<name>` names one of its pages
     * when that page exists, and anything else on that host — a file, an SPA route
     * — is not ours to resolve (`null`), so it stays an ordinary navigation.
     */
    function addressResolverFor(pages: string[] = []) {
      return (url: string): { binding: { slug: string; origin: string }; page: string | null } | null => {
        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          return null
        }
        if (parsed.host !== new URL(ORIGIN).host) return null

        const segment = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
        const binding = { slug: 'checkout-flow', origin: ORIGIN }
        if (!segment) return { binding, page: null }
        return segment.includes('/') || !pages.includes(segment) ? null : { binding, page: segment }
      }
    }

    /** The registered `browser-toolbar:navigate` handler. */
    function navigateHandler(): (_event: unknown, instanceId: string, url: string) => Promise<void> {
      const registration = (
        mockIpcMainHandle.mock.calls as unknown as Array<
          [string, (_event: unknown, instanceId: string, url: string) => Promise<void>]
        >
      ).find(([channel]) => channel === 'browser-toolbar:navigate')
      if (!registration) throw new Error('Expected browser-toolbar:navigate IPC registration')
      return registration[1]
    }

    /** Replaces the navigation itself, so the test can see whether it happened. */
    function spyOnNavigate(): ReturnType<typeof mock> {
      const spy = mock(async (_id: string, _url: string) => ({ url: '', title: '' }))
      manager.navigate = spy as unknown as typeof manager.navigate
      return spy
    }

    /** A window bound to a session that works on `checkout-flow`. */
    function boundWindow(id: string): any {
      manager.setPrototypeWindowResolver((sessionId) =>
        sessionId === 'session-1' ? { slug: 'checkout-flow', origin: ORIGIN } : null,
      )
      manager.createInstance(id)
      const instance = (manager as any).instances.get(id)
      instance.boundSessionId = 'session-1'
      return instance
    }

    it('shows the prototype for an overlay, whose page is a third-party site', () => {
      const instance = boundWindow('overlay-window')
      page(instance).currentUrl = 'https://app.example.com/checkout'

      instance.window._emit('show')

      expect(lastToolbarState(instance)).toMatchObject({ url: ORIGIN, prototypeSlug: 'checkout-flow' })
    })

    /**
     * Which page belongs in the bar as much as which prototype: the root alone
     * hides the page you are on and — since typing it opens the entry page — loses
     * it. The page's own address is what survives being typed back.
     */
    it('shows which page an overlay window is on, not just the prototype', () => {
      const instance = boundWindow('overlay-page-window')
      page(instance).currentUrl = 'https://app.example.com/checkout/pay'
      // Stands in for the page table: that address is the page called `pay`.
      manager.setPrototypePageResolver((slug, _origin, url) =>
        slug === 'checkout-flow' && url === 'https://app.example.com/checkout/pay' ? 'pay' : null,
      )

      instance.window._emit('show')

      expect(lastToolbarState(instance)).toMatchObject({
        url: `${ORIGIN}/pay`,
        prototypeSlug: 'checkout-flow',
      })
    })

    // And when the window is somewhere the flow does not describe, the bar falls
    // back to the root rather than inventing a page.
    it('falls back to the prototype root when the window is on none of its pages', () => {
      const instance = boundWindow('overlay-stray-window')
      page(instance).currentUrl = 'https://elsewhere.example.com/'
      manager.setPrototypePageResolver(() => null)

      instance.window._emit('show')

      expect(lastToolbarState(instance)).toMatchObject({ url: ORIGIN, prototypeSlug: 'checkout-flow' })
    })

    it('keeps the real URL while the document is already served by the prototype', () => {
      const instance = boundWindow('scratch-window')
      page(instance).currentUrl = `${ORIGIN}/dist/prototype.html`

      instance.window._emit('show')

      expect(lastToolbarState(instance)).toMatchObject({
        url: `${ORIGIN}/dist/prototype.html`,
        prototypeSlug: 'checkout-flow',
      })
    })

    // Typing an address that names a prototype asks for *the prototype*: an
    // overlay has no page of its own at that address, so fetching it would 404 on
    // a perfectly valid request. It goes to the workbench instead, which resolves
    // per kind and replays the patches (the path the panel's preview takes).
    it('routes a typed prototype address to the workbench instead of fetching it', async () => {
      const actions: Array<{ kind: string; instanceId: string; slug?: string; page?: string | null }> = []
      manager.setWindowManager({
        getRpcEventSink: () => (_channel: string, _routing: unknown, payload: unknown) => {
          actions.push(payload as { kind: string; instanceId: string; slug?: string })
        },
      } as any)
      manager.setPrototypeAddressResolver(addressResolverFor())
      const instance = boundWindow('typed-window')
      page(instance).currentUrl = 'https://app.example.com/checkout'
      const navigate = spyOnNavigate()
      manager.registerToolbarIpc()

      await navigateHandler()({}, 'typed-window', `${ORIGIN}/`)

      expect(actions).toContainEqual({
        kind: 'open-prototype',
        instanceId: 'typed-window',
        slug: 'checkout-flow',
        page: null,
      })
      expect(navigate).not.toHaveBeenCalled()
      // Naming a prototype asks for *it*, so it gets a page of its own: the page
      // the window was on is still there, and the prototype is beside it rather
      // than in place of it (plan §22).
      expect(page(instance).boundPrototype).toBeNull()
      expect(instance.tabs).toHaveLength(2)
      expect(instance.tabs[1].boundPrototype).toEqual({ slug: 'checkout-flow', origin: ORIGIN })
    })

    // A path below the root is a file, not a page (§16.3) — that stays an ordinary
    // navigation, so `/dist/prototype.html` still works from the bar.
    it('navigates normally to a path inside a prototype', async () => {
      manager.setPrototypeAddressResolver(addressResolverFor(['pay']))
      boundWindow('file-window')
      const navigate = spyOnNavigate()
      manager.registerToolbarIpc()

      await navigateHandler()({}, 'file-window', `${ORIGIN}/dist/prototype.html`)

      expect(navigate).toHaveBeenCalledWith('file-window', `${ORIGIN}/dist/prototype.html`)
    })

    /**
     * A page's own address looks like the root but is not it: it names one page, and
     * the answer is where that page actually is. The view then loads that real
     * address (a live page's own, or the host's rendering of one of ours) — nothing
     * is redirected through the prototype — while the bar keeps saying which page
     * this is.
     */
    it('resolves a page address to that page, rather than fetching the address', async () => {
      const actions: Array<{ kind: string; instanceId: string; slug?: string; page?: string | null }> = []
      manager.setWindowManager({
        getRpcEventSink: () => (_channel: string, _routing: unknown, payload: unknown) => {
          actions.push(payload as { kind: string; instanceId: string; slug?: string; page?: string | null })
        },
      } as any)
      manager.setPrototypeAddressResolver(addressResolverFor(['pay']))
      boundWindow('page-address-window')
      const navigate = spyOnNavigate()
      manager.registerToolbarIpc()

      await navigateHandler()({}, 'page-address-window', `${ORIGIN}/pay`)

      expect(actions).toContainEqual({
        kind: 'open-prototype',
        instanceId: 'page-address-window',
        slug: 'checkout-flow',
        page: 'pay',
      })
      expect(navigate).not.toHaveBeenCalled()
    })

    it('shows the page itself for a window that has no prototype', () => {
      manager.createInstance('plain-window')
      const instance = (manager as any).instances.get('plain-window')
      page(instance).currentUrl = 'https://example.com/'

      instance.window._emit('show')

      expect(lastToolbarState(instance)).toMatchObject({ url: 'https://example.com/', prototypeSlug: null })
    })

    /**
     * The case that matters most, and the one that was broken: create a prototype,
     * press Open — and there is no conversation yet, so the session chain has
     * nothing to say. The bar read the third-party address and the prototype
     * actions were greyed out, i.e. the window did not know it was the prototype's.
     * Identity is stated by the opener (the entry's `origin`) instead of deduced.
     */
    it('is told which prototype it was opened for, with no conversation in sight', () => {
      manager.createInstance('opened-window')
      const instance = (manager as any).instances.get('opened-window')
      manager.createTab('opened-window', { prototype: { slug: 'checkout-flow', origin: ORIGIN } })
      page(instance).currentUrl = 'https://app.example.com/checkout'

      instance.window._emit('show')

      expect(instance.boundSessionId).toBeNull()
      expect(lastToolbarState(instance)).toMatchObject({ url: ORIGIN, prototypeSlug: 'checkout-flow' })
    })

    // Typing the address is the other explicit instruction that says so, and it
    // has to stick: the view immediately navigates on to the live page, which
    // would otherwise leave the bar describing that page again.
    it('is bound to the prototype whose address was typed into it', async () => {
      manager.setPrototypeAddressResolver(addressResolverFor())
      manager.createInstance('typed-unbound')
      const instance = (manager as any).instances.get('typed-unbound')
      manager.registerToolbarIpc()
      spyOnNavigate()

      await navigateHandler()({}, 'typed-unbound', `${ORIGIN}/`)
      page(instance).currentUrl = 'https://app.example.com/checkout'
      instance.window._emit('show')

      expect(lastToolbarState(instance)).toMatchObject({ url: ORIGIN, prototypeSlug: 'checkout-flow' })
    })

    // A window opened for a prototype outranks what its session is working on:
    // the window is the more specific fact, and it is the one the user is looking at.
    it('prefers the window own binding over the session one', () => {
      manager.setPrototypeWindowResolver(() => ({ slug: 'another-prototype', origin: 'http://another-1a2b3c4d.localhost' }))
      manager.createInstance('both-bindings')
      const instance = (manager as any).instances.get('both-bindings')
      instance.boundSessionId = 'session-1'
      manager.createTab('both-bindings', { prototype: { slug: 'checkout-flow', origin: ORIGIN } })
      page(instance).currentUrl = 'https://app.example.com/checkout'

      instance.window._emit('show')

      expect(lastToolbarState(instance)).toMatchObject({ url: ORIGIN, prototypeSlug: 'checkout-flow' })
    })

    // The panel resolves the same fact out of the window list (its actions need
    // the slug), so the list has to carry it — a slug only the toolbar knew would
    // mean the bar named the prototype while the buttons stayed greyed out.
    it('reports the prototype in the window list', () => {
      manager.createInstance('listed-window')
      manager.createTab('listed-window', { prototype: { slug: 'checkout-flow', origin: ORIGIN } })

      expect(manager.listInstances().find((item) => item.id === 'listed-window')?.prototypeSlug).toBe('checkout-flow')
    })
  })

  it('does not mark toolbar ready for about:blank did-finish-load', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-ignore-about-blank')
    const instance = (manager as any).instances.get('toolbar-ignore-about-blank')

    instance.toolbarView.webContents.getURL = mock(() => 'about:blank')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(false)
  })

  it('marks toolbar ready for fallback data page did-finish-load', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-fallback-ready')
    const instance = (manager as any).instances.get('toolbar-fallback-ready')

    instance.toolbarView.webContents.getURL = mock(() => 'data:text/html;charset=UTF-8,%3Chtml%3E%3C%2Fhtml%3E')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(true)
  })

  it('keeps focus deferred until a valid toolbar document loads', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-focus-guard')
    const instance = (manager as any).instances.get('toolbar-focus-guard')

    manager.focus('toolbar-focus-guard')
    expect(instance.pendingShowOnReady).toBe(true)
    expect(instance.window.show).toHaveBeenCalledTimes(0)

    instance.toolbarView.webContents.getURL = mock(() => 'about:blank')
    instance.toolbarView.webContents._emit('did-finish-load')
    expect(instance.window.show).toHaveBeenCalledTimes(0)

    instance.toolbarView.webContents.getURL = mock(() => 'file:///mock/renderer/browser-toolbar.html')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(true)
    expect(instance.window.show).toHaveBeenCalledTimes(1)
    expect(instance.window.focus).toHaveBeenCalledTimes(1)
  })

  it('runs early theme extraction shortly after navigation', async () => {
    manager.createInstance('theme-early')
    const instance = (manager as any).instances.get('theme-early')
    page(instance).pageView.webContents.executeJavaScript = mock(async () => '#0f1e2d')

    page(instance).pageView.webContents._emit('did-navigate', 'https://example.com')

    await Bun.sleep(140)

    expect(manager.listInstances().find(i => i.id === 'theme-early')?.themeColor).toBe('#0f1e2d')
  })

  it('clears pending in-page theme timer on full navigation', async () => {
    manager.createInstance('theme-timer-clear')
    const instance = (manager as any).instances.get('theme-timer-clear')

    page(instance).pageView.webContents._emit('did-navigate-in-page', 'https://example.com/route-a')
    await Bun.sleep(0)
    expect(page(instance).inPageThemeTimer).not.toBeNull()

    page(instance).pageView.webContents._emit('did-navigate', 'https://example.com/full-nav')
    expect(page(instance).inPageThemeTimer).toBeNull()
  })

  it('throws when screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('screenshot-empty-image')
    const instance = (manager as any).instances.get('screenshot-empty-image')
    page(instance).pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: function() { return this },
      toPNG: () => Buffer.from('ignored'),
      toJPEG: () => Buffer.from('ignored'),
    }))

    await expect(manager.screenshot('screenshot-empty-image')).rejects.toThrow('Failed to capture screenshot: empty image buffer')
  })

  it('throws when screenshot capture returns empty PNG buffer', async () => {
    manager.createInstance('screenshot-empty-png')
    const instance = (manager as any).instances.get('screenshot-empty-png')
    page(instance).pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function() { return this },
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
    }))

    await expect(manager.screenshot('screenshot-empty-png')).rejects.toThrow('Failed to capture screenshot: empty image buffer')
  })

  it('recovers screenshot via non-disruptive inactive reveal and restores hidden state', async () => {
    manager.createInstance('screenshot-rescue-success')
    const instance = (manager as any).instances.get('screenshot-rescue-success')

    let captureCalls = 0
    page(instance).pageView.webContents.capturePage = mock(async () => {
      captureCalls += 1
      if (captureCalls <= 3) {
        return {
          isEmpty: () => true,
          getSize: () => ({ width: 0, height: 0 }),
          resize: function() { return this },
          toPNG: () => Buffer.alloc(0),
          toJPEG: () => Buffer.alloc(0),
        }
      }

      const img = {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1800 }),
        resize: () => img,
        toPNG: () => Buffer.from('rescued-png'),
        toJPEG: (_q: number) => Buffer.from('rescued-jpeg'),
      }
      return img
    })

    const result = await manager.screenshot('screenshot-rescue-success', { includeMetadata: true })

    expect(result.imageBuffer.toString()).toBe('rescued-png')
    expect(instance.window.showInactive).toHaveBeenCalledTimes(1)
    expect(instance.window.focus).not.toHaveBeenCalled()
    expect(instance.window.hide).toHaveBeenCalled()
    expect(result.metadata?.warnings?.some((w: string) => w.includes('temporary inactive reveal'))).toBe(true)
  })

  it('throws when region screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('region-empty-image')
    const instance = (manager as any).instances.get('region-empty-image')
    page(instance).pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: function() { return this },
      toPNG: () => Buffer.from('ignored'),
      toJPEG: () => Buffer.from('ignored'),
    }))

    await expect(manager.screenshotRegion('region-empty-image', { x: 10, y: 20, width: 120, height: 80 })).rejects.toThrow(
      'Failed to capture region screenshot: empty image buffer'
    )
  })

  it('throws when region screenshot capture returns empty PNG buffer', async () => {
    manager.createInstance('region-empty-png')
    const instance = (manager as any).instances.get('region-empty-png')
    page(instance).pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function() { return this },
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
    }))

    await expect(manager.screenshotRegion('region-empty-png', { x: 10, y: 20, width: 120, height: 80 })).rejects.toThrow(
      'Failed to capture region screenshot: empty image buffer'
    )
  })

  it('captures screenshot region from ref target', async () => {
    manager.createInstance('region-ref')
    const result = await manager.screenshotRegion('region-ref', { ref: '@e1' })

    expect(result.imageBuffer).toBeInstanceOf(Buffer)
    expect(result.metadata?.targetMode).toBe('ref')
  })

  it('captures screenshot region from selector target', async () => {
    manager.createInstance('region-selector')
    const result = await manager.screenshotRegion('region-selector', { selector: 'div.card', padding: 4 })

    expect(result.imageBuffer).toBeInstanceOf(Buffer)
    expect(result.metadata?.targetMode).toBe('selector')
  })

  it('throws for ambiguous screenshot region target modes', async () => {
    manager.createInstance('region-ambiguous')

    await expect(
      manager.screenshotRegion('region-ambiguous', { ref: '@e1', selector: 'div.card' })
    ).rejects.toThrow('Region screenshot target is ambiguous')
  })

  it('throws when selector target cannot be resolved', async () => {
    manager.createInstance('region-selector-missing')
    const instance = (manager as any).instances.get('region-selector-missing')
    page(instance).cdp.getElementGeometryBySelector = mock(async () => {
      throw new Error('No element found for selector "div.missing"')
    })

    await expect(
      manager.screenshotRegion('region-selector-missing', { selector: 'div.missing' })
    ).rejects.toThrow('No element found for selector "div.missing"')
  })

  it('throws when resolved region is outside viewport', async () => {
    manager.createInstance('region-oob')

    await expect(
      manager.screenshotRegion('region-oob', { x: 5000, y: 5000, width: 100, height: 100 })
    ).rejects.toThrow('Resolved screenshot region is outside the current viewport')
  })

  it('resizes browser window viewport and returns effective applied size', () => {
    manager.createInstance('resize-1')
    const resized = manager.windowResize('resize-1', 1280, 720)

    const instance = (manager as any).instances.get('resize-1')
    // 720 of page + the chrome (48 address bar + 200 page rail).
    expect(instance.window.setContentSize).toHaveBeenCalledWith(1480, 768)
    expect(resized).toEqual({ width: 1280, height: 720 })
  })

  it('returns effective viewport size when min window constraints apply', () => {
    manager.createInstance('resize-min')
    const resized = manager.windowResize('resize-min', 200, 200)

    // BrowserWindow minWidth/minHeight is 700x500, and the chrome takes 200 of the
    // width and 48 of the height, so the effective viewport is 500x452.
    expect(resized).toEqual({ width: 500, height: 452 })
  })

  describe('agent control overlay', () => {
    /**
     * The script the **page on screen's** overlay was last told to run — the shield is
     * drawn there and nowhere else, so this is where it is observable.
     */
    const overlayScript = (instance: any): string => {
      const active = instance.tabs.find((tab: any) => tab.id === instance.activeTabId)
      return active?.nativeOverlayView.webContents.executeJavaScript.mock.calls.at(-1)?.[0] ?? ''
    }

    it('setAgentControl activates native overlay on bound instance', async () => {
      manager.createInstance('ac-1')
      drive('ac-1', 'sess-1')

      manager.setAgentControl('sess-1', { displayName: 'Navigate Page', intent: 'Loading example.com' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-1')
      expect(instance.agentControl).toEqual({
        active: true,
        sessionId: 'sess-1',
        displayName: 'Navigate Page',
        intent: 'Loading example.com',
        // No command has resolved a page yet, so the overlay holds nothing.
        tabId: null,
      })
      expect(page(instance).nativeOverlayView.webContents.executeJavaScript).toHaveBeenCalled()
      expect(page(instance).nativeOverlayView.webContents.focus).not.toHaveBeenCalled()
      expect(manager.listInstances().find(i => i.id === 'ac-1')?.agentControlActive).toBe(true)
    })

    // The lock is drawn on the page, not the window (plan §22, 第九轮修正): the shield covers
    // the page the working session holds, and switching away hands the mouse and keyboard
    // back without releasing anything — the agent is still on *its* page.
    it('arms the page shield only while the page on screen is the one being worked on', async () => {
      /** Enough microtasks for a page's overlay document to finish loading. */
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 4; i += 1) await Promise.resolve()
      }

      manager.createInstance('ac-lock')
      drive('ac-lock', 'sess-lock')
      const instance = (manager as any).instances.get('ac-lock')
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      // The page the session is working on is the one on screen — commands act on the
      // page in front, which is what the lock follows.
      const heldId = manager.createTab('ac-lock', {
        url: 'https://held.example.com/',
        openedBySessionId: 'sess-lock',
      })
      const otherId = manager.createTab('ac-lock', { url: 'https://other.example.com/' })
      manager.activateTab('ac-lock', heldId)
      await settle()

      // The overlay alone holds nothing: it takes a command to resolve to a page.
      manager.setAgentControl('sess-lock', { displayName: 'Click', intent: 'Pressing Buy' })
      await settle()
      expect(overlayScript(instance)).toContain('const shieldActive = false;')

      // "Held" is about the page the command works on, and since 第十二轮 that is only the page
      // on screen when the conversation has no page of its own — so the test holds the page the
      // *person* is looking at, which is the case the shield exists for.
      manager.setSessionPage('ac-lock', heldId, 'sess-lock')
      await settle()

      // The held page is on screen: locked, and the pointer says so.
      expect(overlayScript(instance)).toContain('const shieldActive = true;')
      expect(overlayScript(instance)).toContain('const locked = true;')

      manager.activateTab('ac-lock', otherId)
      await settle()

      // A page the person switched to is not the agent's to hold.
      expect(overlayScript(instance)).toContain('const shieldActive = false;')
      expect(overlayScript(instance)).toContain('const locked = false;')
      // …while the page it *is* working on stays locked in the model.
      expect(manager.listTabs('ac-lock').find((tab) => tab.id === heldId)?.lockedBy).toBe('sess-lock')

      manager.activateTab('ac-lock', heldId)
      await settle()
      expect(overlayScript(instance)).toContain('const shieldActive = true;')
    })

    it('keeps native overlay visible for active session control', async () => {
      manager.createInstance('ac-idle')
      drive('ac-idle', 'sess-idle')

      manager.setAgentControl('sess-idle', {
        displayName: 'Browser',
        intent: 'Session controls this window',
      })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-idle')
      expect(page(instance).nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 200, y: 48, width: 1000, height: 852 })
      expect(page(instance).nativeOverlayView.webContents.focus).not.toHaveBeenCalled()
      expect(manager.listInstances().find(i => i.id === 'ac-idle')?.agentControlActive).toBe(true)
    })

    it('emits state change when agent control is set and cleared', () => {
      const stateEvents: any[] = []
      manager.onStateChange((info) => stateEvents.push(info))

      manager.createInstance('ac-state')
      drive('ac-state', 'sess-state')

      manager.setAgentControl('sess-state', { displayName: 'Browser Snapshot' })
      manager.clearAgentControl('sess-state')

      const acStateEvents = stateEvents.filter((event) => event.id === 'ac-state')
      expect(acStateEvents.some((event) => event.agentControlActive === true)).toBe(true)
      expect(acStateEvents.some((event) => event.agentControlActive === false)).toBe(true)
    })

    it('reapplies native overlay after did-stop-loading while control is active', async () => {
      manager.createInstance('ac-reapply')
      drive('ac-reapply', 'sess-reapply')

      manager.setAgentControl('sess-reapply', { displayName: 'Navigate Page', intent: 'Loading example.com' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-reapply')
      const callCountAfterSet = page(instance).nativeOverlayView.webContents.executeJavaScript.mock.calls.length

      page(instance).pageView.webContents._emit('did-stop-loading')
      await Promise.resolve()

      expect(page(instance).nativeOverlayView.webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(callCountAfterSet)
    })

    it('reapplies native overlay after hide/show while control is active', async () => {
      manager.createInstance('ac-show-reapply')
      drive('ac-show-reapply', 'sess-show-reapply')

      manager.setAgentControl('sess-show-reapply', { displayName: 'Click Button', intent: 'Clicking submit' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-show-reapply')
      const callCountAfterSet = page(instance).nativeOverlayView.webContents.executeJavaScript.mock.calls.length

      instance.window._emit('hide')
      instance.window._emit('show')
      await Promise.resolve()

      expect(page(instance).nativeOverlayView.webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(callCountAfterSet)
    })

    it('setAgentControl uses fallback label when no intent', async () => {
      manager.createInstance('ac-2')
      drive('ac-2', 'sess-2')

      manager.setAgentControl('sess-2', { displayName: 'Browser Snapshot' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-2')
      const calls = page(instance).nativeOverlayView.webContents.executeJavaScript.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(String(calls[calls.length - 1][0])).toContain('Browser Snapshot')
    })

    it('setAgentControl uses default label when no metadata', async () => {
      manager.createInstance('ac-3')
      drive('ac-3', 'sess-3')

      manager.setAgentControl('sess-3', {})
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-3')
      const calls = page(instance).nativeOverlayView.webContents.executeJavaScript.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(String(calls[calls.length - 1][0])).toContain('Agent is working…')
    })

    it('clearAgentControl dismisses native overlay', () => {
      manager.createInstance('ac-4')
      drive('ac-4', 'sess-4')

      manager.setAgentControl('sess-4', { displayName: 'Click Button', intent: 'Clicking submit' })
      manager.clearAgentControl('sess-4')

      const instance = (manager as any).instances.get('ac-4')
      expect(instance.agentControl).toBeNull()
      expect(page(instance).nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    })

    it('clearAgentControl is a no-op when not active', () => {
      manager.createInstance('ac-5')
      drive('ac-5', 'sess-5')

      manager.clearAgentControl('sess-5')

      const instance = (manager as any).instances.get('ac-5')
      expect(page(instance).nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    it('clearVisualsForSession resets agent control state', async () => {
      manager.createInstance('ac-6')
      drive('ac-6', 'sess-6')

      manager.setAgentControl('sess-6', { displayName: 'Fill Input', intent: 'Typing email' })
      await manager.clearVisualsForSession('sess-6')

      const instance = (manager as any).instances.get('ac-6')
      expect(instance.agentControl).toBeNull()
      expect(page(instance).nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    })

    it('setAgentControl ignores unbound sessions', () => {
      manager.createInstance('ac-7')

      manager.setAgentControl('nonexistent-session', { displayName: 'Test' })

      const instance = (manager as any).instances.get('ac-7')
      expect(instance.agentControl).toBeNull()
      expect(page(instance).nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    it('navigate does not trigger overlay by itself', async () => {
      manager.createInstance('ac-8')
      drive('ac-8', 'sess-8')

      await manager.navigate('ac-8', 'https://example.com')

      const instance = (manager as any).instances.get('ac-8')
      expect(instance.agentControl).toBeNull()
      expect(page(instance).nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })
  })

  describe('failed interaction tracking', () => {
    it('clickElement records failed lastAction on error', async () => {
      manager.createInstance('fail-click')
      const instance = (manager as any).instances.get('fail-click')
      page(instance).cdp.clickElement = mock(async () => { throw new Error('click failed') })

      await expect(manager.clickElement('fail-click', '@e1')).rejects.toThrow('click failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_click',
        ref: '@e1',
        status: 'failed',
      })
    })

    it('fillElement records failed lastAction on error', async () => {
      manager.createInstance('fail-fill')
      const instance = (manager as any).instances.get('fail-fill')
      page(instance).cdp.fillElement = mock(async () => { throw new Error('fill failed') })

      await expect(manager.fillElement('fail-fill', '@e2', 'hello')).rejects.toThrow('fill failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_fill',
        ref: '@e2',
        status: 'failed',
      })
    })

    it('selectOption records failed lastAction on error', async () => {
      manager.createInstance('fail-select')
      const instance = (manager as any).instances.get('fail-select')
      page(instance).cdp.selectOption = mock(async () => { throw new Error('select failed') })

      await expect(manager.selectOption('fail-select', '@e3', 'opt-1')).rejects.toThrow('select failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_select',
        ref: '@e3',
        status: 'failed',
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Tabs — one window, several pages (plan §22)
  // ---------------------------------------------------------------------------

  describe('tabs', () => {
    /** A page's own `did-navigate`, which is how a view reports where it landed. */
    function navigateOwn(tab: any, url: string) {
      tab.pageView.webContents.loadURL(url)
      tab.pageView.webContents._emit('did-navigate', url)
    }

    it('adds a page to the window and puts it on screen', () => {
      manager.createInstance('tabs-basic')
      const instance = (manager as any).instances.get('tabs-basic')
      const first = instance.tabs[0]
      // The page has been somewhere, so the window is in use and the new page is
      // added beside it rather than taking its place (see the untouched-window
      // test below).
      first.currentUrl = 'https://first.example.com/'

      const secondId = manager.createTab('tabs-basic', { url: 'https://second.example.com/' })
      const second = instance.tabs.find((tab: any) => tab.id === secondId)

      expect(instance.tabs).toHaveLength(2)
      expect(instance.activeTabId).toBe(secondId)
      // The window reports the page on screen, whichever it is.
      navigateOwn(second, 'https://second.example.com/')
      expect(instance.currentUrl).toBe('https://second.example.com/')
      expect(manager.listTabs('tabs-basic')).toEqual([
        tabSummary({ id: first.id, url: 'https://first.example.com/' }),
        // The title comes from the page (`getTitle()` in the mock), which is what a
        // real `did-navigate` would have reported too.
        tabSummary({ id: secondId, url: 'https://second.example.com/', title: 'Test Page', active: true }),
      ])
    })

    // A window is created holding one blank page. That page is what a window is
    // made of rather than something a person put there, so opening into a fresh
    // window opens *into* it: without this, a session that has just opened a
    // prototype would carry its own blank page beside it — a page nobody made and
    // nobody can name.
    it('opens into a window\'s untouched page instead of beside it', () => {
      manager.createInstance('tabs-fresh')
      const instance = (manager as any).instances.get('tabs-fresh')
      const only = instance.tabs[0]

      const tabId = manager.createTab('tabs-fresh', {
        url: 'https://fresh.example.com/',
        prototype: { slug: 'checkout-flow', origin: 'http://checkout-flow-ab12cd34.localhost' },
      })

      expect(tabId).toBe(only.id)
      expect(instance.tabs).toHaveLength(1)
      expect(instance.activeTabId).toBe(only.id)
      // The identity is the point of naming it: an overlay's document is a
      // third-party address, so the page has to be told whose it is.
      expect(only.boundPrototype).toEqual({
        slug: 'checkout-flow',
        origin: 'http://checkout-flow-ab12cd34.localhost',
      })
      expect(only.pageView.webContents.loadURL).toHaveBeenCalledWith('https://fresh.example.com/')
    })

    // The other half of that rule. A caller with neither a url nor an identity to put
    // in the window (the app's "New page", which opens the browser if it is not up yet)
    // wants *a* page, not one more page, and has to say so. On a window that is not up
    // yet its own blank page is the page being asked for: adding beside it is how "New
    // page" came up with two blank pages.
    it('gives an untouched window\'s own page to a caller that asked for one', () => {
      manager.createInstance('tabs-adopt-fresh')
      const instance = (manager as any).instances.get('tabs-adopt-fresh')
      const only = instance.tabs[0]

      const tabId = manager.createTab('tabs-adopt-fresh', { reuseUntouchedWindow: true })

      expect(tabId).toBe(only.id)
      expect(instance.tabs).toHaveLength(1)
      expect(instance.activeTabId).toBe(only.id)
    })

    it('adds a real page for that caller when the window is already in use', () => {
      manager.createInstance('tabs-adopt-used')
      const instance = (manager as any).instances.get('tabs-adopt-used')
      const first = instance.tabs[0]
      first.currentUrl = 'https://first.example.com/'

      const tabId = manager.createTab('tabs-adopt-used', { reuseUntouchedWindow: true })

      expect(tabId).not.toBe(first.id)
      expect(instance.tabs).toHaveLength(2)
      expect(instance.activeTabId).toBe(tabId)
    })

    // The reason the wiring had to move onto the page: a hidden page keeps loading,
    // and its events must land on itself rather than on whoever is on screen.
    it('keeps a background page\'s navigation on itself', () => {
      manager.createInstance('tabs-background')
      const instance = (manager as any).instances.get('tabs-background')
      const first = instance.tabs[0]
      first.currentUrl = 'https://first.example.com/'

      const secondId = manager.createTab('tabs-background', { activate: false })
      const second = instance.tabs.find((tab: any) => tab.id === secondId)

      expect(instance.activeTabId).toBe(first.id)
      navigateOwn(second, 'https://second.example.com/')

      expect(second.currentUrl).toBe('https://second.example.com/')
      expect(instance.currentUrl).toBe('https://first.example.com/')
      // A page that is not on screen is laid out at the same area as the one that is — not
      // parked at zero size, which left it with no viewport and nothing painted, and that is
      // what made a background page useless (plan §22, 第十二轮).
      expect(second.pageView.setBounds).toHaveBeenCalledWith({ x: 200, y: 48, width: 1000, height: 852 })
    })

    it('switches pages and reports the one that came forward', () => {
      manager.createInstance('tabs-switch')
      const instance = (manager as any).instances.get('tabs-switch')
      const first = instance.tabs[0]
      first.currentUrl = 'https://first.example.com/'
      const secondId = manager.createTab('tabs-switch', { activate: false })
      const second = instance.tabs.find((tab: any) => tab.id === secondId)
      navigateOwn(second, 'https://second.example.com/')

      manager.activateTab('tabs-switch', secondId)
      expect(instance.currentUrl).toBe('https://second.example.com/')

      manager.activateTab('tabs-switch', first.id)
      expect(instance.currentUrl).toBe('https://first.example.com/')
      // Switching is a stack change, not a resize: every page is laid out the same way, and
      // the one that came forward is the one raised above the others (plan §22, 第十二轮).
      const raised = instance.window.setTopBrowserView.mock.calls.map((call: unknown[]) => call[0])
      const pagesRaised = raised.filter((view: unknown) => view === first.pageView || view === second.pageView)
      expect(pagesRaised[pagesRaised.length - 1]).toBe(first.pageView)
      expect(first.pageView.setAutoResize).toHaveBeenCalledWith({ width: true, height: true })
    })

    it('closes a page, and closes the window when the last one goes', () => {
      manager.createInstance('tabs-close')
      const instance = (manager as any).instances.get('tabs-close')
      const first = instance.tabs[0]
      first.currentUrl = 'https://first.example.com/'
      const secondId = manager.createTab('tabs-close', { activate: false })

      manager.closeTab('tabs-close', first.id)
      expect(instance.tabs).toHaveLength(1)
      expect(instance.activeTabId).toBe(secondId)

      manager.closeTab('tabs-close', secondId)
      expect((manager as any).instances.has('tabs-close')).toBe(false)
    })

    /** The last state the window pushed to its own toolbar. */
    function lastToolbarState(instance: any): any {
      const calls = instance.toolbarView.webContents.send.mock.calls.filter(
        (call: unknown[]) => call[0] === 'browser-toolbar:state-update',
      )
      return calls[calls.length - 1]?.[1]
    }

    // The window's chrome is an L and the page sits inside it: the rail's width comes
    // off the left, the bar's height off the top. Neither depends on how many pages
    // there are — the room belongs to the window, not to the list.
    it("keeps the rail's room whatever the list does, so its `+` is always reachable", () => {
      manager.createInstance('tabs-room')
      const instance = (manager as any).instances.get('tabs-room')
      instance.window._emit('show')

      // The rail itself: the window's whole left column, and the bar starts where it
      // ends — so the back button and the address bar are all to the right of the
      // pages, and nothing of the bar sits over them.
      expect(instance.railView.setBounds).toHaveBeenCalledWith({
        x: 0, y: 0, width: 200, height: expect.anything(),
      })
      expect(instance.toolbarView.setBounds).toHaveBeenCalledWith({
        x: 200, y: 0, width: 1000, height: 48,
      })

      // And the rail is the topmost view in the window: pages and the agent's overlay
      // are added over it, and raising the chrome leaves the rail on top — so nothing
      // can cover the pages or swallow the clicks meant for them.
      const raised = instance.window.setTopBrowserView.mock.calls.map((call: unknown[]) => call[0])
      expect(raised[raised.length - 1]).toBe(instance.railView)

      // One page: the rail is still there, because that is when somebody wants a
      // second one and the `+` is the only way to make it.
      expect(page(instance).pageView.setBounds).toHaveBeenCalledWith({
        x: 200, y: 48, width: expect.anything(), height: expect.anything(),
      })

      instance.tabs[0].currentUrl = 'https://first.example.com/'
      const secondId = manager.createTab('tabs-room', { url: 'https://second.example.com/' })
      const second = instance.tabs.find((tab: any) => tab.id === secondId)

      expect(second.pageView.setBounds).toHaveBeenCalledWith({
        x: 200, y: 48, width: expect.anything(), height: expect.anything(),
      })

      // And closing back down to one page does not move it.
      manager.closeTab('tabs-room', secondId)
      expect(instance.tabs[0].pageView.setBounds).toHaveBeenCalledWith({
        x: 200, y: 48, width: expect.anything(), height: expect.anything(),
      })
    })

    // The three parts of a page's metadata, in one payload: what the page reports,
    // who asked for it, and who is working on it now.
    it('reports what each page is, who asked for it, and who is driving it', () => {
      manager.createInstance('tabs-meta')
      const instance = (manager as any).instances.get('tabs-meta')
      instance.tabs[0].currentUrl = 'https://first.example.com/'

      manager.createTab('tabs-meta', {
        prototype: { slug: 'checkout-flow', origin: 'http://checkout-flow-ab12cd34.localhost' },
        openedBySessionId: 'session-a',
      })
      const second = instance.tabs[1]
      second.title = 'Cart'
      second.isLoading = true
      second.favicon = 'https://first.example.com/favicon.ico'

      expect(manager.listTabs('tabs-meta')).toEqual([
        tabSummary({ id: instance.tabs[0].id, url: 'https://first.example.com/' }),
        tabSummary({
          id: second.id,
          title: 'Cart',
          isLoading: true,
          favicon: 'https://first.example.com/favicon.ico',
          active: true,
          prototype: { slug: 'checkout-flow', origin: 'http://checkout-flow-ab12cd34.localhost' },
          openedBySessionId: 'session-a',
          // Whoever opened a page is working on it: the lease starts where the page
          // does.
          driverSessionId: 'session-a',
          // …and so does the cursor: a page a conversation opened is the page its next
          // unnamed command means (plan §22, 第十轮).
          cursorOf: 'session-a',
        }),
      ])

      // The window's own state carries the pages too, so the top bar's badge can
      // group them without asking the manager anything else.
      expect(lastToolbarState(instance).tabs).toHaveLength(2)
      expect(manager.listInstances().find((item) => item.id === 'tabs-meta')?.tabs).toHaveLength(2)
    })

    // The rail groups a window's pages by who opened them, and needs a name to write on
    // each group: `openedBySessionId` is an id, and an id is not something a person can
    // read. Names only — an opener with no name yet is left out, because the chrome has
    // a generic label for that and printing an id is worse than saying nothing.
    it('names the conversations whose pages are in the window', () => {
      manager.setSessionLabelResolver((sessionId) => (sessionId === 'session-a' ? 'Checkout fix' : null))
      manager.createInstance('tabs-labels')
      const instance = (manager as any).instances.get('tabs-labels')
      instance.tabs[0].currentUrl = 'https://first.example.com/'

      manager.createTab('tabs-labels', { openedBySessionId: 'session-a' })
      manager.createTab('tabs-labels', { openedBySessionId: 'session-unnamed' })

      expect(lastToolbarState(instance).sessionLabels).toEqual({ 'session-a': 'Checkout fix' })
    })

    // The lock names the page a session *holds* — the one its command resolved to — and only
    // that page (plan §22, 第九轮修正): reading it off "whichever page the lease is on" put
    // it on the page a command fell back to, usually the one the person was looking at.
    it('reports which page a working session has locked, and only that one', () => {
      manager.createInstance('tabs-lock')
      drive('tabs-lock', 'session-a')
      const instance = (manager as any).instances.get('tabs-lock')
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      const heldId = manager.createTab('tabs-lock', {
        url: 'https://second.example.com/',
        openedBySessionId: 'session-a',
      })
      manager.createTab('tabs-lock', { url: 'https://third.example.com/', openedBySessionId: 'session-a' })

      // No overlay yet: pages are *driven*, which is not a lock.
      expect(manager.listTabs('tabs-lock').map((tab) => tab.lockedBy)).toEqual([null, null, null])

      manager.setAgentControl('session-a', { displayName: 'Click', intent: 'Pressing Buy' })
      // …and an overlay with no command behind it yet holds nothing either.
      expect(manager.listTabs('tabs-lock').map((tab) => tab.lockedBy)).toEqual([null, null, null])

      // A command resolving to a page is what takes it — and it takes exactly that one.
      manager.setSessionPage('tabs-lock', heldId, 'session-a')

      expect(manager.listTabs('tabs-lock').map((tab) => tab.lockedBy)).toEqual([null, 'session-a', null])
      // The page the window came with, and the other page of the same session, stay free.
      expect(manager.listTabs('tabs-lock')[0].driverSessionId).toBeNull()

      manager.clearAgentControl('session-a')

      expect(manager.listTabs('tabs-lock').map((tab) => tab.lockedBy)).toEqual([null, null, null])
    })

    // A lock never outlives what it locks: closing the held page lets go of it, instead of
    // leaving the window claiming a page that is gone (plan §22, 第九轮修正).
    it('lets go of a page when the page is closed', () => {
      manager.createInstance('tabs-lock-closed')
      drive('tabs-lock-closed', 'session-a')
      const instance = (manager as any).instances.get('tabs-lock-closed')
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      const heldId = manager.createTab('tabs-lock-closed', { openedBySessionId: 'session-a' })
      manager.setAgentControl('session-a', { displayName: 'Click', intent: 'Pressing Buy' })
      manager.setSessionPage('tabs-lock-closed', heldId, 'session-a')

      expect(manager.listTabs('tabs-lock-closed').map((tab) => tab.lockedBy)).toEqual([null, 'session-a'])
      expect(instance.agentControl.tabId).toBe(heldId)

      manager.closeTab('tabs-lock-closed', heldId)

      expect(instance.agentControl.tabId).toBeNull()
      expect(manager.listTabs('tabs-lock-closed').map((tab) => tab.lockedBy)).toEqual([null])
    })

    // The cursor is where a conversation's unnamed commands go, so a page it opened is its
    // page — and moving to another page of its own leaves exactly one behind (plan §22).
    it('keeps one page per conversation as the page it works from', () => {
      manager.createInstance('tabs-cursor')
      const instance = (manager as any).instances.get('tabs-cursor')
      instance.tabs[0].currentUrl = 'https://first.example.com/'

      const first = manager.createTab('tabs-cursor', { openedBySessionId: 'session-a' })
      // A second page of the same conversation takes the cursor from the first: one page
      // per conversation is the whole point.
      manager.createTab('tabs-cursor', { openedBySessionId: 'session-a' })

      expect(manager.listTabs('tabs-cursor').map((tab) => tab.cursorOf)).toEqual([null, null, 'session-a'])

      manager.setSessionPage('tabs-cursor', first, 'session-a')

      expect(manager.listTabs('tabs-cursor').map((tab) => tab.cursorOf)).toEqual([null, 'session-a', null])

      // The person switching pages moves the display and nothing else.
      manager.activateTab('tabs-cursor', instance.tabs[0].id)

      expect(instance.activeTabId).toBe(instance.tabs[0].id)
      expect(manager.listTabs('tabs-cursor').map((tab) => tab.cursorOf)).toEqual([null, 'session-a', null])
    })

    // "Pretend this page is in front" is turned on per page, not for the whole window: the pages
    // somebody works from are the ones whose timers and rendering must not be throttled, and a
    // page nobody works from stays Chromium's business (plan §22, 第十二轮).
    it('simulates the foreground only for the pages a conversation works from', () => {
      manager.createInstance('tabs-throttle')
      const instance = (manager as any).instances.get('tabs-throttle')
      instance.tabs[0].currentUrl = 'https://first.example.com/'

      const mine = manager.createTab('tabs-throttle', { openedBySessionId: 'session-a' })
      const nobodys = manager.createTab('tabs-throttle')

      /** `true` = Chromium may throttle this page when it is not in front. */
      const throttlingOf = (tabId: string) => {
        const tab = instance.tabs.find((candidate: any) => candidate.id === tabId)
        return tab.pageView.webContents.setBackgroundThrottling.mock.calls.at(-1)?.[0]
      }

      expect(throttlingOf(mine)).toBe(false)
      expect(throttlingOf(nobodys)).toBe(true)
      // The window's own page was never anybody's.
      expect(throttlingOf(instance.tabs[0].id)).toBe(true)

      // Moving the cursor hands the page back to Chromium and the new page over.
      manager.setSessionPage('tabs-throttle', nobodys, 'session-a')

      expect(throttlingOf(mine)).toBe(true)
      expect(throttlingOf(nobodys)).toBe(false)
    })

    // Which page of the prototype it is on is the page table's answer, and it is
    // only asked when there is a prototype at all.
    it('asks the prototype which of its pages each one is on', () => {
      manager.setPrototypePageResolver((_slug, _origin, url) =>
        url.includes('/cart') ? 'cart' : null,
      )
      manager.createInstance('tabs-page')
      const instance = (manager as any).instances.get('tabs-page')
      instance.tabs[0].currentUrl = 'https://first.example.com/'

      manager.createTab('tabs-page', {
        prototype: { slug: 'checkout-flow', origin: 'http://checkout-flow-ab12cd34.localhost' },
      })
      instance.tabs[1].currentUrl = 'http://checkout-flow-ab12cd34.localhost/cart'

      const summaries = manager.listTabs('tabs-page')
      expect(summaries[0].prototypePage).toBeNull()
      expect(summaries[0].prototype).toBeNull()
      expect(summaries[1].prototypePage).toBe('cart')
    })

    /** The registered `browser-toolbar:tabs` handler. */
    function tabsHandler(): (
      _event: unknown,
      instanceId: string,
      action: 'activate' | 'close' | 'new',
      tabId?: string,
    ) => Promise<void> {
      const registration = (
        mockIpcMainHandle.mock.calls as unknown as Array<
          [string, (_event: unknown, instanceId: string, action: 'activate' | 'close' | 'new', tabId?: string) => Promise<void>]
        >
      ).find(([channel]) => channel === 'browser-toolbar:tabs')
      if (!registration) throw new Error('Expected browser-toolbar:tabs IPC registration')
      return registration[1]
    }

    it('switches, closes and adds pages from the strip', async () => {
      manager.createInstance('tabs-ipc')
      const instance = (manager as any).instances.get('tabs-ipc')
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      const firstId = instance.tabs[0].id
      const secondId = manager.createTab('tabs-ipc', { url: 'https://second.example.com/' })
      manager.registerToolbarIpc()
      const handle = tabsHandler()

      await handle({}, 'tabs-ipc', 'activate', firstId)
      expect(instance.activeTabId).toBe(firstId)

      await handle({}, 'tabs-ipc', 'close', secondId)
      expect(instance.tabs.map((tab: any) => tab.id)).toEqual([firstId])

      // The `+` opens a page nobody's session asked for, which is what "a person's
      // page" means here.
      await handle({}, 'tabs-ipc', 'new')
      expect(instance.tabs).toHaveLength(2)
      expect(instance.tabs[1].openedBySessionId).toBeNull()
    })

    it('ignores a strip action that names no page', async () => {
      manager.createInstance('tabs-ipc-empty')
      const instance = (manager as any).instances.get('tabs-ipc-empty')
      manager.registerToolbarIpc()

      await tabsHandler()({}, 'tabs-ipc-empty', 'close')
      await tabsHandler()({}, 'tabs-ipc-empty', 'activate')

      expect(instance.tabs).toHaveLength(1)
      expect(instance.activeTabId).toBe(instance.tabs[0].id)
    })

    // The `+` on a window that has only its own blank page. That page reads as
    // `about:blank` (that is how the empty state is normalized), which is also what the
    // "open into an untouched window" reuse looks for — but that reuse needs something
    // to *put in* the window, and "a new page" is not content, it is the request. With
    // the reuse applying here, nothing appeared to happen: the window kept its one page
    // and the `+` looked broken.
    it('adds a page from the strip when the window holds only its blank page', async () => {
      manager.createInstance('tabs-ipc-fresh')
      const instance = (manager as any).instances.get('tabs-ipc-fresh')
      manager.registerToolbarIpc()

      expect(instance.tabs[0].currentUrl).toBe('about:blank')

      await tabsHandler()({}, 'tabs-ipc-fresh', 'new')

      expect(instance.tabs).toHaveLength(2)
      expect(instance.tabs[1].openedBySessionId).toBeNull()
      expect(instance.activeTabId).toBe(instance.tabs[1].id)
    })
  })

  describe('element picker', () => {
    /** The next macrotask — one pass of the poll loop. */
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

    /** The last state the window pushed to its own toolbar. */
    function lastToolbarState(instance: any): any {
      const calls = instance.toolbarView.webContents.send.mock.calls.filter(
        (call: unknown[]) => call[0] === 'browser-toolbar:state-update',
      )
      return calls[calls.length - 1]?.[1]
    }

    /** The registered handler for a toolbar channel. */
    function toolbarHandler(channel: string): (...args: any[]) => Promise<void> {
      const registration = (
        mockIpcMainHandle.mock.calls as unknown as Array<[string, (...args: any[]) => Promise<void>]>
      ).find(([name]) => name === channel)
      if (!registration) throw new Error(`Expected ${channel} IPC registration`)
      return registration[1]
    }

    /**
     * Stands in for the page's CDP session.
     *
     * The picker is now a loop that arms a page and keeps reading it, so what the
     * tests need to control is those two calls — and what they need to see is that
     * arming a page does *not* tear it down again. The last report repeats, so a
     * loop that keeps polling sees the same answer.
     */
    function stubPicker(tab: any, reports: Array<{ status: string; picks?: unknown[] }>) {
      let reads = 0
      const armPicker = mock(async (_options: unknown) => {})
      const drainPicker = mock(async () => {
        const report = reports[Math.min(reads++, reports.length - 1)]
        // The same shape the CDP session answers with: a status, and whatever
        // elements it has to hand over (usually none).
        return report ? { status: report.status, picks: report.picks ?? [] } : { status: 'pending', picks: [] }
      })
      const cancelPicker = mock(async () => {})
      tab.cdp = { armPicker, drainPicker, cancelPicker }
      return { armPicker, drainPicker, cancelPicker }
    }

    /** An element as the page reports it. */
    const ELEMENT = {
      selector: '#pay',
      tag: 'button',
      text: 'Pay now',
      rect: { x: 1, y: 2, width: 3, height: 4 },
      intent: 'add-to-conversation' as const,
    }

    // The mode outlives a pick, so it cannot be the toolbar's own state: the page
    // can end it (Escape), and the window is what has to report that.
    it('stays on until it is turned off, and reports the mode to the toolbar', async () => {
      manager.createInstance('pick-mode')
      const instance = (manager as any).instances.get('pick-mode')
      const { armPicker, cancelPicker } = stubPicker(instance.tabs[0], [{ status: 'pending', picks: [] }])
      manager.registerToolbarIpc()

      await toolbarHandler('browser-toolbar:pick-element')({}, 'pick-mode', 'Add to conversation')
      await tick()

      expect(armPicker).toHaveBeenCalledWith({
        addToConversation: true,
        addLabel: 'Add to conversation',
        resident: true,
      })
      expect(lastToolbarState(instance).picking).toBe(true)
      // Picking is a mode, not a pick: arming leaves the page's overlay in place.
      expect(cancelPicker).not.toHaveBeenCalled()

      await toolbarHandler('browser-toolbar:cancel-pick')({}, 'pick-mode')

      expect(cancelPicker).toHaveBeenCalled()
      expect(lastToolbarState(instance).picking).toBe(false)
    })

    // The element alone cannot say which page it came from, and the picker is the
    // window's — so the page travels with the pick (plan §12.7).
    it('reports a pick with the page it came from', async () => {
      const actions: any[] = []
      manager.setWindowManager({
        getRpcEventSink: () => (_channel: string, _routing: unknown, payload: unknown) => {
          actions.push(payload)
        },
      } as any)
      manager.setPrototypePageResolver((_slug, _origin, url) => (url.includes('/cart') ? 'cart' : null))
      manager.createInstance('pick-origin')
      const instance = (manager as any).instances.get('pick-origin')
      const tab = instance.tabs[0]
      tab.boundPrototype = { slug: 'checkout-flow', origin: 'http://checkout-flow-ab12cd34.localhost' }
      tab.currentUrl = 'http://checkout-flow-ab12cd34.localhost/cart'
      tab.title = 'Cart'
      stubPicker(tab, [{ status: 'pending', picks: [ELEMENT] }])
      manager.registerToolbarIpc()

      await toolbarHandler('browser-toolbar:pick-element')({}, 'pick-origin', 'Add to conversation')
      await tick()

      expect(actions).toContainEqual({
        kind: 'add-to-conversation',
        instanceId: 'pick-origin',
        element: ELEMENT,
        origin: {
          url: 'http://checkout-flow-ab12cd34.localhost/cart',
          title: 'Cart',
          prototype: { slug: 'checkout-flow', origin: 'http://checkout-flow-ab12cd34.localhost' },
          prototypePage: 'cart',
        },
      })

      await toolbarHandler('browser-toolbar:cancel-pick')({}, 'pick-origin')
    })

    // Escape is the page saying stop. The toolbar would never hear about it
    // otherwise, and it is not a failure — so it ends the mode quietly.
    it('ends the mode when the page reports the user pressed Escape', async () => {
      const actions: any[] = []
      manager.setWindowManager({
        getRpcEventSink: () => (_channel: string, _routing: unknown, payload: unknown) => {
          actions.push(payload)
        },
      } as any)
      manager.createInstance('pick-escape')
      const instance = (manager as any).instances.get('pick-escape')
      stubPicker(instance.tabs[0], [{ status: 'cancelled' }])
      manager.registerToolbarIpc()

      await toolbarHandler('browser-toolbar:pick-element')({}, 'pick-escape')
      await tick()

      expect(instance.picking).toBe(false)
      expect(instance.pickTabId).toBeNull()
      expect(lastToolbarState(instance).picking).toBe(false)
      // Escape is the user giving up, not a failure — so nothing is reported.
      expect(actions).toEqual([])
    })

    // "Any page's elements can be picked" is exactly this: the mode follows the
    // page that comes forward, and the page left behind gets its overlay taken off.
    it('moves to the page that comes forward', async () => {
      manager.createInstance('pick-switch')
      const instance = (manager as any).instances.get('pick-switch')
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      const firstId = instance.tabs[0].id
      const first = stubPicker(instance.tabs[0], [{ status: 'pending', picks: [] }])

      const secondId = manager.createTab('pick-switch', { url: 'https://second.example.com/' })
      // A new page is put on screen, so the test goes back before arming.
      manager.activateTab('pick-switch', firstId)
      const secondTab = instance.tabs.find((tab: any) => tab.id === secondId)
      const second = stubPicker(secondTab, [{ status: 'pending', picks: [] }])
      manager.registerToolbarIpc()

      await toolbarHandler('browser-toolbar:pick-element')({}, 'pick-switch')
      await tick()

      expect(first.armPicker).toHaveBeenCalledTimes(1)
      expect(second.armPicker).not.toHaveBeenCalled()

      manager.activateTab('pick-switch', secondId)
      await tick()

      expect(second.armPicker).toHaveBeenCalledTimes(1)
      expect(first.cancelPicker).toHaveBeenCalled()

      await toolbarHandler('browser-toolbar:cancel-pick')({}, 'pick-switch')
    })
  })
})
