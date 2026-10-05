import { afterEach, describe, expect, it } from 'bun:test';
import { anthropicDriver } from './anthropic.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('anthropicDriver.fetchModels', () => {
  it('filters deprecated Opus 4.5, keeps Opus 4.6, prefers Opus 5.5 as default, and sizes unknown models from the API', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', created_at: '2026-01-01T00:00:00Z', type: 'model' },
        { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-05-01T00:00:00Z', type: 'model' },
        { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', created_at: '2026-04-01T00:00:00Z', type: 'model' },
        { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', created_at: '2025-11-01T00:00:00Z', type: 'model' },
        { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2026-01-01T00:00:00Z', type: 'model' },
        { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-22T00:00:00Z', type: 'model', max_input_tokens: 1_000_000 },
        // Not in MODEL_REGISTRY: metadata must come from the API response, not the 200K fallback.
        { id: 'claude-zeta-9', display_name: 'Claude Zeta 9', created_at: '2026-12-01T00:00:00Z', type: 'model', max_input_tokens: 500_000 },
      ],
      has_more: false,
      first_id: 'claude-opus-4-6',
      last_id: 'claude-zeta-9',
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await anthropicDriver.fetchModels!({
      connection: {
        slug: 'anthropic',
        name: 'Anthropic',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: Date.now(),
      } as any,
      credentials: { apiKey: 'sk-ant-test' },
      hostRuntime: {} as any,
      resolvedPaths: {} as any,
      timeoutMs: 30_000,
    });

    expect(result.serverDefault).toBe('claude-opus-5-5');
    expect(result.models.map(m => m.id)).toEqual([
      'claude-opus-4-6',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-opus-5-5',
      'claude-zeta-9',
    ]);
    const opus55 = result.models.find(m => m.id === 'claude-opus-5-5')!;
    expect(opus55.name).toBe('Opus 5.5');
    expect(opus55.contextWindow).toBe(1_000_000);
    expect(opus55.thinkingAlwaysOn).toBe(true);
    const opus48 = result.models.find(m => m.id === 'claude-opus-4-8')!;
    expect(opus48.name).toBe('Opus 4.8');
    expect(opus48.contextWindow).toBe(1_000_000);
    const opus46 = result.models.find(m => m.id === 'claude-opus-4-6')!;
    expect(opus46.name).toBe('Opus 4.6');
    expect(opus46.contextWindow).toBe(200_000);
    const zeta = result.models.find(m => m.id === 'claude-zeta-9')!;
    expect(zeta.name).toBe('Claude Zeta 9');
    expect(zeta.shortName).toBe('Zeta');
    expect(zeta.contextWindow).toBe(500_000);
  });

  it('falls back to the default when the server does not list the registry default', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-03-01T00:00:00Z', type: 'model', max_input_tokens: 1_000_000 },
        { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z', type: 'model', max_input_tokens: 200_000 },
      ],
      has_more: false,
      first_id: 'claude-sonnet-5',
      last_id: 'claude-haiku-4-5-20251001',
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await anthropicDriver.fetchModels!({
      connection: { slug: 'anthropic', name: 'Anthropic', providerType: 'anthropic', authType: 'api_key', createdAt: Date.now() } as any,
      credentials: { apiKey: 'sk-ant-test' },
      hostRuntime: {} as any,
      resolvedPaths: {} as any,
      timeoutMs: 30_000,
    });

    expect(result.serverDefault).toBe('claude-sonnet-5');
  });
});
