import { describe, it, expect, beforeEach } from 'bun:test';
import {
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  getSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tools.ts';
import type { BrowserPaneFns } from '../browser-tools.ts';

describe('session-scoped tool callback merge', () => {
  const sessionId = 'test-session-merge';

  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(sessionId);
  });

  it('preserves existing browserPaneFns when merging turn-level callbacks', () => {
    const browserPaneFns: BrowserPaneFns = {
      openPanel: async () => ({ instanceId: 'browser-1' }),
      navigate: async () => ({ url: 'https://example.com', title: 'Example' }),
      snapshot: async () => ({ url: 'https://example.com', title: 'Example', nodes: [] }),
      click: async () => {},
      clickAt: async () => {},
      drag: async () => {},
      fill: async () => {},
      type: async () => {},
      select: async () => {},
      setClipboard: async () => {},
      getClipboard: async () => 'clipboard',
      screenshot: async () => ({ imageBuffer: Buffer.from('png'), imageFormat: 'png' as const }),
      screenshotRegion: async () => ({ imageBuffer: Buffer.from('png'), imageFormat: 'png' as const }),
      getConsoleLogs: async () => [],
      windowResize: async () => ({ width: 1280, height: 720 }),
      getNetworkLogs: async () => [],
      waitFor: async () => ({ ok: true as const, kind: 'network-idle', elapsedMs: 0, detail: 'ok' }),
      sendKey: async () => {},
      getDownloads: async () => [],
      upload: async () => {},
      scroll: async () => {},
      goBack: async () => {},
      goForward: async () => {},
      evaluate: async () => 'ok',
      pick: async () => null,
      applyPrototype: async (slug: string) => ({ slug, applied: 0, files: [], skipped: [] }),
      clearPrototype: async (slug: string) => ({ slug, removed: [] }),
      commitPrototype: async (slug: string) => ({ slug, scopes: [], nothingToCommit: true }),
      setPrototypeProject: async () => ({ slug: 'checkout-flow', projectSlug: null }),
      verifyPrototype: async (slug: string) => ({
        slug,
        page: null,
        passed: 0,
        failed: 0,
        skipped: 0,
        reportPath: `/tmp/prototypes/${slug}/dist/acceptance.md`,
        results: [],
      }),
      startPrototypeFrames: async () => ({
        startedAt: '2026-09-15T00:00:00.000Z',
        intervalMs: 400,
        threshold: 0.005,
        maxFrames: 60,
      }),
      stopPrototypeFrames: async () => null,
      importPrototypeVideo: async () => null,
      exportPrototype: async (slug: string) => ({
        slug,
        extensionDir: '/tmp/prototypes/checkout-flow/dist/extension',
        pagePath: null,
        pageUrl: null,
        version: '1.20000.630',
        specPath: '/tmp/dev-spec.md',
        applied: 0,
        pageCount: 0,
        warnings: [],
      }),
      composeContract: async ({ slug, service }: { slug: string; service?: string }) => ({
        service: service ?? 'api',
        endpoints: 0,
        conflicts: [],
        missingFixtures: [],
      }),
      exportContract: async ({ slug, service }: { slug: string; service?: string }) => ({
        service: service ?? 'api',
        openapiPath: '/tmp/openapi.yaml',
        docPath: '/tmp/contract.md',
        fixturesDir: '/tmp/fixtures',
        endpoints: 0,
        fixtures: 0,
        missingFixtures: [],
        conflicts: [],
      }),
      applyMock: async ({ slug, service }: { slug: string; service?: string }) => ({
        service: service ?? 'api',
        routes: 0,
        missingFixtures: [],
        unmocked: [],
      }),
      clearMock: async () => {},
      prototypeStatus: async (slug: string) => ({
        slug,
        dir: '/tmp/prototypes',
        references: [],
        projectSlug: null,
        pages: [],
        entryPage: null,
        pageIssues: [],
        requirements: [],
        findings: [],
        briefIssues: [],
        frameCaptures: [],
        pageAvailable: false,
        patches: { total: 0, byLane: {}, scoped: 0, files: [], entries: [] },
        anchors: { files: [], issues: [] },
        services: [],
        distFiles: [],
        ownership: { inspected: 0, violations: [] },
        lanes: {},
      }),
      prototypeEntry: async ({ slug }: { slug: string }) => ({
        page: null,
        path: null,
        url: `http://${slug}.localhost:41234/`,
        origin: `http://${slug}.localhost:41234`,
        injectPatches: false,
      }),
      getBoundPrototypeSlug: () => null,
      listPrototypes: async () => [],
      createPrototype: async ({ name }: { name: string }) => ({
        slug: name,
        dir: `/tmp/prototypes/${name}`,
        patchesPath: `/tmp/prototypes/${name}/patches`,
      }),
      setPrototypePageUrl: async (_slug: string, url: string, page?: string) => ({
        pages: [{ name: page ?? 'entry', kind: 'overlay' as const, url, entry: page === undefined }],
      }),
      setPrototypePages: async (slug: string) => ({ slug, pages: [], note: 'no change' }),
      bindPrototype: async (_slug: string | null) => {},
      linkPrototypeReference: async (_slug: string, referenceSlug: string) => ({ references: [referenceSlug] }),
      unlinkPrototypeReference: async () => ({ references: [] }),
      focusWindow: async () => ({ instanceId: 'browser-1', title: 'Example', url: 'https://example.com' }),
      createTab: async () => 'tab-1',
      activateTab: async () => {},
      closeTab: async () => ({ remaining: 1 }),
      listTabs: async () => [],
      releaseControl: async () => ({ action: 'released' as const, affectedIds: [] }),
      closeWindow: async () => ({ action: 'closed' as const, affectedIds: [] }),
      hideWindow: async () => ({ action: 'hidden' as const, affectedIds: [] }),
      listWindows: async () => [],
      detectChallenge: async () => ({ detected: false, provider: 'none', signals: [] }),
    };

    registerSessionScopedToolCallbacks(sessionId, {
      browserPaneFns,
    });

    const queryFn = async () => ({ text: 'ok', model: 'test' });
    mergeSessionScopedToolCallbacks(sessionId, { queryFn });

    const merged = getSessionScopedToolCallbacks(sessionId);
    expect(merged).toBeTruthy();
    expect(merged?.browserPaneFns).toBe(browserPaneFns);
    expect(merged?.queryFn).toBe(queryFn);
  });
});
