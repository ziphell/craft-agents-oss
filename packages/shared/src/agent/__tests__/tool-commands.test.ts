/**
 * Tests for the pane tool factories.
 *
 * `browser_tool`, `video_tool` and `drawio_tool` are doors onto one command table, and the suite
 * drives each command through the door that owns it. All of them delegate to `BrowserPaneFns` via
 * CLI commands.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import { createBrowserTools } from '../browser-tools'
import { createVideoTools } from '../video-tools'
import { createDrawioTools } from '../drawio-tools'
import type { BrowserPaneFns } from '../browser-pane'
import type { BrowserTabSummary } from '../../protocol/dto'

/**
 * One page as `tabs` reports it: what the page reports, plus what its opener said.
 * Every field the test does not care about gets the value a plain, user-opened page
 * would have.
 */
function tabRow(overrides: Partial<BrowserTabSummary> & { id: string }): BrowserTabSummary {
  return {
    url: 'about:blank',
    title: 'New Tab',
    favicon: null,
    isLoading: false,
    active: false,
    disposition: null,
    belongsTo: null,
    drivenBy: null,
    cursorOf: [],
    lockedBy: null,
    ...overrides,
  }
}

// ============================================================================
// Mock BrowserPaneFns
// ============================================================================

function createMockFns(): BrowserPaneFns {
  return {
    openPanel: async () => ({ instanceId: 'browser-test-1' }),
    navigate: async (url: string) => ({ url: `https://${url}`, title: 'Test Page' }),
    snapshot: async () => ({
      url: 'https://example.com',
      title: 'Example',
      nodes: [
        { ref: '@e1', role: 'button', name: 'Click me' },
        { ref: '@e2', role: 'textbox', name: 'Search', value: '', focused: true },
      ],
    }),
    click: async (_ref: string) => {},
    clickAt: async (_x: number, _y: number) => {},
    drag: async (_x1: number, _y1: number, _x2: number, _y2: number) => {},
    fill: async (_ref: string, _value: string) => {},
    type: async (_text: string) => {},
    select: async (_ref: string, _value: string) => {},
    setClipboard: async (_text: string) => {},
    getClipboard: async () => 'clipboard content',
    screenshot: async () => ({ imageBuffer: Buffer.from('fake-png-data'), imageFormat: 'png' as const }),
    screenshotRegion: async () => ({ imageBuffer: Buffer.from('fake-png-data'), imageFormat: 'png' as const }),
    getConsoleLogs: async () => ([
      { timestamp: Date.now(), level: 'warn', message: 'Test warning' },
    ]),
    resizeViewport: async (args) => ({ width: args.width, height: args.height }),
    getNetworkLogs: async () => ([
      { timestamp: Date.now(), method: 'GET', url: 'https://example.com/api', status: 500, resourceType: 'xhr', ok: false },
    ]),
    waitFor: async (args) => ({ ok: true as const, kind: args.kind, elapsedMs: 123, detail: 'condition met' }),
    sendKey: async (_args) => {},
    getDownloads: async () => ([
      { id: 'dl-1', timestamp: Date.now(), url: 'https://example.com/file.pdf', filename: 'file.pdf', state: 'completed', bytesReceived: 100, totalBytes: 100, mimeType: 'application/pdf' },
    ]),
    upload: async (_ref: string, _filePaths: string[]) => {},
    scroll: async (_dir: 'up' | 'down' | 'left' | 'right', _amount?: number) => {},
    goBack: async () => {},
    goForward: async () => {},
    reload: async () => {},
    evaluate: async (expr: string) => eval(expr),
    fetchResource: async () => ({ ok: false, error: 'no session in this test' }),
    pick: async (_options?: { timeoutMs?: number }) => ({
      selector: '[data-testid="pay"]',
      tag: 'button',
      text: 'Pay now',
      rect: { x: 10, y: 20, width: 120, height: 40 },
    }),
    sampleVideo: async () => ({
      durationMs: 6000,
      truncated: false,
      frames: [
        { offsetMs: 0, bytes: new Uint8Array([1]), path: null },
        { offsetMs: 2000, bytes: new Uint8Array([2]), path: null },
        { offsetMs: 4000, bytes: new Uint8Array([3]), path: null },
      ],
    }),
    exportDrawio: async () => ({
      bytes: new Uint8Array([1]),
      mimeType: 'image/svg+xml',
      extension: '.svg',
      path: null,
    }),
    listDrawioPages: async () => [{ id: 'p1', name: 'Checkout', compressed: false }],
    focusWindow: async (instanceId?: string) => ({ instanceId: instanceId ?? 'browser-1', title: 'Example Domain', url: 'https://example.com' }),
    createTab: async () => 'tab-1',
    targetTab: async (_tabId: string) => {},
    activateTab: async (_tabId: string) => ({ movedView: true }),
    closeTab: async (_tabId: string) => ({ remaining: 1 }),
    assignTab: async (_tabId: string, _targetSessionId: string) => {},
    listTabs: async () => ([
      tabRow({ id: 'tab-1', active: true }),
    ]),
    releaseControl: async (_instanceId?: string) => ({ action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }),
    closeWindow: async (_instanceId?: string) => ({ action: 'closed' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }),
    hideWindow: async (_instanceId?: string) => ({ action: 'hidden' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }),
    listWindows: async () => ([
      {
        id: 'browser-1',
        title: 'Example Domain',
        url: 'https://example.com',
        isVisible: true,
        agentControlActive: true,
      },
    ]),
    detectChallenge: async () => ({ detected: false, provider: 'none', signals: [] }),
  }
}

// ============================================================================
// Helper: execute a tool by name
// ============================================================================

function findTool(tools: any[], name: string) {
  // SDK tool objects have a .name property
  return tools.find((t: any) => t.name === name)
}

async function executeTool(tools: any[], name: string, args: Record<string, unknown> = {}) {
  const t = findTool(tools, name) as any
  if (!t) throw new Error(`Tool "${name}" not found`)
  // SDK tools have an execute/handler function — use the handler directly
  return t.handler(args)
}

/**
 * Every command the runtime dispatches, read from its source.
 *
 * The help text is the only place an agent learns a command exists, so a command that is
 * implemented but missing there is invisible to it. The list is read from the module rather
 * than kept here: a hand-maintained list is one more thing to forget — which is how a command
 * comes to be runnable and undocumented at the same time.
 *
 * One module per door, because that is where a command belongs now — the names carry no prefix
 * for the test to sort them by.
 */
async function runtimeCommands(module: 'browser-commands' | 'video-commands' | 'drawio-commands'): Promise<string[]> {
  const source = await Bun.file(new URL(`../${module}.ts`, import.meta.url)).text()
  const matches = [...source.matchAll(/\bcmd === '([a-z-]+)'/g)]
  return [...new Set(matches.map((match) => match[1]!))]
}

// ============================================================================
// Tests
// ============================================================================

describe('the pane tools', () => {
  let mockFns: BrowserPaneFns
  let tools: any[]

  beforeEach(() => {
    mockFns = createMockFns()
    // Every door: one command table each, and the suite drives commands through the one that owns
    // them.
    tools = [
      ...createBrowserTools({
        sessionId: 'test-session',
        getBrowserPaneFns: () => mockFns,
      }),
      ...createVideoTools({
        sessionId: 'test-session',
        getBrowserPaneFns: () => mockFns,
      }),
      ...createDrawioTools({
        sessionId: 'test-session',
        getBrowserPaneFns: () => mockFns,
      }),
    ]
  })

  it('returns exactly 1 tool (browser_tool only)', () => {
    const browserOnly = createBrowserTools({
      sessionId: 'test-session',
      getBrowserPaneFns: () => mockFns,
    })
    expect(browserOnly.length).toBe(1)
    expect(browserOnly.map((t: any) => t.name)).toEqual(['browser_tool'])
  })

  describe('drawio_tool', () => {
    it('returns exactly 1 tool (drawio_tool only)', () => {
      const diagramOnly = createDrawioTools({
        sessionId: 'test-session',
        getBrowserPaneFns: () => mockFns,
      })
      expect(diagramOnly.length).toBe(1)
      expect(diagramOnly.map((t: any) => t.name)).toEqual(['drawio_tool'])
    })

    it('answers --help with the commands, and where a relative path is counted from', async () => {
      const help = (await executeTool(tools, 'drawio_tool', { command: '--help' })).content[0].text

      expect(help).toContain('drawio_tool command help')
      expect(help).toContain('pages <diagram-file>')
      expect(help).toContain('export <diagram-file> --to <path>')
      expect(help).toContain('render <diagram-file>')
      expect(help).toContain('workspace root')
    })

    // A rendering is a picture in the reply — that is the whole of `render` — and this door is
    // where the picture becomes a content block rather than something described in words.
    it('puts a rendering in the reply as an image', async () => {
      mockFns.exportDrawio = async () => ({
        bytes: new Uint8Array([137, 80, 78, 71]),
        mimeType: 'image/png',
        extension: '.png',
        path: null,
      })

      const result = await executeTool(tools, 'drawio_tool', { command: 'render /tmp/flow.drawio' })

      expect(result.content[0].text).toContain('Rendered /tmp/flow.drawio')
      expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    })

    it('reports an engine failure as an error rather than as an empty result', async () => {
      mockFns.exportDrawio = async () => {
        throw new Error('The diagram engine did not answer in time.')
      }

      const result = await executeTool(tools, 'drawio_tool', { command: 'render /tmp/flow.drawio' })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Error: The diagram engine did not answer in time.')
    })
  })

  describe('video_tool', () => {
    const tempDirs: string[] = []

    beforeEach(() => {
      tempDirs.length = 0
    })

    afterEach(() => {
      for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    })

    it('returns exactly 1 tool (video_tool only)', () => {
      const videoOnly = createVideoTools({
        sessionId: 'test-session',
        getBrowserPaneFns: () => mockFns,
      })
      expect(videoOnly.length).toBe(1)
      expect(videoOnly.map((t: any) => t.name)).toEqual(['video_tool'])
    })

    it('answers --help with the one command, its flags, and where the frames go', async () => {
      const help = (await executeTool(tools, 'video_tool', { command: '--help' })).content[0].text

      expect(help).toContain('video_tool command help')
      expect(help).toContain('sample <path> [--out <dir>] [--every <dur>] [--changes] [--threshold <r>] [--from <dur>] [--to <dur>] [--first] [--last] [--max-edge <n>] [--max <n>]')
      expect(help).toContain('--out <dir>')
      expect(help).toContain('Chromium')
      expect(help).toContain('workspace root')
    })

    it('samples on a timeline every 1000 ms, at most 1000 frames, writing nothing, by default', async () => {
      const seen: Array<Record<string, unknown>> = []
      mockFns.sampleVideo = async (args) => {
        seen.push(args)
        return { durationMs: 6000, truncated: false, frames: [{ offsetMs: 0, bytes: new Uint8Array([1]), path: null }] }
      }

      const result = await executeTool(tools, 'video_tool', { command: 'sample /tmp/demo.mp4' })
      const text = result.content[0].text

      expect(seen[0]).toMatchObject({ mode: 'timeline', everyMs: 1000, maxFrames: 1000 })
      expect(seen[0]!.out).toBeUndefined()
      expect(text).toContain('Sampled 1 frame out of /tmp/demo.mp4 (6s long)')
      expect(text).toContain('• frame-0001.jpg  @ 0ms')
      expect(text).toContain('no files written')
    })

    it('writes the frames under --out, once each, and reports the files', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'craft-video-out-'))
      tempDirs.push(dir)
      let receivedOut: string | undefined
      mockFns.sampleVideo = async ({ out }) => {
        receivedOut = out
        const frames = [
          { offsetMs: 0, bytes: new Uint8Array([1]) },
          { offsetMs: 2000, bytes: new Uint8Array([2]) },
        ]
        // The pane writes them when it is told where — the contract the command reports on.
        frames.forEach((frame, index) => {
          writeFileSync(join(out!, `frame-${String(index + 1).padStart(4, '0')}.jpg`), frame.bytes)
        })
        return {
          durationMs: 4000,
          truncated: false,
          frames: frames.map((frame, index) => ({
            ...frame,
            path: join(out!, `frame-${String(index + 1).padStart(4, '0')}.jpg`),
          })),
        }
      }

      const result = await executeTool(tools, 'video_tool', {
        command: ['sample', '/tmp/demo.mp4', '--out', dir],
      })
      const text = result.content[0].text

      expect(receivedOut).toBe(dir)
      expect(existsSync(join(dir, 'frame-0001.jpg'))).toBe(true)
      expect(existsSync(join(dir, 'frame-0002.jpg'))).toBe(true)
      expect(text).toContain(`into ${dir}, as:`)
      expect(text).toContain('• frame-0001.jpg  @ 0ms')
      expect(text).toContain('• frame-0002.jpg  @ 2000ms')
      expect(text).not.toContain('Nothing was written to disk')
    })

    it('keeps only the frames that moved with --changes', async () => {
      let receivedMode: string | undefined
      mockFns.sampleVideo = async ({ mode }) => {
        receivedMode = mode
        return { durationMs: 6000, truncated: false, frames: [{ offsetMs: 3000, bytes: new Uint8Array([1]), path: null }] }
      }

      await executeTool(tools, 'video_tool', { command: 'sample /tmp/demo.mp4 --changes' })

      expect(receivedMode).toBe('changes')
    })

    it('reports a sample when the frame ceiling truncated it', async () => {
      let receivedMax: number | undefined
      mockFns.sampleVideo = async ({ maxFrames }) => {
        receivedMax = maxFrames
        return {
          durationMs: 120_000,
          truncated: true,
          frames: Array.from({ length: maxFrames! }, (_unused, i) => ({
            offsetMs: i * 3000,
            bytes: new Uint8Array([i]),
            path: null,
          })),
        }
      }

      const result = await executeTool(tools, 'video_tool', { command: 'sample /tmp/demo.mp4 --max 12' })
      const text = result.content[0].text

      expect(receivedMax).toBe(12)
      expect(text).toContain('Sampled 12 frames')
      expect(text).toContain('than the ceiling holds')
    })

    it('writes nothing without --out, and says how to get files instead', async () => {
      const result = await executeTool(tools, 'video_tool', { command: 'sample /tmp/demo.mp4' })
      const text = result.content[0].text

      expect(text).toContain('no files written')
      expect(text).toContain('Nothing was written to disk')
      expect(text).toContain('--out <dir>')
      expect(text).toContain('keep them as files')
    })

    it('hands every frame back as an image, whether or not it was written', async () => {
      const result = await executeTool(tools, 'video_tool', { command: 'sample /tmp/demo.mp4' })
      const images = result.content.filter((block: any) => block.type === 'image')

      expect(images.length).toBe(3)
      expect(images[0].mimeType).toBe('image/jpeg')
      expect(images[0].data).toBe(Buffer.from(new Uint8Array([1])).toString('base64'))
    })

    it('passes a decode failure through unchanged', async () => {
      const message =
        'Could not read the recording: this browser cannot decode the recording (media error 4). ' +
        'Chromium reads mp4 (H.264), webm and most mov files. HEVC reads only where the machine ' +
        'has a hardware decoder for it, and ProRes does not read at all — a file that will not open ' +
        'has to be converted first.'
      mockFns.sampleVideo = async () => { throw new Error(message) }

      const result = await executeTool(tools, 'video_tool', { command: 'sample /tmp/demo.mov' })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain(message)
    })

    it('refuses a browser command, and names the tool that takes it', async () => {
      const result = await executeTool(tools, 'video_tool', { command: 'navigate example.com' })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Unknown video_tool command "navigate"')
      expect(result.content[0].text).toContain('browser_tool')
    })

    // A relative path counts from the workspace root, the same rule every pane command follows.
    it('counts a relative path from the workspace root', async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-video-ws-'))
      tempDirs.push(workspaceRoot)
      let received: { path?: string; out?: string } = {}
      mockFns.sampleVideo = async (args) => {
        received = args
        return { durationMs: 1000, truncated: false, frames: [] }
      }

      const scoped = createVideoTools({
        sessionId: 'test-session',
        workspaceRootPath: workspaceRoot,
        getBrowserPaneFns: () => mockFns,
      })
      await executeTool(scoped, 'video_tool', { command: 'sample clips/demo.mp4 --out frames/here' })

      expect(received.path).toBe(resolve(workspaceRoot, 'clips/demo.mp4'))
      expect(received.out).toBe(resolve(workspaceRoot, 'frames/here'))
    })
  })


  describe('browser_tool', () => {
    it('documents every browser command the runtime implements', async () => {
      const browserCommands = await runtimeCommands('browser-commands')
      expect(browserCommands.length).toBeGreaterThan(20)

      const help = (await executeTool(tools, 'browser_tool', { command: '--help' })).content[0].text
      expect(browserCommands.filter((cmd) => !help.includes(cmd))).toEqual([])
    })

    // A command of another tool's is refused with a pointer to the help and nothing else: the doors
    // are told apart by which tool was called, not by this message doing the routing.
    it('refuses a command that is not ours, and points at the help', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'list' })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Unknown browser_tool command "list"')
      expect(result.content[0].text).toContain('--help')
      expect(result.content[0].text).not.toContain('prototype')
    })

    it('returns help text for --help without release hint', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: '--help' })
      expect(result.content[0].text).toContain('browser_tool command help')
      expect(result.content[0].text).toContain('navigate <url>')
      expect(result.content[0].text).toContain('find <query>')
      expect(result.content[0].text).toContain('click-at <x> <y>')
      expect(result.content[0].text).toContain('type <text>')
      expect(result.content[0].text).toContain('upload <ref> <path> [path2...]')
      expect(result.content[0].text).toContain('set-clipboard <text>')
      expect(result.content[0].text).toContain('get-clipboard')
      expect(result.content[0].text).toContain('paste <text>')
      expect(result.content[0].text).toContain('screenshot [--annotated|-a]')
      expect(result.content[0].text).toContain('focus [windowId]')
      expect(result.content[0].text).toContain('tab-show <id>')
      expect(result.content[0].text).toContain('Array mode (JSON array input, no batch splitting/tokenization):')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('routes navigate command and appends release hint', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'navigate example.com' })
      expect(result.content[0].text).toContain('Navigated to')
      expect(result.content[0].text).toContain('When you are done using the browser')
    })

    it('releases control when navigate lands on a security challenge', async () => {
      let releaseCalls = 0
      mockFns.detectChallenge = async () => ({
        detected: true,
        provider: 'cloudflare',
        signals: ['title:just-a-moment'],
      })
      mockFns.releaseControl = async (_instanceId?: string) => {
        releaseCalls += 1
        return { action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'navigate example.com' })
      expect(releaseCalls).toBe(1)
      expect(result.content[0].text).toContain('Security verification detected (cloudflare).')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('routes open command in background by default', async () => {
      let openOptions: { background?: boolean } | undefined
      mockFns.openPanel = async (options) => {
        openOptions = options
        return { instanceId: 'browser-test-1' }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'open' })
      expect(openOptions).toEqual({ background: true })
      expect(result.content[0].text).toContain('Opened in-app browser window in background')
      expect(result.content[0].text).toContain('browser-test-1')
    })

    it('routes open command with --foreground flag and reports settled visibility', async () => {
      let openOptions: { background?: boolean } | undefined
      let listCalls = 0
      mockFns.openPanel = async (options) => {
        openOptions = options
        return { instanceId: 'browser-test-1' }
      }
      mockFns.listWindows = async () => {
        listCalls += 1
        const isVisible = listCalls >= 3
        return [{
          id: 'browser-test-1',
          title: 'Example Domain',
          url: 'https://example.com',
          isVisible,
          agentControlActive: true,
        }]
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'open --foreground' })
      expect(openOptions).toEqual({ background: false })
      expect(result.content[0].text).toContain('Opened in-app browser window in foreground')
      expect(result.content[0].text).toContain('Visibility settle: wait-loop')
      expect(result.content[0].text).toContain('Visible: true')
    })

    it('uses focus fallback when foreground open visibility does not settle in wait loop', async () => {
      const previousTimeout = process.env.CRAFT_BROWSER_OPEN_SETTLE_TIMEOUT_MS
      const previousPoll = process.env.CRAFT_BROWSER_OPEN_SETTLE_POLL_MS
      process.env.CRAFT_BROWSER_OPEN_SETTLE_TIMEOUT_MS = '120'
      process.env.CRAFT_BROWSER_OPEN_SETTLE_POLL_MS = '20'

      try {
        let focusCalls = 0
        let listCalls = 0
        mockFns.listWindows = async () => {
          listCalls += 1
          const isVisible = focusCalls > 0
          return [{
            id: 'browser-test-1',
            title: 'Example Domain',
            url: 'https://example.com',
            isVisible,
            agentControlActive: true,
          }]
        }
        mockFns.focusWindow = async (instanceId?: string) => {
          focusCalls += 1
          return {
            instanceId: instanceId ?? 'browser-test-1',
            title: 'Example Domain',
            url: 'https://example.com',
          }
        }

        const result = await executeTool(tools, 'browser_tool', { command: 'open --foreground' })
        expect(listCalls).toBeGreaterThan(2)
        expect(focusCalls).toBe(1)
        expect(result.content[0].text).toContain('Visibility settle: timeout + focus retry')
        expect(result.content[0].text).toContain('Visible: true')
      } finally {
        if (previousTimeout === undefined) delete process.env.CRAFT_BROWSER_OPEN_SETTLE_TIMEOUT_MS
        else process.env.CRAFT_BROWSER_OPEN_SETTLE_TIMEOUT_MS = previousTimeout

        if (previousPoll === undefined) delete process.env.CRAFT_BROWSER_OPEN_SETTLE_POLL_MS
        else process.env.CRAFT_BROWSER_OPEN_SETTLE_POLL_MS = previousPoll
      }
    })

    it('does not use focus fallback for background open', async () => {
      let focusCalls = 0
      mockFns.focusWindow = async (instanceId?: string) => {
        focusCalls += 1
        return {
          instanceId: instanceId ?? 'browser-test-1',
          title: 'Example Domain',
          url: 'https://example.com',
        }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'open' })
      expect(focusCalls).toBe(0)
      expect(result.content[0].text).not.toContain('Visibility settle:')
    })

    it('routes snapshot command and formats nodes', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'snapshot' })
      const text = result.content[0].text
      expect(text).toContain('@e1')
      expect(text).toContain('[button]')
      expect(text).toContain('"Click me"')
      expect(text).toContain('(focused)')
      // The snapshot text is about the page: the tab's document is the whole answer, and
      // nothing here claims to know which project or conversation the tab belongs to.
      expect(text).not.toContain('Prototype:')
    })

    it('treats near-zero actionable snapshot as challenge state and attaches screenshot', async () => {
      let releaseCalls = 0
      mockFns.snapshot = async () => ({
        url: 'https://protected.example.com',
        title: 'Protected',
        nodes: [
          { ref: '@e1', role: 'staticText', name: 'Checking your browser before accessing' },
        ],
      })
      mockFns.detectChallenge = async () => ({
        detected: true,
        provider: 'cloudflare',
        signals: ['text:checking-browser'],
      })
      mockFns.releaseControl = async (_instanceId?: string) => {
        releaseCalls += 1
        return { action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'snapshot' })
      expect(releaseCalls).toBe(1)
      expect(result.content[0].text).toContain('Security verification detected (cloudflare).')
      expect(result.content[0].text).toContain('Detected only 0 actionable element(s) out of 1 accessibility nodes.')
      expect(result.content[1].type).toBe('image')
      expect((result.content[1] as any).mimeType).toBe('image/jpeg')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('still reports challenge when screenshot capture fails or is empty', async () => {
      mockFns.snapshot = async () => ({
        url: 'https://protected.example.com',
        title: 'Protected',
        nodes: [],
      })
      mockFns.detectChallenge = async () => ({
        detected: true,
        provider: 'cloudflare',
        signals: ['title:just-a-moment'],
      })
      mockFns.screenshot = async () => ({ imageBuffer: Buffer.alloc(0), imageFormat: 'png' as const })

      const result = await executeTool(tools, 'browser_tool', { command: 'snapshot' })
      expect(result.content[0].text).toContain('Security verification detected (cloudflare).')
      expect(result.content[0].text).toContain('Detected only 0 actionable element(s) out of 0 accessibility nodes.')
      expect(result.content.some((item: any) => item.type === 'image')).toBe(false)
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('routes find command and returns matching refs', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'find click button' })
      const text = result.content[0].text
      expect(text).toContain('Found 1 element(s)')
      expect(text).toContain('@e1')
      expect(text).toContain('[button]')
    })

    it('returns helpful message for find command with no matches', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'find this-does-not-exist' })
      expect(result.content[0].text).toContain('No elements found matching')
    })

    it('routes click command', async () => {
      let clickedRef = ''
      mockFns.click = async (ref) => { clickedRef = ref }
      const result = await executeTool(tools, 'browser_tool', { command: 'click @e1' })
      expect(clickedRef).toBe('@e1')
      expect(result.content[0].text).toContain('Clicked element @e1')
    })

    it('routes click with wait arguments', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'click @e1 network-idle 5000' })
      expect(result.content[0].text).toContain('waitFor=network-idle')
    })

    it('detects security challenge after click even when URL does not change', async () => {
      let releaseCalls = 0
      mockFns.detectChallenge = async () => ({
        detected: true,
        provider: 'cloudflare',
        signals: ['dom:challenge-form'],
      })
      mockFns.releaseControl = async (_instanceId?: string) => {
        releaseCalls += 1
        return { action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'click @e1' })
      expect(releaseCalls).toBe(1)
      expect(result.content[0].text).toContain('security challenge detected (cloudflare)')
      expect(result.content[0].text).toContain('URL changed: false')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('routes click-at command with coordinates', async () => {
      let clickedX = 0
      let clickedY = 0
      mockFns.clickAt = async (x, y) => { clickedX = x; clickedY = y }
      const result = await executeTool(tools, 'browser_tool', { command: 'click-at 350 200' })
      expect(clickedX).toBe(350)
      expect(clickedY).toBe(200)
      expect(result.content[0].text).toContain('Clicked at coordinates (350, 200)')
    })

    it('returns error for click-at with missing coordinates', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'click-at 350' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('click-at requires x and y coordinates')
    })

    it('returns error for click-at with non-numeric coordinates', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'click-at foo bar' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('click-at coordinates must be numbers')
    })

    it('routes drag command with coordinates', async () => {
      let draggedCoords = { x1: 0, y1: 0, x2: 0, y2: 0 }
      mockFns.drag = async (x1, y1, x2, y2) => { draggedCoords = { x1, y1, x2, y2 } }
      const result = await executeTool(tools, 'browser_tool', { command: 'drag 100 200 300 400' })
      expect(draggedCoords).toEqual({ x1: 100, y1: 200, x2: 300, y2: 400 })
      expect(result.content[0].text).toContain('Dragged from (100, 200) to (300, 400)')
    })

    it('returns error for drag with missing coordinates', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'drag 100 200' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('drag requires 4 coordinates')
    })

    it('returns error for drag with non-numeric coordinates', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'drag foo bar baz qux' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('drag coordinates must be numbers')
    })

    it('routes fill command', async () => {
      let filledRef = ''
      let filledValue = ''
      mockFns.fill = async (ref, value) => { filledRef = ref; filledValue = value }
      const result = await executeTool(tools, 'browser_tool', { command: 'fill @e2 hello world' })
      expect(filledRef).toBe('@e2')
      expect(filledValue).toBe('hello world')
      expect(result.content[0].text).toContain('Filled element @e2')
    })

    it('supports semicolon command batching', async () => {
      const calls: string[] = []
      mockFns.fill = async (ref, value) => { calls.push(`fill:${ref}:${value}`) }
      mockFns.click = async (ref) => { calls.push(`click:${ref}`) }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'fill @e1 user@example.com; fill @e2 password123; click @e3',
      })

      expect(calls).toEqual([
        'fill:@e1:user@example.com',
        'fill:@e2:password123',
        'click:@e3',
      ])
      expect(result.content[0].text).toContain('Filled element @e1')
      expect(result.content[0].text).toContain('Clicked element @e3')
    })

    it('does not split batch on semicolons inside quoted text', async () => {
      const calls: string[] = []
      mockFns.fill = async (ref, value) => { calls.push(`fill:${ref}:${value}`) }
      mockFns.click = async (ref) => { calls.push(`click:${ref}`) }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'fill @e1 "a;b;c"; click @e2',
      })

      expect(calls).toEqual([
        'fill:@e1:a;b;c',
        'click:@e2',
      ])
      expect(result.content[0].text).toContain('Filled element @e1 with "a;b;c"')
      expect(result.content[0].text).toContain('Clicked element @e2')
    })

    it('stops batched commands after navigation-changing command', async () => {
      const calls: string[] = []
      mockFns.navigate = async (url) => {
        calls.push(`navigate:${url}`)
        return { url, title: 'Page' }
      }
      mockFns.fill = async (ref, value) => { calls.push(`fill:${ref}:${value}`) }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'fill @e1 start; navigate https://example.com; fill @e2 should-not-run',
      })

      expect(calls).toEqual([
        'fill:@e1:start',
        'navigate:https://example.com',
      ])
      expect(result.content[0].text).toContain('stopped batch after "navigate"')
    })

    it('routes type command', async () => {
      let typedText = ''
      mockFns.type = async (text) => { typedText = text }
      const result = await executeTool(tools, 'browser_tool', { command: 'type Hello World' })
      expect(typedText).toBe('Hello World')
      expect(result.content[0].text).toContain('Typed 11 characters into focused element')
    })

    /**
     * `reload` is the other half of "that patch is already inlined here" — a page of ours is
     * rendered from disk, so a changed patch shows up on a reload and there was no command
     * for one. What it must not do is pretend the load finished: the browser's own reload is
     * fire-and-forget, so the answer is where it is reloading and how to wait, not a page
     * that may still be the old one.
     */
    it('routes reload, and says the load is not waited for', async () => {
      let reloaded = 0
      mockFns.reload = async () => { reloaded += 1 }
      mockFns.evaluate = async () => ({ url: 'https://example.com/cart', title: 'Cart' })

      const result = await executeTool(tools, 'browser_tool', { command: 'reload' })

      expect(reloaded).toBe(1)
      expect(result.content[0].text).toContain('Reloading this page')
      expect(result.content[0].text).toContain('https://example.com/cart')
      expect(result.content[0].text).toContain('wait network-idle')
      expect(result.content[0].text).toContain('re-"snapshot"')
    })

    // A reload rebuilds the document, so every ref gathered before it is stale — the same
    // reason a batch stops after `navigate`.
    it('stops a batch after reload', async () => {
      const calls: string[] = []
      mockFns.reload = async () => { calls.push('reload') }
      mockFns.click = async (ref) => { calls.push(`click:${ref}`) }

      const result = await executeTool(tools, 'browser_tool', { command: 'reload; click @e1' })

      expect(calls).toEqual(['reload'])
      expect(result.content[0].text).toContain('stopped batch after "reload"')
    })

    it('returns error for type with no text', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'type' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('type requires text')
    })

    it('routes select command', async () => {
      let selectedRef = ''
      let selectedValue = ''
      mockFns.select = async (ref, value) => { selectedRef = ref; selectedValue = value }
      mockFns.snapshot = async () => ({
        url: 'https://example.com',
        title: 'Example',
        nodes: [
          { ref: '@e3', role: 'combobox', name: 'Type', value: 'optionValue' },
        ],
      })

      const result = await executeTool(tools, 'browser_tool', { command: 'select @e3 optionValue' })
      expect(selectedRef).toBe('@e3')
      expect(selectedValue).toBe('optionValue')
      expect(result.content[0].text).toContain('(verified)')
    })

    it('parses select assertion flags and timeout', async () => {
      let selectedRef = ''
      let selectedValue = ''
      mockFns.select = async (ref, value) => { selectedRef = ref; selectedValue = value }
      mockFns.snapshot = async () => ({
        url: 'https://example.com',
        title: 'Example',
        nodes: [
          { ref: '@e75', role: 'combobox', name: 'Type', value: 'CNAME' },
          { ref: '@e80', role: 'textbox', name: 'Target', value: 'beautiful-mermaid.com' },
        ],
      })

      const result = await executeTool(tools, 'browser_tool', {
        command: 'select @e75 CNAME --assert-text Target --assert-value CNAME --timeout 3000',
      })

      expect(selectedRef).toBe('@e75')
      expect(selectedValue).toBe('CNAME')
      expect(result.content[0].text).toContain('assertTextMatched=true')
      expect(result.content[0].text).toContain('assertValueMatched=true')
      expect(result.content[0].text).toContain('timeout=3000ms')
      expect(result.content[0].text).toContain('(verified)')
    })

    it('accepts assert-value from downstream node when selected control metadata lags', async () => {
      let snapshotCount = 0
      mockFns.snapshot = async () => {
        snapshotCount += 1
        if (snapshotCount === 1) {
          return {
            url: 'https://example.com',
            title: 'Example',
            nodes: [
              { ref: '@e75', role: 'combobox', name: 'Sort updated-newest', value: 'Sort' },
              { ref: '@e80', role: 'status', name: 'Current sort', value: 'updated-newest' },
            ],
          }
        }

        return {
          url: 'https://example.com',
          title: 'Example',
          nodes: [
            { ref: '@e75', role: 'combobox', name: 'Sort updated-newest', value: 'Sort' },
            { ref: '@e81', role: 'status', name: 'Current sort', value: 'updated-newest' },
          ],
        }
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'select @e75 updated-newest --assert-value updated-newest --timeout 500',
      })

      expect(result.content[0].text).toContain('(verified)')
      expect(result.content[0].text).toContain('assertValueMatched=true')
      expect(result.content[0].text).not.toContain('assert-value did not match')
    })

    it('returns warning when select cannot be verified', async () => {
      mockFns.snapshot = async () => ({
        url: 'https://example.com',
        title: 'Example',
        nodes: [
          { ref: '@e75', role: 'combobox', name: 'Type', value: 'A' },
          { ref: '@e80', role: 'textbox', name: 'IPv4 address (required)', value: '' },
        ],
      })

      const result = await executeTool(tools, 'browser_tool', {
        command: 'select @e75 CNAME --assert-text Target --timeout 500',
      })

      expect(result.content[0].text).toContain('(warning)')
      expect(result.content[0].text).toContain('Warning: select interaction succeeded but effective form state could not be fully verified')
      expect(result.content[0].text).toContain('assert-text did not match: "Target"')
    })

    it('returns error when select assertion flag is missing value', async () => {
      const result = await executeTool(tools, 'browser_tool', {
        command: 'select @e75 CNAME --assert-text',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('select --assert-text requires a value')
    })

    it('routes upload command with one or more file paths', async () => {
      let uploadedRef = ''
      let uploadedPaths: string[] = []
      mockFns.upload = async (ref, filePaths) => { uploadedRef = ref; uploadedPaths = filePaths }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'upload @e3 /tmp/a.pdf /tmp/b.jpg',
      })

      expect(uploadedRef).toBe('@e3')
      expect(uploadedPaths).toEqual(['/tmp/a.pdf', '/tmp/b.jpg'])
      expect(result.content[0].text).toContain('Uploaded 2 files:')
      expect(result.content[0].text).toContain('/tmp/a.pdf')
      expect(result.content[0].text).toContain('/tmp/b.jpg')
    })

    it('returns error for upload with missing arguments', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'upload @e3' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('upload requires ref and file path(s)')
    })

    it('routes set-clipboard command', async () => {
      let clipboardText = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      const result = await executeTool(tools, 'browser_tool', { command: 'set-clipboard Hello World' })
      expect(clipboardText).toBe('Hello World')
      expect(result.content[0].text).toContain('Clipboard set (11 characters)')
    })

    it('decodes escaped tab/newline sequences for set-clipboard', async () => {
      let clipboardText = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      const result = await executeTool(tools, 'browser_tool', {
        command: 'set-clipboard Hello\\tWorld\\nFoo\\tBar',
      })
      expect(clipboardText).toBe('Hello\tWorld\nFoo\tBar')
      expect(result.content[0].text).toContain('Clipboard set (19 characters)')
    })

    it('preserves unknown escapes for set-clipboard', async () => {
      let clipboardText = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      await executeTool(tools, 'browser_tool', {
        command: 'set-clipboard keep\\xliteral',
      })
      expect(clipboardText).toBe('keep\\xliteral')
    })

    it('returns error for set-clipboard with no text', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'set-clipboard' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('set-clipboard requires text')
    })

    it('routes get-clipboard command', async () => {
      mockFns.getClipboard = async () => 'some clipboard data'
      const result = await executeTool(tools, 'browser_tool', { command: 'get-clipboard' })
      expect(result.content[0].text).toContain('Clipboard content (19 chars, 1 lines, 0 tabs):')
      expect(result.content[0].text).toContain('some clipboard data')
      expect(result.content[0].text).toContain('When you are done using the browser')
    })

    it('routes get-clipboard returns empty placeholder for empty clipboard', async () => {
      mockFns.getClipboard = async () => ''
      const result = await executeTool(tools, 'browser_tool', { command: 'get-clipboard' })
      expect(result.content[0].text).toContain('(empty clipboard)')
    })

    it('routes paste command (set-clipboard + key)', async () => {
      let clipboardText = ''
      let keySent = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      mockFns.sendKey = async (args) => { keySent = args.key }
      const result = await executeTool(tools, 'browser_tool', { command: 'paste Hello World' })
      expect(clipboardText).toBe('Hello World')
      expect(keySent).toBe('v')
      expect(result.content[0].text).toContain('Pasted 11 characters')
    })

    it('decodes escaped tab/newline sequences for paste', async () => {
      let clipboardText = ''
      let keySent = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      mockFns.sendKey = async (args) => { keySent = args.key }
      const result = await executeTool(tools, 'browser_tool', {
        command: 'paste Hello\\tWorld\\nFoo\\tBar',
      })
      expect(clipboardText).toBe('Hello\tWorld\nFoo\tBar')
      expect(keySent).toBe('v')
      expect(result.content[0].text).toContain('Pasted 19 characters')
    })

    it('returns error for paste with no text', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'paste' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('paste requires text')
    })

    it('routes screenshot command and returns image block', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot' })
      expect(result.content[0].text).toContain('Screenshot captured')
      expect(result.content[1].type).toBe('image')
      expect((result.content[1] as any).mimeType).toBe('image/png')
    })

    it('routes annotated screenshot and passes annotate flag', async () => {
      let screenshotArgs: any
      mockFns.screenshot = async (args) => {
        screenshotArgs = args
        return { imageBuffer: Buffer.from('fake-png-data'), imageFormat: 'png' as const }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot --annotated' })
      expect(screenshotArgs).toMatchObject({ annotate: true, format: 'jpeg' })
      expect(result.content[0].text).toContain('Annotated screenshot captured')
      expect(result.content[1].type).toBe('image')
    })

    it('routes screenshot-region command and returns image block', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot-region 10 20 100 80' })
      expect(result.content[0].text).toContain('Region screenshot captured')
      expect(result.content[1].type).toBe('image')
      expect((result.content[1] as any).mimeType).toBe('image/png')
    })

    it('returns error for screenshot when PNG is empty', async () => {
      mockFns.screenshot = async () => ({ imageBuffer: Buffer.alloc(0), imageFormat: 'png' as const })
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('empty image data')
    })

    it('returns error for screenshot-region when PNG is empty', async () => {
      mockFns.screenshotRegion = async () => ({ imageBuffer: Buffer.alloc(0), imageFormat: 'png' as const })
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot-region 10 20 100 80' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('empty image data')
    })

    it('returns parse error for screenshot-region missing padding value', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot-region --ref @e12 --padding' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Missing value for --padding')
    })

    it('returns parse error for screenshot-region non-numeric coords', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot-region 10 nope 100 80' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('coordinates must be numbers')
    })

    it('treats --padding-like text inside quoted selectors as selector content', async () => {
      let screenshotRegionArgs: any
      mockFns.screenshotRegion = async (args) => {
        screenshotRegionArgs = args
        return { imageBuffer: Buffer.from('fake-png-data'), imageFormat: 'png' as const }
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'screenshot-region --selector "div[data-tip=\'--padding 99\';data-x=\'a;b\']" --padding 8',
      })

      expect(result.isError).toBeUndefined()
      expect(screenshotRegionArgs).toMatchObject({
        selector: "div[data-tip='--padding 99';data-x='a;b']",
        padding: 8,
        format: 'jpeg',
      })
      expect(result.content[0].text).toContain('Region screenshot captured')
    })

    it('passes --force through and defaults it off', async () => {
      let args: any
      mockFns.screenshotRegion = async (a) => {
        args = a
        return { imageBuffer: Buffer.from('fake'), imageFormat: 'png' as const }
      }

      await executeTool(tools, 'browser_tool', { command: 'screenshot-region --selector .artboard' })
      expect(args).toMatchObject({ selector: '.artboard', force: false })

      await executeTool(tools, 'browser_tool', { command: 'screenshot-region --selector .artboard --force' })
      expect(args).toMatchObject({ selector: '.artboard', force: true })

      await executeTool(tools, 'browser_tool', { command: 'screenshot-region --ref @e9 --force --png' })
      expect(args).toMatchObject({ ref: '@e9', force: true, format: 'png' })
    })

    it('routes console command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'console 10 warn' })
      expect(result.content[0].text).toContain('Console entries')
    })

    it('routes viewport-resize command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'viewport-resize 1024 768' })
      expect(result.content[0].text).toContain("Your tab's viewport is now 1024x768")
    })

    it('routes network command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'network 10 failed' })
      expect(result.content[0].text).toContain('Network entries')
    })

    it('routes wait command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'wait network-idle 5000' })
      expect(result.content[0].text).toContain('Wait succeeded')
    })

    it('parses quoted wait text values with spaces', async () => {
      let waitArgs: any
      mockFns.waitFor = async (args) => {
        waitArgs = args
        return { ok: true as const, kind: args.kind, elapsedMs: 42, detail: 'condition met' }
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'wait text "hello world" 5000',
      })

      expect(waitArgs).toEqual({ kind: 'text', value: 'hello world', timeoutMs: 5000 })
      expect(result.content[0].text).toContain('Wait succeeded')
    })

    it('routes key command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'key Enter' })
      expect(result.content[0].text).toContain('Key sent: Enter')
    })

    it('routes downloads command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'downloads list 10' })
      expect(result.content[0].text).toContain('Downloads (')
    })

    it('includes savePath in downloads output when available', async () => {
      mockFns.getDownloads = async () => ([
        {
          id: 'dl-42',
          timestamp: Date.now(),
          url: 'https://example.com/file.pdf',
          filename: 'file.pdf',
          state: 'completed',
          bytesReceived: 100,
          totalBytes: 100,
          mimeType: 'application/pdf',
          savePath: '/tmp/downloads/file.pdf',
        },
      ])

      const result = await executeTool(tools, 'browser_tool', { command: 'downloads list 10' })
      expect(result.content[0].text).toContain('-> /tmp/downloads/file.pdf')
    })

    it('routes scroll command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'scroll down 800' })
      expect(result.content[0].text).toContain('Scrolled down')
    })

    it('routes back command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'back' })
      expect(result.content[0].text).toContain('Navigated back')
    })

    it('routes forward command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'forward' })
      expect(result.content[0].text).toContain('Navigated forward')
    })

    it('routes evaluate command', async () => {
      mockFns.evaluate = async () => ({ key: 'value' })
      const result = await executeTool(tools, 'browser_tool', { command: 'evaluate 1+1' })
      expect(result.content[0].text).toContain('"key"')
    })

    it('preserves quoted evaluate expressions with semicolons', async () => {
      let evaluatedExpression = ''
      mockFns.evaluate = async (expression) => {
        evaluatedExpression = expression
        return 'ok'
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'evaluate "document.title + \';\' + location.href"',
      })

      expect(evaluatedExpression).toBe("document.title + ';' + location.href")
      expect(result.content[0].text).toContain('ok')
    })

    /**
     * `evaluate --file` exists so a script the agent already wrote (a probe, usually) can be
     * injected without being spelled out again inside the command. What it runs has to be
     * the file's bytes as they are — a re-encoded copy is the thing the flag is for avoiding.
     */
    describe('evaluate --file', () => {
      let workspaceRoot: string
      let fileTools: ReturnType<typeof createBrowserTools>

      beforeEach(() => {
        workspaceRoot = mkdtempSync(join(tmpdir(), 'browser-evaluate-'))
        fileTools = createBrowserTools({
          sessionId: 'test-session',
          getBrowserPaneFns: () => mockFns,
          workspaceRootPath: workspaceRoot,
        })
      })

      afterEach(() => {
        rmSync(workspaceRoot, { recursive: true, force: true })
      })

      function writeScript(relativePath: string, source: string): string {
        const absolute = join(workspaceRoot, relativePath)
        mkdirSync(dirname(absolute), { recursive: true })
        writeFileSync(absolute, source)
        return absolute
      }

      it('runs a script named by a workspace-relative path, and says which file it ran', async () => {
        const absolute = writeScript('scripts/cart-total.js', 'document.title + "!"\n')

        let evaluatedExpression = ''
        mockFns.evaluate = async (expression) => {
          evaluatedExpression = expression
          return 'Cart'
        }

        const result = await executeTool(fileTools, 'browser_tool', {
          command: 'evaluate --file scripts/cart-total.js',
        })

        expect(evaluatedExpression).toBe('document.title + "!"\n')
        expect(result.isError).toBeUndefined()
        expect(result.content[0].text).toContain(absolute)
        expect(result.content[0].text).toContain('Cart')
      })

      it('accepts an absolute path in array mode, and still honours --tab', async () => {
        const absolute = writeScript('probe.js', 'window.__probe')

        let evaluatedExpression = ''
        mockFns.evaluate = async (expression) => {
          evaluatedExpression = expression
          return 1
        }

        const result = await executeTool(fileTools, 'browser_tool', {
          command: ['evaluate', '--file', absolute, '--tab', 'tab-2'],
        })

        expect(evaluatedExpression).toBe('window.__probe')
        expect(result.isError).toBeUndefined()
      })

      it('drops a byte-order mark rather than letting it break the first statement', async () => {
        writeScript('bom.js', '\uFEFFdocument.title')

        let evaluatedExpression = ''
        mockFns.evaluate = async (expression) => {
          evaluatedExpression = expression
          return 'Cart'
        }

        await executeTool(fileTools, 'browser_tool', { command: 'evaluate --file bom.js' })
        expect(evaluatedExpression).toBe('document.title')
      })

      it('refuses an expression and --file together instead of ignoring one of them', async () => {
        writeScript('mix.js', 'document.title')

        const result = await executeTool(fileTools, 'browser_tool', {
          command: 'evaluate document.title --file mix.js',
        })

        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('not both')
      })

      it('names a file that is not there', async () => {
        const result = await executeTool(fileTools, 'browser_tool', {
          command: 'evaluate --file scripts/missing.js',
        })

        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('no such file')
        expect(result.content[0].text).toContain('missing.js')
      })

      it('refuses --file with no path', async () => {
        const result = await executeTool(fileTools, 'browser_tool', { command: 'evaluate --file' })

        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('--file needs a path')
      })

      it('refuses a relative path when no workspace root is known', async () => {
        const result = await executeTool(tools, 'browser_tool', { command: 'evaluate --file probe.js' })

        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('not absolute')
      })
    })

    it('routes pick command and reports the picked element', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'pick' })
      expect(result.content[0].text).toContain('Picked element:')
      expect(result.content[0].text).toContain('[data-testid="pay"]')
      expect(result.content[0].text).toContain('Pay now')
    })

    it('forwards pick --timeout and reports a cancelled pick', async () => {
      let receivedOptions: { timeoutMs?: number } | undefined
      mockFns.pick = async (options) => {
        receivedOptions = options
        return null
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'pick --timeout 5000' })
      expect(receivedOptions?.timeoutMs).toBe(5000)
      expect(result.content[0].text).toContain('no element was selected')
    })


    // A window is one and its tabs are many, so a tab is the unit of work and a
    // command can name one. The list is what makes naming possible.
    it('lists this window\'s tabs with the one on screen marked', async () => {
      mockFns.listTabs = async () => ([
        tabRow({
          id: 'tab-1',
          url: 'https://app.example.com/checkout',
          title: 'Checkout',
          active: true,
          belongsTo: { kind: 'session', sessionId: 'session-a' },
          drivenBy: 'session-b',
        }),
        tabRow({ id: 'tab-2', url: 'https://docs.example.com', title: 'Docs', isLoading: true }),
      ])

      const text = (await executeTool(tools, 'browser_tool', { command: 'tabs' })).content[0].text

      expect(text).toContain('has 2 tabs')
      expect(text).toContain('* tab-1  Checkout')
      // Whose tab it is, and who is on it: the first decides what may be closed,
      // the second is who is mid-work.
      expect(text).toContain('belongs to: agent (session-a)')
      expect(text).toContain('driven by:  session-b')
      expect(text).toContain('tab-2  Docs')
      expect(text).toContain('url:        https://docs.example.com  (loading)')
      expect(text).toContain('belongs to: a person')
      expect(text).toContain('driven by:  nobody right now')
      // The two halves are named, because a reader that takes a declaration for a
      // measurement is the failure this split exists to prevent.
      expect(text).toContain('"belongs to" and "driven by" are')
    })

    // A page that is held right now says so — and says it about *that page*, since with a
    // shared window the neighbouring pages are free even while one of them is locked.
    it('says which page is locked, and whose work is holding it', async () => {
      mockFns.listTabs = async () => ([
        tabRow({
          id: 'tab-1',
          url: 'https://app.example.com/checkout',
          title: 'Checkout',
          active: true,
          belongsTo: { kind: 'session', sessionId: 'session-a' },
          drivenBy: 'session-b',
          lockedBy: 'session-b',
        }),
        tabRow({ id: 'tab-2', url: 'https://docs.example.com', title: 'Docs' }),
      ])

      const text = (await executeTool(tools, 'browser_tool', { command: 'tabs' })).content[0].text

      expect(text).toContain('locked:     session-b is working on it, so it is held until that turn ends')
      // The page nobody is holding says nothing about being held.
      expect(text.match(/locked: {5}/g)).toHaveLength(1)
      expect(text).toContain('"locked" is the lease')
    })

    // Where an unnamed command lands is stated, because it is *not* "the tab on screen":
    // the person clicking around moves their own view, and this must not move with it.
    // Only the reader's own tab is marked — another conversation's is
    // not this reader's business.
    it('marks the page this conversation works from, and only its own', async () => {
      mockFns.listTabs = async () => ([
        tabRow({ id: 'tab-1', url: 'https://app.example.com/checkout', title: 'Checkout', active: true }),
        tabRow({ id: 'tab-2', url: 'https://docs.example.com', title: 'Docs', cursorOf: ['test-session'] }),
        tabRow({ id: 'tab-3', url: 'https://other.example.com', title: 'Other', cursorOf: ['session-b'] }),
      ])

      const text = (await executeTool(tools, 'browser_tool', { command: 'tabs' })).content[0].text

      expect(text).toContain('your tab:  yes — a command that names no tab acts here')
      expect(text.match(/your tab: {2}/g)).toHaveLength(1)
      // The tab on screen is not it, which is the whole point: `tab-1` stays unmarked even
      // though it is the one showing.
      expect(text).toContain('* tab-1  Checkout')
      expect(text).toContain('the person switching tabs does not move it')
    })

    it('says so when there is no window whose pages could be listed', async () => {
      mockFns.listTabs = async () => []

      const text = (await executeTool(tools, 'browser_tool', { command: 'tabs' })).content[0].text

      expect(text).toContain('No browser window is open')
    })

    // Naming a page targets it: the command runs against that page — and the window is not
    // moved, because the person may be reading another one of its pages.
    it('targets a named page, and keeps it out of the command itself', async () => {
      const targeted: string[] = []
      const activated: string[] = []
      mockFns.targetTab = async (tabId) => { targeted.push(tabId) }
      mockFns.activateTab = async (tabId) => { activated.push(tabId); return { movedView: true } }
      let evaluated = ''
      mockFns.evaluate = async (expression) => { evaluated = expression; return 'Checkout' }

      await executeTool(tools, 'browser_tool', { command: 'evaluate document.title --tab tab-2' })

      expect(targeted).toEqual(['tab-2'])
      expect(activated).toEqual([])
      expect(evaluated).toBe('document.title')
    })

    it('brings a page up for the person only when asked to', async () => {
      const activated: string[] = []
      mockFns.activateTab = async (tabId) => { activated.push(tabId); return { movedView: true } }

      const result = await executeTool(tools, 'browser_tool', { command: 'tab-show tab-2' })

      expect(activated).toEqual(['tab-2'])
      expect(result.content[0].text).toContain('tab-2')
    })

    it('refuses --tab without a tab id rather than acting on the tab on screen', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'snapshot --tab' })
      expect(result.content[0].text).toContain('--tab needs a tab id')
    })

    it('opens a page of its own with tab-new', async () => {
      const opened: Array<{ url?: string; activate?: boolean }> = []
      mockFns.createTab = async (options) => { opened.push(options ?? {}); return 'tab-3' }

      const result = await executeTool(tools, 'browser_tool', { command: 'tab-new https://docs.example.com' })

      // Behind whatever the person is reading: opening a page for the agent is not a reason to
      // take their page away, and "tab-show" is how one is brought up.
      expect(opened).toEqual([{ url: 'https://docs.example.com', activate: false }])
      expect(result.content[0].text).toContain('tab-3')
    })

    it('requires a tab id for tab-close', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'tab-close' })
      expect(result.content[0].text).toContain('tab-close needs a tab id')
    })

    it('closes a page and says whether the window went with it', async () => {
      const closed: string[] = []
      mockFns.closeTab = async (tabId) => { closed.push(tabId); return { remaining: 0 } }

      const result = await executeTool(tools, 'browser_tool', { command: 'tab-close tab-2' })

      expect(closed).toEqual(['tab-2'])
      expect(result.content[0].text).toContain('the window went with it')
    })

    it('routes focus command and calls focusWindow', async () => {
      let focusedId: string | undefined
      mockFns.focusWindow = async (instanceId?: string) => {
        focusedId = instanceId
        return { instanceId: instanceId ?? 'browser-1', title: 'Focused Tab', url: 'https://focused.example' }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'focus browser-1' })

      expect(focusedId).toBe('browser-1')
      expect(result.content[0].text).toContain('Focused browser window browser-1')
      expect(result.content[0].text).toContain('When you are done using the browser')
    })

    it('routes release command and calls releaseControl without hint', async () => {
      let requestedId: string | undefined
      mockFns.releaseControl = async (instanceId?: string) => {
        requestedId = instanceId
        return { action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'release' })

      expect(requestedId).toBeUndefined()
      expect(result.content[0].text).toContain('Browser control released')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('routes close command and calls closeWindow without hint', async () => {
      let requestedId: string | undefined
      mockFns.closeWindow = async (instanceId?: string) => {
        requestedId = instanceId
        return { action: 'closed' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'close' })

      expect(requestedId).toBeUndefined()
      expect(result.content[0].text).toContain('Browser window closed and destroyed')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('routes hide command and calls hideWindow without hint', async () => {
      let requestedId: string | undefined
      mockFns.hideWindow = async (instanceId?: string) => {
        requestedId = instanceId
        return { action: 'hidden' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'hide' })

      expect(requestedId).toBeUndefined()
      expect(result.content[0].text).toContain('Browser window hidden')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('routes close command with explicit window id', async () => {
      let requestedId: string | undefined
      mockFns.closeWindow = async (instanceId?: string) => {
        requestedId = instanceId
        return { action: 'closed' as const, requestedInstanceId: instanceId, resolvedInstanceId: instanceId, affectedIds: instanceId ? [instanceId] : [] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'close browser-9' })

      expect(requestedId).toBe('browser-9')
      expect(result.content[0].text).toContain('Browser window closed and destroyed')
      expect(result.content[0].text).toContain('requested=browser-9')
    })

    it('reports close no-op explicitly', async () => {
      mockFns.closeWindow = async (instanceId?: string) => ({
        action: 'noop' as const,
        requestedInstanceId: instanceId,
        affectedIds: [],
        reason: 'No close target is currently associated with this session.',
      })

      const result = await executeTool(tools, 'browser_tool', { command: 'close' })

      expect(result.content[0].text).toContain('No browser window was closed')
      expect(result.content[0].text).toContain('No window state changed')
      expect(result.content[0].text).toContain('No close target is currently associated with this session')
    })

    it('returns validation feedback for invalid command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'scroll diagonal' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('scroll requires direction')
    })

    it('returns parse error for unclosed quotes', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'fill @e1 "unterminated' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Parse error: unclosed quote')
    })

    it('returns error for unknown command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'teleport' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Unknown browser_tool command')
    })
  })

  describe('array command mode', () => {
    it('evaluate preserves semicolons without quoting', async () => {
      let evaluatedExpression = ''
      mockFns.evaluate = async (expression) => {
        evaluatedExpression = expression
        return 'ok'
      }
      const result = await executeTool(tools, 'browser_tool', {
        command: ['evaluate', 'var x = 1; var y = 2; x + y'],
      })
      expect(evaluatedExpression).toBe('var x = 1; var y = 2; x + y')
      expect(result.content[0].text).toContain('ok')
    })

    it('paste preserves tabs and newlines', async () => {
      let clipboardText = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      mockFns.sendKey = async () => {}
      const result = await executeTool(tools, 'browser_tool', {
        command: ['paste', 'Name\tAge\nAlice\t30'],
      })
      expect(clipboardText).toBe('Name\tAge\nAlice\t30')
      expect(result.content[0].text).toContain('Pasted')
    })

    it('set-clipboard preserves semicolons and special characters', async () => {
      let clipboardText = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      const result = await executeTool(tools, 'browser_tool', {
        command: ['set-clipboard', 'function foo() { return 1; }'],
      })
      expect(clipboardText).toBe('function foo() { return 1; }')
      expect(result.content[0].text).toContain('Clipboard set')
    })

    it('click works with array input', async () => {
      let clickedRef = ''
      mockFns.click = async (ref) => { clickedRef = ref }
      const result = await executeTool(tools, 'browser_tool', {
        command: ['click', '@e1'],
      })
      expect(clickedRef).toBe('@e1')
      expect(result.content[0].text).toContain('Clicked element @e1')
    })

    it('empty array returns error', async () => {
      const result = await executeTool(tools, 'browser_tool', {
        command: [],
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Missing command')
    })

    it('type preserves whitespace characters', async () => {
      let typedText = ''
      mockFns.type = async (text) => { typedText = text }
      const result = await executeTool(tools, 'browser_tool', {
        command: ['type', 'Hello\tWorld'],
      })
      expect(typedText).toBe('Hello\tWorld')
      expect(result.content[0].text).toContain('Typed')
    })

    it('--help works in array mode', async () => {
      const result = await executeTool(tools, 'browser_tool', {
        command: ['--help'],
      })
      expect(result.content[0].text).toContain('browser_tool command help')
    })
  })

  describe('error handling', () => {
    it('returns isError when getBrowserPaneFns returns undefined', async () => {
      const errorTools = createBrowserTools({
        sessionId: 'test',
        getBrowserPaneFns: () => undefined,
      })
      const result = await executeTool(errorTools, 'browser_tool', { command: 'navigate test.com' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Error')
    })

    it('catches and wraps thrown errors', async () => {
      mockFns.navigate = async () => { throw new Error('Network error') }
      const result = await executeTool(tools, 'browser_tool', { command: 'navigate test.com' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Network error')
    })
  })
})
