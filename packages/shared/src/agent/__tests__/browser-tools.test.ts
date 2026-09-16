/**
 * Tests for the browser tools factory.
 *
 * Verifies that createBrowserTools produces a single browser_tool
 * and that it delegates correctly to BrowserPaneFns callbacks via CLI commands.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { createBrowserTools, type BrowserPaneFns } from '../browser-tools'
import type { PrototypeStatus } from '../../prototypes/status'
import type { PrototypePage, PrototypePagesChange, PrototypePagesResult } from '../../prototypes/pages'
import type { PrototypeExportResult } from '../../prototypes/export'
import type { PageKind } from '../../prototypes/types'

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
    windowResize: async (args) => ({ width: args.width, height: args.height }),
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
    evaluate: async (expr: string) => eval(expr),
    pick: async (_options?: { timeoutMs?: number }) => ({
      selector: '[data-testid="pay"]',
      tag: 'button',
      text: 'Pay now',
      rect: { x: 10, y: 20, width: 120, height: 40 },
    }),
    applyPrototype: async (slug: string) => ({ slug, applied: 2, files: ['A-001-btn.css', 'A-002-guard.js'], skipped: [] }),
    clearPrototype: async (slug: string) => ({ slug, removed: [`prototype:${slug}:A-001-btn.css`] }),
    commitPrototype: async (slug: string) => ({ slug, scopes: [], nothingToCommit: true }),
    setPrototypeProject: async ({ slug, projectSlug }: { slug: string; projectSlug: string | null }) => ({
      slug,
      projectSlug,
    }),
    verifyPrototype: async (slug: string) => ({
      slug,
      page: 'http://x.localhost/cart',
      passed: 1,
      failed: 1,
      skipped: 0,
      reportPath: `/tmp/prototypes/${slug}/dist/acceptance.md`,
      results: [
        { requirementId: 'R-001', target: 'selector [data-total]', status: 'pass', detail: 'found on the page' },
        { requirementId: 'R-002', target: 'endpoint GET /api/cart', status: 'fail', detail: 'not declared' },
      ],
    }),
    startPrototypeFrames: async (options: { intervalMs?: number; threshold?: number; maxFrames?: number }) => ({
      startedAt: '2026-09-15T00:00:00.000Z',
      intervalMs: options.intervalMs ?? 400,
      threshold: options.threshold ?? 0.005,
      maxFrames: options.maxFrames ?? 60,
    }),
    stopPrototypeFrames: async (slug: string) => ({
      dir: `/tmp/prototypes/${slug}/research/frames/20260915-000000`,
      frames: 2,
      files: ['frame-0001.jpg', 'frame-0002.jpg', 'frames.json', 'index.md'],
      truncated: false,
    }),
    importPrototypeVideo: async () => ({
      session: 'import-demo-20260915-000000',
      video: 'videos/demo.mp4',
      frames: 3,
      files: ['frame-0001.jpg', 'frame-0002.jpg', 'frame-0003.jpg', 'frames.json', 'index.md'],
      truncated: false,
      durationMs: 6000,
    }),
    exportPrototype: async (slug: string) => exported(slug),
    composeContract: async ({ slug, service }: { slug: string; service?: string }) => ({
      service: service ?? 'checkout-api',
      endpoints: 3,
      conflicts: [],
      missingFixtures: [],
    }),
    exportContract: async ({ slug, service }: { slug: string; service?: string }) => ({
      service: service ?? 'checkout-api',
      openapiPath: `/tmp/prototypes/${slug}/dist/openapi.yaml`,
      docPath: `/tmp/prototypes/${slug}/dist/contract.md`,
      fixturesDir: `/tmp/prototypes/${slug}/dist/fixtures`,
      endpoints: 3,
      fixtures: 2,
      missingFixtures: [],
      conflicts: [],
    }),
    applyMock: async ({ slug, service }: { slug: string; service?: string }) => ({
      service: service ?? 'checkout-api',
      routes: 3,
      missingFixtures: [],
      unmocked: [],
    }),
    clearMock: async () => {},
    prototypeStatus: async (slug: string) => ({
      slug,
      dir: `/tmp/prototypes/${slug}`,
      references: [],
      projectSlug: null,
      pages: [
        { name: 'entry', kind: 'overlay' as const, file: null, url: 'https://app.example.com/checkout', entry: true },
      ],
      entryPage: 'entry',
      pageIssues: [],
      requirements: [],
      findings: [],
      briefIssues: [],
      frameCaptures: [],
      pageAvailable: true,
      patches: { total: 2, byLane: { A: 2 }, scoped: 1, files: [], entries: [] },
      anchors: { files: [], issues: [] },
      services: [
        { slug: 'checkout-api', fragments: 1, fixtures: 1, endpoints: 2, mockedEndpoints: 1, missingFixtures: [] },
      ],
      distFiles: ['prototype.html', 'dev-spec.md'],
      ownership: { inspected: 4, violations: [] },
      lanes: { A: 'UI / interaction (patches)' },
    }),
    prototypeEntry: async ({ slug }: { slug: string }) => ({
      page: 'entry',
      path: `/tmp/prototypes/${slug}/entry.html`,
      url: `http://${slug}.localhost:41234/`,
      origin: `http://${slug}.localhost:41234`,
      injectPatches: false,
    }),
    // Unbound by default; tests that exercise the no-slug fallback override it.
    getBoundPrototypeSlug: () => null,
    listPrototypes: async () => [],
    createPrototype: async ({ name }: { name: string }) => ({
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
      dir: `/tmp/prototypes/${name}`,
      patchesPath: `/tmp/prototypes/${name}/patches`,
    }),
    setPrototypePageUrl: async (_slug: string, url: string, page?: string) => ({
      pages: [{ name: page ?? 'entry', kind: 'overlay' as const, url, entry: page === undefined }],
    }),
    setPrototypePages: async (slug: string, change: PrototypePagesChange): Promise<PrototypePagesResult> => ({
      slug,
      pages: change.op === 'remove'
        ? []
        : [{ name: 'payment', kind: 'overlay' as const, url: 'https://app.example.com/checkout/payment' }],
      note: `${change.op} page`,
    }),
    bindPrototype: async (_slug: string | null) => {},
    linkPrototypeReference: async (_slug: string, referenceSlug: string) => ({ references: [referenceSlug] }),
    unlinkPrototypeReference: async () => ({ references: [] }),
    focusWindow: async (instanceId?: string) => ({ instanceId: instanceId ?? 'browser-1', title: 'Example Domain', url: 'https://example.com' }),
    releaseControl: async (_instanceId?: string) => ({ action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }),
    closeWindow: async (_instanceId?: string) => ({ action: 'closed' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }),
    hideWindow: async (_instanceId?: string) => ({ action: 'hidden' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }),
    listWindows: async () => ([
      {
        id: 'browser-1',
        title: 'Example Domain',
        url: 'https://example.com',
        isVisible: true,
        ownerType: 'session',
        ownerSessionId: 'test-session',
        boundSessionId: 'test-session',
        agentControlActive: true,
      },
    ]),
    detectChallenge: async () => ({ detected: false, provider: 'none', signals: [] }),
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Minimal PrototypeStatus for `prototype-list` tests — only the listed fields are read. */
function prototypeStatus(slug: string, overrides: Partial<PrototypeStatus> = {}): PrototypeStatus {
  return {
    slug,
    dir: `/tmp/prototypes/${slug}`,
    references: [],
    projectSlug: null,
    pages: [],
    entryPage: null,
    pageIssues: [],
    requirements: [],
    findings: [],
    briefIssues: [],
    frameCaptures: [],
    pageAvailable: true,
    patches: { total: 1, byLane: { A: 1 }, scoped: 0, files: [], entries: [] },
    anchors: { files: [], issues: [] },
    services: [],
    distFiles: [],
    ownership: { inspected: 1, violations: [] },
    lanes: {},
    ...overrides,
  }
}

/**
 * One row of a page table. The kind is what decides how the page is changed, and
 * where it lives follows from it: an overlay records an address, a page of ours
 * a document in the prototype directory.
 */
function page(
  name: string,
  kind: PageKind,
  where: { file?: string; url?: string },
  entry = false,
): PrototypePage {
  return {
    name,
    kind,
    file: where.file ?? null,
    url: where.url ?? null,
    entry,
  }
}

/**
 * An export result as the runtime reads it. An overlay's package is the default
 * because it is the one with no document of ours inside it.
 */
function exported(slug: string, overrides: Partial<PrototypeExportResult> = {}): PrototypeExportResult {
  return {
    slug,
    extensionDir: `/tmp/prototypes/${slug}/dist/extension`,
    pagePath: null,
    pageUrl: null,
    version: '1.20000.630',
    specPath: `/tmp/prototypes/${slug}/dist/dev-spec.md`,
    applied: 2,
    pageCount: 1,
    warnings: [],
    ...overrides,
  }
}

// ============================================================================
// Helper: execute a tool by name
// ============================================================================

function findTool(tools: ReturnType<typeof createBrowserTools>, name: string) {
  // SDK tool objects have a .name property
  return tools.find((t: any) => t.name === name)
}

async function executeTool(tools: ReturnType<typeof createBrowserTools>, name: string, args: Record<string, unknown> = {}) {
  const t = findTool(tools, name) as any
  if (!t) throw new Error(`Tool "${name}" not found`)
  // SDK tools have an execute/handler function — use the handler directly
  return t.handler(args)
}

// ============================================================================
// Tests
// ============================================================================

describe('createBrowserTools', () => {
  let mockFns: BrowserPaneFns
  let tools: ReturnType<typeof createBrowserTools>

  beforeEach(() => {
    mockFns = createMockFns()
    tools = createBrowserTools({
      sessionId: 'test-session',
      getBrowserPaneFns: () => mockFns,
    })
  })

  it('returns exactly 1 tool (browser_tool only)', () => {
    expect(tools.length).toBe(1)
  })

  it('exposes only browser_tool', () => {
    const names = tools.map((t: any) => t.name)
    expect(names).toEqual(['browser_tool'])
  })

  // The description is always in the model's context, and the model also sees a
  // real <project_context>. Without this line the two meanings of "project"
  // collide with nothing to tell them apart.
  it('tells the model that a prototype is not a project', () => {
    const tool = tools.find((t: any) => t.name === 'browser_tool') as any
    expect(tool.description).toContain('A prototype is NOT a')
    expect(tool.description).toContain('projects are separate containers')
  })

  describe('browser_tool', () => {
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
      expect(result.content[0].text).toContain('windows')
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
          ownerType: 'session',
          ownerSessionId: 'test-session',
          boundSessionId: 'test-session',
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
            ownerType: 'session',
            ownerSessionId: 'test-session',
            boundSessionId: 'test-session',
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
      // A window that is not a prototype's says nothing about prototypes: the
      // context appears only where it is true.
      expect(text).not.toContain('Prototype:')
    })

    // The URL alone cannot tell whether the document in front of the agent is ours
    // to edit or a real site's to patch — and both addresses matter, because for an
    // overlay the page's URL and the prototype's own address are different pages.
    it('names the prototype, the page and the page kind alongside the page URL', async () => {
      mockFns.snapshot = async () => ({
        url: 'https://app.example.com/checkout',
        title: 'Checkout',
        prototype: {
          slug: 'checkout-flow',
          kind: 'overlay',
          origin: 'http://checkout-flow-abc123ab.localhost:41234',
          page: 'entry',
        },
        nodes: [{ ref: '@e1', role: 'button', name: 'Pay' }],
      })

      const text = (await executeTool(tools, 'browser_tool', { command: 'snapshot' })).content[0].text

      expect(text).toContain('URL: https://app.example.com/checkout')
      expect(text).toContain(
        'Prototype: checkout-flow — page "entry" (overlay), its own address http://checkout-flow-abc123ab.localhost:41234',
      )
      expect(text).toContain("the live site's own page")
    })

    it('says a from-scratch prototype document is ours to change', async () => {
      mockFns.snapshot = async () => ({
        url: 'http://quotes-flow-def456.localhost:41234/',
        title: 'Quotes',
        prototype: {
          slug: 'quotes-flow',
          kind: 'scratch',
          origin: 'http://quotes-flow-def456.localhost:41234',
          page: 'entry',
        },
        nodes: [{ ref: '@e1', role: 'button', name: 'New quote' }],
      })

      const text = (await executeTool(tools, 'browser_tool', { command: 'snapshot' })).content[0].text

      expect(text).toContain('Prototype: quotes-flow — page "entry" (scratch)')
      expect(text).toContain('the document above is ours')
    })

    // A window on the prototype's own address but on no described page (the page
    // index, or a route the table does not name) has no kind — and saying so is
    // what stops the agent from reading "no kind" as "a page of ours".
    it('says a window on no described page is on the page index', async () => {
      mockFns.snapshot = async () => ({
        url: 'http://checkout-flow-abc123ab.localhost:41234/_index',
        title: 'Pages',
        prototype: {
          slug: 'checkout-flow',
          kind: null,
          origin: 'http://checkout-flow-abc123ab.localhost:41234',
          page: null,
        },
        nodes: [{ ref: '@e1', role: 'link', name: 'cart' }],
      })

      const text = (await executeTool(tools, 'browser_tool', { command: 'snapshot' })).content[0].text

      expect(text).toContain('Prototype: checkout-flow — the page index, its own address')
      expect(text).toContain("not on one of its pages")
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

    it('routes console command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'console 10 warn' })
      expect(result.content[0].text).toContain('Console entries')
    })

    it('routes window-resize command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'window-resize 1024 768' })
      expect(result.content[0].text).toContain('Window resized to 1024x768')
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

    it('routes prototype-apply and reports the applied patches', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-apply checkout-flow' })
      expect(result.content[0].text).toContain('Prototype "checkout-flow": applied 2 patches')
      expect(result.content[0].text).toContain('A-001-btn.css')
    })

    it('reports when prototype-apply finds no patch files', async () => {
      mockFns.applyPrototype = async (slug) => ({ slug, applied: 0, files: [], skipped: [] })
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-apply empty-flow' })
      expect(result.content[0].text).toContain('no patch files found')
    })

    /**
     * The rendered page arrives with its patches inlined, so there is nothing to
     * inject — and saying "applied 0 patches" would read as a failure.
     */
    it('distinguishes "already on the page" from "no patches exist"', async () => {
      mockFns.applyPrototype = async (slug) => ({
        slug,
        applied: 0,
        files: [],
        skipped: ['A-001-btn.css'],
      })
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-apply checkout-flow' })

      expect(result.content[0].text).toContain('already carries all 1 patch')
      expect(result.content[0].text).toContain('reload the page')
      expect(result.content[0].text).not.toContain('no patch files found')
    })

    it('requires a slug for prototype-apply', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-apply' })
      expect(result.content[0].text).toContain('needs a prototype')
    })

    /**
     * What the patches made of the page (§21.1): the two failures that used to be
     * invisible — a selector that matched nothing, and one that matched before —
     * plus the patches nobody could check at all.
     */
    it('names what the patches matched, and what they did not', async () => {
      mockFns.applyPrototype = async (slug) => ({
        slug,
        applied: 2,
        files: ['A-001-btn.css', 'A-002-guard.js'],
        skipped: [],
        targets: [{ file: 'A-001-btn.css', target: '.btn', matched: 0, recorded: true }],
        unmatched: ['.typo'],
        drifted: [{ target: '.btn', lastMatchedAt: '2026-09-15T10:00:00.000Z', suggestions: ['#pay'] }],
        untargeted: ['A-002-guard.js'],
      })
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-apply checkout-flow' })
      const text = result.content[0].text

      expect(text).toContain('matched nothing (and have never matched): .typo')
      expect(text).toContain('the page moved rather than the patch being wrong')
      expect(text).toContain('#pay')
      expect(text).toContain('No "@target" declared, so nothing could check these: A-002-guard.js')
    })

    it('routes prototype-commit and reports where the changes landed', async () => {
      mockFns.commitPrototype = async (slug) => ({
        slug,
        scopes: [
          {
            page: 'cart',
            kind: 'scratch',
            wrote: ['assets/cart/committed.css'],
            folded: ['cart/A-001-btn.css'],
            promoted: [],
            deleted: ['cart/A-001-btn.css'],
            unverified: [],
            refused: [],
          },
          {
            page: 'pay',
            kind: 'overlay',
            wrote: ['patches/pay/Z-001-upper.css', 'patches/pay/Z-002-upper.js'],
            folded: ['pay/A-001-btn.css'],
            promoted: ['pay/A-002-guard.js'],
            deleted: ['pay/A-001-btn.css', 'pay/A-002-guard.js'],
            unverified: ['pay/A-001-btn.css'],
            refused: [],
          },
        ],
        nothingToCommit: false,
      })

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-commit checkout-flow' })
      const text = result.content[0].text

      expect(text).toContain('Prototype "checkout-flow": committed.')
      expect(text).toContain('page "cart" (scratch):')
      expect(text).toContain('wrote assets/cart/committed.css')
      expect(text).toContain('wrote patches/pay/Z-001-upper.css')
      expect(text).toContain('promoted patches/pay/A-002-guard.js (now a script the page loads)')
      expect(text).toContain('deleted patches/cart/A-001-btn.css')
      // Both the patch nobody could check and the page that was skipped are named.
      expect(text).toContain('not checked: patches/pay/A-001-btn.css')
    })

    it('says a second commit has nothing to fold, rather than reporting zeros', async () => {
      mockFns.commitPrototype = async (slug) => ({ slug, scopes: [], nothingToCommit: true })

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-commit checkout-flow' })

      expect(result.content[0].text).toContain('nothing to fold')
    })

    it('refuses prototype-commit --page without a page name', async () => {
      // Bound, so the missing page name is what is wrong — not the missing slug.
      mockFns.getBoundPrototypeSlug = () => 'checkout-flow'
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-commit --page' })
      expect(result.content[0].text).toContain('prototype-commit --page needs a page name')
    })

    it('routes prototype-clear and lists the removed keys', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-clear checkout-flow' })
      expect(result.content[0].text).toContain('removed 1 patch')
      expect(result.content[0].text).toContain('prototype:checkout-flow:A-001-btn.css')
    })

    it('routes prototype-export and points at the deliverable', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-export checkout-flow' })
      expect(result.content[0].text).toContain('exported 1 page(s) and 2 patches')
      expect(result.content[0].text).toContain('/dist/extension')
      expect(result.content[0].text).toContain('/dist/dev-spec.md')
    })

    // The folder is one deliverable either way, but what it *does* differs by the
    // pages it covers: a live page gets patched in a real browser, a page of ours
    // is shipped inside the package. So the next step cannot be the same sentence.
    it('separates the live pages it patches from the documents of ours it ships', async () => {
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          pages: [page('entry', 'overlay', { url: 'https://app.example.com/checkout' }, true)],
          entryPage: 'entry',
        })
      mockFns.exportPrototype = async (slug) => exported(slug, { pageCount: 1 })

      const live = await executeTool(tools, 'browser_tool', { command: 'prototype-export checkout-flow' })
      expect(live.content[0].text).toContain('exported 1 page(s)')
      expect(live.content[0].text).toContain('puts its patches on the 1 live')
      // No page of ours in the package, so there is nothing to open here.
      expect(live.content[0].text).not.toContain('page(s) of ours ship inside')
      expect(live.content[0].text).not.toContain('browser_tool navigate')

      // A flow may mix both kinds, and then the package says both things.
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          pages: [
            page('entry', 'overlay', { url: 'https://app.example.com/checkout' }),
            page('cart', 'scratch', { file: 'cart.html', url: 'http://checkout-flow.localhost:41234/cart.html' }, true),
          ],
          entryPage: 'cart',
        })
      mockFns.exportPrototype = async (slug) =>
        exported(slug, {
          pageCount: 2,
          pagePath: `/tmp/prototypes/${slug}/dist/extension/cart.html`,
          pageUrl: 'http://checkout-flow.localhost:41234/dist/extension/cart.html',
        })

      const mixed = await executeTool(tools, 'browser_tool', { command: 'prototype-export checkout-flow' })
      expect(mixed.content[0].text).toContain('exported 2 page(s)')
      expect(mixed.content[0].text).toContain('puts its patches on the 1 live')
      expect(mixed.content[0].text).toContain('The 1 page(s) of ours ship inside the package')
      // The packaged page can be opened here first, and it is named as it is
      // served — the one inside the package, not the prototype root.
      expect(mixed.content[0].text).toContain(
        'browser_tool navigate http://checkout-flow.localhost:41234/dist/extension/cart.html',
      )
    })

    // A package that had to rewrite part of the document has to say so, or the
    // author reads a clean export and never learns what moved.
    it('passes on what the package had to change about the document', async () => {
      mockFns.exportPrototype = async (slug) =>
        exported(slug, { warnings: ['2 inline <script> block(s) were moved into files.'] })

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-export checkout-flow' })

      expect(result.content[0].text).toContain('adapted for the extension')
      expect(result.content[0].text).toContain('2 inline <script> block(s) were moved into files.')
    })

    it('requires a slug for prototype-export', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-export' })
      expect(result.content[0].text).toContain('needs a prototype')
    })

    // A page's kind decides how it is changed and where it lives, so both are
    // said for every row — otherwise an overlay and a page of ours read alike.
    it('lists a prototype’s pages in flow order, each with its kind and where it lives', async () => {
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          pages: [
            page('entry', 'overlay', { url: 'https://app.example.com/cart' }, true),
            page('payment', 'overlay', { url: 'https://app.example.com/checkout/payment' }),
          ],
          entryPage: 'entry',
        })

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-pages checkout-flow' })

      expect(result.content[0].text).toContain('2 page(s), in flow order')
      expect(result.content[0].text).toContain('entry (overlay) [entry] — https://app.example.com/cart')
      expect(result.content[0].text).toContain('payment (overlay) — https://app.example.com/checkout/payment')
      expect(result.content[0].text).toContain('prototype-pages --add <name>=<url>')
      // Removing a page is the one change that reaches the filesystem, so the
      // listing has to say so before the agent runs it.
      expect(result.content[0].text).toContain('removing a page of ours deletes its document')
    })

    // A page of ours *is* its document, so the listing names the file rather than
    // an address — and a declared page whose file is gone is a screen that is not
    // there, which is a page issue worth printing.
    it('lists the documents of ours, and the page issues that go with them', async () => {
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          pages: [
            page('cart', 'scratch', { file: 'cart.html', url: 'http://checkout-flow.localhost:41234/cart.html' }, true),
            page('orders', 'scratch', {}),
          ],
          entryPage: 'cart',
          pageIssues: ['the page table lists "orders", but orders.html is not in the prototype directory.'],
        })

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-pages checkout-flow' })

      expect(result.content[0].text).toContain('cart (scratch) [entry] — cart.html')
      expect(result.content[0].text).toContain('orders (scratch) — document missing')
      expect(result.content[0].text).toContain('Issues (fix or acknowledge these')
      expect(result.content[0].text).toContain('orders.html is not in the prototype directory')
    })

    it('says how to make a first page when the table is empty', async () => {
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, { pages: [], pageAvailable: false })

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-pages checkout-flow' })

      expect(result.content[0].text).toContain('no pages yet')
      expect(result.content[0].text).toContain('a top-level <name>.html')
      expect(result.content[0].text).toContain('prototype-pages --add <name>=<url>')
    })

    it('adds a live page and says the delivered extension has to be rebuilt', async () => {
      let received: { slug: string; change: unknown } | undefined
      mockFns.setPrototypePages = async (slug, change) => {
        received = { slug, change }
        return {
          slug,
          pages: [{ name: 'payment', kind: 'overlay', url: 'https://app.example.com/checkout/payment' }],
          note: 'added overlay page "payment" → https://app.example.com/checkout/payment',
        }
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'prototype-pages checkout-flow --add payment=https://app.example.com/checkout/payment',
      })

      expect(received).toEqual({
        slug: 'checkout-flow',
        change: { op: 'add', name: 'payment', url: 'https://app.example.com/checkout/payment' },
      })
      expect(result.content[0].text).toContain('added overlay page "payment"')
      expect(result.content[0].text).toContain('payment (overlay) — https://app.example.com/checkout/payment')
      // The package is a snapshot (§17.4), and nothing else would say so.
      expect(result.content[0].text).toContain('Re-export')
    })

    // A bare `--add <name>` is not a second way to create a page: the document is
    // what makes one, and placing it in the flow is all the table can do about it.
    it('places an existing document with a bare --add, and says what that did', async () => {
      const changes: unknown[] = []
      mockFns.setPrototypePages = async (slug, change) => {
        changes.push(change)
        return {
          slug,
          pages: [{ name: 'cart', kind: 'scratch', entry: true }],
          note: 'declared page "cart" (cart.html was already a page; this puts it in the flow order)',
        }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-pages checkout-flow --add cart' })

      expect(changes).toEqual([{ op: 'add', name: 'cart' }])
      expect(result.content[0].text).toContain('declared page "cart"')
      expect(result.content[0].text).toContain('cart (scratch) [entry] — a document of ours')
    })

    it('names the file to write when --add <name> has no document yet', async () => {
      mockFns.setPrototypePages = async () => {
        throw new Error(
          'A scratch page is a document of ours, so orders.html has to exist before it can be placed in the flow. ' +
            'Write /tmp/prototypes/checkout-flow/orders.html first — that alone makes it a page.',
        )
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-pages checkout-flow --add orders' })

      expect(result.content[0].text).toContain('orders.html has to exist')
      expect(result.content[0].text).toContain('/tmp/prototypes/checkout-flow/orders.html')
    })

    it('removes and renames pages', async () => {
      const changes: unknown[] = []
      mockFns.setPrototypePages = async (slug, change) => {
        changes.push(change)
        return { slug, pages: [], note: `${change.op} page` }
      }

      await executeTool(tools, 'browser_tool', { command: 'prototype-pages checkout-flow --remove payment' })
      await executeTool(tools, 'browser_tool', { command: 'prototype-pages checkout-flow --rename cart=basket' })

      expect(changes).toEqual([
        { op: 'remove', name: 'payment' },
        { op: 'rename', from: 'cart', to: 'basket' },
      ])
    })

    it('asks for the value it needs instead of guessing', async () => {
      const malformed = [
        ['prototype-pages checkout-flow --add', /--add needs a page name/],
        ['prototype-pages checkout-flow --rename cart', /--rename needs old=new/],
        ['prototype-pages checkout-flow --remove', /--remove needs a page name/],
        ['prototype-pages checkout-flow --add a=b --remove c', /one change at a time/],
      ] as const

      for (const [command, expected] of malformed) {
        const result = await executeTool(tools, 'browser_tool', { command })
        expect(result.content[0].text).toMatch(expected)
      }
    })

    it('routes prototype-contract-compose with a service flag', async () => {
      let received: { slug: string; service?: string } | undefined
      mockFns.composeContract = async (options) => {
        received = options
        return { service: 'checkout-api', endpoints: 5, conflicts: ['/orders'], missingFixtures: ['x-200'] }
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'prototype-contract-compose checkout-flow --service checkout-api',
      })

      expect(received).toEqual({ slug: 'checkout-flow', service: 'checkout-api' })
      expect(result.content[0].text).toContain('composed 5 endpoints')
      expect(result.content[0].text).toContain('Duplicate path')
      expect(result.content[0].text).toContain('x-200')
    })

    it('routes prototype-contract-export and reports the deliverables', async () => {
      const result = await executeTool(tools, 'browser_tool', {
        command: 'prototype-contract-export checkout-flow',
      })

      expect(result.content[0].text).toContain('exported contract with 3 endpoints')
      expect(result.content[0].text).toContain('/dist/openapi.yaml')
      expect(result.content[0].text).toContain('/dist/contract.md')
      expect(result.content[0].text).toContain('/dist/fixtures')
    })

    it('routes prototype-mock-apply and reports skipped/unmocked endpoints', async () => {
      mockFns.applyMock = async (_options) => ({
        service: 'checkout-api',
        routes: 2,
        missingFixtures: ['nope-200'],
        unmocked: ['GET /health'],
      })

      const result = await executeTool(tools, 'browser_tool', {
        command: 'prototype-mock-apply checkout-flow --service checkout-api',
      })

      expect(result.content[0].text).toContain('serving 2 mock routes')
      expect(result.content[0].text).toContain('GET /health')
      expect(result.content[0].text).toContain('nope-200')
    })

    it('routes prototype-mock-clear', async () => {
      let cleared = false
      mockFns.clearMock = async () => {
        cleared = true
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-mock-clear' })

      expect(cleared).toBe(true)
      expect(result.content[0].text).toContain('Mock cleared')
    })

    it('requires a slug for prototype-mock-apply', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-mock-apply' })
      expect(result.content[0].text).toContain('needs a prototype')
    })

    it('routes prototype-status and reports the summary plus ownership violations', async () => {
      mockFns.prototypeStatus = async (slug) => ({
        slug,
        dir: `/tmp/prototypes/${slug}`,
        references: [],
        pages: [
          page('entry', 'overlay', { url: 'https://app.example.com/checkout' }, true),
          page('login', 'overlay', { url: 'https://app.example.com/login' }),
        ],
        entryPage: 'entry',
        pageAvailable: true,
        projectSlug: null,
        pageIssues: [],
        requirements: [],
        findings: [],
        briefIssues: [],
        frameCaptures: [],
        patches: { total: 2, byLane: { A: 2 }, scoped: 1, files: [], entries: [] },
        anchors: { files: [], issues: [] },
        services: [
          { slug: 'checkout-api', fragments: 1, fixtures: 1, endpoints: 2, mockedEndpoints: 1, missingFixtures: ['nope-200'] },
        ],
        distFiles: ['prototype.html'],
        ownership: { inspected: 5, violations: [{ path: 'patches/oops.css', reason: 'misnamed patch' }] },
        lanes: { A: 'UI / interaction (patches)' },
      })

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-status checkout-flow' })

      expect(result.content[0].text).toContain('patches:    2 (A: 2) — 1 page-scoped, 1 shared')
      expect(result.content[0].text).toContain('entry (overlay) [entry] — https://app.example.com/checkout')
      expect(result.content[0].text).toContain('login (overlay) — https://app.example.com/login')
      expect(result.content[0].text).toContain('2 endpoints, 1 mocked')
      expect(result.content[0].text).toContain('missing fixtures: nope-200')
      expect(result.content[0].text).toContain('dist:       prototype.html')
      expect(result.content[0].text).toContain('ownership:  1 violation(s)')
      expect(result.content[0].text).toContain('patches/oops.css')
    })

    it('reports a clean ownership check when there are no violations', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-status checkout-flow' })
      expect(result.content[0].text).toContain('ownership:  OK (4 files)')
    })

    // "references: rival-cart" is not actionable until you know what rival-cart is.
    it('resolves each reference to what it holds', async () => {
      const checkout = prototypeStatus('checkout-flow', {
        references: ['rival-cart', 'ghost'],
        pages: [page('cart', 'scratch', { file: 'cart.html' }, true)],
        entryPage: 'cart',
      })
      mockFns.prototypeStatus = async () => checkout
      mockFns.listPrototypes = async () => [
        checkout,
        prototypeStatus('rival-cart', {
          pages: [
            page('cart', 'overlay', { url: 'https://rival.example.com/cart' }, true),
            page('pay', 'overlay', { url: 'https://rival.example.com/pay' }),
          ],
          entryPage: 'cart',
        }),
      ]

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-status checkout-flow' })

      expect(result.content[0].text).toContain('cart (scratch) [entry] — cart.html')
      expect(result.content[0].text).toContain('rival-cart (2 page(s), entry "cart")')
      // A dangling reference is named rather than silently dropped.
      expect(result.content[0].text).toContain('ghost (MISSING — no prototype with that slug)')
    })

    it('reports who references this prototype', async () => {
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, { pages: [page('cart', 'overlay', { url: 'https://rival.example.com/cart' }, true)], entryPage: 'cart' })
      mockFns.listPrototypes = async () => [
        prototypeStatus('rival-cart', {
          pages: [page('cart', 'overlay', { url: 'https://rival.example.com/cart' }, true)],
          entryPage: 'cart',
        }),
        prototypeStatus('checkout-flow', { references: ['rival-cart'] }),
      ]

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-status rival-cart' })

      expect(result.content[0].text).toContain('referenced by: checkout-flow')
    })

    // `/` is a page of the flow only when one carries the entry flag; without it
    // the root is the generated index, and the two read nothing alike.
    it('says which page the address root opens, or that it shows the index', async () => {
      const withEntry = await executeTool(tools, 'browser_tool', { command: 'prototype-status checkout-flow' })
      expect(withEntry.content[0].text).toContain('root:       opens "entry"')

      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          pages: [page('cart', 'scratch', { file: 'cart.html' })],
          entryPage: null,
        })
      const withoutEntry = await executeTool(tools, 'browser_tool', { command: 'prototype-status checkout-flow' })
      expect(withoutEntry.content[0].text).toContain('root:       shows the generated page index')
      expect(withoutEntry.content[0].text).toContain('references: none')
    })

    // A page issue is a screen that is not there (or a patch nothing replays), and
    // the status is the only place that says which.
    it('lists the page issues, which a clean prototype does not have', async () => {
      const clean = await executeTool(tools, 'browser_tool', { command: 'prototype-status checkout-flow' })
      expect(clean.content[0].text).not.toContain('page issues:')

      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          pages: [page('cart', 'scratch', {}, true)],
          entryPage: 'cart',
          pageIssues: [
            'the page table lists "cart", but cart.html is not in the prototype directory.',
            'patches/orders/ belongs to no page of this prototype, so nothing there is replayed. Pages: cart',
          ],
        })

      const issues = await executeTool(tools, 'browser_tool', { command: 'prototype-status checkout-flow' })
      expect(issues.content[0].text).toContain('page issues: 2')
      expect(issues.content[0].text).toContain('cart.html is not in the prototype directory')
      expect(issues.content[0].text).toContain('patches/orders/ belongs to no page')
    })

    it('routes prototype-open to the entry page', async () => {
      let navigated = ''
      mockFns.navigate = async (url) => {
        navigated = url
        return { url, title: 'Checkout' }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-open checkout-flow' })

      // The address is the prototype's origin — the entry page rendered with every
      // patch applied — not a file path.
      expect(navigated).toBe('http://checkout-flow.localhost:41234/')
      expect(result.content[0].text).toContain('opened entry page "entry" with every patch applied')
      expect(result.content[0].text).toContain('base: /tmp/prototypes/checkout-flow/entry.html')
      expect(result.content[0].text).toContain('Checkout')
    })

    // "Open the prototype" has no single meaning once a flow has several pages, so
    // an unqualified open continues where the window already is rather than
    // jumping back to the front door.
    it('prefers the page the bound window is already on', async () => {
      let navigated = ''
      mockFns.snapshot = async () => ({
        url: 'http://checkout-flow.localhost:41234/orders.html',
        title: 'Orders',
        nodes: [],
        prototype: {
          slug: 'checkout-flow',
          kind: 'scratch',
          origin: 'http://checkout-flow.localhost:41234',
          page: 'orders',
        },
      })
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          pages: [
            page('entry', 'scratch', { file: 'entry.html', url: 'http://checkout-flow.localhost:41234/' }, true),
            page('orders', 'scratch', { file: 'orders.html', url: 'http://checkout-flow.localhost:41234/orders.html' }),
          ],
          entryPage: 'entry',
        })
      mockFns.navigate = async (url) => {
        navigated = url
        return { url, title: 'Orders' }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-open checkout-flow' })

      expect(navigated).toBe('http://checkout-flow.localhost:41234/orders.html')
      expect(result.content[0].text).toContain('opened page "orders" (scratch)')
    })

    // A window that cannot be read is not a reason to refuse the open: it only
    // means there is no current page to prefer.
    it('falls back to the entry page when the window cannot be read', async () => {
      let navigated = ''
      mockFns.snapshot = async () => {
        throw new Error('No browser window controls are available.')
      }
      mockFns.navigate = async (url) => {
        navigated = url
        return { url, title: 'Checkout' }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-open checkout-flow' })

      expect(navigated).toBe('http://checkout-flow.localhost:41234/')
      expect(result.content[0].text).toContain('opened entry page "entry"')
    })

    it('requires a slug for prototype-open', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-open' })
      expect(result.content[0].text).toContain('needs a prototype')
    })

    // A prototype is a flow, so `--page` names one screen of it. The names come
    // from the prototype's own status — which is also what makes the failure
    // below actionable.
    it('opens a named page of a multi-page prototype', async () => {
      let navigated = ''
      mockFns.prototypeEntry = async () => ({
        page: 'entry',
        path: '/tmp/prototypes/checkout-flow/entry.html',
        url: 'http://checkout-flow.localhost:41234',
        origin: 'http://checkout-flow.localhost:41234',
        injectPatches: false,
      })
      mockFns.prototypeStatus = async (slug: string) =>
        prototypeStatus(slug, {
          pages: [
            page('entry', 'scratch', { file: 'entry.html', url: 'http://checkout-flow.localhost:41234' }, true),
            page('orders', 'scratch', { file: 'orders.html', url: 'http://checkout-flow.localhost:41234/orders.html' }),
          ],
          entryPage: 'entry',
        })
      mockFns.navigate = async (url) => {
        navigated = url
        return { url, title: 'Orders' }
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'prototype-open checkout-flow --page orders',
      })

      expect(navigated).toBe('http://checkout-flow.localhost:41234/orders.html')
      expect(result.content[0].text).toContain('opened page "orders" (scratch)')
      // The entry's document is not the one opened here.
      expect(result.content[0].text).not.toContain('base: ')
    })

    it('lists the pages when --page names one that does not exist', async () => {
      mockFns.prototypeStatus = async (slug: string) =>
        prototypeStatus(slug, {
          pages: [
            page('entry', 'scratch', { file: 'entry.html', url: 'http://checkout-flow.localhost:41234' }, true),
            page('orders', 'scratch', { file: 'orders.html', url: 'http://checkout-flow.localhost:41234/orders.html' }),
          ],
          entryPage: 'entry',
        })

      const result = await executeTool(tools, 'browser_tool', {
        command: 'prototype-open checkout-flow --page nope',
      })

      expect(result.content[0].text).toContain('has no page "nope"')
      expect(result.content[0].text).toContain('entry, orders')
    })

    // A live page has no address of its own until something serves it, and a
    // document that is gone is a screen that is not there: both are refusals that
    // name which page, not navigations to an empty address.
    it('refuses to open a page that has no address', async () => {
      mockFns.prototypeStatus = async (slug: string) =>
        prototypeStatus(slug, {
          pages: [page('orders', 'scratch', {})],
          entryPage: 'orders',
        })

      const result = await executeTool(tools, 'browser_tool', {
        command: 'prototype-open checkout-flow --page orders',
      })

      expect(result.content[0].text).toContain('has no address')
      expect(result.content[0].text).toContain('its document is missing')
    })

    // An overlay's page is the site's own page, which knows nothing about the
    // prototype — navigating and stopping there would show the *target* page.
    // The replay is what makes the address the prototype.
    it('replays the patches when it opens an overlay', async () => {
      const applied: string[] = []
      mockFns.prototypeEntry = async () => ({
        page: 'entry',
        path: null,
        url: 'https://app.example.com/checkout',
        origin: 'http://checkout-flow.localhost:41234',
        injectPatches: true,
      })
      mockFns.navigate = async (url) => ({ url, title: 'Checkout' })
      mockFns.applyPrototype = async (slug) => {
        applied.push(slug)
        return { slug, applied: 2, files: ['A-001-btn.css', 'A-002-guard.js'], skipped: [] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-open checkout-flow' })

      expect(applied).toEqual(['checkout-flow'])
      expect(result.content[0].text).toContain('live page it changes')
      expect(result.content[0].text).toContain('Replayed 2 patches')
    })

    // The address recorded on the prototype is what we *asked* for; the page the
    // patches landed on is whatever the site served (sign-in walls redirect).
    // Reporting the request as the result would name a page that is not on screen.
    it('reports where an overlay actually landed when the site redirected', async () => {
      mockFns.prototypeEntry = async () => ({
        page: 'entry',
        path: null,
        url: 'https://app.example.com/checkout',
        origin: 'http://checkout-flow.localhost:41234',
        injectPatches: true,
      })
      mockFns.navigate = async (url) => ({ url, title: 'Sign in' })
      mockFns.evaluate = async () =>
        ({
          url: 'https://app.example.com/login?next=%2Fcheckout',
          title: 'Sign in',
          viewportWidth: 1280,
          viewportHeight: 800,
          documentWidth: 1280,
          documentHeight: 800,
          scrollX: 0,
          scrollY: 0,
          maxScrollX: 0,
          maxScrollY: 0,
          activeElementTag: 'input',
          activeElementRole: '',
          activeElementId: 'email',
          activeElementName: '',
        }) as never

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-open checkout-flow' })

      expect(result.content[0].text).toContain('landed on: https://app.example.com/login?next=%2Fcheckout')
    })

    // ========================================================================
    // Prototype binding — a bound session drives the prototype without slugs.
    // ========================================================================

    it('falls back to the bound prototype when no slug is passed', async () => {
      mockFns.getBoundPrototypeSlug = () => 'bound-flow'
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-apply' })
      expect(result.content[0].text).toContain('Prototype "bound-flow": applied 2 patches')
    })

    it('lets an explicit slug win over the binding', async () => {
      mockFns.getBoundPrototypeSlug = () => 'bound-flow'
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-apply other-flow' })
      expect(result.content[0].text).toContain('Prototype "other-flow"')
    })

    it('treats a leading flag as "no slug" so options can follow the command directly', async () => {
      mockFns.getBoundPrototypeSlug = () => 'bound-flow'
      const result = await executeTool(tools, 'browser_tool', {
        command: 'prototype-contract-compose --service checkout-api',
      })
      // The bound slug was used, not the literal "--service".
      expect(result.content[0].text).toContain('Prototype "bound-flow" service "checkout-api"')
    })

    it('names both ways out when there is no slug and no binding', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-apply' })
      expect(result.content[0].text).toContain('prototype-bind')
      expect(result.content[0].text).toContain('prototype-list')
    })

    it('lists prototypes, marks the bound one, and says which have no pages', async () => {
      mockFns.getBoundPrototypeSlug = () => 'checkout-flow'
      mockFns.listPrototypes = async () => [
        prototypeStatus('checkout-flow'),
        prototypeStatus('draft', {
          pageAvailable: false,
          patches: { total: 0, byLane: {}, scoped: 0, files: [], entries: [] },
          anchors: { files: [], issues: [] },
        }),
        prototypeStatus('no-target', { pageAvailable: false }),
      ]

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-list' })
      const text = result.content[0].text
      expect(text).toContain('bound to "checkout-flow"')
      expect(text).toContain('BOUND')
      // No pages is the normal state of a new prototype, not a broken one — so it
      // is said the way the panel says it, as the thing that decides openability.
      expect(text).toContain('draft — no pages yet')
      expect(text).toContain('no-target — no pages yet')
    })

    // A prototype is a table of pages that may mix both kinds, so the listing
    // prints every row with its kind and where it lives — otherwise an overlay and
    // a document of ours read alike, and they behave nothing alike.
    it('lists each prototype’s pages with their kinds and where they live', async () => {
      mockFns.listPrototypes = async () => [
        prototypeStatus('checkout-flow', {
          pages: [
            page('cart', 'scratch', { file: 'cart.html', url: 'http://checkout-flow.localhost:41234/cart.html' }, true),
            page('pay', 'overlay', { url: 'https://app.example.com/pay' }),
          ],
          entryPage: 'cart',
        }),
        prototypeStatus('rival-cart', {
          pages: [page('cart', 'overlay', { url: 'https://rival.example.com/cart' }, true)],
          entryPage: 'cart',
        }),
      ]

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-list' })
      const text = result.content[0].text

      expect(text).toContain('cart (scratch) [entry] — cart.html')
      expect(text).toContain('pay (overlay) — https://app.example.com/pay')
      expect(text).toContain('cart (overlay) [entry] — https://rival.example.com/cart')
      expect(text).toContain('entry: cart')
    })

    // The stored relation is one-way, so a listing that only printed `references`
    // would leave the other end invisible.
    it('shows references in both directions', async () => {
      mockFns.listPrototypes = async () => [
        prototypeStatus('checkout-flow', {
          references: ['rival-cart'],
          pages: [page('cart', 'scratch', { file: 'cart.html' }, true)],
          entryPage: 'cart',
        }),
        prototypeStatus('rival-cart'),
      ]

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-list' })

      expect(result.content[0].text).toContain('references: rival-cart')
      expect(result.content[0].text).toContain('referenced by: checkout-flow')
    })

    it('creates a prototype and binds the session in the same step', async () => {
      const bound: Array<string | null> = []
      mockFns.bindPrototype = async (slug) => { bound.push(slug) }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'prototype-create Checkout flow',
      })

      expect(result.content[0].text).toContain('Created prototype "checkout-flow" and bound this session to it.')
      expect(bound).toEqual(['checkout-flow'])
    })

    // Creation is the container, and nothing about the pages is decided here: a
    // page's kind is a fact about that page, so there is no kind and no address to
    // pass — and the output has to say how the first page comes to exist instead.
    it('creates a container with no pages, and says how a page comes to exist', async () => {
      const seen: Array<{ name: string }> = []
      mockFns.createPrototype = async (input) => {
        seen.push(input)
        return {
          slug: 'landing-page',
          dir: '/tmp/prototypes/landing-page',
          patchesPath: '/tmp/prototypes/landing-page/patches',
        }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-create Landing page' })

      expect(seen).toEqual([{ name: 'Landing page' }])

      const text = result.content[0].text
      expect(text).toContain('It has no pages yet')
      // Both kinds are named, with the move that places each one.
      expect(text).toContain('a document of ours')
      expect(text).toContain('prototype-pages --add pay=https://app.example.com/pay')
      expect(text).toContain('prototype-entry cart')
      expect(text).toContain('prototype-open')
    })

    it('asks for a name, which is all creation needs', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-create' })
      expect(result.content[0].text).toContain('needs a name')
    })

    /**
     * The same page lives in a dev, a staging and a production environment, and the
     * same patches are meant to be looked at in each of them — so the address is not
     * a rule to be fixed but a fact about where the page is. Changing it is allowed;
     * what quietly goes stale with it is what the command has to say.
     */
    it('repoints the entry page when it is a live page, naming what goes stale with it', async () => {
      const seen: Array<[string, string, string | undefined]> = []
      mockFns.getBoundPrototypeSlug = () => 'checkout-flow'
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          pages: [page('entry', 'overlay', { url: 'https://app.example.com/checkout' }, true)],
          entryPage: 'entry',
        })
      mockFns.setPrototypePageUrl = async (slug, url, page) => {
        seen.push([slug, url, page])
        return { pages: [{ name: 'entry', kind: 'overlay', url }] }
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'prototype-target https://staging.example.com/checkout',
      })

      // No `--page`: the page that moves is the entry one (it is a live page), and
      // its name is passed through rather than left for the other side to work out
      // a second time — the page reported below is then the page that changed.
      expect(seen).toEqual([['checkout-flow', 'https://staging.example.com/checkout', 'entry']])
      const text = result.content[0].text
      expect(text).toContain('page "entry" pointed somewhere else')
      expect(text).toContain('from: https://app.example.com/checkout')
      expect(text).toContain('to:   https://staging.example.com/checkout')
      // The two failures that raise no error at all are the reason to say anything.
      expect(text).toContain('already showing the old page')
      expect(text).toContain('written against the old page')
      // The kind is not what moved, and saying so stops the address from reading
      // as "this page is now a different kind of page".
      expect(text).toContain("The page's kind is still fixed")
    })

    // With several pages, "point it somewhere else" has to say which one — and a
    // flow of mostly documents of ours has no natural overlay to fall back on.
    it('repoints the page named with --page', async () => {
      const seen: Array<[string, string, string | undefined]> = []
      mockFns.getBoundPrototypeSlug = () => 'checkout-flow'
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          pages: [
            page('cart', 'scratch', { file: 'cart.html' }, true),
            page('pay', 'overlay', { url: 'https://app.example.com/pay' }),
          ],
          entryPage: 'cart',
        })
      mockFns.setPrototypePageUrl = async (slug, url, page) => {
        seen.push([slug, url, page])
        return { pages: [{ name: 'pay', kind: 'overlay', url }] }
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'prototype-target https://staging.example.com/pay --page pay',
      })

      expect(seen).toEqual([['checkout-flow', 'https://staging.example.com/pay', 'pay']])
      const text = result.content[0].text
      expect(text).toContain('page "pay" pointed somewhere else')
      expect(text).toContain('from: https://app.example.com/pay')
      expect(text).toContain('to:   https://staging.example.com/pay')
    })

    it('lists the pages when --page names one the prototype does not have', async () => {
      mockFns.getBoundPrototypeSlug = () => 'checkout-flow'
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          pages: [page('cart', 'scratch', { file: 'cart.html' }, true)],
          entryPage: 'cart',
        })

      const result = await executeTool(tools, 'browser_tool', {
        command: 'prototype-target https://staging.example.com/checkout --page pay',
      })

      expect(result.content[0].text).toContain('has no page "pay"')
      expect(result.content[0].text).toContain('cart')
    })

    it('needs the address, and a binding to point it at', async () => {
      const noUrl = await executeTool(tools, 'browser_tool', { command: 'prototype-target' })
      expect(noUrl.content[0].text).toContain('needs the address')

      // A URL is the only positional argument this command takes, so it cannot
      // also read one as a slug: binding is what names the prototype.
      const unbound = await executeTool(tools, 'browser_tool', {
        command: 'prototype-target https://staging.example.com/checkout',
      })
      expect(unbound.content[0].text).toContain('prototype-bind')
    })

    // `prototype-entry` is the only change to the table about the front door
    // rather than about the flow, so it is its own command.
    it('makes a page the entry the address root opens', async () => {
      const seen: Array<{ slug: string; change: PrototypePagesChange }> = []
      mockFns.getBoundPrototypeSlug = () => 'checkout-flow'
      mockFns.setPrototypePages = async (slug, change) => {
        seen.push({ slug, change })
        return {
          slug,
          pages: [
            { name: 'cart', kind: 'scratch', entry: true },
            { name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay' },
          ],
          note: '"cart" is the entry page now',
        }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-entry cart' })

      expect(seen).toEqual([{ slug: 'checkout-flow', change: { op: 'entry', name: 'cart' } }])
      const text = result.content[0].text
      expect(text).toContain('"cart" is the entry page now')
      expect(text).toContain('cart (scratch) [entry] — a document of ours')
      expect(text).toContain('pay (overlay) — https://app.example.com/pay')
      // Taking the entry never takes the index away.
      expect(text).toContain('/_index')
    })

    it('goes back to the generated page index with "none"', async () => {
      const seen: Array<{ slug: string; change: PrototypePagesChange }> = []
      mockFns.getBoundPrototypeSlug = () => 'checkout-flow'
      mockFns.setPrototypePages = async (slug, change) => {
        seen.push({ slug, change })
        return {
          slug,
          pages: [{ name: 'cart', kind: 'scratch' }],
          note: 'the address root shows the page index again',
        }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-entry none' })

      expect(seen).toEqual([{ slug: 'checkout-flow', change: { op: 'entry', name: null } }])
      expect(result.content[0].text).toContain('shows the page index again')
      expect(result.content[0].text).toContain('cart (scratch) — a document of ours')
    })

    it('explains how to bind when prototype-entry runs unbound', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-entry cart' })

      expect(result.content[0].text).toContain('not bound to one')
      expect(result.content[0].text).toContain('prototype-bind')
    })

    it('asks which page when prototype-entry is given none', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-entry' })
      expect(result.content[0].text).toContain('needs a page name, or "none"')
    })

    // Without this, creating a reference would rebind the session to the page
    // being studied and every later slug-less command would retarget it.
    it('leaves the session binding alone with --no-bind', async () => {
      let bound = false
      mockFns.bindPrototype = async () => { bound = true }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'prototype-create Rival checkout --no-bind',
      })

      expect(bound).toBe(false)
      expect(result.content[0].text).toContain('not bound')
    })

    it('still binds by default, so the name keeps its spaces', async () => {
      const bound: Array<string | null> = []
      mockFns.bindPrototype = async (slug) => { bound.push(slug) }

      await executeTool(tools, 'browser_tool', { command: 'prototype-create Checkout flow' })

      expect(bound).toEqual(['checkout-flow'])
    })

    it('links a reference on the bound prototype', async () => {
      const linked: Array<[string, string]> = []
      mockFns.getBoundPrototypeSlug = () => 'checkout-flow'
      mockFns.linkPrototypeReference = async (slug, referenceSlug) => {
        linked.push([slug, referenceSlug])
        return { references: ['rival-checkout'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-reference rival-checkout' })

      expect(linked).toEqual([['checkout-flow', 'rival-checkout']])
      expect(result.content[0].text).toContain('is now a reference')
      expect(result.content[0].text).toContain('references: rival-checkout')
      expect(result.content[0].text).toContain('do NOT copy')
    })

    it('removes a reference with --remove', async () => {
      let unlinked: Array<[string, string]> = []
      mockFns.getBoundPrototypeSlug = () => 'checkout-flow'
      mockFns.unlinkPrototypeReference = async (slug, referenceSlug) => {
        unlinked = [[slug, referenceSlug]]
        return { references: [] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-reference rival-checkout --remove' })

      expect(unlinked).toEqual([['checkout-flow', 'rival-checkout']])
      expect(result.content[0].text).toContain('is no longer a reference')
      expect(result.content[0].text).toContain('references: none')
    })

    it('names both ways out when prototype-reference runs unbound', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-reference rival-checkout' })
      expect(result.content[0].text).toContain('not bound to one')
      expect(result.content[0].text).toContain('prototype-bind')
    })

    it('asks for a slug when prototype-reference is given none', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-reference' })
      expect(result.content[0].text).toContain('needs the slug of the prototype to study')
    })

    it('refuses to bind a slug that does not exist, and lists what does', async () => {
      mockFns.listPrototypes = async () => [prototypeStatus('checkout-flow')]
      let bound = false
      mockFns.bindPrototype = async () => { bound = true }

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-bind nope' })
      expect(result.content[0].text).toContain('No prototype "nope"')
      expect(result.content[0].text).toContain('checkout-flow')
      expect(bound).toBe(false)
    })

    it('unbinds with prototype-bind --clear', async () => {
      const bound: Array<string | null> = []
      mockFns.bindPrototype = async (slug) => { bound.push(slug) }

      const result = await executeTool(tools, 'browser_tool', { command: 'prototype-bind --clear' })
      expect(result.content[0].text).toContain('Unbound')
      expect(bound).toEqual([null])
    })

    it('lists browser windows via windows command without release hint', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'windows' })
      expect(result.content[0].text).toContain('Browser windows (1)')
      expect(result.content[0].text).toContain('browser-1')
      expect(result.content[0].text).toContain('ownerType: session')
      expect(result.content[0].text).toContain('lockState: locked-session(test-session)')
      expect(result.content[0].text).toContain('availableToSession: true')
      expect(result.content[0].text).toContain('agentControlActive: true')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    // Which window is a prototype's — on which page, of which kind — is what
    // decides how to work with it; the URL alone says nothing (an overlay's URL is
    // the site's own page).
    it('marks which window is a prototype, on which page', async () => {
      mockFns.listWindows = async () => [
        {
          id: 'browser-1',
          title: 'Checkout',
          url: 'https://app.example.com/checkout',
          prototype: {
            slug: 'checkout-flow',
            kind: 'overlay' as const,
            origin: 'http://checkout-flow-abc123ab.localhost:41234',
            page: 'entry',
          },
          isVisible: true,
          ownerType: 'session' as const,
          ownerSessionId: 'test-session',
          boundSessionId: 'test-session',
        },
        {
          id: 'browser-2',
          title: 'Docs',
          url: 'https://docs.example.com',
          isVisible: false,
          ownerType: 'manual' as const,
          ownerSessionId: null,
          boundSessionId: null,
        },
      ]

      const text = (await executeTool(tools, 'browser_tool', { command: 'windows' })).content[0].text

      expect(text).toContain(
        'prototype: checkout-flow — page "entry" (overlay), its own address http://checkout-flow-abc123ab.localhost:41234',
      )
      // The plain window gets no prototype line at all.
      expect(text.match(/prototype:/g)).toHaveLength(1)
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
