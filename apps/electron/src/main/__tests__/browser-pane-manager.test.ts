/**
 * Tests for BrowserPaneManager.
 *
 * Mocks Electron BrowserWindow and session modules to validate lifecycle,
 * session binding, and navigation behavior.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickCommandTarget, whyTabIsLocked, whyTabIsOutOfReach } from '@craft-agent/server-core/domain'
import { BACKGROUND_HEX } from '@craft-agent/shared/config'
import type { BrowserTabSummary, TabBelongsTo } from '@craft-agent/shared/protocol'

const createdWindows: any[] = []
let toolbarLoadFailuresRemaining = 0
/**
 * When set, the next `browser-empty-state.html` load throws it. Lets tests drive
 * the create-time empty-state fallback (see the fallback tests near the top).
 */
let emptyStateLoadError: Error | null = null
const mockShellOpenExternal = mock(async () => {})
const mockIpcMainHandle = mock(() => {})

/**
 * The `screen` module, as the manager sees it: one display, 0..1920.
 *
 * The display events are **real** here — a person plugs a screen in and the manager has to hear it —
 * so a test fires them (`mockScreen._emit('display-added')`) after changing what the displays are.
 */
const mockScreen = (() => {
  const listeners: Record<string, Function[]> = {}
  return {
    getAllDisplays: mock(() => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]),
    on: mock((event: string, listener: Function) => {
      ;(listeners[event] ??= []).push(listener)
    }),
    removeListener: mock((event: string, listener: Function) => {
      listeners[event] = (listeners[event] ?? []).filter((registered) => registered !== listener)
    }),
    _emit: (event: string) => {
      for (const listener of listeners[event] ?? []) listener()
    },
    _listeners: listeners,
  }
})()

/**
 * The downloads folder, as `app.getPath` reports it.
 *
 * A real directory rather than a made-up path: the recorder writes here, and a path that
 * cannot be created would only ever prove that `mkdir` failed.
 */
const downloadsDir = mkdtempSync(join(tmpdir(), 'craft-downloads-'))

function maybeFailEmptyStateLoad(target: string): void {
  if (emptyStateLoadError && target.includes('browser-empty-state.html')) {
    const error = emptyStateLoadError
    emptyStateLoadError = null
    throw error
  }
}

function createMockWebContents() {
  const listeners: Record<string, Function[]> = {}
  const emit = (event: string, ...args: any[]) => {
    for (const cb of listeners[event] || []) cb({}, ...args)
  }
  let currentUrl = 'about:blank'
  // Which of these contents has its developer tools up. The events below are how the
  // real thing reports it, and how the manager hears about them being closed from
  // their own window rather than from the bar's button.
  let devToolsOpen = false
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
    close: mock(() => {}),
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
    isFocused: mock(() => false),
    setWindowOpenHandler: mock((_handler: any) => {}),
    send: mock((_channel: string, _payload?: unknown) => {}),
    debugger: {
      attach: mock(() => {}),
      detach: mock(() => {}),
      sendCommand: mock(async () => ({ nodes: [] })),
      on: mock(() => {}),
    },
    _listeners: listeners,
    _emit: emit,
    isDevToolsOpened: mock(() => devToolsOpen),
    openDevTools: mock((_options?: unknown) => {
      devToolsOpen = true
      emit('devtools-opened')
    }),
    closeDevTools: mock(() => {
      devToolsOpen = false
      emit('devtools-closed')
    }),
  }
}

/**
 * A `BrowserView`: the chrome's and the overlay's kind. It carries `setAutoResize` (the page's
 * kind does not — it is a `WebContentsView`), which is what keeps the two mocks honest about
 * which class each surface is.
 */
function createMockBrowserView() {
  const webContents = createMockWebContents()
  return {
    webContents,
    setBounds: mock(() => {}),
    setAutoResize: mock(() => {}),
    setBackgroundColor: mock((_color: string) => {}),
  }
}

/**
 * A `WebContentsView`: the page's kind. The whole reason the page is one is `setBorderRadius`
 * — the page's corners are cut out of its own view, so nothing is drawn over the page and the
 * person keeps their clicks — so that is what this mock exists to expose.
 */
function createMockWebContentsView(options?: any) {
  const webContents = createMockWebContents()
  // The view's own bounds, remembered the way the real one remembers them: a tab that is not on
  // screen keeps whatever it was last given (that *is* its viewport), and the manager reads it back
  // when it hands the view to a parking window.
  let bounds = { x: 0, y: 0, width: 0, height: 0 }
  return {
    webContents,
    /**
     * What the view was built with. A page's `backgroundThrottling` is part of how it behaves
     * rather than a detail of its construction — a covered page Chromium counts as hidden stops
     * honouring the layout it is given — so the tests read it back from here.
     */
    _options: options,
    setBounds: mock((next: { x: number; y: number; width: number; height: number }) => { bounds = next }),
    getBounds: mock(() => bounds),
    setBackgroundColor: mock((_color: string) => {}),
    setBorderRadius: mock((_radius: number) => {}),
  }
}

/**
 * Electron's rule about views, which the manager leans on now that a tab can live in one of two
 * windows: a view has **one** parent, and adding it to another window's view tree takes it out of
 * the tree it was in. Without this the mock would report a parked tab as a child of both windows.
 */
const viewParent = new WeakMap<object, any[]>()

function createMockWindow(opts?: { width?: number; height?: number; minWidth?: number; minHeight?: number }) {
  const listeners: Record<string, Function[]> = {}
  const webContents = createMockWebContents()
  let contentWidth = opts?.width ?? 1200
  let contentHeight = opts?.height ?? 900
  let winX = 40
  let winY = 40
  let skipTaskbar = false
  let visible = false
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
    show: mock(() => {
      visible = true
      win._emit('show')
    }),
    showInactive: mock(() => {
      visible = true
      win._emit('show')
    }),
    isVisible: mock(() => visible),
    setWindowButtonVisibility: mock((_visible: boolean) => {}),
    // The window's place, for a parking window that has to stay off every display whatever the
    // person does to their screens (`keepOffEveryDisplay`), and its taskbar flag.
    getBounds: mock(() => ({ x: winX, y: winY, width: contentWidth, height: contentHeight })),
    getPosition: mock((): [number, number] => [winX, winY]),
    // Moving a window is something the desktop can do too, and the manager hears about it: the real
    // one fires `move` for both, which is why this does.
    setPosition: mock((x: number, y: number) => {
      winX = x
      winY = y
      win._emit('move')
    }),
    setSkipTaskbar: mock((skip: boolean) => { skipTaskbar = skip }),
    _skipTaskbar: () => skipTaskbar,
    hide: mock(() => {
      visible = false
      win._emit('hide')
    }),
    focus: mock(() => {}),
    // The app's window is the one the person is in, unless a test says otherwise: the keyboard
    // only goes back to the tab on screen inside the window that already has it
    // (`focusTheTabOnScreen`).
    isFocused: mock(() => true),
    destroy: mock(() => {
      win._emit('closed')
    }),
    setBrowserView: mock((_view: any) => {}),
    /**
     * The window's view tree, and the two APIs that put views in it.
     *
     * One tree, like the real thing: a `BrowserView` is added through `addBrowserView` and a
     * `WebContentsView` — the page — through `contentView.addChildView`, and either can be
     * raised above the other. Re-adding a view that is already a child raises it, which is the
     * rule the manager stacks the page and the overlay by, so this mock has to be the tree
     * rather than a pile of call records.
     */
    contentView: {
      children: [] as any[],
      addChildView: mock((view: any) => {
        // A view has one parent, like the real thing: adding it to this window's tree takes it out
        // of the one it was in. That is what "the person's window never holds a page that is not on
        // screen" is observed through, now that a tab can live in either of two windows.
        const previous = viewParent.get(view)
        if (previous && previous !== win.contentView.children) {
          const was = previous.indexOf(view)
          if (was >= 0) previous.splice(was, 1)
        }
        const index = win.contentView.children.indexOf(view)
        if (index >= 0) win.contentView.children.splice(index, 1)
        win.contentView.children.push(view)
        viewParent.set(view, win.contentView.children)
      }),
      removeChildView: mock((view: any) => {
        const index = win.contentView.children.indexOf(view)
        if (index >= 0) win.contentView.children.splice(index, 1)
        if (viewParent.get(view) === win.contentView.children) viewParent.delete(view)
      }),
    },
    addBrowserView: mock((view: any) => {
      win.contentView.children.push(view)
    }),
    removeBrowserView: mock((view: any) => {
      const index = win.contentView.children.indexOf(view)
      if (index >= 0) win.contentView.children.splice(index, 1)
    }),
    setTopBrowserView: mock((view: any) => {
      const index = win.contentView.children.indexOf(view)
      if (index >= 0) win.contentView.children.splice(index, 1)
      win.contentView.children.push(view)
    }),
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
    getPath: mock((name: string) => name === 'downloads' ? downloadsDir : `/tmp/mock-${name}`),
  },
  // One display, so "off screen" has a definite meaning in a test: past its right edge.
  screen: mockScreen,
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
  WebContentsView: class MockWebContentsView {
    webContents: any
    constructor(opts?: any) {
      const view = createMockWebContentsView(opts)
      this.webContents = view.webContents
      Object.assign(this, view)
    }
  },
  ipcMain: {
    handle: mockIpcMainHandle,
    // The one-way channel: the record button's chunks arrive this way, with no answer to
    // give (see `TOOLBAR_CHANNELS.RECORD_CHUNK`).
    on: mockIpcMainHandle,
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
    /**
     * The element overlay (plan §12.7).
     *
     * One script serves two callers, so these are the calls the manager makes on it:
     * arm a tab, read what it has reported, ask it to leave, write the draft down, and
     * take it down. A test that is about the picker replaces this whole object with its
     * own stub (`stubPicker`); the ones that only need the manager not to crash — closing
     * a tab that was being picked, say — get this and nothing happens.
     */
    armOverlay = mock(async (_options: unknown) => {})
    drainOverlay = mock(async () => ({
      status: 'pending' as const,
      picks: [],
      saves: [],
      leavingWithEdits: false,
    }))
    askOverlayToLeave = mock(async () => {})
    teardownOverlay = mock(async () => {})
    saveEdits = mock(async () => {})
  },
}))

const { BrowserPaneManager } = await import('../browser-pane-manager')

/**
 * The tab a window is showing.
 *
 * A window's address, title, view, CDP session and prototype belong to its *tabs*
 * now, so a test that used to say `instance.tabView` says `tab(instance).tabView`:
 * exactly the migration the manager itself went through. These tests drive a
 * single-tab window, so "the tab" is its first tab.
 */
function tab(instance: any): any {
  return instance.tabs[0]
}

/**
 * One tab as `listTabs` reports it — the observation half filled with what a
 * plain tab has, the declaration half with `'user'` (which is what the manager's
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
    belongsTo: null,
    driverSessionId: null,
    cursorOf: null,
    lockedBy: null,
    ...overrides,
  }
}

/** A conversation's own work — what a tab it opened says it belongs to (plan §22). */
function work(sessionId: string): TabBelongsTo {
  return { kind: 'session', sessionId }
}

/** A DAG node's work: the task, the run, and which node of it (plan §22). */
function nodeWork(taskSlug: string, nodeId: string | null, sessionId: string): TabBelongsTo {
  return { kind: 'task', taskSlug, runId: 'r1', nodeId, sessionId }
}

describe('BrowserPaneManager', () => {
  let manager: InstanceType<typeof BrowserPaneManager>

  beforeEach(() => {
    createdWindows.length = 0
    toolbarLoadFailuresRemaining = 0
    emptyStateLoadError = null
    mockShellOpenExternal.mockClear()
    mockIpcMainHandle.mockClear()
    mockScreen.getAllDisplays.mockImplementation(() => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }])
    for (const event of Object.keys(mockScreen._listeners)) delete mockScreen._listeners[event]
    manager = new BrowserPaneManager()
  })

  /**
   * Put a session to work on a window's tab.
   *
   * There is no window lease to write any more: which conversation is where is a fact about
   * **tabs** (plan §22, Conductor), so this writes the tab's own facts — the tab is the one
   * that session works from, and is held by it while the window has its overlay up.
   */
  function drive(id: string, sessionId: string): void {
    const instance = (manager as any).instances.get(id)
    if (!instance) throw new Error(`no instance ${id}`)
    const tab = instance.tabs.find((candidate: any) => candidate.id === instance.activeTabId) ?? instance.tabs[0]
    tab.cursorOf = sessionId
    if (instance.controlBy?.has(sessionId)) tab.heldBy = sessionId
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

    expect(tab(instance).tabView.webContents.loadURL).not.toHaveBeenCalledWith('about:blank')
  })

  // …while a genuine failure still gets the fallback, so the blank window case
  // does not regress into showing nothing.
  it('still falls back to about:blank when the empty state fails for another reason', async () => {
    emptyStateLoadError = new Error('mock empty-state failure')

    manager.createInstance('empty-state-broken')
    const instance = (manager as any).instances.get('empty-state-broken')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(tab(instance).tabView.webContents.loadURL).toHaveBeenCalledWith('about:blank')
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

  // Every request for a window of its own becomes a tab beside the one that asked,
  // whatever asked: a link, a scripted popup, a link on a prototype's own document
  // (plan §22). There is no second-window path left.
  it('opens a window request as a tab beside the one that asked for it', () => {
    manager.createInstance('window-open-link')
    const instance = (manager as any).instances.get('window-open-link')
    const origin = instance.tabs[0].id
    const openHandler = tab(instance).tabView.webContents.setWindowOpenHandler.mock.calls[0][0]

    const result = openHandler({
      url: 'https://accounts.google.com/o/oauth2/v2/auth',
      // What Chromium reports for a scripted `window.open` with features.
      disposition: 'new-window',
      frameName: 'oauth-popup',
    })

    expect(result).toEqual({ action: 'deny' })
    expect(instance.tabs).toHaveLength(2)
    expect(instance.tabs[1].disposition).toBe('popup')
    // The new tab loads the address the link asked for, and is the one on screen: a
    // link is clicked in order to be looked at.
    expect(instance.tabs[1].tabView.webContents.loadURL).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth')
    expect(instance.activeTabId).toBe(instance.tabs[1].id)
    expect(manager.listTabs('window-open-link')[1]!.id).not.toBe(origin)
    // Nobody owned the tab it came from, so nobody owns this one: no owner is invented
    // for a tab that merely appeared (plan §22, 第十一轮).
    expect(instance.tabs[1].belongsTo).toBeNull()
    expect(instance.tabs[1].cursorOf).toBeNull()
    expect(instance.tabs[1].driverSessionId).toBeNull()
  })

  // A tab derived from a task's tab joins that task (plan §22, 第十一轮). It inherits the
  // group and nothing else: the person following a link inside the agent's tab must not
  // retarget the agent's next command, and must not make the window claim the agent is
  // driving the new tab.
  it('gives a derived tab its parent task, but not its cursor or lease', () => {
    manager.createInstance('window-open-inherit')
    drive('window-open-inherit', 'session-a')
    const instance = (manager as any).instances.get('window-open-inherit')
    const parentId = manager.createTab('window-open-inherit', {
      url: 'https://app.example.com/',
      belongsTo: work('session-a'),
    })
    const parent = instance.tabs.find((tab: any) => tab.id === parentId)
    const openHandler = parent.tabView.webContents.setWindowOpenHandler.mock.calls[0][0]

    openHandler({ url: 'https://docs.example.com/', disposition: 'foreground-tab', frameName: '' })

    const derived = instance.tabs.find((tab: any) => tab.id !== parentId)
    expect(derived?.belongsTo).toEqual({ kind: 'session', sessionId: 'session-a' })
    expect(derived?.cursorOf).toBeNull()
    expect(derived?.driverSessionId).toBeNull()
    // The parent is still the tab that conversation works from.
    expect(parent.cursorOf).toBe('session-a')
  })

  it('puts the new tab right after the tab it came from', () => {
    manager.createInstance('window-open-order')
    const instance = (manager as any).instances.get('window-open-order')
    // Two ordinary tabs first, so "beside" and "at the end" are different answers.
    instance.tabs[0].currentUrl = 'https://first.example.com/'
    const first = instance.tabs[0].id
    manager.createTab('window-open-order', { url: 'https://second.example.com/' })
    const second = instance.tabs[1].id
    manager.activateTab('window-open-order', first)

    const openHandler = tab(instance).tabView.webContents.setWindowOpenHandler.mock.calls[0][0]
    openHandler({ url: 'https://third.example.com/', disposition: 'foreground-tab', frameName: '' })

    // Between the two, not after them: "beside the tab that asked" is the whole point.
    const order = manager.listTabs('window-open-order').map((tab) => tab.id)
    expect(order).toHaveLength(3)
    expect(order[0]).toBe(first)
    expect(order[2]).toBe(second)
    expect(instance.tabs[1].disposition).toBe('link')
    expect(instance.tabs[1].tabView.webContents.loadURL).toHaveBeenCalledWith('https://third.example.com/')
  })

  it('leaves a background window request in the background', () => {
    manager.createInstance('window-open-bg')
    const instance = (manager as any).instances.get('window-open-bg')
    const before = instance.activeTabId
    const openHandler = tab(instance).tabView.webContents.setWindowOpenHandler.mock.calls[0][0]

    openHandler({ url: 'https://background.example.com/', disposition: 'background-tab', frameName: '' })

    expect(instance.tabs).toHaveLength(2)
    expect(instance.activeTabId).toBe(before)
  })

  it('refuses a window request that is not a web address', () => {
    manager.createInstance('window-open-scheme')
    const instance = (manager as any).instances.get('window-open-scheme')
    const openHandler = tab(instance).tabView.webContents.setWindowOpenHandler.mock.calls[0][0]

    expect(openHandler({ url: 'file:///etc/passwd', disposition: 'foreground-tab', frameName: '' })).toEqual({ action: 'deny' })
    expect(openHandler({ url: 'not a url', disposition: 'foreground-tab', frameName: '' })).toEqual({ action: 'deny' })
    expect(instance.tabs).toHaveLength(1)
  })

  it('denies app deep-link popups and forwards to deep-link handler', async () => {
    manager.createInstance('popup-deeplink')
    const instance = (manager as any).instances.get('popup-deeplink')
    const openHandler = tab(instance).tabView.webContents.setWindowOpenHandler.mock.calls[0][0]

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

  it('holds a tab for a session, and lets go without touching the window or the cursor', () => {
    manager.createInstance('b1')
    drive('b1', 'session-abc')
    const tab = (manager as any).instances.get('b1').tabs[0]

    manager.unbindAllForSession('session-abc')

    expect(tab.driverSessionId).toBeNull()
    expect(tab.heldBy).toBeNull()
    // The cursor is not a lease: this conversation still works from the tab it chose.
    expect(tab.cursorOf).toBe('session-abc')
    // Letting go is not closing: the window is still there for the next turn.
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('createForSession resolves the same window, and writes nothing about who asked', () => {
    const id1 = manager.createForSession('sess-1')
    const id2 = manager.createForSession('sess-1')
    const info = manager.listInstances()[0]

    expect(id1).toBe(id2)
    expect(manager.listInstances()).toHaveLength(1)
    // The window is its workspace's (plan §22), and which conversation is working in it is a
    // fact about its *tabs* — so asking for the window leaves no mark on the window itself.
    expect(info.workspaceId).toBeNull()
    expect(info.agentControlActive).toBe(false)
    expect(info.tabs?.[0].lockedBy).toBeNull()
  })

  it('getOrCreateForSession reuses existing instance', () => {
    const id1 = manager.getOrCreateForSession('sess-1')
    const id2 = manager.getOrCreateForSession('sess-1')
    expect(id1).toBe(id2)
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('hands back the window of that workspace rather than opening a second one', () => {
    // One window per workspace (plan §22). A window already stamped with a workspace
    // *is* that workspace's window — `workspaceId` is the whole of a window's
    // identity — so a conversation joining the workspace lands in it, and the window
    // keeps its id.
    const made = manager.createInstance('named-window', { workspaceId: 'ws-a' })

    const id = manager.createForSession('sess-reuse', { workspaceId: 'ws-a' })

    expect(id).toBe(made)
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('keeps a window with no workspace context out of a workspace', () => {
    // The null bucket is a workspace of its own: a window opened with no workspace
    // context is not handed to a workspace that has one.
    manager.createInstance('unscoped')

    const id = manager.createForSession('sess-ws', { workspaceId: 'ws-a' })

    expect(id).not.toBe('unscoped')
    expect(manager.listInstances()).toHaveLength(2)
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

    it('finds the window by workspace, so an overlay lands where the tool is working', () => {
      // The overlay is put on the window of the workspace the session is working in — that is
      // the only thing that picks it now (plan §22); a window of another workspace is not it.
      manager.createInstance('overlay-scoped', { workspaceId: 'ws-delta' })
      manager.createInstance('overlay-other', { workspaceId: 'ws-other' })

      manager.setAgentControl('sess-legacy', { displayName: 'browser_navigate' }, { workspaceId: 'ws-delta' })

      expect((manager as any).instances.get('overlay-scoped').controlBy.size).toBe(1)
      expect((manager as any).instances.get('overlay-other').controlBy.size).toBe(0)
    })

    it('toInfo emits workspaceId on the DTO', () => {
      const id = manager.createForSession('sess-dto', { workspaceId: 'ws-epsilon' })
      const dto = manager.listInstances().find((i) => i.id === id)
      expect(dto).toBeDefined()
      expect(dto).toHaveProperty('workspaceId', 'ws-epsilon')
    })

    /**
     * One window per workspace, shared by every conversation in it and by the user
     * (plan §22). Nothing on the window says who is using it — that is a fact about its
     * **tabs**, which is what lets a parent and its children work in it at once
     * (Conductor).
     */
    describe("the workspace's browser window", () => {
      const instanceInfo = (id: string) => manager.listInstances().find((item) => item.id === id)

      it('gives every session in a workspace the same window', () => {
        const first = manager.createForSession('sess-a1', { workspaceId: 'ws-a' })

        expect(manager.createForSession('sess-a2', { workspaceId: 'ws-a' })).toBe(first)
        expect(manager.listInstances()).toHaveLength(1)
      })

      /**
       * The point of the whole tab-level model (plan §22, Conductor): several conversations
       * work in one window at the same time, each on its own tab, and one starting or
       * finishing does not touch another's tab.
       */
      it('lets two conversations work in it at once, each on its own tab', () => {
        const shared = manager.createForSession('sess-a1', { workspaceId: 'ws-a' })
        // The window has been used, so each `createTab` below adds a tab rather than
        // reusing the blank one it opened with.
        ;(manager as any).instances.get(shared).tabs[0].currentUrl = 'https://start.example.com/'

        manager.setAgentControl('sess-a1', { displayName: 'A' }, { workspaceId: 'ws-a' })
        manager.setAgentControl('sess-a2', { displayName: 'B' }, { workspaceId: 'ws-a' })
        const tabA = manager.createTab(shared, { url: 'https://a.example.com/', belongsTo: work('sess-a1') })
        const tabB = manager.createTab(shared, { url: 'https://b.example.com/', belongsTo: work('sess-a2') })
        manager.setSessionTab(shared, tabA, 'sess-a1')
        manager.setSessionTab(shared, tabB, 'sess-a2')

        const held = (tabId: string) => manager.listTabs(shared).find((tab) => tab.id === tabId)?.lockedBy
        expect(held(tabA)).toBe('sess-a1')
        // The second conversation claiming its own tab does not drop the first one's hold.
        expect(held(tabB)).toBe('sess-a2')

        // One of them finishing lets go of *its* tab, and only that one.
        manager.clearVisualsForSession('sess-a2')
        expect(held(tabA)).toBe('sess-a1')
        expect(held(tabB)).toBeNull()
      })

      it('keeps the same window between turns, and takes it back up', () => {
        const shared = manager.createForSession('sess-a1', { workspaceId: 'ws-a' })

        manager.unbindAllForSession('sess-a1')
        expect(manager.listInstances()).toHaveLength(1)
        // Still the workspace's window — nothing about it was demoted or handed over.
        expect(instanceInfo(shared)?.workspaceId).toBe('ws-a')

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
      })

      it('opens a hand-opened tab in the same window without disturbing anyone', () => {
        const shared = manager.createForSession('sess-a', { workspaceId: 'ws-a' })
        drive(shared, 'sess-a')
        const tabStates = () => manager.listTabs(shared).map((tab) => `${tab.id}:${tab.cursorOf ?? '-'}:${tab.lockedBy ?? '-'}`)
        const before = tabStates()

        // The user's own "+": the person clicking around did not stop a conversation, and
        // nothing about the tab it is working from moved.
        expect(manager.createForSession(null, { workspaceId: 'ws-a' })).toBe(shared)
        expect(tabStates()).toEqual(before)
      })

      it('is never destroyed by a session being torn down', () => {
        const shared = manager.createForSession('sess-a', { workspaceId: 'ws-a' })
        drive(shared, 'sess-a')

        manager.destroyForSession('sess-a')

        expect(manager.listInstances().map((item) => item.id)).toEqual([shared])
        const tab = manager.listTabs(shared)[0]
        expect(tab.driverSessionId).toBeNull()
        // The tab is still the one this conversation works from: tearing a session down ends
        // its lease, not the window, and not where it was working.
        expect(tab.cursorOf).toBe('sess-a')
      })

      it('belongs to its workspace rather than to whoever opened it', () => {
        const shared = manager.createForSession('sess-a', { workspaceId: 'ws-a' })
        manager.unbindAllForSession('sess-a')

        // Nothing on the window remembers `sess-a`: it is the workspace's, and the conversation
        // that opened it leaves no trace once its turn is over.
        expect(instanceInfo(shared)?.workspaceId).toBe('ws-a')
        expect(instanceInfo(shared)?.agentControlActive).toBe(false)
      })
    })
    // Two facts live here and they are not the same one: the **cursor** (`cursorOf`) is the
    // tab a conversation works from — sticky, named, where its unnamed commands go — and
    // the **lease** (`driverSessionId`) is the last tab a command actually reached, which
    // the turn ending sweeps away (plan §22, 第九轮修正 / 第十轮).
    describe('which tab is being driven', () => {
      const tabsOf = (id: string) => manager.listTabs(id)
      const driverOf = (id: string, tabId: string) =>
        tabsOf(id).find((tab) => tab.id === tabId)?.driverSessionId
      const cursorOf = (id: string, tabId: string) =>
        tabsOf(id).find((tab) => tab.id === tabId)?.cursorOf

      /** The window in use, so adding a tab adds one beside the tab on screen. */
      function usedWindow(id: string, sessionId: string): any {
        const instanceId = manager.createForSession(sessionId, { workspaceId: 'ws-a' })
        const instance = (manager as any).instances.get(instanceId)
        instance.tabs[0].currentUrl = `https://${id}.example.com/`
        return instance
      }

      /**
       * One command, as `SessionManager` runs it: resolve the window, resolve the tab it
       * acts on (the same rule — `pickCommandTarget`), then record that tab as the one
       * this conversation works from. Two steps, because resolving a window no longer says
       * which tab the command is about — and recording it does **not** move the window
       * (plan §22, 第十二轮): the target is what the next command is told, not what the
       * person is shown.
       */
      function command(sessionId: string, tabId?: string): { instanceId: string; tabId?: string } {
        const instanceId = manager.createForSession(sessionId, { workspaceId: 'ws-a' })
        const target = tabId ?? pickCommandTarget(tabsOf(instanceId), sessionId)?.tab.id
        if (target) manager.setSessionTab(instanceId, target, sessionId)
        return { instanceId, tabId: target }
      }

      it('records the driver on the tab a command reached, and releases it when the turn ends', () => {
        const { instanceId } = command('sess-a')
        const first = tabsOf(instanceId)[0]!.id

        // A command: the conversation resolves its window, then the tab it works from —
        // with none yet, that is the tab on screen.
        command('sess-b')
        expect(driverOf(instanceId, first)).toBe('sess-b')
        expect(cursorOf(instanceId, first)).toBe('sess-b')

        manager.unbindAllForSession('sess-b')
        expect(driverOf(instanceId, first)).toBeNull()
        // A lease, not a cursor: the turn ending takes the lease and leaves the tab as the
        // one this conversation works from.
        expect(cursorOf(instanceId, first)).toBe('sess-b')
      })

      // The rule the cursor exists for: a command lands on the conversation's own tab, not
      // on whatever the person is looking at (plan §22, 第十轮).
      it('lands on the tab the conversation works from, not the one on screen', () => {
        const instance = usedWindow('first', 'sess-a')
        const instanceId = instance.id
        const first = instance.tabs[0].id
        command('sess-a')
        expect(cursorOf(instanceId, first)).toBe('sess-a')

        // The person switches to a tab of their own, and the conversation runs a command.
        const other = manager.createTab(instanceId, { url: 'https://other.example.com/' })
        command('sess-a')

        // The window is left where the person put it — that is the half of this that used to
        // be wrong: the command's tab is what the *next* command is told, not what they are
        // shown (第十二轮).
        expect(instance.activeTabId).toBe(other)
        expect(driverOf(instanceId, first)).toBe('sess-a')
        expect(cursorOf(instanceId, first)).toBe('sess-a')
        expect(driverOf(instanceId, other)).toBeNull()
        expect(cursorOf(instanceId, other)).toBeNull()
      })

      // …and it *acts* there: the tab is named to the manager, so a command works on the
      // conversation's tab and the window does not move (plan §22, 第十二轮).
      it('acts on the tab it is given, without moving the window', async () => {
        const instance = usedWindow('first', 'sess-a')
        const instanceId = instance.id
        const mine = instance.tabs[0]
        const persons = manager.createTab(instanceId, { url: 'https://person.example.com/' })
        expect(instance.activeTabId).toBe(persons)

        await manager.navigate(instanceId, 'https://work.example.com/', mine.id)

        expect(mine.tabView.webContents.loadURL).toHaveBeenCalledWith('https://work.example.com/')
        expect(instance.activeTabId).toBe(persons)

        // A tab that is gone is an error rather than a slide onto the tab on screen: the
        // named tab was the whole point of the command.
        expect(() => manager.reload(instanceId, 'tab-that-never-was')).toThrow(/no tab/)
      })

      /**
       * A capability call as the remote bridge sends it — the wire the routing has to survive,
       * because the manager on the other end is one shared instance and the tab is not in the
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

      it('takes the tab off the request when it comes from the bridge', async () => {
        const instance = usedWindow('first', 'sess-a')
        const instanceId = instance.id
        const mine = instance.tabs[0]
        const persons = manager.createTab(instanceId, { url: 'https://person.example.com/' })

        await invoke({ method: 'navigate', args: [instanceId, 'https://work.example.com/'], tabId: mine.id })

        expect(mine.tabView.webContents.loadURL).toHaveBeenCalledWith('https://work.example.com/')
        expect(instance.activeTabId).toBe(persons)
      })

      // A request that names no tab still means the tab on screen: that is what the person's
      // own toolbar calls mean, and it is the only reading that does not make every caller
      // resolve a tab it has no opinion about.
      it('falls back to the tab on screen when the request names none', async () => {
        const instance = usedWindow('first', 'sess-a')
        const instanceId = instance.id
        const personsId = manager.createTab(instanceId, { url: 'https://person.example.com/' })
        const persons = instance.tabs.find((tab: any) => tab.id === personsId)

        await invoke({ method: 'navigate', args: [instanceId, 'https://work.example.com/'] })

        expect(persons.tabView.webContents.loadURL).toHaveBeenCalledWith('https://work.example.com/')
      })

      /**
       * The tab lock names the **caller**, in the id the caller knows itself by.
       *
       * The bridge is where that can go wrong: the manager writes down whatever identity
       * the request carries, and the agent reads `lockedBy` back and compares it with its
       * own session id — two spellings of one conversation would make it refuse its own
       * tab as somebody else's (plan §22, 第九轮).
       */
      it('locks the tab for the bridge caller, under the id that caller uses', async () => {
        const instance = usedWindow('lock', 'sess-a')
        const instanceId = instance.id
        const tabId = instance.tabs[0].id

        await invoke({ method: 'setAgentControl', args: ['sess-a', { displayName: 'Click' }] })
        await invoke({ method: 'setSessionTab', args: [instanceId, tabId, 'sess-a'] })

        const locked = manager.listTabs(instanceId).find((tab) => tab.id === tabId)!
        expect(locked.lockedBy).toBe('sess-a')
        // The conversation holding it is not told its own tab is busy…
        expect(whyTabIsLocked(locked, 'sess-a')).toBeNull()
        // …while another one is, which is what the lock is for.
        expect(whyTabIsLocked(locked, 'sess-b')).toContain('locked')
      })

      it('a conversation keeps driving its tab after another one takes the window', () => {
        // The lease is per tab, so the window changing hands does not erase the fact
        // that a tab is mid-work — the conversation's own tabs stay its own until its
        // turn ends.
        const instance = usedWindow('first', 'sess-a')
        const instanceId = instance.id
        const first = instance.tabs[0].id

        command('sess-a')
        const second = manager.createTab(instanceId, {
          url: 'https://second.example.com/',
          belongsTo: work('sess-a'),
        })
        expect(driverOf(instanceId, first)).toBe('sess-a')
        expect(driverOf(instanceId, second)).toBe('sess-a')

        // Another conversation's command takes the window, and — having no tab of its own
        // — the tab on screen.
        command('sess-b')
        expect(driverOf(instanceId, second)).toBe('sess-b')
        expect(driverOf(instanceId, first)).toBe('sess-a')

        // And the first conversation's turn ending clears *its* tab, wherever the
        // window's lease has got to since.
        manager.unbindAllForSession('sess-a')
        expect(driverOf(instanceId, first)).toBeNull()
        expect(driverOf(instanceId, second)).toBe('sess-b')
      })

      it('lets a tab the reader is not looking at stay idle', () => {
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
    expect(tab(instance).tabView.webContents.loadURL).toHaveBeenCalledWith('https://example.com')
  })

  it('navigate treats plain text as search query', async () => {
    manager.createInstance('nav-2')
    await manager.navigate('nav-2', 'craft agents browser tools')
    const instance = (manager as any).instances.get('nav-2')
    expect(tab(instance).tabView.webContents.loadURL).toHaveBeenCalledWith(
      'https://duckduckgo.com/?q=craft%20agents%20browser%20tools'
    )
  })

  /**
   * Electron hands an abort to whichever `loadURL` promise is *current*, so
   * creating a window (which loads the empty state) and pointing it somewhere in
   * the same breath makes a **successful** navigation reject with the *previous*
   * document's abort. Reported as a failure it says "navigate failed" about a tab
   * that is already on screen — and the fields that would identify it are empty in
   * practice (`{"errno":-3,"code":"","url":"file:///…/browser-empty-state.html"}`),
   * so `errno` is what we match on.
   */
  it('does not report a navigation as failed when it aborted an earlier load', async () => {
    manager.createInstance('nav-superseded')
    const instance = (manager as any).instances.get('nav-superseded')
    tab(instance).currentUrl = 'https://example.com'
    tab(instance).title = 'Example'
    tab(instance).tabView.webContents.loadURL = mock(async () => {
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
    tab(instance).tabView.webContents.loadURL = mock(async () => {
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
    tab(instance).tabView.webContents.loadURL = mock(async () => {
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

    tab(instance).tabView.webContents._emit('console-message', 2, 'warn message')
    tab(instance).tabView.webContents._emit('console-message', 3, 'error message')

    const allEntries = manager.getConsoleLogs('console-1', { level: 'all', limit: 10 })
    expect(allEntries).toHaveLength(2)

    const warnEntries = manager.getConsoleLogs('console-1', { level: 'warn', limit: 10 })
    expect(warnEntries).toHaveLength(1)
    expect(warnEntries[0].message).toBe('warn message')
  })

  it('applies observer theme signal and skips regular console logging for it', () => {
    manager.createInstance('theme-signal')
    const instance = (manager as any).instances.get('theme-signal')
    tab(instance).themeObserverToken = 'tok-1'

    tab(instance).tabView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-1:#123456')

    expect(manager.listInstances().find(i => i.id === 'theme-signal')?.themeColor).toBe('#123456')
    expect(manager.getConsoleLogs('theme-signal', { level: 'all', limit: 10 })).toHaveLength(0)
  })

  it('dedupes repeated observer theme signals', () => {
    manager.createInstance('theme-dedupe')
    const instance = (manager as any).instances.get('theme-dedupe')
    tab(instance).themeObserverToken = 'tok-2'

    tab(instance).tabView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-2:#445566')
    const sendCallsAfterFirst = instance.window.webContents.send.mock.calls.length

    tab(instance).tabView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-2:#445566')
    const sendCallsAfterSecond = instance.window.webContents.send.mock.calls.length

    expect(sendCallsAfterSecond).toBe(sendCallsAfterFirst)
  })

  it('ignores observer theme signals from stale token', () => {
    manager.createInstance('theme-stale-token')
    const instance = (manager as any).instances.get('theme-stale-token')
    tab(instance).themeObserverToken = 'tok-current'
    tab(instance).themeColor = '#aaaaaa'

    tab(instance).tabView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-old:#bbccdd')

    expect(manager.listInstances().find(i => i.id === 'theme-stale-token')?.themeColor).toBe('#aaaaaa')
  })

  it('clears theme on explicit null sentinel signal', () => {
    manager.createInstance('theme-null')
    const instance = (manager as any).instances.get('theme-null')
    tab(instance).themeObserverToken = 'tok-null'

    tab(instance).tabView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-null:#223344')
    expect(manager.listInstances().find(i => i.id === 'theme-null')?.themeColor).toBe('#223344')

    tab(instance).tabView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-null:__NULL__')
    expect(manager.listInstances().find(i => i.id === 'theme-null')?.themeColor).toBeNull()
  })

  // The chrome draws the app's colours, not the tab's, so the state it gets is about
  // the tab (address, title, back/forward, picker, tabs) and never about how the tab
  // looks. The tab's own colour is still measured — the top bar's chip uses it — and
  // that is a different test (the theme-signal ones above).
  it('replays toolbar state when window is shown', () => {
    manager.createInstance('theme-show-replay')
    const instance = (manager as any).instances.get('theme-show-replay')

    tab(instance).currentUrl = 'https://example.com'
    tab(instance).title = 'Example'
    tab(instance).canGoBack = true
    tab(instance).canGoForward = false

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
        // The picker is off, and the window has one tab — which the rail draws and
        // the bar leaves alone.
        picking: false,
        // Nothing is holding the mode open, so the chip says how the mode works rather
        // than asking whether to save.
        leavingWithEdits: false,
        // …and so are the tab's developer tools, which the bar's own button toggles.
        devTools: false,
        tabs: [
          tabSummary({ id: instance.tabs[0].id, url: 'https://example.com', title: 'Example', active: true }),
        ],
        // Nothing opened these tabs through a conversation, so there is no group to
        // name — the rail draws no headers for a window that is all one person's.
        sessionLabels: {},
        // Nobody pressed the record button.
        recording: null,
      },
    ])
  })

  it('replays full toolbar state when toolbar renderer finishes loading', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-finish-load-replay')
    const instance = (manager as any).instances.get('toolbar-finish-load-replay')

    tab(instance).currentUrl = 'https://craft.do'
    tab(instance).title = 'Craft'
    tab(instance).isLoading = true
    tab(instance).canGoBack = true
    tab(instance).canGoForward = true

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
        leavingWithEdits: false,
        devTools: false,
        tabs: [
          tabSummary({ id: instance.tabs[0].id, url: 'https://craft.do', title: 'Craft', isLoading: true, active: true }),
        ],
        sessionLabels: {},
        // Nobody pressed the record button.
        recording: null,
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

    /** A window whose tab is the one a session works on `checkout-flow` from. */
    function boundWindow(id: string): any {
      manager.setPrototypeWindowResolver((sessionId) =>
        sessionId === 'session-1' ? { slug: 'checkout-flow', origin: ORIGIN } : null,
      )
      manager.createInstance(id)
      const instance = (manager as any).instances.get(id)
      // What the tab's prototype is borrowed from: the conversation that works from it (plan
      // §22) — there is no window-level session to ask any more.
      instance.tabs[0].cursorOf = 'session-1'
      return instance
    }

    it('shows the prototype for an overlay, whose page is a third-party site', () => {
      const instance = boundWindow('overlay-window')
      tab(instance).currentUrl = 'https://app.example.com/checkout'

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
      tab(instance).currentUrl = 'https://app.example.com/checkout/pay'
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
      tab(instance).currentUrl = 'https://elsewhere.example.com/'
      manager.setPrototypePageResolver(() => null)

      instance.window._emit('show')

      expect(lastToolbarState(instance)).toMatchObject({ url: ORIGIN, prototypeSlug: 'checkout-flow' })
    })

    it('keeps the real URL while the document is already served by the prototype', () => {
      const instance = boundWindow('scratch-window')
      tab(instance).currentUrl = `${ORIGIN}/dist/prototype.html`

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
      tab(instance).currentUrl = 'https://app.example.com/checkout'
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
      expect(tab(instance).boundPrototype).toBeNull()
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
      tab(instance).currentUrl = 'https://example.com/'

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
      tab(instance).currentUrl = 'https://app.example.com/checkout'

      instance.window._emit('show')

      expect(instance.tabs[0].belongsTo).toBeNull()
      expect(instance.tabs[0].cursorOf).toBeNull()
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
      tab(instance).currentUrl = 'https://app.example.com/checkout'
      instance.window._emit('show')

      expect(lastToolbarState(instance)).toMatchObject({ url: ORIGIN, prototypeSlug: 'checkout-flow' })
    })

    /**
     * Typing an address is the person speaking for the tab, and this is what saying
     * "somewhere else" does: the tab stops being the prototype's — the bar mirrors
     * where the view actually is, the rail's second line stops naming it, and the two
     * prototype actions go with the binding (plan §12.6).
     *
     * It has to outrank the session chain, which still knows this conversation works
     * on `checkout-flow`: the address was about *this tab*, not about the work.
     */
    it('gives the tab up when the person types an address of their own', async () => {
      manager.setPrototypeAddressResolver(addressResolverFor(['pay']))
      const instance = boundWindow('steered-window')
      tab(instance).currentUrl = 'https://app.example.com/checkout'
      const navigate = spyOnNavigate()
      manager.registerToolbarIpc()

      await navigateHandler()({}, 'steered-window', 'https://example.com/')

      expect(navigate).toHaveBeenCalledWith('steered-window', 'https://example.com/')
      expect(tab(instance).boundPrototype).toBeNull()
      expect(tab(instance).prototypeReleased).toBe(true)
      // Still true on the next push, not just the one made while answering the keystroke.
      instance.window._emit('show')
      expect(lastToolbarState(instance)).toMatchObject({
        url: 'https://app.example.com/checkout',
        prototypeSlug: null,
      })
    })

    // What the window was *opened* for is given up the same way — the address speaks
    // for the tab on screen, and a tab is what carries the identity (plan §22).
    it('gives up the prototype it was opened for when the person types elsewhere', async () => {
      manager.setPrototypeAddressResolver(addressResolverFor())
      manager.createInstance('opened-then-steered')
      const instance = (manager as any).instances.get('opened-then-steered')
      manager.createTab('opened-then-steered', { prototype: { slug: 'checkout-flow', origin: ORIGIN } })
      spyOnNavigate()
      manager.registerToolbarIpc()

      await navigateHandler()({}, 'opened-then-steered', 'https://example.com/')

      expect(tab(instance).boundPrototype).toBeNull()
      instance.window._emit('show')
      expect(lastToolbarState(instance)).toMatchObject({ prototypeSlug: null })
    })

    /**
     * Not every typed address is somewhere else. The prototype's own host serves files
     * and its own routes (§16.3), and a page of the flow has a live address of its own:
     * typing either is still this prototype's business, and giving the tab up there
     * would take the two actions off a document they belong on.
     */
    it('keeps the tab when the address typed is still the prototype\'s', async () => {
      manager.setPrototypeAddressResolver(addressResolverFor(['pay']))
      manager.setPrototypePageResolver((slug, _origin, url) =>
        slug === 'checkout-flow' && url === 'https://app.example.com/checkout/pay' ? 'pay' : null,
      )
      const instance = boundWindow('kept-window')
      spyOnNavigate()
      manager.registerToolbarIpc()

      // A file on the prototype's own host.
      tab(instance).currentUrl = `${ORIGIN}/dist/prototype.html`
      await navigateHandler()({}, 'kept-window', `${ORIGIN}/dist/other.html`)
      expect(tab(instance).prototypeReleased).toBe(false)

      // The live address of one of its pages.
      tab(instance).currentUrl = 'https://app.example.com/checkout/pay'
      await navigateHandler()({}, 'kept-window', 'https://app.example.com/checkout/pay')
      expect(tab(instance).prototypeReleased).toBe(false)

      instance.window._emit('show')
      expect(lastToolbarState(instance)).toMatchObject({ url: `${ORIGIN}/pay`, prototypeSlug: 'checkout-flow' })
    })

    // A window opened for a prototype outranks what the tab's conversation is working on:
    // the tab's own declaration is the more specific fact, and it is the one the user is
    // looking at.
    it('prefers the tab own binding over the session one', () => {
      manager.setPrototypeWindowResolver(() => ({ slug: 'another-prototype', origin: 'http://another-1a2b3c4d.localhost' }))
      manager.createInstance('both-bindings')
      const instance = (manager as any).instances.get('both-bindings')
      instance.tabs[0].cursorOf = 'session-1'
      manager.createTab('both-bindings', { prototype: { slug: 'checkout-flow', origin: ORIGIN } })
      tab(instance).currentUrl = 'https://app.example.com/checkout'

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
    tab(instance).tabView.webContents.executeJavaScript = mock(async () => '#0f1e2d')

    tab(instance).tabView.webContents._emit('did-navigate', 'https://example.com')

    await Bun.sleep(140)

    expect(manager.listInstances().find(i => i.id === 'theme-early')?.themeColor).toBe('#0f1e2d')
  })

  it('clears pending in-page theme timer on full navigation', async () => {
    manager.createInstance('theme-timer-clear')
    const instance = (manager as any).instances.get('theme-timer-clear')

    tab(instance).tabView.webContents._emit('did-navigate-in-page', 'https://example.com/route-a')
    await Bun.sleep(0)
    expect(tab(instance).inPageThemeTimer).not.toBeNull()

    tab(instance).tabView.webContents._emit('did-navigate', 'https://example.com/full-nav')
    expect(tab(instance).inPageThemeTimer).toBeNull()
  })

  it('throws when screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('screenshot-empty-image')
    const instance = (manager as any).instances.get('screenshot-empty-image')
    // A hidden window on Windows: the shot is taken from the parked view, and an empty answer there
    // is the same empty answer as anywhere (`canCaptureHiddenWindows` so a Mac host agrees).
    ;(manager as any).canCaptureHiddenWindows = false
    tab(instance).tabView.webContents.capturePage = mock(async () => ({
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
    ;(manager as any).canCaptureHiddenWindows = false
    tab(instance).tabView.webContents.capturePage = mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function() { return this },
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
    }))

    await expect(manager.screenshot('screenshot-empty-png')).rejects.toThrow('Failed to capture screenshot: empty image buffer')
  })

  /** A shot of that buffer, as the mock's `capturePage` would answer with it. */
  const answerWith = (marker: string) => {
    const image = {
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: () => image,
      toPNG: () => Buffer.from(marker),
      toJPEG: (_q: number) => Buffer.from(marker),
    }
    return image
  }

  it('takes a hidden window\'s shot from a view parked in a window nobody can see', async () => {
    manager.createInstance('screenshot-parked-hidden')
    const instance = (manager as any).instances.get('screenshot-parked-hidden')
    // On Windows a hidden window answers for nothing, so the shot goes straight to the parked view —
    // and the one that keeps the tests the same everywhere is that answer, not the host's platform.
    ;(manager as any).canCaptureHiddenWindows = false
    // The window is not on screen, so nothing inside it has a surface: the shot comes from the parked
    // view, which is the only place this tab can be read at all.
    tab(instance).tabView.webContents.capturePage = mock(async () => answerWith('parked-png'))

    const windowsBefore = createdWindows.length
    const result = await manager.screenshot('screenshot-parked-hidden', { includeMetadata: true })

    expect(result.imageBuffer.toString()).toBe('parked-png')
    expect(result.metadata?.warnings?.some((w: string) => w.includes('parked that tab in a window nobody can see'))).toBe(true)
    // The window the person owns was neither shown nor moved: the parking window is the one that was.
    expect(instance.window.showInactive).not.toHaveBeenCalled()
    expect(instance.window.setPosition).not.toHaveBeenCalled()
    expect(instance.isVisible).toBe(false)

    expect(createdWindows.length).toBe(windowsBefore + 1)
    const parking = createdWindows[createdWindows.length - 1]
    expect(parking.contentView.addChildView.mock.calls.some(([view]: any[]) => view === tab(instance).tabView)).toBe(true)
    expect(parking.showInactive).toHaveBeenCalled()
    expect(parking.destroy).toHaveBeenCalled()
    // And the tab's view is back in the window it belongs to.
    expect(instance.window.contentView.children).toContain(tab(instance).tabView)
  })

  it('takes a hidden window\'s shot where it is, where that is known to answer', async () => {
    manager.createInstance('screenshot-hidden-in-place')
    const instance = (manager as any).instances.get('screenshot-hidden-in-place')
    // macOS answers for a hidden window (Electron's own behaviour), so it gets the first go and no
    // parking window is made at all.
    ;(manager as any).canCaptureHiddenWindows = true
    tab(instance).tabView.webContents.capturePage = mock(async () => answerWith('in-place-png'))

    const windowsBefore = createdWindows.length
    const result = await manager.screenshot('screenshot-hidden-in-place')

    expect(result.imageBuffer.toString()).toBe('in-place-png')
    expect(createdWindows.length).toBe(windowsBefore)
  })

  it('shoots a tab that has never been composited from a parked view, and puts it straight back', async () => {
    manager.createInstance('screenshot-first-frame')
    const instance = (manager as any).instances.get('screenshot-first-frame')
    // The window's own tab has an address — written by hand because a mock tab never hears the
    // `did-navigate` that would write it — so what follows is a second tab, not a reuse of it.
    instance.tabs[0].currentUrl = 'https://front.example.com/'
    const onScreen = instance.tabs[0]
    // The agent's tab: opened behind the person's, so Chromium has never composited it and it has no
    // surface to copy — the case the parked view exists for (`captureWhileParked`).
    const behindId = manager.createTab('screenshot-first-frame', { url: 'https://behind.example.com/', activate: false })
    const behind = instance.tabs.find((candidate: any) => candidate.id === behindId)

    // The person is looking at the window: nothing of it may be shown, moved or re-stacked.
    instance.window._emit('show')

    let captureCalls = 0
    behind.tabView.webContents.capturePage = mock(async () => {
      captureCalls += 1
      // What Chromium says about a page it has never composited. One answer is enough to give up on
      // the window: another go inside it would find just as little.
      if (captureCalls <= 1) throw new Error('Current display surface not available for capture')
      // The person drags the window edge while the page is away — the shot is taken at 1200 wide.
      instance.window.setContentSize(1000, 900)
      return answerWith('first-frame-png')
    })

    const windowsBefore = createdWindows.length
    const result = await manager.screenshot('screenshot-first-frame', { includeMetadata: true }, behindId)

    expect(result.imageBuffer.toString()).toBe('first-frame-png')
    expect(result.metadata?.warnings?.some((w: string) => w.includes('parked that tab in a window nobody can see'))).toBe(true)
    expect(captureCalls).toBe(2)

    // A window nobody can see was made for it, the view was handed to it, and it is gone again.
    expect(createdWindows.length).toBe(windowsBefore + 1)
    const parking = createdWindows[createdWindows.length - 1]
    expect(parking.contentView.addChildView.mock.calls.some(([view]: any[]) => view === behind.tabView)).toBe(true)
    expect(parking.showInactive).toHaveBeenCalled()
    expect(parking.destroy).toHaveBeenCalled()

    // The person's window: unchanged, their tab still on screen — and **only** theirs in it. The tab
    // that is not on screen lives in the parking window, so the window someone is looking at never
    // holds a page nobody asked to see.
    expect(instance.activeTabId).toBe(onScreen.id)
    expect(instance.window.showInactive).not.toHaveBeenCalled()
    const children = instance.window.contentView.children
    expect(children).toContain(onScreen.tabView)
    expect(children).not.toContain(behind.tabView)

    // Handed back to **the window it lives in**, at the viewport the shot was taken at: this tab is
    // not on screen, so the person dragging the window to 1000 while it was away does not reach it —
    // the tab on screen is the one that follows the window (`layoutTabView`), while every other tab
    // is parked at the size it had when it was last on screen (`parkTab`).
    const resident = instance.parkingWindow
    expect(resident.contentView.children).toContain(behind.tabView)
    expect(behind.tabView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 993, height: 845 })
    expect(behind.tabView.getBounds()).toEqual({ x: 0, y: 0, width: 993, height: 845 })
  })

  it('treats a capture that never comes back as a miss, and the parked view answers instead', async () => {
    manager.createInstance('screenshot-capture-timeout')
    const instance = (manager as any).instances.get('screenshot-capture-timeout')
    ;(manager as any).captureTimeoutMs = 20
    // The window is up, so the shot is first tried where the tab is.
    instance.window._emit('show')

    let captureCalls = 0
    tab(instance).tabView.webContents.capturePage = mock(() => {
      captureCalls += 1
      // What a page with no surface does: it does not fail, it stops answering.
      if (captureCalls <= 1) return new Promise(() => {})
      return Promise.resolve(answerWith('parked-png'))
    })

    const result = await manager.screenshot('screenshot-capture-timeout')

    expect(result.imageBuffer.toString()).toBe('parked-png')
    expect(captureCalls).toBe(2)
  })

  it('gives up instead of hanging when the capture never answers, in the window or parked', async () => {
    manager.createInstance('screenshot-capture-never-answers')
    const instance = (manager as any).instances.get('screenshot-capture-never-answers')
    ;(manager as any).captureTimeoutMs = 20
    instance.window._emit('show')

    tab(instance).tabView.webContents.capturePage = mock(() => new Promise(() => {}))

    await expect(manager.screenshot('screenshot-capture-never-answers')).rejects.toThrow(
      'the page had no display surface to copy, even from a view of its own',
    )
  })

  it('throws when region screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('region-empty-image')
    const instance = (manager as any).instances.get('region-empty-image')
    tab(instance).tabView.webContents.capturePage = mock(async () => ({
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
    tab(instance).tabView.webContents.capturePage = mock(async () => ({
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
    tab(instance).cdp.getElementGeometryBySelector = mock(async () => {
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
    // 720 of page + everything the page does not get: the 48 address bar, the 200 tab rail, the
    // 1px the page keeps against each of them for the line's top and left edges, and 6px on the
    // right and below (`pagePanelInsets`).
    expect(instance.window.setContentSize).toHaveBeenCalledWith(1487, 775)
    // The promise is the viewport, and it is kept exactly: what the window ended up with, minus
    // all of that again.
    expect(resized).toEqual({ width: 1280, height: 720 })
  })

  it('returns effective viewport size when min window constraints apply', () => {
    manager.createInstance('resize-min')
    const resized = manager.windowResize('resize-min', 200, 200)

    // BrowserWindow minWidth/minHeight is 700x500, and the chrome plus the panel's gutter takes
    // 200 + 7 of the width and 48 + 7 of the height, so the effective viewport is 493x445.
    expect(resized).toEqual({ width: 493, height: 445 })
  })

  /**
   * The window being resized is what a person does with the window itself — and it is the
   * only thing that lays the page out again, because the page is the one view in the window
   * with no `setAutoResize` of its own (`buildTab`). So the page has to be laid out both
   * while the drag reports sizes and on the size the window ends up with: on Windows the
   * last step of a drag arrives as `resized`, not as another `resize`.
   */
  it('lays the page out on the size the window ends up with, not the last one it reported', () => {
    manager.createInstance('resize-by-hand')
    const instance = (manager as any).instances.get('resize-by-hand')
    const tabView = tab(instance).tabView
    tabView.setBounds.mockClear()

    // The drag, a step of it: 1200 wide when it opened.
    instance.window.setContentSize(1010, 900)
    instance.window._emit('resize')

    // The rail keeps its 200 and the bar its 48; the page is what is left of the window,
    // minus the 1px it keeps against each of them and the 6px of panel gutter on the right
    // and below (`pageAreaBounds`).
    expect(tabView.setBounds).toHaveBeenLastCalledWith({ x: 201, y: 49, width: 803, height: 845 })

    // And where the window actually landed — a size no `resize` reported.
    instance.window.setContentSize(1000, 900)
    instance.window._emit('resized')

    expect(tabView.setBounds).toHaveBeenLastCalledWith({ x: 201, y: 49, width: 793, height: 845 })
  })

  /**
   * Where a window nobody may see is put, and — the part that matters — that it *stays* out: the
   * person can plug a screen in beside the spot or change scaling, and the desktop itself will bring
   * a window it judges unreachable back onto a screen. Reported by the person: "你的停车窗太靠近屏幕
   * 了，用户切换双屏幕/调整 dpi 就露出来了".
   */
  it('keeps a window nobody may see off every display, through screen changes and being moved onto one', () => {
    manager.createInstance('parking-away')
    const instance = (manager as any).instances.get('parking-away')
    instance.tabs[0].currentUrl = 'https://front.example.com/'
    manager.createTab('parking-away', { url: 'https://behind.example.com/', activate: false })
    const parking = instance.parkingWindow
    expect(parking).toBeTruthy()

    // Put past the right edge of the only display (0..1920) — and far past it, not just past the
    // window's own edge: this is a request the desktop may cap (measured: it lands at 16383 whatever
    // you ask for), which is why where it ended up is checked rather than assumed.
    expect(parking.getBounds().x).toBeGreaterThan(1920)
    const whereItWasFirstPut = parking.getBounds().x

    // The person plugs a screen in that covers that spot, and the manager hears about it.
    mockScreen.getAllDisplays.mockImplementation(() => [{ bounds: { x: 0, y: 0, width: 40_000, height: 1080 } }])
    mockScreen._emit('display-added')
    expect(parking.getBounds().x).toBeGreaterThanOrEqual(40_000)

    // And the desktop moving it back onto a screen — the other thing that happens without us: the
    // window is watched, so it goes back out.
    parking.setPosition(0, 0)
    expect(parking.getBounds().x).toBeGreaterThanOrEqual(40_000)
    expect(parking.getBounds().x).not.toBe(whereItWasFirstPut)

    // The subscription is dropped with the last window, rather than outliving the manager.
    manager.destroyAll()
    expect(mockScreen.removeListener).toHaveBeenCalled()
  })

  /**
   * A tab that is not on screen keeps the viewport it has, because it is not in the person's window
   * at all: it lives in the parking window, so what an agent measured there — the page's layout, its
   * elements, the coordinates of both — survives the person dragging the window. It gets the
   * window's size when it comes forward, which is what a browser does with a background tab
   * (`apps/electron/spike/background-viewport.ts`).
   */
  it('keeps a tab that is not on screen out of the window, at the size it was opened at', () => {
    manager.createInstance('resize-frozen')
    const instance = (manager as any).instances.get('resize-frozen')
    instance.tabs[0].currentUrl = 'https://front.example.com/'
    const onScreen = instance.tabs[0]
    const behindId = manager.createTab('resize-frozen', { url: 'https://behind.example.com/', activate: false })
    const behind = instance.tabs.find((tab: any) => tab.id === behindId)

    // Born in the parking window, at the size the page area had then.
    expect(behind.tabView.getBounds()).toEqual({ x: 0, y: 0, width: 993, height: 845 })
    expect(instance.parkingWindow.contentView.children).toContain(behind.tabView)
    expect(instance.window.contentView.children).not.toContain(behind.tabView)
    behind.tabView.setBounds.mockClear()

    instance.window.setContentSize(1010, 900)
    instance.window._emit('resize')

    // The tab the person is looking at follows the window…
    expect(onScreen.tabView.setBounds).toHaveBeenLastCalledWith({ x: 201, y: 49, width: 803, height: 845 })
    // …and the one that is not on screen is only ever told the size it already has: it is parked
    // again at the very viewport it was given, so the page is not laid out a second time, and it is
    // never given the window's area while it is not showing.
    expect(behind.tabView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 993, height: 845 })
    expect(behind.tabView.getBounds()).toEqual({ x: 0, y: 0, width: 993, height: 845 })
    expect(instance.window.contentView.children).not.toContain(behind.tabView)

    // Coming forward is where it gets the window's size — and the window holds it from then on.
    manager.activateTab('resize-frozen', behindId)
    expect(behind.tabView.setBounds).toHaveBeenLastCalledWith({ x: 201, y: 49, width: 803, height: 845 })
    expect(instance.window.contentView.children).toContain(behind.tabView)
    expect(instance.parkingWindow.contentView.children).not.toContain(behind.tabView)
  })

  describe('agent control overlay', () => {
    /**
     * The script the **window's** overlay was last told to run.
     *
     * The overlay is up for the window whenever it is — it draws the page's panel — so this is
     * where both the panel's colours and the agent's markings are observable. It is the window's
     * view, so what it says is about the tab on screen (`updateNativeOverlayState` reads that).
     */
    const overlayScript = (instance: any): string => {
      return instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.at(-1)?.[0] ?? ''
    }

    /**
     * The other half of "the agent is working in here": a command landing on the tab on
     * screen, which is what holds it (plan §22). The panel being up is not enough — the lock,
     * the dim and the shield are the held tab's.
     */
    const holdActiveTab = (id: string, sessionId: string): void => {
      const instance = (manager as any).instances.get(id)
      manager.setSessionTab(id, instance.activeTabId, sessionId)
    }

    it('setAgentControl notes the session and its label on the window', async () => {
      manager.createInstance('ac-1')
      drive('ac-1', 'sess-1')

      manager.setAgentControl('sess-1', { displayName: 'Navigate Page', intent: 'Loading example.com' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-1')
      expect(instance.controlBy.get('sess-1')).toEqual({
        displayName: 'Navigate Page',
        intent: 'Loading example.com',
      })
      // No command has resolved a tab yet, so the overlay holds nothing — and a hold is what
      // the agent's markings are drawn for. The panel's own line is up either way (the page's
      // corner comes from the page's view, not from this document).
      expect(tab(instance).heldBy ?? null).toBeNull()
      expect(instance.nativeOverlayView.setBounds).toHaveBeenLastCalledWith({ x: 200, y: 48, width: 1000, height: 852 })
      expect(overlayScript(instance)).toContain('const locked = false;')
      expect(overlayScript(instance)).toContain('const shieldActive = false;')
      expect(instance.nativeOverlayView.webContents.focus).not.toHaveBeenCalled()
      expect(manager.listInstances().find(i => i.id === 'ac-1')?.agentControlActive).toBe(true)
    })

    // The lock is drawn on the tab, not the window (plan §22, 第九轮修正 / 第十三轮): the
    // shield covers the tab the working session holds, and switching away hands the mouse and
    // keyboard back without releasing anything — the agent is still on *its* tab. What the
    // person switched to keeps its panel and nothing else: a tab nobody holds is not an
    // overlay with its markings switched off, it is a panel with no agent on it.
    it('arms the tab shield only while the tab on screen is the one being worked on', async () => {
      /** Enough microtasks for a tab's overlay document to finish loading. */
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 4; i += 1) await Promise.resolve()
      }

      manager.createInstance('ac-lock')
      drive('ac-lock', 'sess-lock')
      const instance = (manager as any).instances.get('ac-lock')
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      // The tab the session is working on is the one on screen — commands act on the
      // tab in front, which is what the lock follows.
      const heldId = manager.createTab('ac-lock', {
        url: 'https://held.example.com/',
        belongsTo: work('sess-lock'),
      })
      const otherId = manager.createTab('ac-lock', { url: 'https://other.example.com/' })
      manager.activateTab('ac-lock', heldId)
      await settle()

      // The overlay alone holds nothing: it takes a command to resolve to a tab, and until then
      // the tab in front is a panel with no lock on it.
      manager.setAgentControl('sess-lock', { displayName: 'Click', intent: 'Pressing Buy' })
      await settle()
      expect(overlayScript(instance)).toContain('const locked = false;')
      expect(overlayScript(instance)).toContain('const shieldActive = false;')

      // "Held" is about the tab the command works on, and since 第十二轮 that is only the tab
      // on screen when the conversation has no tab of its own — so the test holds the tab the
      // *person* is looking at, which is the case the shield exists for.
      manager.setSessionTab('ac-lock', heldId, 'sess-lock')
      await settle()

      // The held tab is on screen: covered, locked, and the pointer says so.
      expect(instance.nativeOverlayView.setBounds).toHaveBeenLastCalledWith({ x: 200, y: 48, width: 1000, height: 852 })
      expect(overlayScript(instance)).toContain('const shieldActive = true;')
      expect(overlayScript(instance)).toContain('const locked = true;')

      manager.activateTab('ac-lock', otherId)
      await settle()

      // A tab the person switched to is not the agent's to hold. The panel comes forward with it
      // — same overlay, sized to the tab area, saying this tab's state — but nothing on it is a
      // lock: no accent, no dim, no chip, and the page takes input.
      expect(instance.nativeOverlayView.setBounds).toHaveBeenLastCalledWith({ x: 200, y: 48, width: 1000, height: 852 })
      expect(overlayScript(instance)).toContain('const locked = false;')
      expect(overlayScript(instance)).toContain('const shieldActive = false;')
      // …while the tab it *is* working on stays locked in the model.
      expect(manager.listTabs('ac-lock').find((tab) => tab.id === heldId)?.lockedBy).toBe('sess-lock')

      manager.activateTab('ac-lock', heldId)
      await settle()
      expect(overlayScript(instance)).toContain('const shieldActive = true;')
    })

    // A conversation can be working in this window with no tab held yet — its overlay is up for
    // the turn before its first command resolves a tab. That does not put a lock on the page:
    // the window being in use is said by the chrome (the rail's marks), because the lock, the
    // dim and the shield belong to the held tab (plan §22, 第十三轮修正).
    it('draws the panel without a lock while no tab is held', async () => {
      manager.createInstance('ac-idle')
      drive('ac-idle', 'sess-idle')

      manager.setAgentControl('sess-idle', {
        displayName: 'Browser',
        intent: 'Session controls this window',
      })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-idle')
      // The panel's line around the page is up, and it says no lock.
      expect(instance.nativeOverlayView.setBounds).toHaveBeenLastCalledWith({ x: 200, y: 48, width: 1000, height: 852 })
      expect(overlayScript(instance)).toContain('const locked = false;')
      expect(overlayScript(instance)).toContain('const shieldActive = false;')
      expect(instance.nativeOverlayView.webContents.focus).not.toHaveBeenCalled()
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
      holdActiveTab('ac-reapply', 'sess-reapply')
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-reapply')
      const callCountAfterSet = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length

      tab(instance).tabView.webContents._emit('did-stop-loading')
      await Promise.resolve()

      expect(instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(callCountAfterSet)
    })

    it('reapplies native overlay after hide/show while control is active', async () => {
      manager.createInstance('ac-show-reapply')
      drive('ac-show-reapply', 'sess-show-reapply')

      manager.setAgentControl('sess-show-reapply', { displayName: 'Click Button', intent: 'Clicking submit' })
      holdActiveTab('ac-show-reapply', 'sess-show-reapply')
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-show-reapply')
      const callCountAfterSet = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length

      instance.window._emit('hide')
      instance.window._emit('show')
      await Promise.resolve()

      expect(instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(callCountAfterSet)
    })

    it('setAgentControl uses fallback label when no intent', async () => {
      manager.createInstance('ac-2')
      drive('ac-2', 'sess-2')

      manager.setAgentControl('sess-2', { displayName: 'Browser Snapshot' })
      holdActiveTab('ac-2', 'sess-2')
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-2')
      const calls = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(String(calls[calls.length - 1][0])).toContain('Browser Snapshot')
    })

    it('setAgentControl uses default label when no metadata', async () => {
      manager.createInstance('ac-3')
      drive('ac-3', 'sess-3')

      manager.setAgentControl('sess-3', {})
      holdActiveTab('ac-3', 'sess-3')
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-3')
      const calls = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(String(calls[calls.length - 1][0])).toContain('Agent is working…')
    })

    it('clearAgentControl dismisses native overlay', () => {
      manager.createInstance('ac-4')
      drive('ac-4', 'sess-4')

      manager.setAgentControl('sess-4', { displayName: 'Click Button', intent: 'Clicking submit' })
      manager.clearAgentControl('sess-4')

      const instance = (manager as any).instances.get('ac-4')
      expect(instance.controlBy.size).toBe(0)
      expect(instance.nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    })

    it('clearAgentControl is a no-op when not active', () => {
      manager.createInstance('ac-5')
      drive('ac-5', 'sess-5')

      manager.clearAgentControl('sess-5')

      const instance = (manager as any).instances.get('ac-5')
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    it('clearVisualsForSession resets agent control state', async () => {
      manager.createInstance('ac-6')
      drive('ac-6', 'sess-6')

      manager.setAgentControl('sess-6', { displayName: 'Fill Input', intent: 'Typing email' })
      await manager.clearVisualsForSession('sess-6')

      const instance = (manager as any).instances.get('ac-6')
      expect(instance.controlBy.size).toBe(0)
      expect(instance.nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    })

    it('setAgentControl is a no-op when the workspace has no window', () => {
      manager.createInstance('ac-7', { workspaceId: 'ws-quiet' })

      // No window in the workspace the tool is working in: there is nothing to put an overlay
      // on, and the window of another workspace is not it (plan §22).
      manager.setAgentControl('some-session', { displayName: 'Test' }, { workspaceId: 'ws-elsewhere' })

      const instance = (manager as any).instances.get('ac-7')
      expect(instance.controlBy.size).toBe(0)
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    it('navigate does not trigger overlay by itself', async () => {
      manager.createInstance('ac-8')
      drive('ac-8', 'sess-8')

      await manager.navigate('ac-8', 'https://example.com')

      const instance = (manager as any).instances.get('ac-8')
      expect(instance.controlBy.size).toBe(0)
      // Navigating is not working *in* the window: the page keeps its panel, and the panel says
      // no agent is here.
      expect(overlayScript(instance)).toContain('const locked = false;')
    })
  })

  describe('failed interaction tracking', () => {
    it('clickElement records failed lastAction on error', async () => {
      manager.createInstance('fail-click')
      const instance = (manager as any).instances.get('fail-click')
      tab(instance).cdp.clickElement = mock(async () => { throw new Error('click failed') })

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
      tab(instance).cdp.fillElement = mock(async () => { throw new Error('fill failed') })

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
      tab(instance).cdp.selectOption = mock(async () => { throw new Error('select failed') })

      await expect(manager.selectOption('fail-select', '@e3', 'opt-1')).rejects.toThrow('select failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_select',
        ref: '@e3',
        status: 'failed',
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Tabs — one window, several tabs (plan §22)
  // ---------------------------------------------------------------------------

  describe('tabs', () => {
    /** A tab's own `did-navigate`, which is how a view reports where it landed. */
    function navigateOwn(tab: any, url: string) {
      tab.tabView.webContents.loadURL(url)
      tab.tabView.webContents._emit('did-navigate', url)
    }

    it('adds a tab to the window and puts it on screen', () => {
      manager.createInstance('tabs-basic')
      const instance = (manager as any).instances.get('tabs-basic')
      const first = instance.tabs[0]
      // The tab has been somewhere, so the window is in use and the new tab is
      // added beside it rather than taking its place (see the untouched-window
      // test below).
      first.currentUrl = 'https://first.example.com/'

      const secondId = manager.createTab('tabs-basic', { url: 'https://second.example.com/' })
      const second = instance.tabs.find((tab: any) => tab.id === secondId)

      expect(instance.tabs).toHaveLength(2)
      expect(instance.activeTabId).toBe(secondId)
      // The window reports the tab on screen, whichever it is.
      navigateOwn(second, 'https://second.example.com/')
      expect(instance.currentUrl).toBe('https://second.example.com/')
      expect(manager.listTabs('tabs-basic')).toEqual([
        tabSummary({ id: first.id, url: 'https://first.example.com/' }),
        // The title comes from the page (`getTitle()` in the mock), which is what a
        // real `did-navigate` would have reported too.
        tabSummary({ id: secondId, url: 'https://second.example.com/', title: 'Test Page', active: true }),
      ])
    })

    // The backdrop belongs to the *view*: `webContents.setBackgroundColor` does not exist,
    // so calling it there was a silent no-op and a tab whose page paints nothing was a hole
    // onto whichever tab is stacked under it (every tab is laid out at the same bounds).
    it('gives each tab a backdrop of its own', () => {
      manager.createInstance('tabs-backdrop')
      const instance = (manager as any).instances.get('tabs-backdrop')
      const first = instance.tabs[0]

      expect(first.tabView.setBackgroundColor).toHaveBeenCalledWith(BACKGROUND_HEX.light)
      // The overlay is the window's and is transparent: what it paints — the gutter's surface —
      // is its document's business, not the view's backdrop.
      expect(instance.nativeOverlayView.setBackgroundColor).toHaveBeenCalledWith('#00000000')

      const secondId = manager.createTab('tabs-backdrop', { url: 'https://second.example.com/' })
      const second = instance.tabs.find((tab: any) => tab.id === secondId)

      expect(second.tabView.setBackgroundColor).toHaveBeenCalledWith(BACKGROUND_HEX.light)
    })

    // A window is created holding one blank tab. That tab is what a window is
    // made of rather than something a person put there, so opening into a fresh
    // window opens *into* it: without this, a session that has just opened a
    // prototype would carry its own blank tab beside it — a tab nobody made and
    // nobody can name.
    it('opens into a window\'s untouched tab instead of beside it', () => {
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
      // third-party address, so the tab has to be told whose it is.
      expect(only.boundPrototype).toEqual({
        slug: 'checkout-flow',
        origin: 'http://checkout-flow-ab12cd34.localhost',
      })
      expect(only.tabView.webContents.loadURL).toHaveBeenCalledWith('https://fresh.example.com/')
    })

    // The other half of that rule. A caller with neither a url nor an identity to put
    // in the window (the app's "New tab", which opens the browser if it is not up yet)
    // wants *a* tab, not one more tab, and has to say so. On a window that is not up
    // yet its own blank tab is the tab being asked for: adding beside it is how "New
    // tab" came up with two blank tabs.
    it('gives an untouched window\'s own tab to a caller that asked for one', () => {
      manager.createInstance('tabs-adopt-fresh')
      const instance = (manager as any).instances.get('tabs-adopt-fresh')
      const only = instance.tabs[0]

      const tabId = manager.createTab('tabs-adopt-fresh', { reuseUntouchedWindow: true })

      expect(tabId).toBe(only.id)
      expect(instance.tabs).toHaveLength(1)
      expect(instance.activeTabId).toBe(only.id)
    })

    it('adds a real tab for that caller when the window is already in use', () => {
      manager.createInstance('tabs-adopt-used')
      const instance = (manager as any).instances.get('tabs-adopt-used')
      const first = instance.tabs[0]
      first.currentUrl = 'https://first.example.com/'

      const tabId = manager.createTab('tabs-adopt-used', { reuseUntouchedWindow: true })

      expect(tabId).not.toBe(first.id)
      expect(instance.tabs).toHaveLength(2)
      expect(instance.activeTabId).toBe(tabId)
    })

    // The reason the wiring had to move onto the tab: a hidden tab keeps loading,
    // and its events must land on itself rather than on whoever is on screen.
    it('keeps a background tab\'s navigation on itself', () => {
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
      // A tab that is not on screen is **created in the parking window** — the window shown off
      // screen where every tab that is not showing lives — at the size the page area had when it was
      // opened. That is its viewport until it comes forward, and it is what keeps the person's window
      // free of pages nobody asked to see (plan §22 第十七轮).
      expect(second.tabView.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 993, height: 845 })
      expect(instance.window.contentView.children).not.toContain(second.tabView)
      expect(instance.parkingWindow.contentView.children).toContain(second.tabView)
    })

    it('switches tabs and reports the one that came forward', () => {
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
      // Switching is a stack change, not a resize: every tab is laid out the same way, and
      // the one that came forward is the one raised above the others (plan §22, 第十二轮).
      // The page is raised through `contentView` — it is a `WebContentsView` — while the
      // overlays and the chrome are still raised through `setTopBrowserView`.
      const pageRaises = instance.window.contentView.addChildView.mock.calls.map((call: unknown[]) => call[0])
      const tabsRaised = pageRaises.filter((view: unknown) => view === first.tabView || view === second.tabView)
      expect(tabsRaised[tabsRaised.length - 1]).toBe(first.tabView)
    })

    // Committing a page is where Chromium hands a webContents the focus, and it does not ask
    // which tab is showing (measured: the cursor left the field on the tab on screen the moment
    // an agent's tab loaded, and switching back did not bring it back).
    it('keeps the keyboard on the tab on screen when a page loads in a tab behind it', () => {
      manager.createInstance('tabs-focus-behind')
      const instance = (manager as any).instances.get('tabs-focus-behind')
      const onScreen = instance.tabs[0]
      const behindId = manager.createTab('tabs-focus-behind', { activate: false })
      const behind = instance.tabs.find((tab: any) => tab.id === behindId)
      // The page that just committed is the one that was handed the focus…
      behind.tabView.webContents.isFocused = mock(() => true)
      onScreen.tabView.webContents.focus.mockClear()

      navigateOwn(behind, 'https://behind.example.com/')

      // …and the tab on screen takes it back, because that is the one the person is looking at.
      expect(onScreen.tabView.webContents.focus).toHaveBeenCalled()
    })

    it('leaves the address bar alone when a page loads in a tab behind the person', () => {
      manager.createInstance('tabs-focus-bar')
      const instance = (manager as any).instances.get('tabs-focus-bar')
      const onScreen = instance.tabs[0]
      const behindId = manager.createTab('tabs-focus-bar', { activate: false })
      const behind = instance.tabs.find((tab: any) => tab.id === behindId)
      onScreen.tabView.webContents.focus.mockClear()

      // No tab holds the keyboard: the person is typing into the window's chrome (the address
      // bar, the rail), and a page committing behind their back is no reason to take that away.
      navigateOwn(behind, 'https://behind.example.com/')

      expect(onScreen.tabView.webContents.focus).not.toHaveBeenCalled()
    })

    it('gives the keyboard to the tab that comes forward, and never moves the window for it', () => {
      manager.createInstance('tabs-focus-switch')
      const instance = (manager as any).instances.get('tabs-focus-switch')
      const first = instance.tabs[0]
      const secondId = manager.createTab('tabs-focus-switch', { activate: false })
      const second = instance.tabs.find((tab: any) => tab.id === secondId)
      second.tabView.webContents.focus.mockClear()

      manager.activateTab('tabs-focus-switch', secondId)
      expect(second.tabView.webContents.focus).toHaveBeenCalled()

      // A window that is not the one the person is in is left alone: `webContents.focus()`
      // activates its window (measured: the app's window came forward over another one), and a
      // conversation working in the background must never pull the window in front.
      instance.window.focus.mockClear()
      first.tabView.webContents.focus.mockClear()
      instance.window.isFocused = mock(() => false)
      manager.activateTab('tabs-focus-switch', first.id)

      expect(first.tabView.webContents.focus).not.toHaveBeenCalled()
      expect(instance.window.focus).not.toHaveBeenCalled()
    })

    it('hands the keyboard to the tab that takes over when the tab on screen closes', () => {
      manager.createInstance('tabs-focus-close')
      const instance = (manager as any).instances.get('tabs-focus-close')
      const onScreen = instance.tabs[0]
      manager.createTab('tabs-focus-close', { activate: false })

      manager.closeTab('tabs-focus-close', onScreen.id)

      // The tab that went away had the keyboard; what the window shows next takes it.
      const next = instance.tabs.find((tab: any) => tab.id === instance.activeTabId)
      expect(next.tabView.webContents.focus).toHaveBeenCalled()
    })

    it('rounds the page itself, so any page is a rounded panel the person can click', () => {
      manager.createInstance('tabs-radius')
      const instance = (manager as any).instances.get('tabs-radius')
      const first = instance.tabs[0]

      // Rounded by the page's own view rather than by ink over it: a view covers a rectangle
      // whatever it paints, so anything drawn over the page takes the page's clicks with it.
      expect(first.tabView.setBorderRadius).toHaveBeenCalledWith(10)
      // …and it is in the window's view tree through that same view's API.
      expect(instance.window.contentView.children).toContain(first.tabView)
      expect(instance.window.contentView.children).toContain(instance.nativeOverlayView)
      // The overlay sits under the page: what it draws is around the page. It is the window's,
      // and it is in the window before any page is — a new tab's page lands inside a frame that
      // is already drawn rather than one that arrives with the page.
      expect(instance.window.contentView.children.indexOf(first.tabView))
        .toBeGreaterThan(instance.window.contentView.children.indexOf(instance.nativeOverlayView))
    })

    it('says the page corner radius again when the window lands on another display', () => {
      manager.createInstance('tabs-moved')
      const instance = (manager as any).instances.get('tabs-moved')
      const view = instance.tabs[0].tabView
      const before = view.setBorderRadius.mock.calls.length

      // The cut is built against the display the window is on, and it does not survive arriving
      // on a different one: the corner comes back square, which lets the page's own paint (white,
      // on many sites) show where the panel's rounded surface and its line are.
      instance.window._emit('moved')

      expect(view.setBorderRadius.mock.calls.length).toBeGreaterThan(before)
      expect(view.setBorderRadius.mock.calls.at(-1)).toEqual([10])
    })

    it('draws no corner of its own, leaving the shape to the page', () => {
      manager.createInstance('tabs-mask-square')
      const instance = (manager as any).instances.get('tabs-mask-square')
      const loaded = String(instance.nativeOverlayView.webContents.loadURL.mock.calls[0]?.[0] ?? '')
      const html = decodeURIComponent(loaded.slice(loaded.indexOf(',') + 1))

      // What is behind the page is square, so the corner's shape is the page's own cut and only
      // that. A rounded hole here would be a second copy of the shape — CSS pixels here, the
      // display's metrics for the cut — and where the two disagree the page's own paint (white,
      // on many sites) is what shows through in the difference, which nothing in this document
      // can cover: the page sits above it.
      expect(html).not.toMatch(/#mask\s*\{[^}]*border-radius/)
      // The line outside the page keeps its arc: it sits outside the page, so its arcs are the
      // line's own shape rather than a second copy of the page's corner.
      expect(html).toMatch(/#frame\s*\{[^}]*border-radius:\s*11px/)
    })

    it('draws the agent frame over the page edge and into the gutter', () => {
      manager.createInstance('tabs-lock-frame')
      const instance = (manager as any).instances.get('tabs-lock-frame')
      const loaded = String(instance.nativeOverlayView.webContents.loadURL.mock.calls[0]?.[0] ?? '')
      const html = decodeURIComponent(loaded.slice(loaded.indexOf(',') + 1))

      // The agent's frame is its own element, in the resting line's box (1px outside the page, so
      // its arcs are concentric with the page's corner) but with its own weight: 2.5px — the outer
      // pixel fills the gutter, the inner 1.5px covers the page's edge. Covering that edge is the
      // point: the page's corner is cut by its own view, a hard edge nothing outside the page can
      // hide.
      expect(html).toContain('id="lock"')
      expect(html).toContain('border: 2.5px solid transparent')
      expect(html).toContain('id="frame"')
    })

    it('closes a tab, and closes the window when the last one goes', () => {
      manager.createInstance('tabs-close')
      const instance = (manager as any).instances.get('tabs-close')
      const first = instance.tabs[0]
      first.currentUrl = 'https://first.example.com/'
      const secondId = manager.createTab('tabs-close', { activate: false })
      const second = instance.tabs.find((tab: any) => tab.id === secondId)

      manager.closeTab('tabs-close', first.id)
      expect(instance.tabs).toHaveLength(1)
      expect(instance.activeTabId).toBe(secondId)

      // A closed tab leaves the window: `tabs` is not the view list, and a view left behind
      // keeps painting at the tab area — a tab nobody can name showing through every tab
      // opened after it, and one more renderer to pay for. The overlay is not part of this:
      // it is the window's, so a tab going away does not take the panel's ground with it.
      expect(instance.window.contentView.removeChildView.mock.calls.map((call: unknown[]) => call[0]))
        .toEqual([first.tabView])
      expect(instance.window.contentView.children).not.toContain(first.tabView)
      expect(instance.window.removeBrowserView.mock.calls.map((call: unknown[]) => call[0]))
        .not.toContain(instance.nativeOverlayView)
      expect(instance.window.contentView.children).toContain(instance.nativeOverlayView)
      expect(first.tabView.webContents.close).toHaveBeenCalled()
      // …and the tab that is still open is not touched by somebody else's tab going away,
      // nor is the overlay the window keeps for it.
      expect(second.tabView.webContents.close).not.toHaveBeenCalled()
      expect(instance.nativeOverlayView.webContents.close).not.toHaveBeenCalled()

      manager.closeTab('tabs-close', secondId)
      expect((manager as any).instances.has('tabs-close')).toBe(false)
    })

    /**
     * Which tab takes over when the one that closes was the tab on screen.
     *
     * A neighbour **of its own section** when its section has one left, and only the neighbour
     * *by position* when it does not (`successorOf`). The section is what the rail draws, so
     * this is the handover a person sees: closing a page they opened for a conversation lands on
     * that conversation's next page rather than on whichever tab sits beside it in the window's
     * list — which here is somebody else's.
     */
    it('hands over inside the closed tab\'s own section, not across sections', () => {
      const work = { kind: 'session', sessionId: 'session-1' } as const
      manager.createInstance('tabs-successor')
      const instance = (manager as any).instances.get('tabs-successor')

      // The window's list, in order: yours, the conversation's, yours, the conversation's.
      const theirsFirstId = manager.createTab('tabs-successor', { activate: false, belongsTo: work })
      const mineSecondId = manager.createTab('tabs-successor', { activate: false })
      const theirsSecondId = manager.createTab('tabs-successor', { activate: false, belongsTo: work })

      manager.activateTab('tabs-successor', theirsFirstId)
      manager.closeTab('tabs-successor', theirsFirstId)
      expect(instance.activeTabId).toBe(theirsSecondId)

      // Their section is empty now, so the neighbour by position decides — the tab that was
      // before it, since it was the last of the window.
      manager.closeTab('tabs-successor', theirsSecondId)
      expect(instance.activeTabId).toBe(mineSecondId)
    })

    it('hands a section over to the tab before it when nothing of that work is left after', () => {
      const work = { kind: 'session', sessionId: 'session-2' } as const
      manager.createInstance('tabs-successor-back')
      const instance = (manager as any).instances.get('tabs-successor-back')

      // yours, the conversation's first, yours, the conversation's second: closing the second is
      // the end of its section, with somebody else's tab right after it in the window's list.
      const theirsFirstId = manager.createTab('tabs-successor-back', { activate: false, belongsTo: work })
      manager.createTab('tabs-successor-back', { activate: false })
      const theirsSecondId = manager.createTab('tabs-successor-back', { activate: false, belongsTo: work })

      manager.activateTab('tabs-successor-back', theirsSecondId)
      manager.closeTab('tabs-successor-back', theirsSecondId)
      expect(instance.activeTabId).toBe(theirsFirstId)
    })

    /**
     * Whether the tab was sent somewhere at all — the empty state through either route
     * (`loadFile` in a packaged app, `loadURL` against the dev server), or an address.
     */
    function loadsOf(tab: any): string[][] {
      return [
        ...tab.tabView.webContents.loadFile.mock.calls,
        ...tab.tabView.webContents.loadURL.mock.calls,
      ]
    }

    // A tab created and left empty is not an empty tab: a view that has never painted
    // contributes no pixels, and every tab of the window sits at the same bounds — so the
    // new tab showed the tab underneath it, i.e. switching to a new tab looked like the
    // old one still being there (plan §22, 用户报告). Every entry point that adds a tab
    // therefore leaves a document in it, and the agent's `tab-new` and the app's "New tab"
    // are the ones that used to leave about:blank behind.
    it('gives a document to a tab that was not given an address', () => {
      manager.createInstance('tabs-document')
      const instance = (manager as any).instances.get('tabs-document')
      instance.tabs[0].currentUrl = 'https://first.example.com/'

      const secondId = manager.createTab('tabs-document', { activate: true })
      const second = instance.tabs.find((tab: any) => tab.id === secondId)
      expect(loadsOf(second)).toHaveLength(1)

      // A tab that *was* given an address gets that, and not the empty state as well:
      // the address is the document it was made for.
      const thirdId = manager.createTab('tabs-document', { url: 'https://third.example.com/' })
      const third = instance.tabs.find((tab: any) => tab.id === thirdId)
      expect(loadsOf(third)).toEqual([['https://third.example.com/']])
    })

    /** The last state the window pushed to its own toolbar. */
    function lastToolbarState(instance: any): any {
      const calls = instance.toolbarView.webContents.send.mock.calls.filter(
        (call: unknown[]) => call[0] === 'browser-toolbar:state-update',
      )
      return calls[calls.length - 1]?.[1]
    }

    // The window's chrome is an L and the tab sits inside it: the rail's width comes
    // off the left, the bar's height off the top. Neither depends on how many tabs
    // there are — the room belongs to the window, not to the list.
    it("keeps the rail's room whatever the list does, so its `+` is always reachable", () => {
      manager.createInstance('tabs-room')
      const instance = (manager as any).instances.get('tabs-room')
      instance.window._emit('show')

      // The rail itself: the window's whole left column, and the bar starts where it
      // ends — so the back button and the address bar are all to the right of the
      // tabs, and nothing of the bar sits over them.
      expect(instance.railView.setBounds).toHaveBeenCalledWith({
        x: 0, y: 0, width: 200, height: expect.anything(),
      })
      expect(instance.toolbarView.setBounds).toHaveBeenCalledWith({
        x: 200, y: 0, width: 1000, height: 48,
      })

      // And the rail is the topmost view in the window: tabs and the agent's overlay
      // are added over it, and raising the chrome leaves the rail on top — so nothing
      // can cover the tabs or swallow the clicks meant for them.
      const raised = instance.window.setTopBrowserView.mock.calls.map((call: unknown[]) => call[0])
      expect(raised[raised.length - 1]).toBe(instance.railView)

      // One tab: the rail is still there, because that is when somebody wants a
      // second one and the `+` is the only way to make it.
      expect(tab(instance).tabView.setBounds).toHaveBeenCalledWith({
        x: 201, y: 49, width: expect.anything(), height: expect.anything(),
      })

      instance.tabs[0].currentUrl = 'https://first.example.com/'
      const secondId = manager.createTab('tabs-room', { url: 'https://second.example.com/' })
      const second = instance.tabs.find((tab: any) => tab.id === secondId)

      expect(second.tabView.setBounds).toHaveBeenCalledWith({
        x: 201, y: 49, width: expect.anything(), height: expect.anything(),
      })

      // And closing back down to one tab does not move it.
      manager.closeTab('tabs-room', secondId)
      expect(instance.tabs[0].tabView.setBounds).toHaveBeenCalledWith({
        x: 201, y: 49, width: expect.anything(), height: expect.anything(),
      })
    })

    // The three parts of a tab's metadata, in one payload: what the tab reports,
    // who asked for it, and who is working on it now.
    it('reports what each tab is, who asked for it, and who is driving it', () => {
      manager.createInstance('tabs-meta')
      const instance = (manager as any).instances.get('tabs-meta')
      instance.tabs[0].currentUrl = 'https://first.example.com/'

      manager.createTab('tabs-meta', {
        prototype: { slug: 'checkout-flow', origin: 'http://checkout-flow-ab12cd34.localhost' },
        belongsTo: work('session-a'),
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
          belongsTo: work('session-a'),
          // Whoever opened a tab is working on it: the lease starts where the tab
          // does.
          driverSessionId: 'session-a',
          // …and so does the cursor: a tab a conversation opened is the tab its next
          // unnamed command means (plan §22, 第十轮).
          cursorOf: 'session-a',
        }),
      ])

      // The window's own state carries the tabs too, so the top bar's badge can
      // group them without asking the manager anything else.
      expect(lastToolbarState(instance).tabs).toHaveLength(2)
      expect(manager.listInstances().find((item) => item.id === 'tabs-meta')?.tabs).toHaveLength(2)
    })

    // The rail groups a window's tabs by whose work they are, and needs a name to write on
    // each group: `belongsTo` names a conversation (a session id is not something a person
    // can read; a task is named by its own slug, which needs nothing from here). Names only —
    // an opener with no name yet is left out, because the chrome has
    // a generic label for that and printing an id is worse than saying nothing.
    it('names the conversations whose tabs are in the window', () => {
      manager.setSessionLabelResolver((sessionId) => (sessionId === 'session-a' ? 'Checkout fix' : null))
      manager.createInstance('tabs-labels')
      const instance = (manager as any).instances.get('tabs-labels')
      instance.tabs[0].currentUrl = 'https://first.example.com/'

      manager.createTab('tabs-labels', { belongsTo: work('session-a') })
      manager.createTab('tabs-labels', { belongsTo: work('session-unnamed') })

      expect(lastToolbarState(instance).sessionLabels).toEqual({ 'session-a': 'Checkout fix' })
    })

    // The lock names the tab a session *holds* — the one its command resolved to — and only
    // that tab (plan §22, 第九轮修正): reading it off "whichever tab the lease is on" put
    // it on the tab a command fell back to, usually the one the person was looking at.
    it('reports which tab a working session has locked, and only that one', () => {
      manager.createInstance('tabs-lock')
      drive('tabs-lock', 'session-a')
      const instance = (manager as any).instances.get('tabs-lock')
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      const heldId = manager.createTab('tabs-lock', {
        url: 'https://second.example.com/',
        belongsTo: work('session-a'),
      })
      manager.createTab('tabs-lock', { url: 'https://third.example.com/', belongsTo: work('session-a') })

      // No overlay yet: tabs are *driven*, which is not a lock.
      expect(manager.listTabs('tabs-lock').map((tab) => tab.lockedBy)).toEqual([null, null, null])

      manager.setAgentControl('session-a', { displayName: 'Click', intent: 'Pressing Buy' })
      // …and an overlay with no command behind it yet holds nothing either.
      expect(manager.listTabs('tabs-lock').map((tab) => tab.lockedBy)).toEqual([null, null, null])

      // A command resolving to a tab is what takes it — and it takes exactly that one.
      manager.setSessionTab('tabs-lock', heldId, 'session-a')

      expect(manager.listTabs('tabs-lock').map((tab) => tab.lockedBy)).toEqual([null, 'session-a', null])
      // The tab the window came with, and the other tab of the same session, stay free.
      expect(manager.listTabs('tabs-lock')[0].driverSessionId).toBeNull()

      manager.clearAgentControl('session-a')

      expect(manager.listTabs('tabs-lock').map((tab) => tab.lockedBy)).toEqual([null, null, null])
    })

    // A lock never outlives what it locks: closing the held tab lets go of it, instead of
    // leaving the window claiming a tab that is gone (plan §22, 第九轮修正).
    it('lets go of a tab when the tab is closed', () => {
      manager.createInstance('tabs-lock-closed')
      drive('tabs-lock-closed', 'session-a')
      const instance = (manager as any).instances.get('tabs-lock-closed')
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      const heldId = manager.createTab('tabs-lock-closed', { belongsTo: work('session-a') })
      manager.setAgentControl('session-a', { displayName: 'Click', intent: 'Pressing Buy' })
      manager.setSessionTab('tabs-lock-closed', heldId, 'session-a')

      expect(manager.listTabs('tabs-lock-closed').map((tab) => tab.lockedBy)).toEqual([null, 'session-a'])

      manager.closeTab('tabs-lock-closed', heldId)

      expect(manager.listTabs('tabs-lock-closed').map((tab) => tab.lockedBy)).toEqual([null])
    })

    // The cursor is where a conversation's unnamed commands go, so a tab it opened is its
    // tab — and moving to another tab of its own leaves exactly one behind (plan §22).
    it('keeps one tab per conversation as the tab it works from', () => {
      manager.createInstance('tabs-cursor')
      const instance = (manager as any).instances.get('tabs-cursor')
      instance.tabs[0].currentUrl = 'https://first.example.com/'

      const first = manager.createTab('tabs-cursor', { belongsTo: work('session-a') })
      // A second tab of the same conversation takes the cursor from the first: one tab
      // per conversation is the whole point.
      manager.createTab('tabs-cursor', { belongsTo: work('session-a') })

      expect(manager.listTabs('tabs-cursor').map((tab) => tab.cursorOf)).toEqual([null, null, 'session-a'])

      manager.setSessionTab('tabs-cursor', first, 'session-a')

      expect(manager.listTabs('tabs-cursor').map((tab) => tab.cursorOf)).toEqual([null, 'session-a', null])

      // The person switching tabs moves the display and nothing else.
      manager.activateTab('tabs-cursor', instance.tabs[0].id)

      expect(instance.activeTabId).toBe(instance.tabs[0].id)
      expect(manager.listTabs('tabs-cursor').map((tab) => tab.cursorOf)).toEqual([null, 'session-a', null])
    })

    /**
     * Handing a tab over: the orchestrator's half of "a DAG's nodes each get their own tab"
     * (plan §22, Conductor). Who may give a tab away is decided here, because only the tab
     * knows whose task it is — and the receiver has to be able to start working without naming
     * anything, or the handover would hand over a tab it cannot reach.
     */
    it('hands a tab to another conversation, and refuses to hand on somebody else\'s', () => {
      manager.createInstance('tabs-assign')
      const instance = (manager as any).instances.get('tabs-assign')
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      const handedTab = manager.createTab('tabs-assign', { belongsTo: work('parent') })

      manager.assignTab('tabs-assign', handedTab, work('child-1'), work('parent'))

      const tab = () => manager.listTabs('tabs-assign').find((candidate) => candidate.id === handedTab)!
      expect(tab().belongsTo).toEqual({ kind: 'session', sessionId: 'child-1' })
      // The tab is the receiver's to work from: it can start without naming one.
      expect(tab().cursorOf).toBe('child-1')
      expect(whyTabIsOutOfReach(tab(), work('child-1'))).toBeNull()

      // The giver is out of it: it can neither work there any more nor pass it on again.
      expect(whyTabIsOutOfReach(tab(), work('parent'))).not.toBeNull()
      expect(() => manager.assignTab('tabs-assign', handedTab, work('child-2'), work('parent'))).toThrow(/child-1/)
    })

    // What a DAG needs of a tab's owner (plan §22): a tab handed to a node belongs to that
    // *node*, so the session repair spawns to re-run the same node finds it again instead of
    // opening a second one — while a sibling node, and the next run of the same task, do not.
    it('stamps a node\'s work on the tab, so a re-run of that node inherits it', () => {
      manager.createInstance('tabs-node-work')
      const instance = (manager as any).instances.get('tabs-node-work')
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      const stampedTab = manager.createTab('tabs-node-work', { belongsTo: work('orchestrator') })

      manager.assignTab('tabs-node-work', stampedTab, nodeWork('checkout-flow', 'pay', 'child-1'), work('orchestrator'))

      const tab = () => manager.listTabs('tabs-node-work').find((candidate) => candidate.id === stampedTab)!
      expect(tab().belongsTo).toEqual({
        kind: 'task',
        taskSlug: 'checkout-flow',
        runId: 'r1',
        nodeId: 'pay',
        sessionId: 'child-1',
      })
      // The node that was re-run works in the tab its predecessor left; a sibling node does not.
      expect(whyTabIsOutOfReach(tab(), nodeWork('checkout-flow', 'pay', 'child-1-rerun'))).toBeNull()
      expect(whyTabIsOutOfReach(tab(), nodeWork('checkout-flow', 'cart', 'child-2'))).not.toBeNull()
    })

    // Every tab but the one on screen is covered by the view above it, and Chromium marks a
    // covered page hidden — and a hidden page stops honouring the layout it is handed, which is
    // how a background tab was left at the old size when the window grew (measured in
    // `apps/electron/spike/resize-follow.cjs`). So no tab's throttling is narrowed, for anybody.
    it('builds every tab view never-throttled, whoever works from it', () => {
      manager.createInstance('tabs-throttle')
      const instance = (manager as any).instances.get('tabs-throttle')
      instance.tabs[0].currentUrl = 'https://first.example.com/'

      const mine = manager.createTab('tabs-throttle', { belongsTo: work('session-a') })
      const nobodys = manager.createTab('tabs-throttle')

      /** `false` = Chromium may not throttle this page when it is not the one on screen. */
      const builtUnthrottled = (tabId: string) => {
        const tab = instance.tabs.find((candidate: any) => candidate.id === tabId)
        return tab.tabView._options?.webPreferences?.backgroundThrottling
      }

      expect(builtUnthrottled(instance.tabs[0].id)).toBe(false)
      expect(builtUnthrottled(mine)).toBe(false)
      expect(builtUnthrottled(nobodys)).toBe(false)

      // And nothing re-states it per tab afterwards: the page's visibility is not something a
      // cursor or a hand-over may narrow.
      const narrowed = () => instance.tabs
        .map((tab: any) => tab.tabView.webContents.setBackgroundThrottling.mock.calls.length)
      const before = narrowed()
      manager.setSessionTab('tabs-throttle', nobodys, 'session-a')
      expect(narrowed()).toEqual(before)
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

    it('switches, closes and adds tabs from the strip', async () => {
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

      // The `+` opens a tab nobody's session asked for, which is what "a person's
      // tab" means here.
      await handle({}, 'tabs-ipc', 'new')
      expect(instance.tabs).toHaveLength(2)
      expect(instance.tabs[1].belongsTo).toBeNull()
    })

    it('ignores a strip action that names no tab', async () => {
      manager.createInstance('tabs-ipc-empty')
      const instance = (manager as any).instances.get('tabs-ipc-empty')
      manager.registerToolbarIpc()

      await tabsHandler()({}, 'tabs-ipc-empty', 'close')
      await tabsHandler()({}, 'tabs-ipc-empty', 'activate')

      expect(instance.tabs).toHaveLength(1)
      expect(instance.activeTabId).toBe(instance.tabs[0].id)
    })

    // The `+` on a window that has only its own blank tab. That tab reads as
    // `about:blank` (that is how the empty state is normalized), which is also what the
    // "open into an untouched window" reuse looks for — but that reuse needs something
    // to *put in* the window, and "a new tab" is not content, it is the request. With
    // the reuse applying here, nothing appeared to happen: the window kept its one tab
    // and the `+` looked broken.
    it('adds a tab from the strip when the window holds only its blank tab', async () => {
      manager.createInstance('tabs-ipc-fresh')
      const instance = (manager as any).instances.get('tabs-ipc-fresh')
      manager.registerToolbarIpc()

      expect(instance.tabs[0].currentUrl).toBe('about:blank')

      await tabsHandler()({}, 'tabs-ipc-fresh', 'new')

      expect(instance.tabs).toHaveLength(2)
      expect(instance.tabs[1].belongsTo).toBeNull()
      expect(instance.activeTabId).toBe(instance.tabs[1].id)
    })
  })

  describe('developer tools', () => {
    /** The last state the window pushed to its own toolbar. */
    function lastToolbarState(instance: any): any {
      const calls = instance.toolbarView.webContents.send.mock.calls.filter(
        (call: unknown[]) => call[0] === 'browser-toolbar:state-update',
      )
      return calls[calls.length - 1]?.[1]
    }

    /** The registered `browser-toolbar:devtools` handler. */
    function devToolsHandler(): (_event: unknown, instanceId: string) => Promise<void> {
      const registration = (
        mockIpcMainHandle.mock.calls as unknown as Array<
          [string, (_event: unknown, instanceId: string) => Promise<void>]
        >
      ).find(([channel]) => channel === 'browser-toolbar:devtools')
      if (!registration) throw new Error('Expected browser-toolbar:devtools IPC registration')
      return registration[1]
    }

    /** A window with a second tab in front, so "the tab on screen" is a choice. */
    function windowWithTwoTabs(id: string): any {
      manager.createInstance(id)
      const instance = (manager as any).instances.get(id)
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      manager.createTab(id, { url: 'https://second.example.com/' })
      return instance
    }

    // Detached, because the page is a `BrowserView`: a docked panel would be laid out
    // inside the view's own rectangle, over the page it is inspecting.
    it('opens the tools on the tab on screen, and reports them to the bar', async () => {
      manager.createInstance('devtools-window')
      const instance = (manager as any).instances.get('devtools-window')
      manager.registerToolbarIpc()
      const handle = devToolsHandler()

      await handle({}, 'devtools-window')

      expect(tab(instance).tabView.webContents.openDevTools).toHaveBeenCalledWith({ mode: 'detach' })
      expect(lastToolbarState(instance).devTools).toBe(true)

      // The button is a toggle, and the state that comes back is the tab's own answer
      // rather than the click's.
      await handle({}, 'devtools-window')

      expect(tab(instance).tabView.webContents.closeDevTools).toHaveBeenCalled()
      expect(lastToolbarState(instance).devTools).toBe(false)
    })

    it('puts them away when the user switches to another tab', async () => {
      const instance = windowWithTwoTabs('devtools-switch')
      const [first, second] = instance.tabs
      manager.registerToolbarIpc()

      await devToolsHandler()({}, 'devtools-switch')
      expect(second.tabView.webContents.openDevTools).toHaveBeenCalled()

      manager.activateTab('devtools-switch', first.id)

      // The tab that left the screen took its tools with it, and the one that came
      // forward did not inherit them: what is on screen and what is inspected agree.
      expect(second.tabView.webContents.closeDevTools).toHaveBeenCalled()
      expect(first.tabView.webContents.openDevTools).not.toHaveBeenCalled()
      expect(lastToolbarState(instance).devTools).toBe(false)
    })

    it('takes them with a tab that is closed', async () => {
      const instance = windowWithTwoTabs('devtools-close')
      const second = instance.tabs[1]
      manager.registerToolbarIpc()

      await devToolsHandler()({}, 'devtools-close')
      manager.closeTab('devtools-close', second.id)

      expect(second.tabView.webContents.closeDevTools).toHaveBeenCalled()
      expect(lastToolbarState(instance).devTools).toBe(false)
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
     * Stands in for the tab's CDP session.
     *
     * The picker is now a loop that arms a tab and keeps reading it, so what the
     * tests need to control is those two calls — and what they need to see is that
     * arming a tab does *not* tear it down again. The last report repeats, so a
     * loop that keeps polling sees the same answer.
     */
    function stubPicker(tab: any, reports: Array<{ status: string; picks?: unknown[] }>) {
      let reads = 0
      const armOverlay = mock(async (_options: unknown) => {})
      const drainOverlay = mock(async () => {
        const report = reports[Math.min(reads++, reports.length - 1)]
        // The same shape the CDP session answers with: a status, whatever elements it
        // has to hand over (usually none), and whether a draft is holding the mode open.
        const empty = { status: 'pending', picks: [], saves: [], leavingWithEdits: false }
        return report ? { ...empty, status: report.status, picks: report.picks ?? [] } : empty
      })
      const askOverlayToLeave = mock(async () => {})
      const teardownOverlay = mock(async () => {})
      const saveEdits = mock(async () => {})
      tab.cdp = { armOverlay, drainOverlay, askOverlayToLeave, teardownOverlay, saveEdits }
      return { armOverlay, drainOverlay, askOverlayToLeave, teardownOverlay, saveEdits }
    }

    /**
     * Long enough for one more pass of the poll loop (250ms between passes).
     *
     * The loop is not driven by the calls that change the mode — asking the page to
     * leave is answered by the page, on its next poll — so a test that waits for the
     * answer has to wait that long.
     */
    const PICKER_POLL_WAIT = 350

    /** The toolbar's words, as the panel sends them down (the page has no i18n). */
    const PICK_LABELS = {
      add: 'Add to conversation',
      undo: 'Undo',
      redo: 'Redo',
      bold: 'Bold',
      italic: 'Italic',
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
      const { armOverlay, askOverlayToLeave, teardownOverlay } = stubPicker(instance.tabs[0], [
        { status: 'pending', picks: [] },
        { status: 'cancelled' },
      ])
      manager.registerToolbarIpc()

      await toolbarHandler('browser-toolbar:pick-element')({}, 'pick-mode', PICK_LABELS)
      await tick()

      expect(armOverlay).toHaveBeenCalledWith(
        expect.objectContaining({
          // The window's own mode: it stays mounted, and it draws the bar.
          resident: true,
          bar: true,
          // The bar's words travel down with the call: the page has no i18n.
          labels: PICK_LABELS,
          // The app's own accent: a concrete colour, because a page cannot see the
          // app's variables and the overlay has to be drawn in it. The bar's *own*
          // colours come down beside it, resolved the same way (the menu's, not the
          // accent — the bar is our menu on their page).
          accent: expect.stringMatching(/^(#|oklch|rgb|hsl)/),
          menu: { surface: expect.any(String), text: expect.any(String) },
        }),
      )
      expect(lastToolbarState(instance).picking).toBe(true)
      // Nothing is holding the mode open: the chip says how the mode works rather than
      // asking the save question.
      expect(lastToolbarState(instance).leavingWithEdits).toBe(false)
      // Picking is a mode, not a pick: arming leaves the page's overlay in place.
      expect(teardownOverlay).not.toHaveBeenCalled()

      await toolbarHandler('browser-toolbar:cancel-pick')({}, 'pick-mode')

      // Asking, not tearing down: the page may be holding a draft, so leaving is a
      // question — and the answer comes back on the next poll, not from this call.
      expect(askOverlayToLeave).toHaveBeenCalled()
      expect(teardownOverlay).not.toHaveBeenCalled()
      expect(lastToolbarState(instance).picking).toBe(true)

      await new Promise((resolve) => setTimeout(resolve, PICKER_POLL_WAIT))

      expect(lastToolbarState(instance).picking).toBe(false)
    })

    // The question "save before leaving?" is asked in the window's chrome, and answered
    // there: the ✓ writes the draft down and leaves, and the crosshair pressed again is
    // the "no" — the draft goes, and the mode with it.
    it('carries the question, and takes both answers from the window’s chrome', async () => {
      manager.createInstance('pick-save')
      const instance = (manager as any).instances.get('pick-save')
      const { drainOverlay, saveEdits, teardownOverlay } = stubPicker(instance.tabs[0], [{ status: 'pending' }])
      drainOverlay.mockImplementation(async () => ({
        status: 'pending',
        picks: [],
        saves: [],
        leavingWithEdits: true,
      }))
      manager.registerToolbarIpc()

      await toolbarHandler('browser-toolbar:pick-element')({}, 'pick-save', PICK_LABELS)
      await tick()

      // What the chip says ("unsaved edits — save before leaving?") comes from the page.
      expect(lastToolbarState(instance).leavingWithEdits).toBe(true)

      // The ✓: the page writes it down, and nothing here pretends to know what a save is.
      await toolbarHandler('browser-toolbar:save-edits')({}, 'pick-save')
      expect(saveEdits).toHaveBeenCalled()

      // The crosshair, pressed again while the question is up: no second ask, it leaves.
      await toolbarHandler('browser-toolbar:cancel-pick')({}, 'pick-save')
      expect(teardownOverlay).toHaveBeenCalled()
      expect(instance.picking).toBe(false)
      expect(lastToolbarState(instance).picking).toBe(false)
    })

    // The element alone cannot say which tab it came from, and the picker is the
    // window's — so the tab travels with the pick (plan §12.7).
    it('reports a pick with the tab it came from', async () => {
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

      await toolbarHandler('browser-toolbar:pick-element')({}, 'pick-origin', PICK_LABELS)
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

    // "Any tab's elements can be picked" is exactly this: the mode follows the
    // tab that comes forward, and the tab left behind gets its overlay taken off.
    it('moves to the tab that comes forward', async () => {
      manager.createInstance('pick-switch')
      const instance = (manager as any).instances.get('pick-switch')
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      const firstId = instance.tabs[0].id
      const first = stubPicker(instance.tabs[0], [{ status: 'pending', picks: [] }])

      const secondId = manager.createTab('pick-switch', { url: 'https://second.example.com/' })
      // A new tab is put on screen, so the test goes back before arming.
      manager.activateTab('pick-switch', firstId)
      const secondTab = instance.tabs.find((tab: any) => tab.id === secondId)
      const second = stubPicker(secondTab, [{ status: 'pending', picks: [] }])
      manager.registerToolbarIpc()

      await toolbarHandler('browser-toolbar:pick-element')({}, 'pick-switch')
      await tick()

      expect(first.armOverlay).toHaveBeenCalledTimes(1)
      expect(second.armOverlay).not.toHaveBeenCalled()

      manager.activateTab('pick-switch', secondId)
      await tick()

      expect(second.armOverlay).toHaveBeenCalledTimes(1)
      // The tab left behind has its overlay taken off — torn down rather than asked:
      // nobody is there to answer the question, the window is on another tab now.
      expect(first.teardownOverlay).toHaveBeenCalled()

      await toolbarHandler('browser-toolbar:cancel-pick')({}, 'pick-switch')
    })
  })

  /**
   * The person's recording of the tab on screen (plan §20.3's revision).
   *
   * What is pinned here is where the file goes: the **downloads folder**, the same place a
   * download from this window goes, whatever the tab belongs to — the window is one per
   * workspace and a tab's owner says who opened it, not who the recording is for. The
   * picture itself comes from Electron's display-media handler, which no test here can
   * supply, so nothing is ever recorded; what that costs is checked too (a recording that
   * never got a picture leaves no file behind).
   */
  describe('the record button', () => {
    function toolbarHandler(channel: string): (...args: any[]) => Promise<any> {
      const registration = (
        mockIpcMainHandle.mock.calls as unknown as Array<[string, (...args: any[]) => Promise<any>]>
      ).find(([name]) => name === channel)
      if (!registration) throw new Error(`Expected ${channel} IPC registration`)
      return registration[1]
    }

    let root: string

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'craft-recording-'))
    })

    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('files the recording in the downloads folder, whoever\'s tab it was', async () => {
      // A conversation's tab, with a session path resolver installed: the recording still
      // goes to the person's downloads — whose tab it is is not what the file is about.
      manager.setSessionPathResolver(() => join(root, 'sessions', 'session-a'))

      const instanceId = manager.createInstance('record-downloads', { workspaceId: 'workspace-a' })
      manager.createTab(instanceId, { belongsTo: work('session-a') })
      manager.registerToolbarIpc()

      const started = await toolbarHandler('browser-toolbar:record')({}, instanceId, 'start')
      expect(started.file.startsWith(join(downloadsDir, ''))).toBe(true)

      // Nothing was ever captured — no display media, so no chunk — and a recording with
      // nothing in it is not left behind as a webm that shows nothing.
      expect(await toolbarHandler('browser-toolbar:record')({}, instanceId, 'stop')).toBeNull()
      expect(existsSync(started.file)).toBe(false)
    })

    it('names the file for the container the chrome is about to record into', async () => {
      const instanceId = manager.createInstance('record-format')
      manager.registerToolbarIpc()
      const record = toolbarHandler('browser-toolbar:record')

      // The extension comes from the chrome — it is the side that knows what
      // `MediaRecorder` will write — but from a list: the last case is a name, and a name
      // is not the caller's to invent.
      const cases: Array<[string | undefined, string]> = [
        ['mp4', '.mp4'],
        ['WEBM', '.webm'],
        ['../../evil', '.webm'],
        [undefined, '.webm'],
      ]
      for (const [asked, expected] of cases) {
        const started = await record({}, instanceId, 'start', asked)
        expect(started.file.endsWith(expected)).toBe(true)
        // Every one of these is empty (nothing was ever captured), so this also removes
        // the file it just made.
        await record({}, instanceId, 'stop')
      }
    })

    it('reports the recording to the toolbar, and stops reporting it once it is done', async () => {
      const instanceId = manager.createInstance('record-shown')
      const instance = (manager as any).instances.get('record-shown')
      manager.registerToolbarIpc()

      const sent = () =>
        instance.toolbarView.webContents.send.mock.calls
          .filter((call: unknown[]) => call[0] === 'browser-toolbar:state-update')
          .map((call: unknown[]) => (call[1] as { recording: unknown }).recording)

      expect(sent().at(-1)).toBeUndefined()
      const started = await toolbarHandler('browser-toolbar:record')({}, instanceId, 'start')
      expect(sent().at(-1)).toMatchObject({ file: started.file, startedAt: started.startedAt })

      await toolbarHandler('browser-toolbar:record')({}, instanceId, 'stop')
      expect(sent().at(-1)).toBeNull()
    })
  })
})
