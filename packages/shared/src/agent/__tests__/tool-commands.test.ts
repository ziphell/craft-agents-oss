/**
 * Tests for the two pane tool factories.
 *
 * `browser_tool` and `prototype_tool` are two doors onto one command table, and the suite drives
 * each command through the door that owns it. Both delegate to `BrowserPaneFns` via CLI commands.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import { createBrowserTools } from '../browser-tools'
import { createPrototypeTools } from '../prototype-tools'
import type { BrowserPaneFns } from '../browser-pane'
import type { PrototypeStatus } from '../../prototypes/status'
import { notice } from '../../prototypes/notices'
import type { PrototypePage, PrototypePagesChange, PrototypePagesResult } from '../../prototypes/pages'
import type { PrototypeExportResult } from '../../prototypes/export'
import type { PageKind } from '../../prototypes/types'
import type { BrowserTabSummary } from '../../protocol/dto'

/**
 * One page as `tabs` reports it: what the page reports, plus what its opener said.
 * Every field the test does not care about gets the value a plain, user-opened,
 * prototype-less page would have.
 */
function tabRow(overrides: Partial<BrowserTabSummary> & { id: string }): BrowserTabSummary {
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
    reload: async () => {},
    evaluate: async (expr: string) => eval(expr),
    pick: async (_options?: { timeoutMs?: number }) => ({
      selector: '[data-testid="pay"]',
      tag: 'button',
      text: 'Pay now',
      rect: { x: 10, y: 20, width: 120, height: 40 },
    }),
    applyPrototype: async (slug: string) => ({ slug, applied: 2, files: ['A-001-btn.css', 'A-002-guard.js'], skipped: [] }),
    clearPrototype: async (slug: string) => ({ slug, removed: [`prototype:${slug}:A-001-btn.css`] }),
    verifyPrototype: async (slug: string) => ({
      slug,
      page: 'http://x.localhost/cart',
      pageName: 'cart',
      passed: 1,
      failed: 1,
      skipped: 0,
      round: 2,
      diff: {
        round: 2,
        newRed: ['endpoint: GET /api/cart'],
        stillRed: [],
        notRun: [],
        fixed: [],
        gone: [],
      },
      previous: { round: 1, at: '2026-09-16T10:00:00.000Z', passed: 2, failed: 0, skipped: 0, red: [] },
      reportPath: `/tmp/prototypes/${slug}/dist/acceptance.md`,
      statePath: `/tmp/prototypes/${slug}/acceptance/state.json`,
      results: [
        {
          requirementId: 'R-001',
          requirementTitle: 'A cart holds its line',
          kind: 'selector',
          target: '[data-total]',
          status: 'pass',
          detail: 'found on the page',
        },
        {
          requirementId: 'R-002',
          requirementTitle: 'The cart is priced by the service',
          kind: 'endpoint',
          target: 'GET /api/cart',
          status: 'fail',
          detail: 'not declared',
        },
      ],
    }),
    importPrototypeVideo: async () => ({
      session: 'import-demo-20260915-000000',
      video: 'videos/demo.mp4',
      frames: 3,
      files: ['frame-0001.jpg', 'frame-0002.jpg', 'frame-0003.jpg', 'frames.json', 'index.md'],
      truncated: false,
      durationMs: 6000,
      images: [
        { path: '/tmp/prototypes/checkout-flow/research/frames/import-demo-20260915-000000/frame-0001.jpg', bytes: new Uint8Array([1]) },
      ],
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
      stateful: 2,
      stateIssues: [],
      stateProblem: null,
    }),
    clearMock: async () => {},
    prototypeStatus: async (slug: string) => ({
      slug,
      dir: `/tmp/prototypes/${slug}`,
      pages: [
        { name: 'entry', kind: 'overlay' as const, file: null, url: 'https://app.example.com/checkout', entry: true },
      ],
      entryPage: 'entry',
      pageIssues: [],
      requirements: [],
      entryDocument: null,
      files: [],
      findings: [],
      briefIssues: [],
      frameCaptures: [],
      pageAvailable: true,
      patches: { total: 2, byWriter: { A: 2 }, scoped: 1, files: [], entries: [] },
      anchors: { files: [], issues: [] },
      services: [
        { slug: 'checkout-api', fragments: 1, fixtures: 1, endpoints: 2, mockedEndpoints: 1, statefulEndpoints: 1, missingFixtures: [] },
      ],
      distFiles: ['prototype.html', 'dev-spec.md'],
      ownership: { inspected: 4, violations: [] },
      reviews: { total: 0, byStatus: { open: 0, fixed: 0, rebutted: 0, accepted: 0 }, unresolved: [] },
      acceptance: null,
      unresolved: { unmet: [], disputes: [], redChecks: [] },
      settleBlockers: [],
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
// Helpers
// ============================================================================

/** Minimal PrototypeStatus for `status` tests — only the listed fields are read. */
function prototypeStatus(slug: string, overrides: Partial<PrototypeStatus> = {}): PrototypeStatus {
  return {
    slug,
    dir: `/tmp/prototypes/${slug}`,
    pages: [],
    entryPage: null,
    pageIssues: [],
    requirements: [],
    entryDocument: null,
    files: [],
    findings: [],
    briefIssues: [],
    frameCaptures: [],
    pageAvailable: true,
    patches: { total: 1, byWriter: { A: 1 }, scoped: 0, files: [], entries: [] },
    anchors: { files: [], issues: [] },
    services: [],
    distFiles: [],
    ownership: { inspected: 1, violations: [] },
    reviews: { total: 0, byStatus: { open: 0, fixed: 0, rebutted: 0, accepted: 0 }, unresolved: [] },
    acceptance: null,
    unresolved: { unmet: [], disputes: [], redChecks: [] },
    settleBlockers: [],
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
    handoffPath: `/tmp/prototypes/${slug}/dist/handoff.md`,
    staticDir: null,
    staticPath: null,
    staticWarnings: [],
    bookmarkletPath: null,
    applied: 2,
    pageCount: 1,
    warnings: [],
    ...overrides,
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
async function runtimeCommands(module: 'browser-commands' | 'prototype-commands'): Promise<string[]> {
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
    // Both doors: one command table, and the suite drives commands through the one that owns
    // them — a prototype command named at `browser_tool` is refused (there is a test for that).
    tools = [
      ...createBrowserTools({
        sessionId: 'test-session',
        getBrowserPaneFns: () => mockFns,
      }),
      ...createPrototypeTools({
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

  // A tool's own description is what the model reads before choosing it, and it is the only
  // place the two meanings of "project" are told apart.
  it('tells the model that a prototype is not a project', () => {
    const tool = findTool(tools, 'prototype_tool') as any
    expect(tool.description).toContain('not a project')
    expect(tool.description).toContain('projects are separate containers')
  })

  describe('prototype_tool', () => {
    it('returns exactly 1 tool (prototype_tool only)', () => {
      const prototypeOnly = createPrototypeTools({
        sessionId: 'test-session',
        getBrowserPaneFns: () => mockFns,
      })
      expect(prototypeOnly.length).toBe(1)
      expect(prototypeOnly.map((t: any) => t.name)).toEqual(['prototype_tool'])
    })

    it('documents every prototype command the runtime implements', async () => {
      const prototypeCommands = await runtimeCommands('prototype-commands')
      expect(prototypeCommands.length).toBeGreaterThan(10)

      const help = (await executeTool(tools, 'prototype_tool', { command: '--help' })).content[0].text
      expect(prototypeCommands.filter((cmd) => !help.includes(cmd))).toEqual([])
    })

    // The two doors answer "--help" with their own list: an agent that asked the prototype tool
    // what exists is not asking about the browser. The commands carry no prefix — the tool's
    // name is the subject, the way `browser_tool snapshot` reads.
    it('answers --help with the prototype commands, and the layout they write into', async () => {
      const help = (await executeTool(tools, 'prototype_tool', { command: '--help' })).content[0].text

      expect(help).toContain('prototype_tool command help')
      expect(help).toContain('  apply [slug] [--file <path>]')
      expect(help).toContain('  contract-compose [slug] [--service <svc>]')
      expect(help).toContain('PRD.md')
      expect(help).toContain('patches/')
      expect(help).not.toContain('browser_tool command help')
      expect(help).not.toContain('navigate <url>')
    })

    // The description is the whole model-facing brief for this door: what the commands act on
    // (the files) and what they drive (the shared window).
    it('describes how it uses the files and the window', () => {
      const tool = findTool(tools, 'prototype_tool') as any

      expect(tool.description).toContain('**The files**')
      expect(tool.description).toContain('**The window**')
      expect(tool.description).toContain('PRD.md')
      expect(tool.description).toContain('browser_tool')
    })

    // `browser_tool apply` reads plausible, so the refusal has to say where the other subject's
    // commands live rather than just "unknown".
    it('refuses a browser command, and names the tool that takes it', async () => {
      const result = await executeTool(tools, 'prototype_tool', { command: 'snapshot' })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Unknown prototype_tool command "snapshot"')
      expect(result.content[0].text).toContain('browser_tool')
    })

    it('runs one command per call, so a batch is refused rather than half-run', async () => {
      const result = await executeTool(tools, 'prototype_tool', {
        command: 'list; status',
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('One command per call')
    })

    it('routes apply and reports the applied patches', async () => {
      const result = await executeTool(tools, 'prototype_tool', { command: 'apply checkout-flow' })
      expect(result.content[0].text).toContain('Prototype "checkout-flow": applied 2 patches')
      expect(result.content[0].text).toContain('A-001-btn.css')
    })

    /**
     * `apply --file` is the loop for a patch being iterated on: the file is named,
     * so it is never spelled out in the command, and the patches already registered stay
     * registered — which is only visible in what the command asks the browser for.
     */
    describe('apply --file', () => {
      let workspaceRoot: string
      let fileTools: any[]

      beforeEach(() => {
        workspaceRoot = mkdtempSync(join(tmpdir(), 'browser-apply-file-'))
        fileTools = [
          ...createBrowserTools({
            sessionId: 'test-session',
            getBrowserPaneFns: () => mockFns,
            workspaceRootPath: workspaceRoot,
          }),
          ...createPrototypeTools({
            sessionId: 'test-session',
            getBrowserPaneFns: () => mockFns,
            workspaceRootPath: workspaceRoot,
          }),
        ]
      })

      afterEach(() => {
        rmSync(workspaceRoot, { recursive: true, force: true })
      })

      it('resolves the named path and asks for that one file', async () => {
        let received: { file?: string } | undefined
        mockFns.applyPrototype = async (slug, options) => {
          received = options
          return {
            slug,
            applied: 1,
            files: ['cart/ui-002-total.js'],
            skipped: [],
            page: 'cart',
            file: { name: 'cart/ui-002-total.js', page: 'cart' },
          }
        }

        const result = await executeTool(fileTools, 'prototype_tool', {
          command: 'apply checkout-flow --file prototypes/cart/patches/ui-002-total.js',
        })

        expect(received?.file).toBe(join(workspaceRoot, 'prototypes/cart/patches/ui-002-total.js'))
        expect(result.content[0].text).toContain('applied patches/cart/ui-002-total.js')
        expect(result.content[0].text).toContain('the page "cart" brings it')
      })

      /**
       * Naming a file cannot move the DOM it belongs to: with another page open, every target
       * that matched nothing has to be readable as "the wrong page is open" rather than as a
       * wrong selector.
       */
      it('says when the file belongs to a page other than the one it acted on', async () => {
        mockFns.applyPrototype = async (slug) => ({
          slug,
          applied: 1,
          files: ['cart/ui-002-total.js'],
          skipped: [],
          page: 'orders',
          file: { name: 'cart/ui-002-total.js', page: 'cart' },
        })

        const result = await executeTool(fileTools, 'prototype_tool', {
          command: 'apply checkout-flow --file prototypes/cart/patches/ui-002-total.js',
        })

        expect(result.content[0].text).toContain('acted on the page "orders"')
        expect(result.content[0].text).toContain('wrong page being open')
      })

      it('names the file it could not put on the page', async () => {
        mockFns.applyPrototype = async (slug) => ({
          slug,
          applied: 0,
          files: [],
          skipped: ['cart/ui-002-total.js'],
          page: 'cart',
          file: { name: 'cart/ui-002-total.js', page: 'cart' },
        })

        const result = await executeTool(fileTools, 'prototype_tool', {
          command: 'apply checkout-flow --file prototypes/cart/patches/ui-002-total.js',
        })

        expect(result.content[0].text).toContain('already carries patches/cart/ui-002-total.js')
        expect(result.content[0].text).toContain('run "reload"')
      })

      it('refuses --file with no path', async () => {
        const result = await executeTool(fileTools, 'prototype_tool', {
          command: 'apply checkout-flow --file',
        })

        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('--file needs a path')
      })
    })

    it('reports when apply finds no patch files', async () => {
      mockFns.applyPrototype = async (slug) => ({ slug, applied: 0, files: [], skipped: [] })
      const result = await executeTool(tools, 'prototype_tool', { command: 'apply empty-flow' })
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
      const result = await executeTool(tools, 'prototype_tool', { command: 'apply checkout-flow' })

      expect(result.content[0].text).toContain('already carries all 1 patch')
      // Named, not described: the reload it asks for is a command now.
      expect(result.content[0].text).toContain('run "reload"')
      expect(result.content[0].text).not.toContain('no patch files found')
    })

    it('requires a slug for apply', async () => {
      const result = await executeTool(tools, 'prototype_tool', { command: 'apply' })
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
      const result = await executeTool(tools, 'prototype_tool', { command: 'apply checkout-flow' })
      const text = result.content[0].text

      expect(text).toContain('matched nothing (and have never matched): .typo')
      expect(text).toContain('the page moved rather than the patch being wrong')
      expect(text).toContain('#pay')
      expect(text).toContain('No "@target" declared, so nothing could check these: A-002-guard.js')
    })

    it('routes clear and lists the removed keys', async () => {
      const result = await executeTool(tools, 'prototype_tool', { command: 'clear checkout-flow' })
      expect(result.content[0].text).toContain('removed 1 patch')
      expect(result.content[0].text).toContain('prototype:checkout-flow:A-001-btn.css')
    })

    it('routes export and points at the deliverable', async () => {
      const result = await executeTool(tools, 'prototype_tool', { command: 'export checkout-flow' })
      expect(result.content[0].text).toContain('exported 1 page(s) and 2 patches')
      expect(result.content[0].text).toContain('/dist/extension')
      expect(result.content[0].text).toContain('/dist/dev-spec.md')
    })

    // The gate (plan §3.7). Without `--strict` the deliverable is still built — being able to look
    // at an unfinished prototype is the point of building one — but what is outstanding is said out
    // loud rather than left for the recipient to discover. With it, an unattended run stops instead
    // of handing over something nobody checked.
    it('refuses to export an unsettled prototype under --strict, naming what is outstanding', async () => {
      let calls = 0
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          unresolved: { unmet: ['R-003'], disputes: [], redChecks: ['selector: [data-cart-total]'] },
        })
      mockFns.exportPrototype = async (slug) => {
        calls += 1
        return exported(slug)
      }

      const result = await executeTool(tools, 'prototype_tool', {
        command: 'export checkout-flow --strict',
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('is not settled')
      expect(result.content[0].text).toContain('R-003 is in PRD.md but no page or patch refers to it')
      expect(result.content[0].text).toContain('`selector: [data-cart-total]` failed')
      // Nothing was written: refusing is the whole point of the flag.
      expect(calls).toBe(0)
    })

    it('exports an unsettled prototype without --strict, and says what is outstanding', async () => {
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, { unresolved: { unmet: ['R-003'], disputes: [], redChecks: [] } })

      const result = await executeTool(tools, 'prototype_tool', { command: 'export checkout-flow' })

      expect(result.isError).toBeUndefined()
      expect(result.content[0].text).toContain('exported 1 page(s)')
      expect(result.content[0].text).toContain('not settled — 1 thing(s) still outstanding')
      expect(result.content[0].text).toContain('R-003 is in PRD.md')
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

      const live = await executeTool(tools, 'prototype_tool', { command: 'export checkout-flow' })
      expect(live.content[0].text).toContain('exported 1 page(s)')
      expect(live.content[0].text).toContain('puts its patches on the 1 live')
      // No page of ours in the package, so there is nothing to open here.
      expect(live.content[0].text).not.toContain('page(s) of ours ship inside')
      expect(live.content[0].text).not.toContain('browser_tool navigate')
      // …and no static half either: a live page is not ours to freeze.
      expect(live.content[0].text).not.toContain('  Static:')

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

      const mixed = await executeTool(tools, 'prototype_tool', { command: 'export checkout-flow' })
      expect(mixed.content[0].text).toContain('exported 2 page(s)')
      expect(mixed.content[0].text).toContain('puts its patches on the 1 live')
      expect(mixed.content[0].text).toContain('The 1 page(s) of ours ship inside the package')
      // The packaged page can be opened here first, and it is named as it is
      // served — the one inside the package, not the prototype root.
      expect(mixed.content[0].text).toContain(
        'browser_tool navigate http://checkout-flow.localhost:41234/dist/extension/cart.html',
      )
    })

    // The live pages' half in the carrier that needs nothing installed (plan §17.9):
    // printed only when there is one, like the static half — a path for a file that
    // is not there would read as a broken export.
    it('names the bookmarklet file for the live pages, and only when there is one', async () => {
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          pages: [page('entry', 'overlay', { url: 'https://app.example.com/checkout' }, true)],
          entryPage: 'entry',
        })
      mockFns.exportPrototype = async (slug) =>
        exported(slug, {
          bookmarkletPath: `/tmp/prototypes/${slug}/dist/bookmarklet.html`,
        })

      const withLive = await executeTool(tools, 'prototype_tool', { command: 'export checkout-flow' })

      expect(withLive.content[0].text).toContain('  Bookmarklet: /tmp/prototypes/checkout-flow/dist/bookmarklet.html')
      expect(withLive.content[0].text).toContain('links to drag onto the bookmarks bar')

      // No live page, no bookmarklet, and nothing said about one: the export result
      // is what decides, so a stale file cannot be advertised either.
      mockFns.exportPrototype = async (slug) => exported(slug)

      const scratchOnly = await executeTool(tools, 'prototype_tool', { command: 'export checkout-flow' })

      expect(scratchOnly.content[0].text).not.toContain('Bookmarklet:')
    })

    // A package that had to rewrite part of the document has to say so, or the
    // author reads a clean export and never learns what moved.
    it('passes on what the package had to change about the document', async () => {
      mockFns.exportPrototype = async (slug) =>
        exported(slug, { warnings: ['2 inline <script> block(s) were moved into files.'] })

      const result = await executeTool(tools, 'prototype_tool', { command: 'export checkout-flow' })

      expect(result.content[0].text).toContain('adapted for the extension')
      expect(result.content[0].text).toContain('2 inline <script> block(s) were moved into files.')
    })

    // The second deliverable (plan §17.8): the same pages as files a reader can
    // open with nothing installed — and the one thing such a file cannot carry.
    it('names the static files the pages of ours were written to', async () => {
      mockFns.exportPrototype = async (slug) =>
        exported(slug, {
          pagePath: `/tmp/prototypes/${slug}/dist/extension/cart.html`,
          staticDir: `/tmp/prototypes/${slug}/dist/static`,
          staticPath: `/tmp/prototypes/${slug}/dist/static/cart.html`,
          staticWarnings: [
            'cart.html: the page references `/missing/app.css`, which is not a file of this prototype.',
          ],
        })

      const result = await executeTool(tools, 'prototype_tool', { command: 'export checkout-flow' })

      expect(result.content[0].text).toContain('  Static: /tmp/prototypes/checkout-flow/dist/static')
      expect(result.content[0].text).toContain('double-click /tmp/prototypes/checkout-flow/dist/static/cart.html')
      // A broken reference is not an extension adaptation, so it is not under that
      // heading — an author who reads only one of the two blocks would fix the
      // wrong thing.
      expect(result.content[0].text).toContain('could not carry everything the document asks for')
      expect(result.content[0].text).not.toContain('adapted for the extension')
    })

    it('requires a slug for export', async () => {
      const result = await executeTool(tools, 'prototype_tool', { command: 'export' })
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

      const result = await executeTool(tools, 'prototype_tool', { command: 'pages checkout-flow' })

      expect(result.content[0].text).toContain('2 page(s), in flow order')
      expect(result.content[0].text).toContain('entry (overlay) [entry] — https://app.example.com/cart')
      expect(result.content[0].text).toContain('payment (overlay) — https://app.example.com/checkout/payment')
      expect(result.content[0].text).toContain('pages --add <name>=<url>')
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
          pageIssues: [notice('page.documentMissing', { name: 'orders', file: 'orders.html' })],
        })

      const result = await executeTool(tools, 'prototype_tool', { command: 'pages checkout-flow' })

      expect(result.content[0].text).toContain('cart (scratch) [entry] — cart.html')
      expect(result.content[0].text).toContain('orders (scratch) — document missing')
      expect(result.content[0].text).toContain('Issues (fix or acknowledge these')
      expect(result.content[0].text).toContain('orders.html is not in the prototype directory')
    })

    it('says how to make a first page when the table is empty', async () => {
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, { pages: [], pageAvailable: false })

      const result = await executeTool(tools, 'prototype_tool', { command: 'pages checkout-flow' })

      expect(result.content[0].text).toContain('no pages yet')
      expect(result.content[0].text).toContain('a top-level <name>.html')
      expect(result.content[0].text).toContain('pages --add <name>=<url>')
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

      const result = await executeTool(tools, 'prototype_tool', {
        command: 'pages checkout-flow --add payment=https://app.example.com/checkout/payment',
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

      const result = await executeTool(tools, 'prototype_tool', { command: 'pages checkout-flow --add cart' })

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

      const result = await executeTool(tools, 'prototype_tool', { command: 'pages checkout-flow --add orders' })

      expect(result.content[0].text).toContain('orders.html has to exist')
      expect(result.content[0].text).toContain('/tmp/prototypes/checkout-flow/orders.html')
    })

    it('removes and renames pages', async () => {
      const changes: unknown[] = []
      mockFns.setPrototypePages = async (slug, change) => {
        changes.push(change)
        return { slug, pages: [], note: `${change.op} page` }
      }

      await executeTool(tools, 'prototype_tool', { command: 'pages checkout-flow --remove payment' })
      await executeTool(tools, 'prototype_tool', { command: 'pages checkout-flow --rename cart=basket' })

      expect(changes).toEqual([
        { op: 'remove', name: 'payment' },
        { op: 'rename', from: 'cart', to: 'basket' },
      ])
    })

    it('asks for the value it needs instead of guessing', async () => {
      const malformed = [
        ['pages checkout-flow --add', /--add needs a page name/],
        ['pages checkout-flow --rename cart', /--rename needs old=new/],
        ['pages checkout-flow --remove', /--remove needs a page name/],
        ['pages checkout-flow --add a=b --remove c', /one change at a time/],
      ] as const

      for (const [command, expected] of malformed) {
        const result = await executeTool(tools, 'prototype_tool', { command })
        expect(result.content[0].text).toMatch(expected)
      }
    })

    it('routes contract-compose with a service flag', async () => {
      let received: { slug: string; service?: string } | undefined
      mockFns.composeContract = async (options) => {
        received = options
        return { service: 'checkout-api', endpoints: 5, conflicts: ['/orders'], missingFixtures: ['x-200'] }
      }

      const result = await executeTool(tools, 'prototype_tool', {
        command: 'contract-compose checkout-flow --service checkout-api',
      })

      expect(received).toEqual({ slug: 'checkout-flow', service: 'checkout-api' })
      expect(result.content[0].text).toContain('composed 5 endpoints')
      expect(result.content[0].text).toContain('Duplicate path')
      expect(result.content[0].text).toContain('x-200')
    })

    it('routes contract-export and reports the deliverables', async () => {
      const result = await executeTool(tools, 'prototype_tool', {
        command: 'contract-export checkout-flow',
      })

      expect(result.content[0].text).toContain('exported contract with 3 endpoints')
      expect(result.content[0].text).toContain('/dist/openapi.yaml')
      expect(result.content[0].text).toContain('/dist/contract.md')
      expect(result.content[0].text).toContain('/dist/fixtures')
    })

    it('routes mock-apply and reports skipped/unmocked endpoints', async () => {
      mockFns.applyMock = async (_options) => ({
        service: 'checkout-api',
        routes: 2,
        missingFixtures: ['nope-200'],
        unmocked: ['GET /health'],
        stateful: 1,
        stateIssues: [],
        stateProblem: null,
      })

      const result = await executeTool(tools, 'prototype_tool', {
        command: 'mock-apply checkout-flow --service checkout-api',
      })

      expect(result.content[0].text).toContain('serving 2 mock routes')
      expect(result.content[0].text).toContain('GET /health')
      expect(result.content[0].text).toContain('nope-200')
    })

    it('routes mock-clear', async () => {
      let cleared = false
      mockFns.clearMock = async () => {
        cleared = true
      }

      const result = await executeTool(tools, 'prototype_tool', { command: 'mock-clear' })

      expect(cleared).toBe(true)
      expect(result.content[0].text).toContain('Mock cleared')
    })

    // The two things a reader has to know before calling a prototype finished, and the line that
    // says it is not: what was argued, and what the last verification answered. Both come from the
    // same report the gate reads, so the command cannot look calmer than the export would be.
    it('reports what the last round answered, what stands disputed, and what is still owed', async () => {
      const dispute = {
        id: 'D-001',
        file: 'reviews/D-001-total.md',
        status: 'open' as const,
        stale: true,
        staleReason: 'patches/main-001-total.css has changed since this was filed (a1b2c3d4 → e5f6a7b8)',
        about: 'patch patches/main-001-total.css',
        claim: 'the total scrolls off screen',
      }
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          reviews: { total: 2, byStatus: { open: 1, fixed: 1, rebutted: 0, accepted: 0 }, unresolved: [dispute] },
          acceptance: { round: 3, at: '2026-09-16T10:00:00.000Z', passed: 1, failed: 1, skipped: 0, red: ['selector: [data-cart-total]'] },
          unresolved: { unmet: [], disputes: [dispute], redChecks: ['selector: [data-cart-total]'] },
        })

      const result = await executeTool(tools, 'prototype_tool', { command: 'status checkout-flow' })
      const text = result.content[0].text

      expect(text).toContain('reviews:    1 standing of 2 filed')
      expect(text).toContain('acceptance: round 3 — 1 passed, 1 failed, 0 skipped')
      expect(text).toContain('unresolved: 2')
      expect(text).toContain('reviews/D-001-total.md disputes patch patches/main-001-total.css')
      expect(text).toContain('`selector: [data-cart-total]` failed in the last verification round')
    })

    it('says so when nothing is owed, rather than staying quiet', async () => {
      const result = await executeTool(tools, 'prototype_tool', { command: 'status checkout-flow' })

      expect(result.content[0].text).toContain('unresolved: nothing')
      expect(result.content[0].text).toContain('acceptance: never run here')
    })

    it('reports the round it ran and what moved, and hands over how to argue with a failure', async () => {
      const result = await executeTool(tools, 'prototype_tool', { command: 'verify checkout-flow' })
      const text = result.content[0].text

      expect(text).toContain('Acceptance — round 2: 1 passed, 1 failed, 0 skipped')
      expect(text).toContain('Since round 1:')
      expect(text).toContain('NEWLY RED   endpoint: GET /api/cart')
      expect(text).toContain('about: endpoint GET /api/cart · status: open')
      expect(text).toContain('acceptance/state.json')
    })

    it('requires a slug for mock-apply', async () => {
      const result = await executeTool(tools, 'prototype_tool', { command: 'mock-apply' })
      expect(result.content[0].text).toContain('needs a prototype')
    })

    it('routes status and reports the summary plus ownership violations', async () => {
      mockFns.prototypeStatus = async (slug) => ({
        slug,
        dir: `/tmp/prototypes/${slug}`,
        pages: [
          page('entry', 'overlay', { url: 'https://app.example.com/checkout' }, true),
          page('login', 'overlay', { url: 'https://app.example.com/login' }),
        ],
        entryPage: 'entry',
        pageAvailable: true,
        pageIssues: [],
        requirements: [],
        entryDocument: null,
        files: [],
        findings: [],
        briefIssues: [],
        frameCaptures: [],
        patches: { total: 2, byWriter: { A: 2 }, scoped: 1, files: [], entries: [] },
        anchors: { files: [], issues: [] },
        services: [
          { slug: 'checkout-api', fragments: 1, fixtures: 1, endpoints: 2, mockedEndpoints: 1, statefulEndpoints: 0, missingFixtures: ['nope-200'] },
        ],
        distFiles: ['prototype.html'],
        ownership: { inspected: 5, violations: [{ path: 'patches/oops.css', reason: 'misnamed patch' }] },
        reviews: { total: 0, byStatus: { open: 0, fixed: 0, rebutted: 0, accepted: 0 }, unresolved: [] },
        acceptance: null,
        unresolved: { unmet: [], disputes: [], redChecks: [] },
        settleBlockers: [],
      })

      const result = await executeTool(tools, 'prototype_tool', { command: 'status checkout-flow' })

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
      const result = await executeTool(tools, 'prototype_tool', { command: 'status checkout-flow' })
      expect(result.content[0].text).toContain('ownership:  OK (4 files)')
    })

    // `/` is a page of the flow only when one carries the entry flag; without it
    // the root is the generated index, and the two read nothing alike.
    it('says which page the address root opens, or that it shows the index', async () => {
      const withEntry = await executeTool(tools, 'prototype_tool', { command: 'status checkout-flow' })
      expect(withEntry.content[0].text).toContain('root:       opens "entry"')

      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          pages: [page('cart', 'scratch', { file: 'cart.html' })],
          entryPage: null,
        })
      const withoutEntry = await executeTool(tools, 'prototype_tool', { command: 'status checkout-flow' })
      expect(withoutEntry.content[0].text).toContain('root:       shows the generated page index')
    })

    // A page issue is a screen that is not there (or a patch nothing replays), and
    // the status is the only place that says which.
    it('lists the page issues, which a clean prototype does not have', async () => {
      const clean = await executeTool(tools, 'prototype_tool', { command: 'status checkout-flow' })
      expect(clean.content[0].text).not.toContain('page issues:')

      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          pages: [page('cart', 'scratch', {}, true)],
          entryPage: 'cart',
          pageIssues: [
            notice('page.documentMissing', { name: 'cart', file: 'cart.html' }),
            notice('page.patchScopeUnmatched', { name: 'orders', pages: 'cart' }),
          ],
        })

      const issues = await executeTool(tools, 'prototype_tool', { command: 'status checkout-flow' })
      expect(issues.content[0].text).toContain('page issues: 2')
      expect(issues.content[0].text).toContain('cart.html is not in the prototype directory')
      expect(issues.content[0].text).toContain('patches/orders/ belongs to no page')
    })

    // One window, many pages. Opening used to mean "navigate this window", which
    // is what made a second prototype replace the first; now the prototype gets a
    // page of its own, and that page is told whose it is — the only place it can be
    // recorded, since an overlay's document is a third-party address (plan §22).
    it('opens the prototype in a page of its own', async () => {
      const opened: Array<{ url?: string; activate?: boolean; prototype?: { slug: string; origin: string } | null }> = []
      mockFns.createTab = async (options) => {
        opened.push(options ?? {})
        return 'tab-7'
      }
      mockFns.navigate = async (url) => ({ url, title: 'Checkout' })
      mockFns.listTabs = async () => ([
        tabRow({ id: 'tab-1', url: 'https://app.example.com/checkout', title: 'Checkout' }),
        tabRow({
          id: 'tab-7',
          url: 'http://checkout-flow.localhost:41234/',
          title: 'Checkout',
          active: true,
          prototype: { slug: 'checkout-flow', origin: 'http://checkout-flow.localhost:41234' },
          belongsTo: { kind: 'session', sessionId: 'session-a' },
          driverSessionId: 'session-a',
        }),
      ])

      const result = await executeTool(tools, 'prototype_tool', { command: 'open checkout-flow' })

      expect(opened).toEqual([
        { activate: false, prototype: { slug: 'checkout-flow', origin: 'http://checkout-flow.localhost:41234' } },
      ])
      // Which tab it is, and that there is another one — the only place a reader
      // can learn it until the window has a tab strip.
      expect(result.content[0].text).toContain('Tab: tab-7')
      expect(result.content[0].text).toContain('1 other tab')
    })

    it('routes open to the entry page', async () => {
      let navigated = ''
      mockFns.navigate = async (url) => {
        navigated = url
        return { url, title: 'Checkout' }
      }

      const result = await executeTool(tools, 'prototype_tool', { command: 'open checkout-flow' })

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

      const result = await executeTool(tools, 'prototype_tool', { command: 'open checkout-flow' })

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

      const result = await executeTool(tools, 'prototype_tool', { command: 'open checkout-flow' })

      expect(navigated).toBe('http://checkout-flow.localhost:41234/')
      expect(result.content[0].text).toContain('opened entry page "entry"')
    })

    it('requires a slug for open', async () => {
      const result = await executeTool(tools, 'prototype_tool', { command: 'open' })
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

      const result = await executeTool(tools, 'prototype_tool', {
        command: 'open checkout-flow --page orders',
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

      const result = await executeTool(tools, 'prototype_tool', {
        command: 'open checkout-flow --page nope',
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

      const result = await executeTool(tools, 'prototype_tool', {
        command: 'open checkout-flow --page orders',
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

      const result = await executeTool(tools, 'prototype_tool', { command: 'open checkout-flow' })

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

      const result = await executeTool(tools, 'prototype_tool', { command: 'open checkout-flow' })

      expect(result.content[0].text).toContain('landed on: https://app.example.com/login?next=%2Fcheckout')
    })

    // ========================================================================
    // Prototype binding — a bound session drives the prototype without slugs.
    // ========================================================================

    it('falls back to the bound prototype when no slug is passed', async () => {
      mockFns.getBoundPrototypeSlug = () => 'bound-flow'
      const result = await executeTool(tools, 'prototype_tool', { command: 'apply' })
      expect(result.content[0].text).toContain('Prototype "bound-flow": applied 2 patches')
    })

    it('lets an explicit slug win over the binding', async () => {
      mockFns.getBoundPrototypeSlug = () => 'bound-flow'
      const result = await executeTool(tools, 'prototype_tool', { command: 'apply other-flow' })
      expect(result.content[0].text).toContain('Prototype "other-flow"')
    })

    it('treats a leading flag as "no slug" so options can follow the command directly', async () => {
      mockFns.getBoundPrototypeSlug = () => 'bound-flow'
      const result = await executeTool(tools, 'prototype_tool', {
        command: 'contract-compose --service checkout-api',
      })
      // The bound slug was used, not the literal "--service".
      expect(result.content[0].text).toContain('Prototype "bound-flow" service "checkout-api"')
    })

    // Neither the page nor a binding says which prototype is meant, so the answer has to be
    // actionable without one: name one, or open it (which is what makes the page say whose it is).
    it('names both ways out when there is no slug, no page and no binding', async () => {
      const result = await executeTool(tools, 'prototype_tool', { command: 'apply' })
      expect(result.content[0].text).toContain('apply <slug>')
      expect(result.content[0].text).toContain('open <slug>')
      expect(result.content[0].text).toContain('list')
    })

    it('lists prototypes, marks the bound one, and says which have no pages', async () => {
      mockFns.getBoundPrototypeSlug = () => 'checkout-flow'
      mockFns.listPrototypes = async () => [
        prototypeStatus('checkout-flow'),
        prototypeStatus('draft', {
          pageAvailable: false,
          patches: { total: 0, byWriter: {}, scoped: 0, files: [], entries: [] },
          anchors: { files: [], issues: [] },
        }),
        prototypeStatus('no-target', { pageAvailable: false }),
      ]

      const result = await executeTool(tools, 'prototype_tool', { command: 'list' })
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

      const result = await executeTool(tools, 'prototype_tool', { command: 'list' })
      const text = result.content[0].text

      expect(text).toContain('cart (scratch) [entry] — cart.html')
      expect(text).toContain('pay (overlay) — https://app.example.com/pay')
      expect(text).toContain('cart (overlay) [entry] — https://rival.example.com/cart')
      expect(text).toContain('entry: cart')
    })

    it('creates a prototype and binds the session in the same step', async () => {
      const bound: Array<string | null> = []
      mockFns.bindPrototype = async (slug) => { bound.push(slug) }

      const result = await executeTool(tools, 'prototype_tool', {
        command: 'create Checkout flow',
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

      const result = await executeTool(tools, 'prototype_tool', { command: 'create Landing page' })

      expect(seen).toEqual([{ name: 'Landing page' }])

      const text = result.content[0].text
      expect(text).toContain('It has no pages yet')
      // Both kinds are named, with the move that places each one.
      expect(text).toContain('a document of ours')
      expect(text).toContain('pages --add pay=https://app.example.com/pay')
      expect(text).toContain('entry cart')
      expect(text).toContain('open')
    })

    it('asks for a name, which is all creation needs', async () => {
      const result = await executeTool(tools, 'prototype_tool', { command: 'create' })
      expect(result.content[0].text).toContain('needs a name')
    })

    /**
     * The same page lives in a dev, a staging and a production environment, and the
     * same patches are meant to be looked at in each of them — so the address is not
     * a rule to be fixed but a fact about where the page is. Changing it is a table
     * edit like the others (`pages --change`), and what quietly goes stale with it is
     * what the command has to say.
     */
    it('repoints a live page, naming what goes stale with it', async () => {
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

      const result = await executeTool(tools, 'prototype_tool', {
        command: 'pages --change entry=https://staging.example.com/checkout',
      })

      // The page is named in the flag, and its name is passed through rather than left for
      // the other side to work out a second time — the table is the list of names.
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

    it('moves only the page named, and lists the pages when the name is unknown', async () => {
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

      // The entry page here is a document of ours, so there is nothing to fall back to:
      // the flag says which page moves, and only that one is touched.
      const moved = await executeTool(tools, 'prototype_tool', {
        command: 'pages --change pay=https://staging.example.com/pay',
      })
      expect(seen).toEqual([['checkout-flow', 'https://staging.example.com/pay', 'pay']])
      expect(moved.content[0].text).toContain('page "pay" pointed somewhere else')

      const unknown = await executeTool(tools, 'prototype_tool', {
        command: 'pages --change nope=https://staging.example.com/nope',
      })
      expect(unknown.content[0].text).toContain('has no page "nope"')
      expect(unknown.content[0].text).toContain('cart')
    })

    // A document of ours has no external page for an address to mean, and that refusal comes
    // from the same function the app's own address dialog uses — the command reports it
    // rather than swallowing it.
    it('reports the refusal when the address belongs to a page of ours', async () => {
      mockFns.getBoundPrototypeSlug = () => 'checkout-flow'
      mockFns.prototypeStatus = async (slug) =>
        prototypeStatus(slug, {
          pages: [page('cart', 'scratch', { file: 'cart.html' }, true)],
          entryPage: 'cart',
        })
      mockFns.setPrototypePageUrl = async () => {
        throw new Error('"cart" is a document of ours — its file is the page, so it has no address to change.')
      }

      const result = await executeTool(tools, 'prototype_tool', {
        command: 'pages --change cart=https://staging.example.com/cart',
      })

      expect(result.content[0].text).toContain('is a document of ours')
    })

    it('needs <name>=<url>, and a prototype in view to change it on', async () => {
      // Which prototype it means is settled first, as for every other flag on this command:
      // a session with nothing in view is told that, not told its flag is malformed.
      mockFns.getBoundPrototypeSlug = () => 'checkout-flow'

      const noValue = await executeTool(tools, 'prototype_tool', { command: 'pages --change' })
      expect(noValue.content[0].text).toContain('pages --change needs <name>=<url>')

      const noName = await executeTool(tools, 'prototype_tool', {
        command: 'pages --change https://staging.example.com/checkout',
      })
      expect(noName.content[0].text).toContain('pages --change needs <name>=<url>')

      // Unlike the flag it grew out of, this one resolves a slug — so with nothing in view
      // the refusal is the shared one, and it names both ways to answer it.
      mockFns.getBoundPrototypeSlug = () => null
      const unbound = await executeTool(tools, 'prototype_tool', {
        command: 'pages --change pay=https://staging.example.com/pay',
      })
      expect(unbound.content[0].text).toContain('pages needs a prototype')
      expect(unbound.content[0].text).toContain('open <slug>')
    })

    // `entry` is the only change to the table about the front door
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

      const result = await executeTool(tools, 'prototype_tool', { command: 'entry cart' })

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

      const result = await executeTool(tools, 'prototype_tool', { command: 'entry none' })

      expect(seen).toEqual([{ slug: 'checkout-flow', change: { op: 'entry', name: null } }])
      expect(result.content[0].text).toContain('shows the page index again')
      expect(result.content[0].text).toContain('cart (scratch) — a document of ours')
    })

    it('says where to go when entry runs with no prototype in view', async () => {
      const result = await executeTool(tools, 'prototype_tool', { command: 'entry cart' })

      expect(result.content[0].text).toContain('none is in view')
      expect(result.content[0].text).toContain('open <slug>')
    })

    it('asks which page when entry is given none', async () => {
      const result = await executeTool(tools, 'prototype_tool', { command: 'entry' })
      expect(result.content[0].text).toContain('needs a page name, or "none"')
    })

    // Without this, creating a prototype you only mean to study would rebind the
    // session to it and every later slug-less command would retarget it.
    it('leaves the session binding alone with --no-bind', async () => {
      let bound = false
      mockFns.bindPrototype = async () => { bound = true }

      const result = await executeTool(tools, 'prototype_tool', {
        command: 'create Rival checkout --no-bind',
      })

      expect(bound).toBe(false)
      expect(result.content[0].text).toContain('not bound')
    })

    it('still binds by default, so the name keeps its spaces', async () => {
      const bound: Array<string | null> = []
      mockFns.bindPrototype = async (slug) => { bound.push(slug) }

      await executeTool(tools, 'prototype_tool', { command: 'create Checkout flow' })

      expect(bound).toEqual(['checkout-flow'])
    })
  })

  describe('browser_tool', () => {
    it('documents every browser command the runtime implements', async () => {
      const browserCommands = await runtimeCommands('browser-commands')
      expect(browserCommands.length).toBeGreaterThan(20)

      const help = (await executeTool(tools, 'browser_tool', { command: '--help' })).content[0].text
      expect(browserCommands.filter((cmd) => !help.includes(cmd))).toEqual([])
    })

    // The mirror of the prototype door's refusal: `browser_tool apply` is a plausible thing to
    // ask for, and the answer has to point at the tool that takes it.
    it('refuses a prototype command, and names the tool that takes it', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'list' })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Unknown browser_tool command "list"')
      expect(result.content[0].text).toContain('prototype_tool')
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

    /**
     * `evaluate --file` exists so a script the agent already wrote (a patch, usually) can be
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
        const absolute = writeScript('prototypes/cart/patches/ui-002-total.js', 'document.title + "!"\n')

        let evaluatedExpression = ''
        mockFns.evaluate = async (expression) => {
          evaluatedExpression = expression
          return 'Cart'
        }

        const result = await executeTool(fileTools, 'browser_tool', {
          command: 'evaluate --file prototypes/cart/patches/ui-002-total.js',
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
          command: 'evaluate --file prototypes/cart/patches/missing.js',
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
    // command can name one (plan §22). The list is what makes naming possible.
    it('lists this window\'s tabs with the one on screen marked', async () => {
      mockFns.listTabs = async () => ([
        tabRow({
          id: 'tab-1',
          url: 'https://app.example.com/checkout',
          title: 'Checkout',
          active: true,
          prototype: { slug: 'checkout-flow', origin: 'http://checkout-flow-1a2b.localhost:41234' },
          prototypePage: 'cart',
          belongsTo: { kind: 'session', sessionId: 'session-a' },
          driverSessionId: 'session-b',
        }),
        tabRow({ id: 'tab-2', url: 'https://docs.example.com', title: 'Docs', isLoading: true }),
      ])

      const text = (await executeTool(tools, 'browser_tool', { command: 'tabs' })).content[0].text

      expect(text).toContain('has 2 tabs')
      expect(text).toContain('* tab-1  Checkout')
      expect(text).toContain('prototype:  checkout-flow')
      expect(text).toContain('page:       cart')
      // Whose page it is, and who is on it: the first decides what may be closed,
      // the second is who is mid-work (plan §22).
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
          driverSessionId: 'session-b',
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
    // the person clicking around moves their own view, and this must not move with it
    // (plan §22, 第十轮). Only the reader's own tab is marked — another conversation's is
    // not this reader's business.
    it('marks the page this conversation works from, and only its own', async () => {
      mockFns.listTabs = async () => ([
        tabRow({ id: 'tab-1', url: 'https://app.example.com/checkout', title: 'Checkout', active: true }),
        tabRow({ id: 'tab-2', url: 'https://docs.example.com', title: 'Docs', cursorOf: 'test-session' }),
        tabRow({ id: 'tab-3', url: 'https://other.example.com', title: 'Other', cursorOf: 'session-b' }),
      ])

      const text = (await executeTool(tools, 'browser_tool', { command: 'tabs' })).content[0].text

      expect(text).toContain('your tab:  yes — a command that names no tab acts here')
      expect(text.match(/your tab: {2}/g)).toHaveLength(1)
      // The tab on screen is not it, which is the whole point: `tab-1` stays unmarked even
      // though it is the one showing.
      expect(text).toContain('* tab-1  Checkout')
      expect(text).toContain('the person switching tabs does not move it')
    })

    // A page the prototype's own table does not describe is said so, rather than
    // being handed the nearest page name.
    it('says when a page is not one of the prototype\'s pages', async () => {
      mockFns.listTabs = async () => ([
        tabRow({
          id: 'tab-1',
          url: 'https://app.example.com/somewhere-else',
          title: 'Somewhere else',
          active: true,
          prototype: { slug: 'checkout-flow', origin: 'http://checkout-flow-1a2b.localhost:41234' },
        }),
      ])

      const text = (await executeTool(tools, 'browser_tool', { command: 'tabs' })).content[0].text

      expect(text).toContain('prototype:  checkout-flow')
      expect(text).toContain('none of the prototype\'s pages')
    })

    it('says so when there is no window whose pages could be listed', async () => {
      mockFns.listTabs = async () => []

      const text = (await executeTool(tools, 'browser_tool', { command: 'tabs' })).content[0].text

      expect(text).toContain('No browser window is open')
    })

    // Naming a page targets it: the command runs against that page — and the window is not
    // moved, because the person may be reading another one of its pages (plan §22, 第十二轮).
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
      // take their page away (plan §22, 第十二轮), and "tab-show" is how one is brought up.
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
