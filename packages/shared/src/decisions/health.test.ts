import { describe, it, expect } from 'bun:test';
import { probeDecisionServer, probeConfiguredDecisionServer, DECISION_PROBE_TIMEOUT_MS } from './health.ts';
import { normalizeDecisionLayerSettings } from './settings.ts';

function stub(handler: (url: string) => Response | Promise<Response>): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return handler(String(input));
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, urls };
}

describe('probeDecisionServer', () => {
  it('reads laya-serve health', async () => {
    const { fetch, urls } = stub(() => new Response(JSON.stringify({ status: 'ok', loaded: ['english', 'multilingual'], device: 'cpu', revisions: {} }), { status: 200 }));
    const probe = await probeDecisionServer('laya', 'http://127.0.0.1:8000/', { fetch });
    expect(urls).toEqual(['http://127.0.0.1:8000/health']);
    expect(probe.reachable).toBe(true);
    expect(probe.status).toBe(200);
    expect(probe.health).toEqual({ status: 'ok', loaded: ['english', 'multilingual'], device: 'cpu' });
    expect(probe.message).toBeUndefined();
  });

  it('treats 404 as reachable without a health endpoint, other statuses as reachable with a message', async () => {
    const notFound = await probeDecisionServer('custom', 'http://localhost:9000', { fetch: stub(() => new Response('nope', { status: 404 })).fetch });
    expect(notFound.reachable).toBe(true);
    expect(notFound.message).toContain('no health endpoint');
    const error = await probeDecisionServer('custom', 'http://localhost:9000', { fetch: stub(() => new Response('x', { status: 503 })).fetch });
    expect(error.reachable).toBe(true);
    expect(error.message).toContain('503');
  });

  it('never throws on network errors, timeouts or bad URLs', async () => {
    const down = await probeDecisionServer('laya', 'http://127.0.0.1:1', { fetch: stub(() => { throw new TypeError('fetch failed'); }).fetch });
    expect(down.reachable).toBe(false);
    expect(down.message).toBe('Could not connect');

    const slow = await probeDecisionServer('laya', 'http://127.0.0.1:1', {
      timeoutMs: 250,
      fetch: (async (_u: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as unknown as typeof fetch,
    });
    expect(slow.reachable).toBe(false);
    expect(slow.message).toContain('250 ms');
    expect(DECISION_PROBE_TIMEOUT_MS).toBeGreaterThan(0);

    const bad = await probeDecisionServer('custom', 'not a url', { fetch: stub(() => new Response('')).fetch });
    expect(bad.reachable).toBe(false);
    expect(bad.message).toContain('not a valid URL');
  });

  it('non-JSON health bodies are reported, not thrown', async () => {
    const probe = await probeDecisionServer('laya', 'http://127.0.0.1:8000', { fetch: stub(() => new Response('OK', { status: 200 })).fetch });
    expect(probe.reachable).toBe(true);
    expect(probe.health).toBeUndefined();
    expect(probe.message).toContain('did not return JSON');
  });
});

describe('probeConfiguredDecisionServer', () => {
  it('uses the preset base URL for laya, the settings base URL otherwise, and an explicit override first', async () => {
    const { fetch, urls } = stub(() => new Response('{}', { status: 200 }));
    await probeConfiguredDecisionServer(normalizeDecisionLayerSettings({ provider: 'laya' }), { fetch });
    await probeConfiguredDecisionServer(normalizeDecisionLayerSettings({ provider: 'custom', baseUrl: 'http://box:8080' }), { fetch });
    await probeConfiguredDecisionServer(normalizeDecisionLayerSettings({ provider: 'laya' }), { fetch, baseUrlOverride: 'http://127.0.0.1:9001' });
    expect(urls).toEqual(['http://127.0.0.1:8000/health', 'http://box:8080/health', 'http://127.0.0.1:9001/health']);
  });

  it('reports a missing base URL for custom without probing', async () => {
    const { fetch, urls } = stub(() => new Response('{}'));
    const probe = await probeConfiguredDecisionServer(normalizeDecisionLayerSettings({ provider: 'custom' }), { fetch });
    expect(probe.reachable).toBe(false);
    expect(probe.message).toContain('No base URL');
    expect(urls).toEqual([]);
  });
});
