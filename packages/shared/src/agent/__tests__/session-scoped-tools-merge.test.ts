import { describe, it, expect, beforeEach } from 'bun:test';
import {
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  getSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tools.ts';
import type { BrowserPaneFns } from '../browser-pane.ts';

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
      resizeViewport: async () => ({ width: 1280, height: 720 }),
      getNetworkLogs: async () => [],
      waitFor: async () => ({ ok: true as const, kind: 'network-idle', elapsedMs: 0, detail: 'ok' }),
      sendKey: async () => {},
      getDownloads: async () => [],
      upload: async () => {},
      scroll: async () => {},
      goBack: async () => {},
      goForward: async () => {},
      reload: async () => {},
      evaluate: async () => 'ok',
      pick: async () => null,
      sampleVideo: async () => ({
        durationMs: 12_000,
        truncated: false,
        frames: [
          { offsetMs: 0, bytes: new Uint8Array([1]), path: null },
        ],
      }),
      exportDrawio: async () => ({
        bytes: new Uint8Array([1]),
        mimeType: 'image/svg+xml',
        extension: '.svg',
        path: null,
      }),
      listDrawioPages: async () => [],
      prototypeStatus: async (slug: string) => ({
        slug,
        dir: '/tmp/prototypes',
        requirements: [],
        specificationFiles: [],
        files: [],
        links: [],
        findings: [],
        reviews: { total: 0, byStatus: { open: 0, fixed: 0, rebutted: 0, accepted: 0 }, unresolved: [] },
        unresolved: { unmet: [], disputes: [] },
        settleBlockers: [],
        briefIssues: [],
      }),
      getBoundPrototypeSlug: () => null,
      listPrototypes: async () => [],
      createPrototype: async ({ name }: { name: string }) => ({
        slug: name,
        dir: `/tmp/prototypes/${name}`,
        prdPath: `/tmp/prototypes/${name}/PRD.md`,
      }),
      bindPrototype: async (_slug: string | null) => {},
      focusWindow: async () => ({ instanceId: 'browser-1', title: 'Example', url: 'https://example.com' }),
      createTab: async () => 'tab-1',
      targetTab: async () => {},
      activateTab: async () => ({ movedView: true }),
      closeTab: async () => ({ remaining: 1 }),
      assignTab: async () => {},
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
