import { describe, it, expect, beforeEach } from 'bun:test';
import {
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  getSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tools.ts';
import type { PrototypeKind } from '../../prototypes/config.ts';

describe('session-scoped tool callback merge', () => {
  const sessionId = 'test-session-merge';

  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(sessionId);
  });

  it('preserves existing browserPaneFns when merging turn-level callbacks', () => {
    const browserPaneFns = {
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
      exportPrototype: async (slug: string) => ({
        slug,
        htmlPath: '/tmp/prototype.html',
        htmlUrl: 'file:///tmp/prototype.html',
        specPath: '/tmp/dev-spec.md',
        applied: 0,
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
        kind: 'overlay' as const,
        references: [],
        baseHtmlPresent: false,
        baseHtmlPath: null,
        patches: { total: 0, byLane: {}, files: [] },
        services: [],
        distFiles: [],
        ownership: { inspected: 0, violations: [] },
        lanes: {},
      }),
      prototypeEntry: async ({ slug }: { slug: string }) => ({
        path: '/tmp/base.html',
        url: 'http://checkout-flow.localhost:41234/',
      }),
      getBoundPrototypeSlug: () => null,
      listPrototypes: async () => [],
      createPrototype: async ({ name, kind }: { name: string; kind?: PrototypeKind; targetUrl?: string }) => ({
        slug: name,
        dir: `/tmp/prototypes/${name}`,
        baseHtmlPath: `/tmp/prototypes/${name}/base.html`,
        kind: kind ?? 'overlay',
      }),
      bindPrototype: async (_slug: string | null) => {},
      linkPrototypeReference: async (_slug: string, referenceSlug: string) => ({ references: [referenceSlug] }),
      unlinkPrototypeReference: async () => ({ references: [] }),
      focusWindow: async () => ({ instanceId: 'browser-1', title: 'Example', url: 'https://example.com' }),
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
