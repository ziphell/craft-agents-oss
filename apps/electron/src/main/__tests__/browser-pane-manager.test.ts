/**
 * Tests for BrowserPaneManager.
 *
 * Mocks Electron BrowserWindow and session modules to validate lifecycle,
 * session binding, and navigation behavior.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
  let closed = false
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
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    loadURL: mock(async (url: string) => {
      currentUrl = url
      maybeFailEmptyStateLoad(url)
      // The chrome's own document, and only it: a tab's page is a different webContents, so a
      // failure meant for the chrome must not be counted against a page load.
      const isChromeDocument = typeof url === 'string' && url.includes('browser-toolbar.html')
      if (isChromeDocument && toolbarLoadFailuresRemaining > 0) {
        toolbarLoadFailuresRemaining--
        throw new Error('mock toolbar load failure')
      }
    }),
    loadFile: mock(async (path: string, opts?: any) => {
      maybeFailEmptyStateLoad(path)
      if (typeof path === 'string' && path.includes('browser-toolbar.html') && toolbarLoadFailuresRemaining > 0) {
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
    /**
     * Closing the page. A window being destroyed does **not** close the `WebContentsView`s inside it
     * (measured on the terminate path: both tab pages were still running after the window and its
     * parking window were gone), so the manager closes each tab's page by name — and this is how the
     * tests see that happen.
     */
    close: mock(() => {
      closed = true
    }),
    isDestroyed: mock(() => closed),
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
    // The manager tells the chrome's pages the pointer has left when the window comes or goes
    // (`releaseChromePointer`); a native input event, so this is where the test sees it.
    sendInputEvent: mock((_event: unknown) => {}),
    // A viewer's stream starts with one scheduled repaint, so a still page produces a frame.
    invalidate: mock(() => {}),
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

function createMockWindow(opts?: { width?: number; height?: number; minWidth?: number; minHeight?: number; title?: string }) {
  const listeners: Record<string, Function[]> = {}
  const webContents = createMockWebContents()
  let contentWidth = opts?.width ?? 1200
  let contentHeight = opts?.height ?? 900
  let windowTitle = opts?.title ?? 'Craft Browser'
  let winX = 40
  let winY = 40
  let skipTaskbar = false
  let visible = false
  let minimized = false
  let maximized = false
  let destroyed = false
  const minWidth = opts?.minWidth ?? 0
  const minHeight = opts?.minHeight ?? 0

  const win = {
    webContents,
    /**
     * What the window was built with. A parking window's "off every display" is a claim about how it
     * was constructed (`frame: false` + `enableLargerThanScreen`), not about anything it does later,
     * so the tests read it back from here.
     */
    _options: opts,
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
    isDestroyed: mock(() => destroyed),
    // What the OS lists the window as (taskbar, alt-tab) — not a title bar, since the
    // window is frameless.
    getTitle: mock(() => windowTitle),
    setTitle: mock((next: string) => {
      windowTitle = next
    }),
    _title: () => windowTitle,
    isMinimized: mock(() => minimized),
    restore: mock(() => {
      minimized = false
      win._emit('restore')
    }),
    minimize: mock(() => {
      minimized = true
      win._emit('minimize')
    }),
    // Maximize/restore, the other caption verb the bar asks for: the state is the
    // window's, and the events are what the manager pushes it back on.
    isMaximized: mock(() => maximized),
    maximize: mock(() => {
      maximized = true
      win._emit('maximize')
    }),
    unmaximize: mock(() => {
      maximized = false
      win._emit('unmaximize')
    }),
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
    // Out of the app's window surfaces: the Window menu flag, and the level Mission Control reads to
    // decide a window is `transient` (`hideFromWindowLists`).
    excludedFromShownWindowsMenu: false,
    setAlwaysOnTop: mock((_flag: boolean, _level?: string) => {}),
    // Ordering a window front is what hands its views a surface on macOS (`parkTab`,
    // `raiseParkedView`, `keepShowing`), so every fake window has one.
    moveTop: mock(() => {}),
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
    // Windows taskbar identity (App User Model ID + icon) — the browser window takes its own
    // group. Windows-only in production, but the call is unconditional from the test's point of
    // view, so the mock has to exist.
    setAppDetails: mock((_details: unknown) => {}),
    destroy: mock(() => {
      destroyed = true
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

/**
 * `nativeTheme`, as the manager sees it: a mutable object rather than a literal, because the
 * app's theme is exactly what must **not** decide a page's own canvas (see the backdrop tests).
 */
const mockNativeTheme = { shouldUseDarkColors: false }

/**
 * Every partition the manager has asked for, in order.
 *
 * The partition name is the only place a window's **profile** shows — one per workspace
 * (`browserPanePartition`) — and a profile is what decides which login state a window has, so the
 * tests below read it here rather than inferring it from anything else.
 */
const requestedPartitions: string[] = []

mock.module('electron', () => ({
  app: {
    getPath: mock((name: string) => name === 'downloads' ? downloadsDir : `/tmp/mock-${name}`),
    /**
     * The name `index.ts` sets before anything else runs, and the source of the product token a
     * tab's user agent drops — the real `app` always answers this, so the mock has to as well.
     */
    getName: mock(() => 'Craft Agents'),
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
  nativeTheme: mockNativeTheme,
  shell: {
    openExternal: mockShellOpenExternal,
  },
  session: {
    // The partition a window asks for is the only thing that says which profile it was built on —
    // one per workspace (`browserPanePartition`) — so it is recorded, not just answered.
    fromPartition: mock((partition: string) => {
      requestedPartitions.push(partition)
      return {
        setPermissionCheckHandler: mock(() => {}),
        setPermissionRequestHandler: mock(() => {}),
        // The manager installs the craft-local scheme handler on this session at instance
        // creation (registerLocalOriginHandler), so a fake without `protocol` fails every
        // test in this file — the mock has to model what the code actually uses.
        protocol: { handle: mock(() => {}) },
        webRequest: {
          onBeforeRequest: mock((_cb: any) => {}),
          onBeforeSendHeaders: mock((_cb: any) => {}),
          onCompleted: mock((_cb: any) => {}),
          onErrorOccurred: mock((_cb: any) => {}),
        },
        on: mock((_event: string, _cb: any) => {}),
      }
    }),
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
    /** Watching a tab: the screencast the viewer subscribes to, and the input it sends back. */
    isScreencasting = mock(() => false)
    startScreencast = mock(async (_options: { onFrame?: (frame: unknown) => void }) => {})
    stopScreencast = mock(async () => {})
    /** The still a viewer gets before its page paints: Chromium's own render, no display surface. */
    captureViewport = mock(async (_options?: unknown) => Buffer.alloc(0))
    /**
     * A recording captures on its own flattened session (`startRecordingScreencast`), so these
     * are separate from the viewer's pair above — recording and watching do not exclude each
     * other any more.
     */
    startRecordingScreencast = mock(async (_options: { onFrame?: (frame: unknown) => void }) => {})
    stopRecordingScreencast = mock(async () => {})
    dispatchInput = mock(async (_events: unknown[]) => {})
    /**
     * What the page is told about being focused while a tab is held — the emulation, in order.
     * Nothing here moves a window: that is the whole reason this is a CDP call and not
     * `webContents.focus()` (`spike/anti-bot-fingerprint.ts` round 2 measures both).
     */
    setFocusEmulation = mock(async (_enabled: boolean) => {})
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
     * The element overlay.
     *
     * One script serves two callers, so these are the calls the manager makes on it:
     * arm a tab, read what it has reported, and take it down. A test that is about the
     * picker replaces this whole object with its own stub (`stubPicker`); the ones that
     * only need the manager not to crash — closing a tab that was being picked, say —
     * get this and nothing happens.
     */
    armOverlay = mock(async (_options: unknown) => {})
    drainOverlay = mock(async () => ({
      status: 'pending' as const,
      picks: [],
    }))
    teardownOverlay = mock(async () => {})
  },
}))

/**
 * The remembered-tabs store, kept off the disk.
 *
 * The manager writes here when a window goes away and reads here when one is created — on disk
 * that is the person's own file under `~/.craft-agent`, which a test has no business reading or
 * writing (and whose contents would depend on whether the person has the setting on). Inert, so
 * every test sees a window with nothing to restore and nothing it remembers.
 */
mock.module('../browser-tabs-state', () => ({
  loadBrowserTabsState: () => ({ windows: [] }),
  saveBrowserTabsState: () => {},
}))

const { BrowserPaneManager, browserPanePartition } = await import('../browser-pane-manager')

/**
 * The tab a window is showing.
 *
 * A window's address, title, view and CDP session belong to its *tabs*
 * now, so a test that used to say `instance.tabView` says `tab(instance).tabView`:
 * exactly the migration the manager itself went through. These tests drive a
 * single-tab window, so "the tab" is its first tab.
 */
function tab(instance: any): any {
  return instance.tabs[0]
}

/**
 * The bar has a document in it — which is the point at which a window may be shown.
 *
 * `focus` and `createInstance({ show: true })` do not open the window on the spot: a chromeless
 * window shown before its address bar has painted is a window with a hole in it, so the show waits
 * for the bar to report a real document (`markToolbarReady`). `ready-to-show` — the event these
 * tests used to emit — is about the window rather than the bar and no longer drives anything; a
 * test that wants the window on screen says so by finishing the bar's load.
 */
function finishLoadingTheBar(instance: any): void {
  instance.chromeView.webContents.getURL = mock(() => 'file:///mock/renderer/browser-toolbar.html')
  instance.chromeView.webContents._emit('did-finish-load')
}

/**
 * One tab as `listTabs` reports it — the observation half filled with what a
 * plain tab has, the declaration half with `'user'` (which is what the manager's
 * default is). Tests override only the field they are about.
 */
function tabSummary(overrides: Partial<BrowserTabSummary> & { id: string }): BrowserTabSummary {
  return {
    url: 'about:newtab',
    title: 'New Tab',
    profileId: 'default',
    favicon: null,
    isLoading: false,
    active: false,
    disposition: null,
    belongsTo: null,
    drivenBy: null,
    cursorOf: [],
    lockedBy: null,
    overlayDismissed: false,
    ...overrides,
  }
}

/** A conversation's own work — what a tab it opened says it belongs to. */
function work(sessionId: string): TabBelongsTo {
  return { kind: 'session', sessionId }
}

/** A DAG node's work: the task, the run, and which node of it. */
function nodeWork(taskSlug: string, nodeId: string | null, sessionId: string): TabBelongsTo {
  return { kind: 'task', taskSlug, runId: 'r1', nodeId, sessionId }
}

describe('BrowserPaneManager', () => {
  let manager: InstanceType<typeof BrowserPaneManager>

  beforeEach(() => {
    createdWindows.length = 0
    requestedPartitions.length = 0
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
   * There is no window-level driver to write any more: which conversation is where is a fact
   * about **tabs**, so this writes the tab's own facts — the tab is the
   * one that session works from, and is held by it while the window has its overlay up.
   */
  function drive(id: string, sessionId: string): void {
    const instance = (manager as any).instances.get(id)
    if (!instance) throw new Error(`no instance ${id}`)
    const tab = instance.tabs.find((candidate: any) => candidate.id === instance.activeTabId) ?? instance.tabs[0]
    if (!tab.cursorOf.includes(sessionId)) tab.cursorOf = [...tab.cursorOf, sessionId]
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

  /**
   * With nothing to say otherwise, every tab lands on the **built-in** profile — and that profile is
   * the bare legacy partition, which is where every login lived before profiles existed. An upgrade
   * therefore keeps its sessions instead of signing out.
   */
  it('runs tabs on the built-in profile when nothing says otherwise', () => {
    manager.createInstance('window-a', { workspaceId: 'ws-a' })
    manager.createTab('window-a', {})

    for (const tab of manager.listTabs('window-a')) {
      expect(tab.profileId).toBe('default')
    }
  })

  /** The name a profile's cookie jar is kept under — the built-in one keeps the legacy name. */
  it('names the built-in profile after the legacy partition', () => {
    expect(browserPanePartition('default')).toBe('persist:browser-pane')
    expect(browserPanePartition('work')).toBe('persist:browser-pane-work')
  })

  /**
   * A profile is a **window**: one workspace holds one window per profile, and a conversation works
   * in the window of the profile it picked. That is the whole of "two accounts of the same site at
   * once" — two cookie jars in two windows, never two accounts in one tab strip.
   */
  it('gives each profile its own window', () => {
    manager.setProfileResolver((sessionId) => (sessionId?.startsWith('sess-work') ? 'work' : 'default'))

    const personal = manager.createForSession('sess-personal', { workspaceId: 'ws-a' })
    const personalWindow = (manager as any).instances.get(personal).window
    // One window needs no account in its name.
    expect(personalWindow._title()).toBe('Craft Browser')

    const work = manager.createForSession('sess-work', { workspaceId: 'ws-a' })
    // Same profile, same window — a second conversation in it does not open a third.
    const workAgain = manager.createForSession('sess-work-2', { workspaceId: 'ws-a' })

    expect(work).not.toBe(personal)
    expect(workAgain).toBe(work)
    expect(requestedPartitions.filter((p) => p === 'persist:browser-pane-work')).toHaveLength(1)

    // A second window makes the OS's own lists name each by the account it works in.
    expect(personalWindow._title()).toContain('Default')
    expect((manager as any).instances.get(work).window._title()).toContain('work')

    // Every tab answers with its own window's profile.
    expect(manager.listTabs(personal).every((tab) => tab.profileId === 'default')).toBe(true)
    expect(manager.listTabs(work).every((tab) => tab.profileId === 'work')).toBe(true)
  })

  /**
   * Switching a conversation's profile moves it to another window rather than mixing accounts in
   * the one it was in: resolution happens per call, so the next browser command lands in the new
   * profile's window (opening it when it does not exist yet).
   */
  it('moves a conversation to another window when it switches profile', () => {
    manager.setProfileResolver(() => 'default')
    const before = manager.createForSession('sess-a', { workspaceId: 'ws-a' })

    manager.setProfileResolver(() => 'work')
    const after = manager.createForSession('sess-a', { workspaceId: 'ws-a' })

    expect(after).not.toBe(before)
    expect(manager.listTabs(after)[0]?.profileId).toBe('work')
  })

  // Every request for a window of its own becomes a tab beside the one that asked,
  // whatever asked: a link, a scripted popup, a link inside one of our own pages.
  // There is no second-window path left.
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
    // for a tab that merely appeared.
    expect(instance.tabs[1].belongsTo).toBeNull()
    expect(instance.tabs[1].cursorOf).toEqual([])
    expect(instance.tabs[1].drivenBy).toBeNull()
  })

  // A tab derived from a task's tab joins that task. It inherits the
  // group and nothing else: the person following a link inside the agent's tab must not
  // retarget the agent's next command, and must not make the window claim the agent is
  // driving the new tab.
  it('gives a derived tab its parent task, but not its cursor or driven-by mark', () => {
    manager.createInstance('window-open-inherit')
    drive('window-open-inherit', 'session-a')
    const instance = (manager as any).instances.get('window-open-inherit')
    // The agent's tab is opened **behind** the one the window was born with, which stays the
    // person's (and the one on screen) until a link in the agent's tab comes forward.
    const parentId = manager.createTab('window-open-inherit', {
      url: 'https://app.example.com/',
      belongsTo: work('session-a'),
    })
    const parent = instance.tabs.find((tab: any) => tab.id === parentId)
    const openHandler = parent.tabView.webContents.setWindowOpenHandler.mock.calls[0][0]
    const before = new Set(instance.tabs.map((tab: any) => tab.id))

    // The agent is working in the parent, which is what a held tab means — and, since a held tab
    // takes no input from a person, it is also why nothing opening a tab from here can be theirs.
    parent.heldBy = 'session-a'

    openHandler({ url: 'https://docs.example.com/', disposition: 'foreground-tab', frameName: '' })

    const derived = instance.tabs.find((tab: any) => !before.has(tab.id))
    expect(derived?.belongsTo).toEqual({ kind: 'session', sessionId: 'session-a' })
    expect(derived?.cursorOf).toEqual([])
    expect(derived?.drivenBy).toBeNull()
    // Opened while the agent is driving, so it lands **behind**: the person's view is not moved
    // by work happening in a tab they cannot touch anyway.
    expect(instance.activeTabId).toBe(instance.tabs[0].id)
    expect(instance.activeTabId).not.toBe(derived!.id)
    // The parent is still the tab that conversation works from.
    expect(parent.cursorOf).toEqual(['session-a'])

    // Take the tab back (which is what drops the hold) and the same link follows the browser
    // again — a person's click is unaffected by any of the above.
    parent.heldBy = null
    const beforeThePersonsClick = new Set(instance.tabs.map((tab: any) => tab.id))
    openHandler({ url: 'https://person.example.com/', disposition: 'foreground-tab', frameName: '' })
    const personsTab = instance.tabs.find((tab: any) => !beforeThePersonsClick.has(tab.id))
    expect(instance.activeTabId).toBe(personsTab!.id)
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

    expect(tab.drivenBy).toBeNull()
    expect(tab.heldBy).toBeNull()
    // The cursor is not the driven-by mark: this conversation still works from the tab it chose.
    expect(tab.cursorOf).toEqual(['session-abc'])
    // Letting go is not closing: the window is still there for the next turn.
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('tells the page it is focused while a session holds the tab, and stops when it lets go', async () => {
    // A tab being driven from the background is what this is for: the page is visible and
    // unfocused, and a site's "is somebody there?" check reads exactly that. What changes here
    // is only what the page is told — no window is activated and none is moved
    // (`spike/anti-bot-fingerprint.ts` round 2 measures both).
    manager.createInstance('focus-hold')
    const instance = (manager as any).instances.get('focus-hold')
    const tab = instance.tabs[0]
    const told = (): unknown[] => tab.cdp.setFocusEmulation.mock.calls.map((call: unknown[]) => call[0])

    // Nothing is held yet, so the page is told nothing.
    expect(told()).toEqual([])

    manager.setAgentControl('sess-hold', { displayName: 'Click' })
    manager.setSessionTab('focus-hold', instance.activeTabId, 'sess-hold')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(told()).toEqual([true])

    // The work is over: the page goes back to answering for the window it is really in, because
    // focus that outlives the work is a reading no person's browser ever gives.
    manager.unbindAllForSession('sess-hold')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(told()).toEqual([true, false])
  })

  it('createForSession resolves the same window, and writes nothing about who asked', () => {
    const id1 = manager.createForSession('sess-1')
    const id2 = manager.createForSession('sess-1')
    const info = manager.listInstances()[0]

    expect(id1).toBe(id2)
    expect(manager.listInstances()).toHaveLength(1)
    // The window is its workspace's, and which conversation is working in it is a
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
    // One window per workspace. A window already stamped with a workspace
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
      // the only thing that picks it now; a window of another workspace is not it.
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
     * One window per workspace, shared by every conversation in it and by the user.
     * Nothing on the window says who is using it — that is a fact about its
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
       * The point of the whole tab-level model: several conversations
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
        const tabStates = () => manager.listTabs(shared).map((tab) => `${tab.id}:${tab.cursorOf.join(',') || '-'}:${tab.lockedBy ?? '-'}`)
        const before = tabStates()

        // The user's own "+": the person clicking around did not stop a conversation, and
        // nothing about the tab it is working from moved.
        expect(manager.createForSession(null, { workspaceId: 'ws-a' })).toBe(shared)
        expect(tabStates()).toEqual(before)
      })

      it('is never destroyed by a session being torn down, but stops claiming a tab for it', () => {
        const shared = manager.createForSession('sess-a', { workspaceId: 'ws-a' })
        drive(shared, 'sess-a')

        manager.destroyForSession('sess-a')

        // The window, the tab and the page it has loaded all stay: tearing a session down is
        // not closing anything.
        expect(manager.listInstances().map((item) => item.id)).toEqual([shared])
        const tab = manager.listTabs(shared)[0]
        expect(tab.drivenBy).toBeNull()
        // Its **cursor** goes, though, and this is the only moment one is dropped (a turn
        // ending keeps it — see "holds a tab for a session, and lets go without touching the
        // window or the cursor"). A deleted conversation cannot work anywhere again, so the id
        // would be state about nothing — read by the toolbar for the tab's label, and by the
        // downloads fallback.
        expect(tab.cursorOf).toEqual([])
        expect(whyTabIsOutOfReach(tab, work('sess-b'))).toBeNull()
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

    // A hub's workspace id is only unique on that hub: two saved servers may both own a `ws-1`.
    // A browser call names the server it came from, and that is half of the window's key.
    describe('a call from a hub', () => {
      const fromServer = (connectionId: string, workspaceId = 'ws-1') =>
        manager.dispatchCapability({
          v: 1,
          method: 'getOrCreateForSession',
          args: ['sess-a'],
          sessionId: 'sess-a',
          workspaceId,
          work: work('sess-a'),
        }, connectionId) as Promise<string>

      it('keeps two servers that use the same workspace id apart', async () => {
        const a = await fromServer('conn-a')
        const b = await fromServer('conn-b')

        expect(a).not.toBe(b)
        expect(manager.listInstances().map((i) => i.workspaceId).sort()).toEqual([
          'hub:conn-a:ws-1',
          'hub:conn-b:ws-1',
        ])
      })

      it('gives the same server the same window on every call', async () => {
        expect(await fromServer('conn-a')).toBe(await fromServer('conn-a'))
      })
    })
    // Two facts live here and they are not the same one: the **cursor** (`cursorOf`) is the
    // tab a conversation works from — sticky, named, where its unnamed commands go — and the
    // **driven-by mark** (`drivenBy`) is the last tab a command actually reached,
    // which being done with the browser sweeps away.
    describe('which tab is being driven', () => {
      const tabsOf = (id: string) => manager.listTabs(id)
      const driverOf = (id: string, tabId: string) =>
        tabsOf(id).find((tab) => tab.id === tabId)?.drivenBy
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
       * this conversation works from. A command names its tab (`--tab` / `tab-select`), or
       * lands on the one the conversation already works from; with neither there is nowhere
       * to go and it is refused — the tab on screen is never the answer. Recording it does
       * **not** move the window: the target is what the next command is told, not what the
       * person is shown.
       */
      function command(sessionId: string, tabId?: string): { instanceId: string; tabId?: string } {
        const instanceId = manager.createForSession(sessionId, { workspaceId: 'ws-a' })
        const target = tabId ?? pickCommandTarget(tabsOf(instanceId), sessionId)?.id
        if (!target) throw new Error('No tab of this window is one you work from.')
        manager.setSessionTab(instanceId, target, sessionId)
        return { instanceId, tabId: target }
      }

      it('records the driver on the tab a command reached, and releases the mark when the turn ends', () => {
        const instanceId = manager.createForSession('sess-a', { workspaceId: 'ws-a' })
        const first = tabsOf(instanceId)[0]!.id
        // A command names the tab it works from: there is no other way to get one, and the
        // tab on screen is not picked for it.
        command('sess-a', first)

        expect(driverOf(instanceId, first)).toBe('sess-a')
        expect(cursorOf(instanceId, first)).toEqual(['sess-a'])

        manager.unbindAllForSession('sess-a')
        expect(driverOf(instanceId, first)).toBeNull()
        // The mark, not the cursor: the turn ending takes the mark and leaves the tab as the
        // one this conversation works from.
        expect(cursorOf(instanceId, first)).toEqual(['sess-a'])
      })

      // The rule the cursor exists for: a command lands on the conversation's own tab, not
      // on whatever the person is looking at.
      it('lands on the tab the conversation works from, not the one on screen', () => {
        const instance = usedWindow('first', 'sess-a')
        const instanceId = instance.id
        const first = instance.tabs[0].id
        command('sess-a', first)
        expect(cursorOf(instanceId, first)).toEqual(['sess-a'])

        // The person opens a tab of their own — their own act, so it comes to the front — and
        // the conversation runs a command.
        const other = manager.createTab(instanceId, { url: 'https://other.example.com/', activate: true })
        command('sess-a')

        // The window is left where the person put it — that is the half of this that used to
        // be wrong: the command's tab is what the *next* command is told, not what they are
        // shown (第十二轮).
        expect(instance.activeTabId).toBe(other)
        expect(driverOf(instanceId, first)).toBe('sess-a')
        expect(cursorOf(instanceId, first)).toEqual(['sess-a'])
        expect(driverOf(instanceId, other)).toBeNull()
        expect(cursorOf(instanceId, other)).toEqual([])
      })

      // The case that used to be a wall (第二十四轮): a tab two conversations work from keeps
      // **both** cursors, so the second one to name the same tab does not send the first
      // one's next command off to whatever the person happens to be looking at.
      it('lets two conversations work from one tab, each keeping its own cursor', () => {
        const instance = usedWindow('first', 'sess-a')
        const instanceId = instance.id
        const first = instance.tabs[0].id

        command('sess-a', first)
        command('sess-b', first)

        expect(cursorOf(instanceId, first)).toEqual(['sess-a', 'sess-b'])
        expect(driverOf(instanceId, first)).toBe('sess-b')

        // And a command of the first conversation still lands there — its cursor was not
        // overwritten by the second one.
        const persons = manager.createTab(instanceId, { url: 'https://person.example.com/', activate: true })
        expect(instance.activeTabId).toBe(persons)

        expect(command('sess-a').tabId).toBe(first)
      })

      // …and it *acts* there: the tab is named to the manager, so a command works on the
      // conversation's tab and the window does not move.
      it('acts on the tab it is given, without moving the window', async () => {
        const instance = usedWindow('first', 'sess-a')
        const instanceId = instance.id
        const mine = instance.tabs[0]
        const persons = manager.createTab(instanceId, { url: 'https://person.example.com/', activate: true })
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
       * arguments.
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
        const persons = manager.createTab(instanceId, { url: 'https://person.example.com/', activate: true })

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
        const personsId = manager.createTab(instanceId, { url: 'https://person.example.com/', activate: true })
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
       * tab as somebody else's.
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
        // The lease is per tab, so another conversation working elsewhere in the window does
        // not erase the fact that a tab is mid-work — the conversation's own tabs stay its own
        // until its turn ends.
        const instance = usedWindow('first', 'sess-a')
        const instanceId = instance.id
        const first = instance.tabs[0].id

        command('sess-a', first)
        const second = manager.createTab(instanceId, {
          url: 'https://second.example.com/',
          belongsTo: work('sess-a'),
        })
        expect(driverOf(instanceId, first)).toBe('sess-a')
        expect(driverOf(instanceId, second)).toBe('sess-a')

        // Another conversation works from a tab of its own — it names it, because the tab on
        // screen is not picked for it any more.
        const theirs = manager.createTab(instanceId, {
          url: 'https://theirs.example.com/',
          belongsTo: work('sess-b'),
        })
        command('sess-b', theirs)
        expect(driverOf(instanceId, theirs)).toBe('sess-b')
        expect(driverOf(instanceId, second)).toBe('sess-a')
        expect(driverOf(instanceId, first)).toBe('sess-a')

        // And the first conversation's turn ending clears *its* tabs, wherever the other
        // conversation's mark has got to since.
        manager.unbindAllForSession('sess-a')
        expect(driverOf(instanceId, first)).toBeNull()
        expect(driverOf(instanceId, second)).toBeNull()
        expect(driverOf(instanceId, theirs)).toBe('sess-b')
      })

      it('lets a tab the reader is not looking at stay idle', () => {
        const instance = usedWindow('first', 'sess-a')
        const idle = manager.createTab(instance.id, { url: 'https://idle.example.com/', activate: false })

        command('sess-a', instance.tabs[0].id)

        expect(driverOf(instance.id, idle)).toBeNull()
        expect(cursorOf(instance.id, idle)).toEqual([])
      })
    })
  })

  it('navigate normalizes hostnames to http', async () => {
    manager.createInstance('nav-1')
    await manager.navigate('nav-1', 'example.com')
    const instance = (manager as any).instances.get('nav-1')
    expect(tab(instance).tabView.webContents.loadURL).toHaveBeenCalledWith('http://example.com')
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
    finishLoadingTheBar(instance)

    expect(instance.window.show).toHaveBeenCalled()
    expect(instance.window.focus).toHaveBeenCalled()
  })

  it('dedupes repeated focus calls before the bar has loaded', () => {
    manager.createInstance('f2')

    manager.focus('f2')
    manager.focus('f2')
    manager.focus('f2')

    const instance = (manager as any).instances.get('f2')
    finishLoadingTheBar(instance)

    expect(instance.window.show.mock.calls.length).toBe(1)
    expect(instance.window.focus.mock.calls.length).toBe(1)
  })

  it('cancels deferred focus when hide happens first', () => {
    manager.createInstance('f-hide-race')

    manager.focus('f-hide-race')
    manager.hide('f-hide-race')

    const instance = (manager as any).instances.get('f-hide-race')
    const showCallsBeforeReady = instance.window.show.mock.calls.length
    const focusCallsBeforeReady = instance.window.focus.mock.calls.length

    finishLoadingTheBar(instance)

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
    const instance = (manager as any).instances.get('retry-toolbar')

    await Bun.sleep(1400)

    // The bar's own page, not the window's: the bar is a `BrowserView`, so its document is loaded
    // into a webContents of its own (`instance.chromeView`) — the app window's webContents never
    // sees it.
    const bar = instance.chromeView.webContents
    const fileAttempts = bar.loadFile.mock.calls.length
    const toolbarUrlAttempts = bar.loadURL.mock.calls
      .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length
    const totalAttempts = fileAttempts + toolbarUrlAttempts

    // Two failures, then the third attempt lands — inside the retry budget, so the window keeps its
    // real bar instead of the "failed to load" page.
    expect(totalAttempts).toBe(3)
    expect(bar.loadURL).not.toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
  })

  it('loads toolbar fallback page after retry exhaustion', async () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('fallback-toolbar')
    const instance = (manager as any).instances.get('fallback-toolbar')

    await Bun.sleep(3200)

    const bar = instance.chromeView.webContents
    const fileAttempts = bar.loadFile.mock.calls.length
    const toolbarUrlAttempts = bar.loadURL.mock.calls
      .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length
    const totalAttempts = fileAttempts + toolbarUrlAttempts

    // The first try plus every retry, and then the page that says so.
    expect(totalAttempts).toBe(5)
    expect(bar.loadURL).toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
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

    const sendsBeforeShow = instance.chromeView.webContents.send.mock.calls.length
    instance.window._emit('show')

    const sendCallsAfterShow = instance.chromeView.webContents.send.mock.calls.slice(sendsBeforeShow)
    expect(sendCallsAfterShow).toContainEqual([
      'browser-toolbar:state-update',
      {
        url: 'https://example.com',
        title: 'Example',
        // The account this window works in, so the bar can say whose browser it is.
        profileName: 'Default',
        isLoading: false,
        canGoBack: true,
        canGoForward: false,
        // The window is not maximized, so its second caption button offers "maximize".
        maximized: false,
        // The picker is off, and the window has one tab — which the rail draws and
        // the bar leaves alone.
        picking: false,
        // …and so are the tab's developer tools, which the bar's own button toggles.
        devTools: false,
        // Nobody has asked for the caret in the address bar.
        urlBarFocusToken: 0,
        // The rail is out: a window is born with it out, and nothing has folded it away.
        railCollapsed: false,
        tabs: [
          tabSummary({ id: instance.tabs[0].id, url: 'https://example.com', title: 'Example', active: true }),
        ],
        // Nothing opened these tabs through a conversation, so there is no group to
        // name — the rail draws no headers for a window that is all one person's.
        sessionLabels: {},
        // Nobody pressed the record button.
        recording: null,
        // And this window has fetched nothing — so the downloads button is not drawn.
        downloads: [],
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

    instance.chromeView.webContents.getURL = mock(() => 'http://localhost:5173/browser-toolbar.html?instanceId=toolbar-finish-load-replay')

    const sendsBeforeFinishLoad = instance.chromeView.webContents.send.mock.calls.length
    instance.chromeView.webContents._emit('did-finish-load')

    const sendCallsAfterFinishLoad = instance.chromeView.webContents.send.mock.calls.slice(sendsBeforeFinishLoad)
    expect(sendCallsAfterFinishLoad).toContainEqual([
      'browser-toolbar:state-update',
      {
        url: 'https://craft.do',
        title: 'Craft',
        // The account this window works in, so the bar can say whose browser it is.
        profileName: 'Default',
        isLoading: true,
        canGoBack: true,
        canGoForward: true,
        // The window is not maximized, so its second caption button offers "maximize".
        maximized: false,
        picking: false,
        devTools: false,
        // Nobody has asked for the caret in the address bar.
        urlBarFocusToken: 0,
        // The rail is out: a window is born with it out, and nothing has folded it away.
        railCollapsed: false,
        tabs: [
          tabSummary({ id: instance.tabs[0].id, url: 'https://craft.do', title: 'Craft', isLoading: true, active: true }),
        ],
        sessionLabels: {},
        // Nobody pressed the record button.
        recording: null,
        // And this window has fetched nothing — so the downloads button is not drawn.
        downloads: [],
      },
    ])
  })

  it('does not mark toolbar ready for about:blank did-finish-load', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-ignore-about-blank')
    const instance = (manager as any).instances.get('toolbar-ignore-about-blank')

    instance.chromeView.webContents.getURL = mock(() => 'about:blank')
    instance.chromeView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(false)
  })

  it('marks toolbar ready for fallback data page did-finish-load', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-fallback-ready')
    const instance = (manager as any).instances.get('toolbar-fallback-ready')

    instance.chromeView.webContents.getURL = mock(() => 'data:text/html;charset=UTF-8,%3Chtml%3E%3C%2Fhtml%3E')
    instance.chromeView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(true)
  })

  it('keeps focus deferred until a valid toolbar document loads', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-focus-guard')
    const instance = (manager as any).instances.get('toolbar-focus-guard')

    manager.focus('toolbar-focus-guard')
    expect(instance.pendingShowOnReady).toBe(true)
    expect(instance.window.show).toHaveBeenCalledTimes(0)

    instance.chromeView.webContents.getURL = mock(() => 'about:blank')
    instance.chromeView.webContents._emit('did-finish-load')
    expect(instance.window.show).toHaveBeenCalledTimes(0)

    instance.chromeView.webContents.getURL = mock(() => 'file:///mock/renderer/browser-toolbar.html')
    instance.chromeView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(true)
    expect(instance.window.show).toHaveBeenCalledTimes(1)
    expect(instance.window.focus).toHaveBeenCalledTimes(1)
  })

  it('runs early theme extraction shortly after navigation', async () => {
    manager.createInstance('theme-early')
    const instance = (manager as any).instances.get('theme-early')
    tab(instance).tabView.webContents.executeJavaScript = mock(async () => '#0f1e2d')
    tab(instance).tabView.webContents.loadURL('https://example.com')

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

  it('takes a hidden window\'s shot from the parking window the tab already lives in', async () => {
    manager.createInstance('screenshot-parked-hidden')
    const instance = (manager as any).instances.get('screenshot-parked-hidden')
    // On Windows a hidden window answers for nothing — and that is exactly where the tab lives: a tab
    // whose window cannot hand out a surface belongs to the parking window (`tabHome`), so the shot is
    // taken where it is, and nothing is moved for it. The one constant the tests keep everywhere is
    // this answer, not the host's platform.
    ;(manager as any).canCaptureHiddenWindows = false
    tab(instance).tabView.webContents.capturePage = mock(async () => answerWith('parked-png'))

    const windowsBefore = createdWindows.length
    const result = await manager.screenshot('screenshot-parked-hidden', { includeMetadata: true })

    expect(result.imageBuffer.toString()).toBe('parked-png')
    // Nothing was parked *for the shot*: it was already there.
    expect(result.metadata?.warnings?.some((w: string) => w.includes('parked that tab in the parking window'))).toBeFalsy()

    // No window was made for the shot either: the parking window every parked tab lives in is the one
    // that was used — kept up, not made and thrown away per shot.
    expect(createdWindows.length).toBe(windowsBefore)
    const parking = createdWindows[createdWindows.length - 1]
    expect(instance.parkingWindow).toBeTruthy()
    expect(parking.contentView.children).toContain(tab(instance).tabView)
    expect(parking.showInactive).toHaveBeenCalled()
    expect(parking.destroy).not.toHaveBeenCalled()

    // The window the person owns was neither shown nor moved, and it never held the page.
    expect(instance.window.showInactive).not.toHaveBeenCalled()
    expect(instance.window.setPosition).not.toHaveBeenCalled()
    expect(instance.isVisible).toBe(false)
    expect(instance.window.contentView.children).not.toContain(tab(instance).tabView)
  })

  it('takes a hidden window\'s shot where it is, where that is known to answer', async () => {
    manager.createInstance('screenshot-hidden-in-place')
    const instance = (manager as any).instances.get('screenshot-hidden-in-place')
    // macOS answers for a hidden window (Electron's own behaviour) — for a window that **has been on
    // a display**, where the surface survives the hiding. That is the state the platform claim is
    // about (`hasBeenShown`), and it is the only one where a hidden window is still a home.
    ;(manager as any).canCaptureHiddenWindows = true
    instance.window.show()
    instance.window.hide()
    tab(instance).tabView.webContents.capturePage = mock(async () => answerWith('in-place-png'))

    const windowsBefore = createdWindows.length
    const result = await manager.screenshot('screenshot-hidden-in-place')

    expect(result.imageBuffer.toString()).toBe('in-place-png')
    expect(createdWindows.length).toBe(windowsBefore)
  })

  it('parks the tab of a window that has never been on a display, even where hidden windows answer', async () => {
    manager.createInstance('screenshot-never-shown')
    const instance = (manager as any).instances.get('screenshot-never-shown')
    // The agent's ordinary case: born hidden, never shown. That is **not** `hidden-after-show` — a
    // window that has never been on a display is composited nowhere, and a capture of it refuses at
    // once ("Current display surface not available for capture", `capture-methods.cjs`), so the
    // platform's answer about hidden windows does not reach it. Its tab lives in the parking window,
    // which is the window that *is* shown.
    ;(manager as any).canCaptureHiddenWindows = true
    tab(instance).tabView.webContents.capturePage = mock(async () => answerWith('never-shown-png'))

    const result = await manager.screenshot('screenshot-never-shown')

    expect(result.imageBuffer.toString()).toBe('never-shown-png')
    expect(instance.parkingWindow.contentView.children).toContain(tab(instance).tabView)
    expect(instance.window.contentView.children).not.toContain(tab(instance).tabView)
  })

  it('shoots a tab that has never been composited from the parking window, and puts it straight back', async () => {
    manager.createInstance('screenshot-first-frame')
    const instance = (manager as any).instances.get('screenshot-first-frame')
    // The window's own tab has an address — written by hand because a mock tab never hears the
    // `did-navigate` that would write it — so what follows is a second tab, not a reuse of it.
    instance.tabs[0].currentUrl = 'https://front.example.com/'
    const onScreen = instance.tabs[0]
    // The agent's tab: opened behind the person's, so Chromium has never composited it and it has no
    // surface to copy — the case the parking window's shot exists for.
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
    expect(result.metadata?.warnings?.some((w: string) => w.includes('parked that tab in the parking window'))).toBe(true)
    expect(captureCalls).toBe(2)

    // No window was built for the shot: this tab already lives in the parking window, so nothing had
    // to be made — its view was brought to the top of that window instead.
    expect(createdWindows.length).toBe(windowsBefore)
    const resident = instance.parkingWindow
    expect(resident.contentView.addChildView.mock.calls.some(([view]: any[]) => view === behind.tabView)).toBe(true)

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
    expect(resident.contentView.children).toContain(behind.tabView)
    expect(behind.tabView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1100, height: 845 })
    expect(behind.tabView.getBounds()).toEqual({ x: 0, y: 0, width: 1100, height: 845 })
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
      'the page had no display surface to copy, even parked in the parking window',
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
    ).rejects.toThrow(/not on screen at all/)
  })

  it('resizes browser window viewport and returns effective applied size', () => {
    manager.createInstance('resize-1')
    const instance = (manager as any).instances.get('resize-1')
    // The person's window is up (`tabHome`), which is the only state a viewport resize is about: the
    // page is in the window, so giving it a size means sizing the window.
    instance.window.show()
    const resized = manager.resizeViewport('resize-1', 1280, 720)

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
    ;(manager as any).instances.get('resize-min').window.show()
    const resized = manager.resizeViewport('resize-min', 200, 200)

    // BrowserWindow minWidth/minHeight is 700x500, and the chrome plus the panel's gutter takes
    // 200 + 7 of the width and 48 + 7 of the height, so the effective viewport is 493x445.
    expect(resized).toEqual({ width: 493, height: 445 })
  })

  /**
   * A minimized window has put its page away, and `viewport-resize` still gives the page the size it
   * asks for — in the **parking window**, because the window nobody is looking at is not the one that
   * decides, and on Windows it cannot hand out a viewport at all.
   *
   * Measured (`hidden-window-usability.cjs`, the `minimized` rows): a view left *inside* a minimized
   * window does not take a new viewport on Windows — `setBounds` moves the view, the page keeps its
   * size, no `resize` arrives — while the parking window, shown and off every display, does. Before the
   * tab was parked there, the same command did something on macOS (which reports a size while
   * minimized) and nothing on Windows (0×0), the latter silently.
   */
  it('resizes the viewport of a minimized window\'s tab, in the parking window', () => {
    manager.createInstance('resize-minimized')
    const instance = (manager as any).instances.get('resize-minimized')
    instance.window.show()
    // The window's own tab, so this is about the page that window was holding (`tabHome`).
    instance.tabs[0].currentUrl = 'https://front.example.com/'
    const front = instance.tabs[0]

    // The person puts the window aside: the page goes to the parking window, where a viewport exists.
    instance.window.minimize()
    expect(instance.parkingWindow.contentView.children).toContain(front.tabView)

    const resized = manager.resizeViewport('resize-minimized', 1280, 720)

    // The page was really given it, where it lives — and the person's window is left alone, size and all.
    expect(front.tabView.getBounds()).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
    expect(resized).toEqual({ width: 1280, height: 720 })
    expect(instance.window.setContentSize).not.toHaveBeenCalled()
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
    // The person is using the window, so the page is in it (`tabHome`) and the drag is about it.
    instance.window.show()
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
   * Terminating a browser window has to close **every** tab's page, the ones parked in the parking
   * window included — a window being destroyed does not close the `WebContentsView`s inside it
   * (measured on the terminate path: both tab pages were still running after the window and its
   * parking window were gone, and would have stayed running). Reported as a question: "terminate
   * 浏览器窗口，是否正确销毁这个窗口所有标签页的停车窗？"
   */
  it('closes every tab\'s page when the window goes, the parked ones included', () => {
    manager.createInstance('terminate-pages')
    const instance = (manager as any).instances.get('terminate-pages')
    instance.tabs[0].currentUrl = 'https://front.example.com/'
    const onScreen = instance.tabs[0]
    manager.createTab('terminate-pages', { url: 'https://behind.example.com/', activate: false })
    const behind = instance.tabs[1]
    const parking = instance.parkingWindow
    expect(parking.contentView.children).toContain(behind.tabView)

    // The order is the point: the pages are closed **first**, and the parking window goes afterwards,
    // as the consequence — an empty window has nothing left to hold. Destroying the window is not what
    // closes a `WebContentsView`'s page (measured: both pages were still running after both windows
    // were gone), so it cannot be the other way round.
    const order: string[] = []
    onScreen.tabView.webContents.close.mockImplementation(() => { order.push('the page on screen') })
    behind.tabView.webContents.close.mockImplementation(() => { order.push('the page parked in the parking window') })
    parking.destroy.mockImplementation(() => { order.push('the parking window, now empty') })

    manager.destroyInstance('terminate-pages')

    expect(order).toEqual([
      'the page on screen',
      'the page parked in the parking window',
      'the parking window, now empty',
    ])
    expect((manager as any).instances.has('terminate-pages')).toBe(false)
  })

  /**
   * The window the person put aside does not hold its page any more — on either platform, and asked
   * directly (`tabHome`), not inferred from the window reporting no size: **macOS reports a size while
   * minimized**, so only Windows would have been parked that way.
   *
   * The other half of why: a minimized window reports no size *at all* on Windows (measured: 0×0), and
   * the floors in `tabAreaBounds` turn that into a plausible-looking 193×93 — which the page then keeps
   * once the window is back, so the person sees a tiny page in a full-size window until something lays
   * out again. Reported: "怎么用着用着浏览器窗口会变成一个很小的值 193×93。切换标签界面又恢复了".
   */
  it('parks the tab a minimized window was holding, and lays out again when it comes back', () => {
    manager.createInstance('minimized')
    const instance = (manager as any).instances.get('minimized')
    // Minimizing is something a person does to a window they are using: it is shown, so the page is in
    // it (`tabHome`) — until it is minimized, where the page goes to the parking window: measured, a
    // view left inside a minimized window moves without its page's viewport following it on Windows
    // (`hidden-window-usability.cjs`), and the parking window is shown, so it does follow there.
    instance.window.show()
    instance.tabs[0].currentUrl = 'https://front.example.com/'
    const onScreen = instance.tabs[0]
    manager.createTab('minimized', { url: 'https://behind.example.com/', activate: false })
    const behind = instance.tabs[1]
    expect(onScreen.tabView.getBounds()).toEqual({ x: 201, y: 49, width: 1100, height: 845 })
    expect(instance.window.contentView.children).toContain(onScreen.tabView)

    // Minimized — and still reporting a size, as macOS does — with a layout asked for anyway, which is
    // what the window's own `resize` does on the way down (`minimize` lays out too).
    instance.window.getContentSize.mockImplementation(() => [1010, 900])
    instance.window.isMinimized.mockImplementation(() => true)
    instance.window._emit('resize')

    // The page goes where a viewport does exist — the parking window, which is shown — at the size it
    // has, rather than being left in a window on a size the window never had.
    expect(instance.parkingWindow.contentView.children).toContain(onScreen.tabView)
    expect(onScreen.tabView.getBounds()).toEqual({ x: 0, y: 0, width: 1100, height: 845 })
    // …and the tab that is not on screen keeps what it had: it lives in the parking window, at its own
    // viewport.
    expect(behind.tabView.getBounds()).toEqual({ x: 0, y: 0, width: 1100, height: 845 })
    expect(instance.parkingWindow.contentView.children).toContain(behind.tabView)

    // Coming back is where the page takes the window's size again — without a tab switch to rescue it.
    instance.window.getContentSize.mockImplementation(() => [1010, 900])
    instance.window.isMinimized.mockImplementation(() => false)
    instance.window._emit('restore')
    expect(onScreen.tabView.setBounds).toHaveBeenLastCalledWith({ x: 201, y: 49, width: 803, height: 845 })
    expect(instance.window.contentView.children).toContain(onScreen.tabView)
  })

  /**
   * A parking window the OS cannot pull back on screen.
   *
   * macOS brings a window it judges unreachable back onto a display, and what it consults is AppKit's
   * `constrainFrameRect:toScreen:` — which Electron leaves alone **only** for a frameless window that
   * set `enableLargerThanScreen` (`electron_ns_window.mm`). Both halves are load-bearing: frameless
   * alone, or the flag alone, and the spot `offscreenSpot` asks for is a request the desktop
   * overrules, so the parking window would appear on screen. The person's report: "macos 浏览器窗口
   * 多标签，停车窗被系统拉到可见区域了".
   */
  it('builds the parking window frameless and larger-than-screen, so the OS leaves it off every display', () => {
    manager.createInstance('parking-unconstrainable')
    const instance = (manager as any).instances.get('parking-unconstrainable')
    instance.tabs[0].currentUrl = 'https://front.example.com/'
    manager.createTab('parking-unconstrainable', { url: 'https://behind.example.com/', activate: false })

    const parking = instance.parkingWindow
    expect(parking).toBeTruthy()
    expect(parking._options.frame).toBe(false)
    expect(parking._options.enableLargerThanScreen).toBe(true)
    expect(parking._options.alwaysOnTop).toBe(true)
  })

  /**
   * …and it may not turn up in the app's own window surfaces either.
   *
   * macOS lists every *shown* window in the application's Window menu (which the dock's window list
   * mirrors) and in Mission Control / "Show All Windows", and the parking window is shown
   * (`showInactive`) — so without this the person sees a grey rectangle they can do nothing with.
   * `excludedFromShownWindowsMenu` takes it out of the menu; the float level is what makes AppKit
   * default its collection behaviour to `transient`, which Mission Control hides. Reported by the
   * person: "显示所有窗口里还是能看到停车窗".
   */
  it('keeps the parking window out of the Window menu and Mission Control', () => {
    manager.createInstance('parking-unlisted')
    const instance = (manager as any).instances.get('parking-unlisted')
    instance.tabs[0].currentUrl = 'https://front.example.com/'
    manager.createTab('parking-unlisted', { url: 'https://behind.example.com/', activate: false })

    const parking = instance.parkingWindow
    expect(parking).toBeTruthy()
    expect(parking.excludedFromShownWindowsMenu).toBe(true)
    expect(parking.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating')
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
    const behind = instance.tabs[1]
    const parking = instance.parkingWindow
    expect(parking).toBeTruthy()
    // Parking a view puts it on top of its window (`addChildView`) **and** orders that window front:
    // a parking window that is not the top window hands its views no surface on macOS, and there is
    // one of these per browser window all asking for the same spot.
    expect(parking.moveTop).toHaveBeenCalled()

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

    // And it may not stop being **shown**: a window that is not shown is not composited, and the
    // views inside it lose the viewport the freeze is for. Nothing about it is the person's, so a
    // shell-wide "minimize everything" does not get to leave it that way.
    parking.moveTop.mockClear()
    parking.minimize()
    expect(parking.restore).toHaveBeenCalled()
    expect(parking.isMinimized()).toBe(false)
    // …and it is ordered front again, because being shown again is not being composited again: the
    // views inside it stay uncomposited until the window is the top window.
    expect(parking.moveTop).toHaveBeenCalled()
    parking.moveTop.mockClear()
    parking.hide()
    expect(parking.isVisible()).toBe(true)
    expect(parking.moveTop).toHaveBeenCalled()
    // …while the tab in it is left alone, wherever the parking window had to go.
    expect(instance.window.contentView.children).not.toContain(behind.tabView)

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
    // The person's window is up: its own tab is in it (`tabHome`), and the one opened behind belongs
    // to the parking window.
    instance.window.show()
    instance.tabs[0].currentUrl = 'https://front.example.com/'
    const onScreen = instance.tabs[0]
    const behindId = manager.createTab('resize-frozen', { url: 'https://behind.example.com/', activate: false })
    const behind = instance.tabs.find((tab: any) => tab.id === behindId)

    // Born in the parking window, at the size the page area had then.
    expect(behind.tabView.getBounds()).toEqual({ x: 0, y: 0, width: 1100, height: 845 })
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
    expect(behind.tabView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1100, height: 845 })
    expect(behind.tabView.getBounds()).toEqual({ x: 0, y: 0, width: 1100, height: 845 })
    expect(instance.window.contentView.children).not.toContain(behind.tabView)

    // Coming forward is where it gets the window's size — and the window holds it from then on.
    manager.activateTab('resize-frozen', behindId)
    expect(behind.tabView.setBounds).toHaveBeenLastCalledWith({ x: 201, y: 49, width: 803, height: 845 })
    expect(instance.window.contentView.children).toContain(behind.tabView)
    expect(instance.parkingWindow.contentView.children).not.toContain(behind.tabView)
  })

  /**
   * The parking stack carries no "current tab" meaning: a tab is parked at the top (so it has a
   * surface), and a shot that raises another tab leaves it there. The active tab may be covered —
   * nothing in the parking window is being looked at.
   */
  it('parks a background tab at the top, and leaves a shot where it was raised', () => {
    manager.createInstance('parking-top')
    const instance = (manager as any).instances.get('parking-top')
    const first = instance.tabs[0]
    const behindId = manager.createTab('parking-top', { url: 'https://behind.example.com/', activate: false })
    const behind = instance.tabs.find((tab: any) => tab.id === behindId)
    const parking = instance.parkingWindow

    // The tab just parked is the one with a surface.
    expect(parking.contentView.children.at(-1)).toBe(behind.tabView)

    // A shot raises another tab and leaves it there; there is no order to restore.
    ;(manager as any).raiseParkedView(instance, first)
    expect(parking.contentView.children.at(-1)).toBe(first.tabView)
    ;(manager as any).putTabBack(instance, first, { width: 1100, height: 845 })
    expect(parking.contentView.children.at(-1)).toBe(first.tabView)
    expect(parking.contentView.children).toContain(behind.tabView)
  })

  /**
   * The unit of a resize is the **view**, so a tab working behind the person can be given a viewport
   * without the person's window moving.
   *
   * Before this, every resize resized the window: an agent asking for a deterministic viewport for
   * its own tab moved what the person was reading — and its own tab, parked, kept the size it had.
   * The parking window is the other half of it: it holds the views, so it follows them both ways.
   */
  it("resizes the view of a tab that is not on screen, and leaves the person's window alone", () => {
    manager.createInstance('resize-behind')
    const instance = (manager as any).instances.get('resize-behind')
    // The person's window is up, so the tab it is on lives in it and the one behind lives in the
    // parking window — the split this test is about.
    instance.window.show()
    // The window's own tab has to be in use first: opening a tab into the untouched tab of a fresh
    // window opens *into* it rather than beside it, and then there would be no tab behind to size.
    instance.tabs[0].currentUrl = 'https://front.example.com/'
    const behindId = manager.createTab('resize-behind', { url: 'https://behind.example.com/', activate: false })
    const behind = instance.tabs.find((tab: any) => tab.id === behindId)
    const parking = instance.parkingWindow
    instance.window.setContentSize.mockClear()

    // Born in the parking window, which is the size of what it holds.
    expect(parking.getContentSize()).toEqual([1100, 845])

    const resized = manager.resizeViewport('resize-behind', 1280, 720, behindId)

    // The view is what got the size…
    expect(behind.tabView.getBounds()).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
    expect(resized).toEqual({ width: 1280, height: 720 })
    // …the person's window is not touched — not even told a size — and the view still lives where a
    // tab that is not on screen lives.
    expect(instance.window.setContentSize).not.toHaveBeenCalled()
    expect(instance.window.contentView.children).not.toContain(behind.tabView)
    expect(parking.contentView.children).toContain(behind.tabView)
    // …and the window holding it grows to fit it.
    expect(parking.getContentSize()).toEqual([1280, 720])

    // Smaller gives the space back rather than leaving the window at the largest size it ever held:
    // a window bigger than its views is space on a desktop nobody sees.
    expect(manager.resizeViewport('resize-behind', 800, 600, behindId)).toEqual({ width: 800, height: 600 })
    expect(parking.getContentSize()).toEqual([800, 600])

    // And the size is the tab's until it comes forward: laying the window out again parks it at the
    // viewport it now has, not at the one it was born with.
    instance.window.setContentSize(1010, 900)
    instance.window._emit('resize')
    expect(behind.tabView.getBounds()).toEqual({ x: 0, y: 0, width: 800, height: 600 })
    expect(parking.getContentSize()).toEqual([800, 600])
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
     * screen, which is what holds it. The panel being up is not enough — the lock,
     * the dim and the shield are the held tab's.
     */
    const holdActiveTab = (id: string, sessionId: string): void => {
      const instance = (manager as any).instances.get(id)
      manager.setSessionTab(id, instance.activeTabId, sessionId)
    }

    it('setAgentControl notes the session and its label on the window', async () => {
      manager.createInstance('ac-1')

      manager.setAgentControl('sess-1', { displayName: 'Navigate Page', intent: 'Loading example.com' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-1')
      expect(instance.controlBy.get('sess-1')).toEqual({
        displayName: 'Navigate Page',
        intent: 'Loading example.com',
      })
      // The session works from no tab yet, so the overlay holds nothing — and a hold is what
      // the agent's markings are drawn for. The panel's own line is up either way (the page's
      // corner comes from the page's view, not from this document).
      expect(tab(instance).heldBy ?? null).toBeNull()
      expect(instance.nativeOverlayView.setBounds).toHaveBeenLastCalledWith({ x: 200, y: 48, width: 1107, height: 852 })
      expect(overlayScript(instance)).toContain('const locked = false;')
      expect(overlayScript(instance)).toContain('const shieldActive = false;')
      expect(instance.nativeOverlayView.webContents.focus).not.toHaveBeenCalled()
      expect(manager.listInstances().find(i => i.id === 'ac-1')?.agentControlActive).toBe(true)
    })

    // The lock is drawn on the tab, not the window: the
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
      const instance = (manager as any).instances.get('ac-lock')
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      // A tab this session opened, and it is the one on screen: opening it is what made it the tab
      // this conversation works from (`createTab` records the cursor), and a command acts on the tab
      // it works from.
      const heldId = manager.createTab('ac-lock', {
        url: 'https://held.example.com/',
        belongsTo: work('sess-lock'),
      })
      const otherId = manager.createTab('ac-lock', { url: 'https://other.example.com/' })
      manager.activateTab('ac-lock', heldId)
      await settle()

      // The overlay takes the tab this session works from — and that tab is the one on screen here,
      // so the shield goes up with the work itself rather than with the first command. It used to
      // wait for a command to resolve a tab, which is how a turn's first command came to take a tab
      // without locking it: the two facts travel different paths, and the command often wins.
      manager.setAgentControl('sess-lock', { displayName: 'Click', intent: 'Pressing Buy' })
      await settle()

      // The held tab is on screen: covered, locked, and the pointer says so.
      expect(instance.nativeOverlayView.setBounds).toHaveBeenLastCalledWith({ x: 200, y: 48, width: 1107, height: 852 })
      expect(overlayScript(instance)).toContain('const shieldActive = true;')
      expect(overlayScript(instance)).toContain('const locked = true;')
      expect(manager.listTabs('ac-lock').find((tab) => tab.id === heldId)?.lockedBy).toBe('sess-lock')

      manager.activateTab('ac-lock', otherId)
      await settle()

      // A tab the person switched to is not the agent's to hold. The panel comes forward with it
      // — same overlay, sized to the tab area, saying this tab's state — but nothing on it is a
      // lock: no accent, no dim, no chip, and the page takes input.
      expect(instance.nativeOverlayView.setBounds).toHaveBeenLastCalledWith({ x: 200, y: 48, width: 1107, height: 852 })
      expect(overlayScript(instance)).toContain('const locked = false;')
      expect(overlayScript(instance)).toContain('const shieldActive = false;')
      // …while the tab it *is* working on stays locked in the model.
      expect(manager.listTabs('ac-lock').find((tab) => tab.id === heldId)?.lockedBy).toBe('sess-lock')

      manager.activateTab('ac-lock', heldId)
      await settle()
      expect(overlayScript(instance)).toContain('const shieldActive = true;')
    })

    // A conversation can be working in this window with no tab held yet — its overlay is up for
    // the turn before its first command resolves a tab, and a conversation that has never worked
    // anywhere has none to hold. That does not put a lock on the page: the window being in use is
    // said by the chrome (the rail's marks), because the lock, the dim and the shield belong to the
    // held tab.
    it('draws the panel without a lock while no tab is held', async () => {
      manager.createInstance('ac-idle')

      manager.setAgentControl('sess-idle', {
        displayName: 'Browser',
        intent: 'Session controls this window',
      })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-idle')
      // The panel's line around the page is up, and it says no lock.
      expect(instance.nativeOverlayView.setBounds).toHaveBeenLastCalledWith({ x: 200, y: 48, width: 1107, height: 852 })
      expect(overlayScript(instance)).toContain('const locked = false;')
      expect(overlayScript(instance)).toContain('const shieldActive = false;')
      expect(instance.nativeOverlayView.webContents.focus).not.toHaveBeenCalled()
      expect(manager.listInstances().find(i => i.id === 'ac-idle')?.agentControlActive).toBe(true)
    })

    /**
     * The takeover case, and the order it usually arrives in: the person opens a tab and the
     * conversation carries on in it, so the command resolves the tab **before** the overlay's own
     * event reaches the window (the two travel different paths — the tool's body and the tool's
     * start event). The tab has to end up locked either way; before the hold was taken when the
     * overlay comes up, this order left the person's tab with the "driven" dot and no lock, and they
     * could still click into the page the agent was working on.
     */
    it("locks a tab the person opened, whichever of the two facts arrives first", async () => {
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 4; i += 1) await Promise.resolve()
      }
      manager.createInstance('takeover-lock')
      const instance = (manager as any).instances.get('takeover-lock')
      const personTab = instance.tabs[0].id

      // The command first: with no tab of its own, the conversation works from the tab in front.
      manager.setSessionTab('takeover-lock', personTab, 'sess-takeover')
      await settle()
      expect(manager.listTabs('takeover-lock')[0]?.lockedBy).toBeNull()

      // …then its overlay lights up. It takes the tab this session works from.
      manager.setAgentControl('sess-takeover', { displayName: 'Click', intent: 'Pressing Buy' })
      await settle()

      expect(manager.listTabs('takeover-lock')[0]?.lockedBy).toBe('sess-takeover')
      expect(instance.window.setTopBrowserView).toHaveBeenCalledWith(instance.nativeOverlayView)
      expect(overlayScript(instance)).toContain('const locked = true;')
      expect(overlayScript(instance)).toContain('const shieldActive = true;')
    })

    /**
     * The mask's fill follows the **layer order**, not "is a menu of ours up".
     *
     * The rectangle's fill is what covers the notches the page's cut corners leave in this
     * document, so it has to be on whenever the overlay is *under* the page — and that includes
     * every menu, because a menu takes the top for the chrome and puts the overlay back under the
     * page (`restackViews`). Reading "a menu is up" as "the overlay is over the page" — the old
     * condition, `shieldActive` — cleared the fill exactly when it was needed, and the page's four
     * corners showed the window's material instead of the surface.
     */
    it("keeps the mask's fill while one of our menus is over the page", async () => {
      /** Enough microtasks for the window's overlay document to finish loading. */
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 4; i += 1) await Promise.resolve()
      }

      manager.createInstance('ac-menu')
      manager.registerToolbarIpc()
      const instance = (manager as any).instances.get('ac-menu')
      await settle()

      const menuGeometry = (
        mockIpcMainHandle.mock.calls as unknown as Array<[string, (...args: any[]) => Promise<void>]>
      ).find(([name]) => name === 'browser-toolbar:menu-geometry')?.[1]
      if (!menuGeometry) throw new Error('Expected browser-toolbar:menu-geometry IPC registration')

      // Nothing held, no menu up: the overlay is under the page, so the rectangle is filled.
      expect(overlayScript(instance)).toContain('const overlayOverPage = false;')

      // A held tab is the one case that raises the overlay *over* the page — there the rectangle
      // has to stay clear, or it would cover the page.
      drive('ac-menu', 'sess-menu')
      manager.setAgentControl('sess-menu', { displayName: 'Click', intent: 'Pressing Buy' })
      holdActiveTab('ac-menu', 'sess-menu')
      await settle()
      expect(overlayScript(instance)).toContain('const overlayOverPage = true;')

      // A menu hands the top back to the chrome, which puts the overlay under the page again — and
      // the fill has to come back with it.
      await menuGeometry({}, 'ac-menu', true, 120)
      expect(instance.window.setTopBrowserView).toHaveBeenLastCalledWith(instance.chromeView)
      expect(overlayScript(instance)).toContain('const overlayOverPage = false;')

      // Read off the layer order, never off the shield: the fill is not the shield's answer.
      expect(overlayScript(instance)).not.toContain('mask.style.background = shieldActive')
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

    it('releases the window it names, and no other window the session is in', () => {
      manager.createInstance('ac-scope-a')
      manager.createInstance('ac-scope-b')
      drive('ac-scope-a', 'sess-scope')
      drive('ac-scope-b', 'sess-scope')

      // The same session is working in both windows. `setAgentControl` resolves one window, so
      // the second one is put in the same state directly — the point of the test is what the
      // release does, not how control was taken.
      manager.setAgentControl('sess-scope', { displayName: 'Click' })
      const b = (manager as any).instances.get('ac-scope-b')
      b.controlBy.set('sess-scope', { displayName: 'Click' })
      const bTab = b.tabs.find((tab: any) => tab.id === b.activeTabId)
      bTab.heldBy = 'sess-scope'

      expect(manager.listTabs('ac-scope-a').some((tab) => tab.lockedBy === 'sess-scope')).toBe(true)

      const result = manager.clearAgentControlForInstance('ac-scope-a', 'sess-scope')

      expect(result.released).toBe(true)
      expect(manager.listTabs('ac-scope-a').some((tab) => tab.lockedBy === 'sess-scope')).toBe(false)
      // The other window is untouched: it is not the one the call named.
      expect(b.controlBy.has('sess-scope')).toBe(true)
      expect(bTab.heldBy).toBe('sess-scope')
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
      // on, and the window of another workspace is not it.
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
  // Tabs — one window, several tabs
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

      const secondId = manager.createTab('tabs-basic', { url: 'https://second.example.com/', activate: true })
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

    // What a page opens at is the **page**, not the window: the rail takes its width off the side
    // and the panel is inset by the gutter, so a 1100px viewport is a wider window. This is the one
    // place that says which of the two numbers is the intended one, so a window tweak cannot quietly
    // move the viewport with it.
    it('opens around a 1100px page, not a 1100px window', () => {
      manager.createInstance('tabs-default-size')
      const instance = (manager as any).instances.get('tabs-default-size')
      // Opened for the person: the window is up, so what it is sized around is a page in it.
      instance.window.show()

      // The page itself — what a site sees as its viewport — is `DEFAULT_VIEWPORT_WIDTH` wide.
      expect(instance.tabs[0].tabView.getBounds()).toEqual({ x: 201, y: 49, width: 1100, height: 845 })
      // And the window is that plus the rail (200) and the panel's gutter (1 + 6).
      expect(instance.window.getContentSize()).toEqual([1307, 900])
    })

    // The backdrop belongs to the *view*: `webContents.setBackgroundColor` does not exist,
    // so calling it there was a silent no-op and a tab whose page paints nothing was a hole
    // onto whichever tab is stacked under it (every tab is laid out at the same bounds).
    // What fills that hole is the **browser's** canvas — white — not the app's own surface:
    // the app's colours belong outside the page's rectangle (the gutter, `#mask`).
    it('gives each tab a backdrop of its own', () => {
      manager.createInstance('tabs-backdrop')
      const instance = (manager as any).instances.get('tabs-backdrop')
      const first = instance.tabs[0]

      expect(first.tabView.setBackgroundColor).toHaveBeenCalledWith('#ffffff')
      // The overlay is the window's and is transparent: what it paints — the gutter's surface —
      // is its document's business, not the view's backdrop.
      expect(instance.nativeOverlayView.setBackgroundColor).toHaveBeenCalledWith('#00000000')

      const secondId = manager.createTab('tabs-backdrop', { url: 'https://second.example.com/' })
      const second = instance.tabs.find((tab: any) => tab.id === secondId)

      expect(second.tabView.setBackgroundColor).toHaveBeenCalledWith('#ffffff')
    })

    // A document that paints nothing is a light page whichever theme the app wears, and the
    // canvas it leaves to the browser is white in both. Measured on `www.baidu.com/more/`
    // (no `theme-color`, `html`/`body` transparent, no full-width bar): backing it with the
    // app's own surface put `#080a10` behind the page's black text in dark mode and the whole
    // page read as black-on-black — a page that looks broken, not a page that is dark.
    // A **page** — one given an address — not the new-tab page, which is our own document and
    // paints the app's surface (see the test below).
    it('backs a page with the browser canvas in dark mode too', () => {
      mockNativeTheme.shouldUseDarkColors = true
      try {
        manager.createInstance('tabs-backdrop-dark')
        const instance = (manager as any).instances.get('tabs-backdrop-dark')
        // Make the window "in use", so the tab below is a real one and not the blank it came with.
        instance.tabs[0].currentUrl = 'https://first.example.com/'
        const pageId = manager.createTab('tabs-backdrop-dark', { url: 'https://dark.example.com/' })
        const page = instance.tabs.find((tab: any) => tab.id === pageId)

        expect(page.tabView.setBackgroundColor).toHaveBeenCalledWith('#ffffff')
        // The app's dark surface is the one thing it must *not* be: it is what painted the
        // page black.
        expect(page.tabView.setBackgroundColor).not.toHaveBeenCalledWith(BACKGROUND_HEX.dark)
      } finally {
        mockNativeTheme.shouldUseDarkColors = false
      }
    })

    // The new-tab page is our own document and paints the app's surface, so the view behind it is
    // that surface too — a white canvas behind it is a flash of the wrong colour every time a tab
    // is opened in a dark theme, for as long as the document takes to paint (it blocks on a remote
    // font stylesheet).
    it('backs the new-tab page with the app surface, not the white canvas', () => {
      mockNativeTheme.shouldUseDarkColors = true
      try {
        manager.createInstance('tabs-backdrop-newtab')
        const instance = (manager as any).instances.get('tabs-backdrop-newtab')
        const first = instance.tabs[0]

        // The last word on a tab's backdrop is the document being loaded — here the new-tab page.
        expect(first.tabView.setBackgroundColor.mock.calls.at(-1)).toEqual([BACKGROUND_HEX.dark])
      } finally {
        mockNativeTheme.shouldUseDarkColors = false
      }
    })

    // A window is created holding one blank tab. A caller that says it wants **a** tab to use
    // (`reuseUntouchedWindow`) opens *into* it: without this, a session that has just opened a
    // page would carry its own blank tab beside it — a tab nobody made and nobody can close.
    it('opens into a window\'s untouched tab instead of beside it', () => {
      manager.createInstance('tabs-fresh')
      const instance = (manager as any).instances.get('tabs-fresh')
      const only = instance.tabs[0]

      const tabId = manager.createTab('tabs-fresh', {
        url: 'https://fresh.example.com/',
        reuseUntouchedWindow: true,
      })

      expect(tabId).toBe(only.id)
      expect(instance.tabs).toHaveLength(1)
      expect(instance.activeTabId).toBe(only.id)
      expect(only.tabView.webContents.loadURL).toHaveBeenCalledWith('https://fresh.example.com/')
    })

    // …and a url alone is **not** that: `tab-new <url>` means one more page, so a blank tab that
    // was already in the window is left where it is. It may be the person's, and taking it is how
    // "New tab" used to do nothing at all.
    it('does not take an untouched tab for a caller that only wants one more', () => {
      manager.createInstance('tabs-fresh-kept')
      const instance = (manager as any).instances.get('tabs-fresh-kept')
      const only = instance.tabs[0]

      const tabId = manager.createTab('tabs-fresh-kept', { url: 'https://fresh.example.com/' })

      expect(tabId).not.toBe(only.id)
      expect(instance.tabs).toHaveLength(2)
      expect(instance.activeTabId).toBe(only.id)
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

    // …and that blank tab is a perfectly good place for a conversation to work from: `tab-new`
    // without an address asks for exactly this, and the tab it lands in is its own from then on.
    // Nothing about a cursor requires the tab to have been anywhere.
    it('lets a blank tab be the tab a conversation works from', () => {
      manager.createInstance('tabs-adopt-blank-cursor')
      const instance = (manager as any).instances.get('tabs-adopt-blank-cursor')
      const only = instance.tabs[0]

      const tabId = manager.createTab('tabs-adopt-blank-cursor', {
        reuseUntouchedWindow: true,
        belongsTo: work('session-a'),
      })

      expect(tabId).toBe(only.id)
      expect(manager.listTabs('tabs-adopt-blank-cursor').map((tab) => tab.cursorOf)).toEqual([['session-a']])
      // Its address is the empty state, not a page — that is what "blank" means, and the cursor
      // does not care.
      expect(manager.listTabs('tabs-adopt-blank-cursor')[0]!.url).not.toContain('http')
    })

    it('adds a real tab for that caller when the window is already in use', () => {
      manager.createInstance('tabs-adopt-used')
      const instance = (manager as any).instances.get('tabs-adopt-used')
      const first = instance.tabs[0]
      first.currentUrl = 'https://first.example.com/'

      const tabId = manager.createTab('tabs-adopt-used', { reuseUntouchedWindow: true, activate: true })

      expect(tabId).not.toBe(first.id)
      expect(instance.tabs).toHaveLength(2)
      expect(instance.activeTabId).toBe(tabId)
    })

    // The other half of "untouched", and the reason it is not "did this call create the
    // window": a window the person has seen is theirs, even if its only tab still reads as
    // New Tab. Taking it would type the agent's page over a tab they opened on purpose.
    it('leaves the blank tab of a window the person has seen where it is', () => {
      manager.createInstance('tabs-adopt-shown')
      const instance = (manager as any).instances.get('tabs-adopt-shown')
      const only = instance.tabs[0]
      instance.hasBeenShown = true

      const tabId = manager.createTab('tabs-adopt-shown', { reuseUntouchedWindow: true })

      expect(tabId).not.toBe(only.id)
      expect(instance.tabs).toHaveLength(2)
    })

    // "Not seen" is not the same as "unowned": a hidden window's blank tab can still have
    // been named, selected or handed to another conversation. Taking it would rewrite that
    // conversation's `belongsTo` and cursor, so the asking conversation gets its own tab.
    it('does not take an unseen blank tab another conversation already works from', () => {
      manager.createInstance('tabs-adopt-claimed')
      const instance = (manager as any).instances.get('tabs-adopt-claimed')
      const only = instance.tabs[0]
      manager.setSessionTab('tabs-adopt-claimed', only.id, 'session-b')

      const tabId = manager.createTab('tabs-adopt-claimed', {
        reuseUntouchedWindow: true,
        belongsTo: work('session-a'),
      })

      expect(tabId).not.toBe(only.id)
      expect(instance.tabs).toHaveLength(2)
      expect(only.cursorOf).toEqual(['session-b'])
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
      // free of pages nobody asked to see.
      expect(second.tabView.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1100, height: 845 })
      expect(instance.window.contentView.children).not.toContain(second.tabView)
      expect(instance.parkingWindow.contentView.children).toContain(second.tabView)
    })

    it('switches tabs and reports the one that came forward', () => {
      manager.createInstance('tabs-switch')
      const instance = (manager as any).instances.get('tabs-switch')
      // The window is up, so the tab it comes forward on is laid out in the window and switching is
      // the stack change this test is about.
      instance.window.show()
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
      // the one that came forward is the one raised above the others.
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
      // A tab with an address is a page, so its own page takes the keyboard; a new-tab page would
      // hand the caret to the address bar instead (see the focus tests below).
      second.currentUrl = 'https://second.example.com/'
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
      // The successor has an address, so it is a page and its page takes the keyboard.
      const nextId = manager.createTab('tabs-focus-close', { activate: false })
      const successor = instance.tabs.find((tab: any) => tab.id === nextId)
      successor.currentUrl = 'https://next.example.com/'

      manager.closeTab('tabs-focus-close', onScreen.id)

      // The tab that went away had the keyboard; what the window shows next takes it.
      const next = instance.tabs.find((tab: any) => tab.id === instance.activeTabId)
      expect(next.tabView.webContents.focus).toHaveBeenCalled()
    })

    // A new tab has no page to type into — it exists to be given an address — so its bar asks for
    // the caret, and coming back to it asks again. The bar is a webContents of its own, so the host
    // does both halves: the request travels in the state push (a bumped count) and the bar's
    // webContents is focused. Which tab is "new" is read from the tab's **address**, so it is known
    // the moment the tab is made, not when its empty-state document commits.
    it('puts the caret in the address bar when a new tab is put on screen', () => {
      manager.createInstance('tabs-focus-newpage')
      const instance = (manager as any).instances.get('tabs-focus-newpage')
      // The window is in use, so the new tab is a second one rather than the blank it came with.
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      instance.chromeView.webContents.focus.mockClear()

      manager.createTab('tabs-focus-newpage', { activate: true })

      expect(instance.chromeView.webContents.focus).toHaveBeenCalled()
      expect(instance.urlBarFocusToken).toBe(1)
    })

    it('puts the caret back in the address bar when the new tab’s own document commits', () => {
      manager.createInstance('tabs-focus-commit')
      const instance = (manager as any).instances.get('tabs-focus-commit')
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      const newId = manager.createTab('tabs-focus-commit', { activate: true })
      const newTab = instance.tabs.find((tab: any) => tab.id === newId)
      const tokenBeforeCommit = instance.urlBarFocusToken
      instance.chromeView.webContents.focus.mockClear()

      // Committing a page is where Chromium hands the keyboard to the page; the new-tab page is the
      // one case where it belongs in the bar instead.
      newTab.tabView.webContents._emit('did-navigate', 'file:///app/renderer/browser-empty-state.html')

      expect(instance.chromeView.webContents.focus).toHaveBeenCalled()
      expect(instance.urlBarFocusToken).toBeGreaterThan(tokenBeforeCommit)
    })

    it('leaves the address bar alone when a tab is made at an address', () => {
      manager.createInstance('tabs-focus-link')
      const instance = (manager as any).instances.get('tabs-focus-link')
      instance.tabs[0].currentUrl = 'https://first.example.com/'
      instance.chromeView.webContents.focus.mockClear()

      // A link opens a tab **at** an address — Chromium's `window.open` path — so the tab reads as a
      // page from the moment it is made and the caret stays out of the bar, without waiting for the
      // page to commit.
      manager.createTab('tabs-focus-link', {
        url: 'https://link.example.com/',
        afterTabId: instance.tabs[0].id,
        disposition: 'link',
      })

      expect(instance.chromeView.webContents.focus).not.toHaveBeenCalled()
      expect(instance.urlBarFocusToken).toBe(0)
    })

    it('puts the caret in the address bar when the person switches back to a new tab', () => {
      manager.createInstance('tabs-focus-back')
      const instance = (manager as any).instances.get('tabs-focus-back')
      const first = instance.tabs[0]
      first.currentUrl = 'https://first.example.com/'

      const newId = manager.createTab('tabs-focus-back', { activate: false })

      manager.activateTab('tabs-focus-back', first.id)
      instance.chromeView.webContents.focus.mockClear()
      const tokenBefore = instance.urlBarFocusToken

      manager.activateTab('tabs-focus-back', newId)

      // The tab on screen is the new-tab page, so the caret goes to the bar rather than the empty
      // document — and the ask is a new number, so the bar focuses again.
      expect(instance.chromeView.webContents.focus).toHaveBeenCalled()
      expect(instance.urlBarFocusToken).toBeGreaterThan(tokenBefore)
    })

    it('puts the caret in the address bar when closing a tab falls back to a new tab', () => {
      manager.createInstance('tabs-focus-close-new')
      const instance = (manager as any).instances.get('tabs-focus-close-new')
      const real = instance.tabs[0]
      real.currentUrl = 'https://first.example.com/'
      manager.createTab('tabs-focus-close-new', { activate: false })

      // The real tab is on screen; closing it hands the window over to the new-tab page behind it.
      instance.chromeView.webContents.focus.mockClear()
      manager.closeTab('tabs-focus-close-new', real.id)

      expect(instance.chromeView.webContents.focus).toHaveBeenCalled()
      expect(instance.urlBarFocusToken).toBe(1)
    })

    it('rounds the page itself, so any page is a rounded panel the person can click', () => {
      manager.createInstance('tabs-radius')
      const instance = (manager as any).instances.get('tabs-radius')
      // The person is looking at the window, so the page is in it (`tabHome`) — which is where the
      // frame it lands inside is.
      instance.window.show()
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
    // old one still being there. Every entry point that adds a tab
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
      const calls = instance.chromeView.webContents.send.mock.calls.filter(
        (call: unknown[]) => call[0] === 'browser-toolbar:state-update',
      )
      return calls[calls.length - 1]?.[1]
    }

    // The window's chrome is one document laid over the window's whole rectangle, and the page
    // sits inside it: the rail's width comes off the left, the bar's height off the top. Neither
    // depends on how many tabs there are — the room belongs to the window, not to the list.
    it("keeps the rail's room whatever the list does, so its `+` is always reachable", () => {
      manager.createInstance('tabs-room')
      const instance = (manager as any).instances.get('tabs-room')
      instance.window._emit('show')

      // The chrome: one view over the window's whole rectangle, so the rail and the bar are one
      // surface rather than two documents that have to be kept looking alike.
      expect(instance.chromeView.setBounds).toHaveBeenCalledWith({
        x: 0, y: 0, width: 1307, height: 900,
      })

      // And the page is over the chrome: the chrome covers the window, so a chrome left on top
      // would swallow the page's clicks — the page is the last thing put back over it.
      const children = instance.window.contentView.children
      expect(children.indexOf(tab(instance).tabView))
        .toBeGreaterThan(children.indexOf(instance.chromeView))

      // One tab: the page is the tab area inset by the panel's gutter — right of the rail (200)
      // and below the bar (48), by the 1px the panel's line sits in.
      expect(tab(instance).tabView.setBounds).toHaveBeenCalledWith({
        x: 201, y: 49, width: expect.anything(), height: expect.anything(),
      })

      instance.tabs[0].currentUrl = 'https://first.example.com/'
      const secondId = manager.createTab('tabs-room', { url: 'https://second.example.com/', activate: true })
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

    // The toggle in the window's top-left: folding the rail away hands its room to the page. The
    // flag is the window's own and lives only here — in memory, for this window, never written
    // down — because the rail's room is part of the tab area the page is placed in.
    it('gives the rail’s room to the page when the rail is folded away', async () => {
      const fold = (): Promise<void> => {
        const registration = (
          mockIpcMainHandle.mock.calls as unknown as Array<[string, (...args: any[]) => Promise<void>]>
        ).find(([name]) => name === 'browser-toolbar:rail-toggle')
        if (!registration) throw new Error('Expected browser-toolbar:rail-toggle IPC registration')
        return registration[1]({}, 'tabs-fold')
      }

      manager.registerToolbarIpc()
      manager.createInstance('tabs-fold')
      const instance = (manager as any).instances.get('tabs-fold')
      instance.window._emit('show')

      // Out: the page starts right of the rail, one pixel into the panel's gutter.
      expect(tab(instance).tabView.setBounds).toHaveBeenLastCalledWith({
        x: 201, y: 49, width: 1100, height: 845,
      })

      // Folded: there is no chrome on the left to hug, so the page is placed from the window's own
      // edge — the panel's edge inset, as on its right and bottom — and takes the rail's width.
      await fold()

      expect(tab(instance).tabView.setBounds).toHaveBeenLastCalledWith({
        x: 6, y: 49, width: 1295, height: 845,
      })
      expect(lastToolbarState(instance).railCollapsed).toBe(true)

      // And back: the same flag, the geometry the window started with.
      await fold()

      expect(tab(instance).tabView.setBounds).toHaveBeenLastCalledWith({
        x: 201, y: 49, width: 1100, height: 845,
      })
      expect(lastToolbarState(instance).railCollapsed).toBe(false)
    })

    // The three parts of a tab's metadata, in one payload: what the tab reports,
    // who asked for it, and who is working on it now.
    it('reports what each tab is, who asked for it, and who is driving it', () => {
      manager.createInstance('tabs-meta')
      const instance = (manager as any).instances.get('tabs-meta')
      instance.tabs[0].currentUrl = 'https://first.example.com/'

      manager.createTab('tabs-meta', { belongsTo: work('session-a') })
      const second = instance.tabs[1]
      second.title = 'Cart'
      second.isLoading = true
      second.favicon = 'https://first.example.com/favicon.ico'

      expect(manager.listTabs('tabs-meta')).toEqual([
        // The window still shows the tab it showed: an agent's tab lands behind the person's,
        // even though opening it is what made this conversation work there.
        tabSummary({ id: instance.tabs[0].id, url: 'https://first.example.com/', active: true }),
        tabSummary({
          id: second.id,
          title: 'Cart',
          isLoading: true,
          favicon: 'https://first.example.com/favicon.ico',
          belongsTo: work('session-a'),
          // Whoever opened a tab is working on it: the lease starts where the tab
          // does.
          drivenBy: 'session-a',
          // …and so does the cursor: a tab a conversation opened is the tab its next
          // unnamed command means.
          cursorOf: ['session-a'],
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
    // that tab: reading it off "whichever tab the lease is on" put
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
      // The overlay takes the tab this session works from — the last tab it opened, which is its
      // cursor — because that tab is the one the overlay is about. Waiting for a command to say so
      // again is what used to let a turn's *first* command take a tab without locking it (the
      // person's tab, with the "driven" dot instead of the lock).
      expect(manager.listTabs('tabs-lock').map((tab) => tab.lockedBy)).toEqual([null, null, 'session-a'])

      // A command resolving to another tab moves the hold to it — and it holds exactly that one.
      manager.setSessionTab('tabs-lock', heldId, 'session-a')

      expect(manager.listTabs('tabs-lock').map((tab) => tab.lockedBy)).toEqual([null, 'session-a', null])
      // The tab the window came with, and the other tab of the same session, stay free.
      expect(manager.listTabs('tabs-lock')[0].drivenBy).toBeNull()

      manager.clearAgentControl('session-a')

      expect(manager.listTabs('tabs-lock').map((tab) => tab.lockedBy)).toEqual([null, null, null])
    })

    // A lock never outlives what it locks: closing the held tab lets go of it, instead of
    // leaving the window claiming a tab that is gone.
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
    // tab — and moving to another tab of its own leaves exactly one behind.
    it('keeps one tab per conversation as the tab it works from', () => {
      manager.createInstance('tabs-cursor')
      const instance = (manager as any).instances.get('tabs-cursor')
      instance.tabs[0].currentUrl = 'https://first.example.com/'

      const first = manager.createTab('tabs-cursor', { belongsTo: work('session-a') })
      // A second tab of the same conversation takes the cursor from the first: one tab
      // per conversation is the whole point.
      manager.createTab('tabs-cursor', { belongsTo: work('session-a') })

      expect(manager.listTabs('tabs-cursor').map((tab) => tab.cursorOf)).toEqual([[], [], ['session-a']])

      manager.setSessionTab('tabs-cursor', first, 'session-a')

      expect(manager.listTabs('tabs-cursor').map((tab) => tab.cursorOf)).toEqual([[], ['session-a'], []])

      // The person switching tabs moves the display and nothing else.
      manager.activateTab('tabs-cursor', instance.tabs[0].id)

      expect(instance.activeTabId).toBe(instance.tabs[0].id)
      expect(manager.listTabs('tabs-cursor').map((tab) => tab.cursorOf)).toEqual([[], ['session-a'], []])
    })

    // A cursor is written on a tab and **ends with it**: closing the tab a conversation works
    // from leaves it with no tab of its own rather than quietly handing it a neighbour. The
    // next command says so and names the ways out — and the tab on screen is not one of them,
    // which is the whole point of not re-pointing anything here.
    it('does not move a conversation\'s cursor to another tab when its tab is closed', () => {
      manager.createInstance('tabs-cursor-close')
      const instance = (manager as any).instances.get('tabs-cursor-close')
      instance.tabs[0].currentUrl = 'https://first.example.com/'

      const closing = manager.createTab('tabs-cursor-close', { activate: false, belongsTo: work('session-a') })
      manager.createTab('tabs-cursor-close', { activate: false, belongsTo: work('session-a') })
      // Two conversations may work from one tab (a route, not a claim), so a close takes both
      // of their cursors away rather than moving one.
      manager.setSessionTab('tabs-cursor-close', closing, 'session-a')
      manager.setSessionTab('tabs-cursor-close', closing, 'session-b')

      expect(manager.listTabs('tabs-cursor-close').map((tab) => tab.cursorOf))
        .toEqual([[], ['session-a', 'session-b'], []])

      manager.closeTab('tabs-cursor-close', closing)

      expect(manager.listTabs('tabs-cursor-close').map((tab) => tab.cursorOf)).toEqual([[], []])
      expect(instance.tabs[0].cursorOf).toEqual([])
    })

    /**
     * Handing a tab over: the orchestrator's half of "a DAG's nodes each get their own tab".
     * Who may give a tab away is decided here, because only the tab
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
      expect(tab().cursorOf).toEqual(['child-1'])
      expect(whyTabIsOutOfReach(tab(), work('child-1'))).toBeNull()

      // The giver is out of it: it can neither work there any more nor pass it on again.
      expect(whyTabIsOutOfReach(tab(), work('parent'))).not.toBeNull()
      expect(() => manager.assignTab('tabs-assign', handedTab, work('child-2'), work('parent'))).toThrow(/child-1/)
    })

    it('refuses to give away a tab the person opened', () => {
      manager.createInstance('tabs-assign-person')
      const personTab = manager.createTab('tabs-assign-person', { url: 'https://person.example.com/' })

      expect(() => manager.assignTab('tabs-assign-person', personTab, work('child-1'), work('parent')))
        .toThrow(/the person's/)
    })

    it('refuses a tab somebody else is holding', () => {
      manager.createInstance('tabs-assign-held')
      const heldTab = manager.createTab('tabs-assign-held', { belongsTo: work('parent') })
      const instance = (manager as any).instances.get('tabs-assign-held')
      instance.tabs.find((tab: any) => tab.id === heldTab).heldBy = 'other'

      expect(() => manager.assignTab('tabs-assign-held', heldTab, work('child-1'), work('parent')))
        .toThrow(/held by other/)
    })

    it('refuses to hand a tab to the conversation that already has it', () => {
      manager.createInstance('tabs-assign-self')
      const tabId = manager.createTab('tabs-assign-self', { belongsTo: work('parent') })

      expect(() => manager.assignTab('tabs-assign-self', tabId, work('parent'), work('parent')))
        .toThrow(/already/)
    })

    it('leaves only the receiver working from the tab it was given', () => {
      manager.createInstance('tabs-assign-cursors')
      const tabId = manager.createTab('tabs-assign-cursors', { belongsTo: work('parent') })
      const instance = (manager as any).instances.get('tabs-assign-cursors')
      const tab = instance.tabs.find((candidate: any) => candidate.id === tabId)
      tab.cursorOf = ['parent', 'someone-else']

      manager.assignTab('tabs-assign-cursors', tabId, work('child-1'), work('parent'))

      expect(manager.listTabs('tabs-assign-cursors').find((candidate) => candidate.id === tabId)!.cursorOf)
        .toEqual(['child-1'])
    })

    // What a DAG needs of a tab's owner: a tab handed to a node belongs to that
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
    // `about:newtab` (that is how the empty state is normalized), which is also what the
    // "open into an untouched window" reuse looks for — but that reuse needs something
    // to *put in* the window, and "a new tab" is not content, it is the request. With
    // the reuse applying here, nothing appeared to happen: the window kept its one tab
    // and the `+` looked broken.
    it('adds a tab from the strip when the window holds only its blank tab', async () => {
      manager.createInstance('tabs-ipc-fresh')
      const instance = (manager as any).instances.get('tabs-ipc-fresh')
      manager.registerToolbarIpc()

      expect(instance.tabs[0].currentUrl).toBe('about:newtab')

      await tabsHandler()({}, 'tabs-ipc-fresh', 'new')

      expect(instance.tabs).toHaveLength(2)
      expect(instance.tabs[1].belongsTo).toBeNull()
      expect(instance.activeTabId).toBe(instance.tabs[1].id)
    })
  })

  describe('watching a tab', () => {
    const watchedTab = (id: string): any => (manager as any).instances.get(id).tabs[0]

    it('is read-only until the viewer takes control', async () => {
      const id = manager.createForSession(null, { workspaceId: 'ws-1' })
      const watched = watchedTab(id)
      const { streamId } = await manager.startViewStream(id, watched.id, 'client-1', () => {})

      await expect(manager.dispatchStreamInput(streamId, 'client-1', [])).rejects.toThrow('Take control')
      expect(watched.cdp.dispatchInput).not.toHaveBeenCalled()

      await manager.setViewStreamControl(streamId, 'client-1', true)
      await manager.dispatchStreamInput(streamId, 'client-1', [])
      expect(watched.cdp.dispatchInput).toHaveBeenCalledTimes(1)
    })

    it('refuses control while the agent holds the tab, and drops it if the agent takes it later', async () => {
      const id = manager.createForSession(null, { workspaceId: 'ws-1' })
      const watched = watchedTab(id)
      const { streamId } = await manager.startViewStream(id, watched.id, 'client-1', () => {})

      watched.heldBy = 'sess-1'
      await expect(manager.setViewStreamControl(streamId, 'client-1', true)).rejects.toThrow('agent is working')

      // The person had it, then the agent took the tab: the hold outranks the viewer.
      watched.heldBy = null
      await manager.setViewStreamControl(streamId, 'client-1', true)
      watched.heldBy = 'sess-1'
      await expect(manager.dispatchStreamInput(streamId, 'client-1', [])).rejects.toThrow('agent is working')
      await expect(manager.dispatchStreamInput(streamId, 'client-1', [])).rejects.toThrow('Take control')
    })

    it('belongs to the client that started it', async () => {
      const id = manager.createForSession(null, { workspaceId: 'ws-1' })
      const watched = watchedTab(id)
      const { streamId } = await manager.startViewStream(id, watched.id, 'client-1', () => {})

      await expect(manager.setViewStreamControl(streamId, 'client-2', true)).rejects.toThrow('another client')
      await expect(manager.stopViewStream(streamId, 'client-2')).rejects.toThrow('another client')
    })

    /**
     * A screencast belongs to the tab, a stream to the viewer: the second person to look at a
     * tab joins the capture that is already running, and only the last one to leave stops it.
     */
    it('lets a second viewer share the tab’s capture, and stops it with the last', async () => {
      const id = manager.createForSession(null, { workspaceId: 'ws-1' })
      const watched = watchedTab(id)
      const firstFrames: any[] = []
      const secondFrames: any[] = []

      const first = await manager.startViewStream(id, watched.id, 'client-1', (frame) => { firstFrames.push(frame) })
      // The tab now has a capture; a second request must join it rather than start another.
      watched.cdp.isScreencasting = mock(() => true)
      const second = await manager.startViewStream(id, watched.id, 'client-2', (frame) => { secondFrames.push(frame) })

      expect(watched.cdp.startScreencast).toHaveBeenCalledTimes(1)
      expect(second.streamId).not.toBe(first.streamId)

      // A viewer is sent one still seed before the page paints — a still page would never send
      // a frame of its own. This test is about the *live* fan-out, so counting starts after the
      // seeds have landed.
      await new Promise((resolve) => setTimeout(resolve, 80))
      firstFrames.length = 0
      secondFrames.length = 0

      // One frame, two viewers, each addressed by its own stream id.
      const capture = (watched.cdp.startScreencast as any).mock.calls[0][0]
      capture.onFrame({ bytes: Buffer.from('jpeg'), width: 1280, height: 800 })
      expect(firstFrames).toHaveLength(1)
      expect(secondFrames).toHaveLength(1)
      expect(firstFrames[0].streamId).toBe(first.streamId)
      expect(secondFrames[0].streamId).toBe(second.streamId)

      // One viewer leaving is not the capture ending; the other keeps its picture.
      await manager.stopViewStream(first.streamId, 'client-1')
      expect(watched.cdp.stopScreencast).not.toHaveBeenCalled()
      await new Promise((resolve) => setTimeout(resolve, 70))
      capture.onFrame({ bytes: Buffer.from('jpeg'), width: 1280, height: 800 })
      expect(secondFrames).toHaveLength(2)

      await manager.stopViewStream(second.streamId, 'client-2')
      expect(watched.cdp.stopScreencast).toHaveBeenCalledTimes(1)
    })

    it('ends every viewer when the tab’s capture goes away', async () => {
      const ended: Array<{ clientId: string; streamId: string }> = []
      manager.setViewStreamEndedHandler((clientId, streamId) => ended.push({ clientId, streamId }))

      const id = manager.createForSession(null, { workspaceId: 'ws-1' })
      const watched = watchedTab(id)
      const first = await manager.startViewStream(id, watched.id, 'client-1', () => {})
      watched.cdp.isScreencasting = mock(() => true)
      const second = await manager.startViewStream(id, watched.id, 'client-2', () => {})

      const capture = (watched.cdp.startScreencast as any).mock.calls[0][0]
      capture.onEnd('the CDP session ended')

      expect(ended.map((entry) => entry.streamId).sort()).toEqual([first.streamId, second.streamId].sort())
      expect(ended.map((entry) => entry.clientId).sort()).toEqual(['client-1', 'client-2'])
    })

    it('takes over a screencast the registry does not know about, instead of refusing', async () => {
      const id = manager.createForSession(null, { workspaceId: 'ws-1' })
      const watched = watchedTab(id)
      // The page reports a capture this manager has no entry for: a viewer's stop that landed
      // after the next start asked, or a detach nobody reported. Refusing used to strand that
      // next viewer — close the panel, open it again, nothing — which is why a tab switch, whose
      // tab had no such leftover, appeared to fix it. `startScreencast` replaces the page's one
      // capture, and this manager is the only thing that starts them, so taking over is safe.
      watched.cdp.isScreencasting = mock(() => true)

      const { streamId } = await manager.startViewStream(id, watched.id, 'client-1', () => {})

      expect(streamId).toBeTruthy()
      expect(watched.cdp.startScreencast).toHaveBeenCalledTimes(1)
    })

    it('restarts a capture whose screencast is gone, rather than seating a viewer in a dead one', async () => {
      const id = manager.createForSession(null, { workspaceId: 'ws-1' })
      const watched = watchedTab(id)
      const firstFrames: unknown[] = []
      const secondFrames: unknown[] = []
      const first = await manager.startViewStream(id, watched.id, 'client-1', (frame) => { firstFrames.push(frame) })
      // Silently gone: the registry still has the capture, but nothing is feeding it. Joining it
      // is what left a reopened viewer on "waiting for the first frame" until it gave up.
      watched.cdp.isScreencasting = mock(() => false)

      const second = await manager.startViewStream(id, watched.id, 'client-2', (frame) => { secondFrames.push(frame) })

      expect(second.streamId).not.toBe(first.streamId)
      expect(watched.cdp.startScreencast).toHaveBeenCalledTimes(2)
      // One restarted screencast serves both seats, the one that was already there included.
      await new Promise((resolve) => setTimeout(resolve, 70))
      const restarted = (watched.cdp.startScreencast as any).mock.calls[1][0]
      restarted.onFrame({ bytes: Buffer.from('jpeg'), width: 1280, height: 800 })
      expect(firstFrames.length).toBeGreaterThan(0)
      expect(secondFrames.length).toBeGreaterThan(0)
    })
  })

  describe('reloading', () => {
    /**
     * The hook exists for the work that has to be in the next document — a tweak's
     * registration. Its whole contract is *before*, so the test holds it open and checks that
     * nothing has been reloaded while it is still unanswered.
     */
    it('answers the hook before reloading, so the next document is born with it', async () => {
      manager.createInstance('reload-hook')
      const instance = (manager as any).instances.get('reload-hook')
      const first = instance.tabs[0]

      const asked: Array<[string, string]> = []
      let answer: (() => void) | null = null
      manager.setBeforeReload((instanceId, tabId) => {
        asked.push([instanceId, tabId])
        return new Promise<void>((resolve) => {
          answer = resolve
        })
      })

      manager.reload('reload-hook')

      expect(asked).toEqual([['reload-hook', first.id]])
      expect(first.tabView.webContents.reload).not.toHaveBeenCalled()

      answer!()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(first.tabView.webContents.reload).toHaveBeenCalledTimes(1)
    })

    // The page is the person's, the hook is ours: whatever it could not read is not a reason
    // to leave them looking at a reload that never happened.
    it('reloads anyway when the hook fails', async () => {
      manager.createInstance('reload-hook-fails')
      const instance = (manager as any).instances.get('reload-hook-fails')
      manager.setBeforeReload(async () => {
        throw new Error('install failed')
      })

      manager.reload('reload-hook-fails')
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(instance.tabs[0].tabView.webContents.reload).toHaveBeenCalledTimes(1)
    })
  })

  describe('developer tools', () => {
    /** The last state the window pushed to its own toolbar. */
    function lastToolbarState(instance: any): any {
      const calls = instance.chromeView.webContents.send.mock.calls.filter(
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
      manager.createTab(id, { url: 'https://second.example.com/', activate: true })
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
      const calls = instance.chromeView.webContents.send.mock.calls.filter(
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
        // The same shape the CDP session answers with: a status, and whatever elements
        // it has to hand over (usually none).
        const empty = { status: 'pending', picks: [] }
        return report ? { ...empty, status: report.status, picks: report.picks ?? [] } : empty
      })
      const teardownOverlay = mock(async () => {})
      tab.cdp = { armOverlay, drainOverlay, teardownOverlay }
      return { armOverlay, drainOverlay, teardownOverlay }
    }

    /**
     * Long enough for one more pass of the poll loop (250ms between passes).
     *
     * The loop is not driven by the calls that change the mode — asking the page to
     * leave is answered by the page, on its next poll — so a test that waits for the
     * answer has to wait that long.
     */
    const PICKER_POLL_WAIT = 350

    /** The bar's word, as the panel sends it down (the page has no i18n). */
    const PICK_LABELS = {
      add: 'Add to conversation',
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
      const { armOverlay, teardownOverlay } = stubPicker(instance.tabs[0], [
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
          // The bar's word travels down with the call: the page has no i18n.
          labels: PICK_LABELS,
          // The app's own accent: a concrete colour, because a page cannot see the
          // app's variables and everything the overlay draws here — the frame, the
          // name, the bar — is drawn in it.
          accent: expect.stringMatching(/^(#|oklch|rgb|hsl)/),
        }),
      )
      expect(lastToolbarState(instance).picking).toBe(true)
      // Picking is a mode, not a pick: arming leaves the page's overlay in place.
      expect(teardownOverlay).not.toHaveBeenCalled()

      // Turning it off takes it down — there is nothing to save, so leaving is leaving.
      await toolbarHandler('browser-toolbar:cancel-pick')({}, 'pick-mode')

      expect(teardownOverlay).toHaveBeenCalled()
      expect(instance.picking).toBe(false)
      expect(lastToolbarState(instance).picking).toBe(false)

      await new Promise((resolve) => setTimeout(resolve, PICKER_POLL_WAIT))
    })

    // The element alone cannot say which tab it came from, and the picker is the
    // window's — so the tab travels with the pick.
    it('reports a pick with the tab it came from', async () => {
      const actions: any[] = []
      manager.setWindowManager({
        getRpcEventSink: () => (_channel: string, _routing: unknown, payload: unknown) => {
          actions.push(payload)
        },
      } as any)
      manager.createInstance('pick-origin')
      const instance = (manager as any).instances.get('pick-origin')
      const tab = instance.tabs[0]
      tab.currentUrl = 'https://shop.example.com/cart'
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
          // The tab travels with the pick (`PickedElementOrigin.tabId`): the conversation acts on
          // the tab the person pointed at, not on the one it happens to be working from.
          tabId: tab.id,
          url: 'https://shop.example.com/cart',
          title: 'Cart',
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
   * The person's recording of the tab on screen.
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

    it('files the recording in one fixed folder of the app\'s own, whoever\'s tab it was', async () => {
      // A conversation's tab: the recording is still the person's file — whose tab it is is not what
      // the file is about. But it goes to a folder the app owns, not to downloads, which is where
      // files get handed around and a recording now carries what was typed into the page.
      const instanceId = manager.createInstance('record-downloads', { workspaceId: 'workspace-a' })
      manager.createTab(instanceId, { belongsTo: work('session-a') })
      manager.registerToolbarIpc()

      const started = await toolbarHandler('browser-toolbar:record')({}, instanceId, 'start')
      expect(started.file.startsWith(join(downloadsDir, ''))).toBe(false)
      expect(started.file.replace(/\\/g, '/')).toContain('/records/')

      // Nothing was ever captured — no display media, so no chunk — and a recording with
      // nothing in it is not left behind as an mp4 that shows nothing.
      expect(await toolbarHandler('browser-toolbar:record')({}, instanceId, 'stop')).toBeNull()
      expect(existsSync(started.file)).toBe(false)
    })

    it('names the file an mp4 whatever container the chrome asks for', async () => {
      const instanceId = manager.createInstance('record-format')
      manager.registerToolbarIpc()
      const record = toolbarHandler('browser-toolbar:record')

      // The extension comes from the chrome — it is the side that knows what
      // `MediaRecorder` will write — but from a list: a name the other side invents is not
      // one we take, and a recording is one container, so anything else comes back as mp4.
      const cases: Array<string | undefined> = ['mp4', 'WEBM', 'webm', '../../evil', undefined]
      for (const asked of cases) {
        const started = await record({}, instanceId, 'start', asked)
        expect(started.file.endsWith('.mp4')).toBe(true)
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
        instance.chromeView.webContents.send.mock.calls
          .filter((call: unknown[]) => call[0] === 'browser-toolbar:state-update')
          .map((call: unknown[]) => (call[1] as { recording: unknown }).recording)

      expect(sent().at(-1)).toBeUndefined()
      const started = await toolbarHandler('browser-toolbar:record')({}, instanceId, 'start')
      expect(sent().at(-1)).toMatchObject({ file: started.file, startedAt: started.startedAt })

      await toolbarHandler('browser-toolbar:record')({}, instanceId, 'stop')
      expect(sent().at(-1)).toBeNull()
    })
  })

  /**
   * Recording **a conversation's** tab (`record-start`).
   *
   * A window is identified by its **workspace** alone (`findWindowForWorkspace`), so the
   * workspace has to be carried into the call. Leaving it out resolves the
   * `workspaceId === null` bucket instead — *creating* that window — and then reports
   * `has no tab "…"` about a window the conversation never worked in. That is the bug
   * pinned here.
   */
  describe("recording a conversation's tab", () => {
    /** The recorder proper is not what these tests are about: what it was *asked* is. */
    function stubRecorder(): Array<{ tabId: string; instanceId: string }> {
      const asked: Array<{ tabId: string; instanceId: string }> = []
      ;(manager as any).sessionRecordings = {
        start: async (options: any) => {
          asked.push({ tabId: options.tabId, instanceId: options.instanceId })
          return {
            ok: true,
            state: {
              tabId: options.tabId,
              file: join(downloadsDir, 'conversation-recording.webm'),
              startedAt: Date.now(),
              bytes: 0,
            },
            // Nothing ends it here, so no test has to wait for one.
            finished: new Promise(() => {}),
          }
        },
      }
      return asked
    }

    it('records the tab in the conversation\'s own workspace window', async () => {
      const workspaceId = 'workspace-recording'
      const instanceId = manager.createInstance('recording-workspace', { workspaceId })
      const tabId = tab((manager as any).instances.get('recording-workspace')).id
      const asked = stubRecorder()

      const result = await manager.startRecordingForSession(
        'session-recording',
        { tabId, ttlMs: 30_000 } as any,
        { workspaceId },
      )

      expect(result.started).toBe(true)
      expect(asked.map((one) => one.tabId)).toEqual([tabId])
      // …and it is asked for **in the caller's window**: a tab is named in a window, and the window
      // is the other half of that name (`tab-recorder.ts` why).
      expect(asked.map((one) => one.instanceId)).toEqual([instanceId])
      // The window it recorded in is the caller's — not a second one conjured up for it.
      expect((manager as any).instances.size).toBe(1)
      expect((manager as any).instances.get(instanceId).workspaceId).toBe(workspaceId)
    })

    it("records in the caller's own window, not another window's tab of the same name", async () => {
      // Ids are per window (`BrowserInstance.tabCounter`), so the other window's first tab is named
      // the same as the caller's own will be: the name alone cannot tell them apart, and it is not
      // asked to. What keeps them apart is that a conversation's command is resolved against **its
      // own** window, and that the window travels with the recording.
      const other = manager.createInstance('recording-other-workspace', { workspaceId: 'workspace-other' })
      const otherTabId = tab((manager as any).instances.get(other)).id
      const asked = stubRecorder()

      const result = await manager.startRecordingForSession(
        'session-recording',
        { tabId: otherTabId, ttlMs: 30_000 } as any,
        { workspaceId: 'workspace-recording' },
      )

      const own = [...(manager as any).instances.values()].find(
        (one: any) => one.workspaceId === 'workspace-recording',
      )
      expect(result.started).toBe(true)
      // The same name in both windows — and the recording is of the caller's own tab.
      expect(otherTabId).toBe('tab-1')
      expect(own.tabs[0].id).toBe('tab-1')
      expect(asked).toEqual([{ tabId: 'tab-1', instanceId: own.id }])
      expect(asked[0].instanceId).not.toBe(other)
      expect(own.tabs[0]).not.toBe((manager as any).instances.get(other).tabs[0])
    })
  })
})
