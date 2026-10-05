import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_DECISION_LAYER_SETTINGS,
  mergeDecisionLayerSettings,
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
} from './settings.ts';
import { buildSystemOneEndpoint, decisionProviderForConnection, DECISION_PROVIDER_PRESETS } from './providers.ts';
import { DecisionError, DECISION_MAX_DEADLINE_MS, DECISION_MIN_DEADLINE_MS } from './types.ts';
import { accountToCredentialId, credentialIdToAccount } from '../credentials/types.ts';

describe('normalizeDecisionLayerSettings', () => {
  it('is off by default with every feature toggle on', () => {
    expect(normalizeDecisionLayerSettings(undefined)).toEqual(DEFAULT_DECISION_LAYER_SETTINGS);
    expect(normalizeDecisionLayerSettings(null)).toEqual(DEFAULT_DECISION_LAYER_SETTINGS);
    expect(DEFAULT_DECISION_LAYER_SETTINGS.enabled).toBe(false);
  });

  it('drops garbage and clamps the deadline', () => {
    const settings = normalizeDecisionLayerSettings({
      enabled: 'yes' as unknown as boolean,
      provider: 'nope' as never,
      connectionSlug: '   ',
      baseUrl: ' https://jev.local ',
      model: '',
      deadlineMs: 5,
      features: { decideTool: false, taskVerdicts: 'x' as unknown as boolean },
    });
    expect(settings.enabled).toBe(false);
    expect(settings.provider).toBe('typesafe');
    expect(settings.connectionSlug).toBeUndefined();
    expect(settings.baseUrl).toBe('https://jev.local');
    expect(settings.model).toBeUndefined();
    expect(settings.deadlineMs).toBe(DECISION_MIN_DEADLINE_MS);
    expect(settings.features).toEqual({ decideTool: false, taskVerdicts: true, semanticLabels: true });
    expect(normalizeDecisionLayerSettings({ deadlineMs: 10 ** 9 }).deadlineMs).toBe(DECISION_MAX_DEADLINE_MS);
  });
});

describe('mergeDecisionLayerSettings', () => {
  it('merges features key-wise and lets null clear optional strings', () => {
    const current = { enabled: true, provider: 'openrouter' as const, connectionSlug: 'openrouter-main', features: { decideTool: false } };
    const merged = mergeDecisionLayerSettings(current, { connectionSlug: null, model: ' typesafe/jev-1.13 ', features: { taskVerdicts: false } });
    expect(merged).toEqual({ enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13', features: { decideTool: false, taskVerdicts: false } });
  });

  it('drops baseUrl/model overrides when the provider or connection changes, unless the patch sets them', () => {
    const custom = { enabled: true, provider: 'custom' as const, baseUrl: 'http://old-box:8080', model: 'my-local-jev' };
    // switching to a hosted provider must not keep pointing at the old box
    expect(mergeDecisionLayerSettings(custom, { provider: 'typesafe' })).toEqual({ enabled: true, provider: 'typesafe' });
    // same provider: overrides stay
    expect(mergeDecisionLayerSettings(custom, { provider: 'custom', enabled: false })).toEqual({ ...custom, enabled: false });
    // patch may set new overrides together with the switch
    expect(mergeDecisionLayerSettings(custom, { provider: 'openrouter', model: 'typesafe/jev-1.13' })).toEqual({ enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13' });
    // choosing / clearing a connection also counts as a provider change
    expect(mergeDecisionLayerSettings(custom, { connectionSlug: 'openrouter-main', provider: 'openrouter' })).toEqual({ enabled: true, provider: 'openrouter', connectionSlug: 'openrouter-main' });
    const viaConnection = { provider: 'openrouter' as const, connectionSlug: 'openrouter-main', model: 'typesafe/jev-1.13' };
    expect(mergeDecisionLayerSettings(viaConnection, { connectionSlug: null })).toEqual({ provider: 'openrouter' });
    expect(mergeDecisionLayerSettings(viaConnection, { connectionSlug: 'openrouter-main', enabled: true })).toEqual({ ...viaConnection, enabled: true });
  });

  it('ignores invalid values in the patch', () => {
    const merged = mergeDecisionLayerSettings(undefined, { enabled: 'true', provider: 'bogus', deadlineMs: '12', features: 'x' });
    expect(merged).toEqual({});
  });
});

describe('resolveDecisionEndpoint', () => {
  it('uses the preset base URL and pinned model for each hosted provider', () => {
    const typesafe = resolveDecisionEndpoint(normalizeDecisionLayerSettings({ provider: 'typesafe' }));
    expect(typesafe.endpoint).toBe('https://api.typesafe.ai/v1/systemone');
    expect(typesafe.model).toBe('jev-1.13.0');

    const openrouter = resolveDecisionEndpoint(normalizeDecisionLayerSettings({ provider: 'openrouter' }));
    expect(openrouter.endpoint).toBe('https://openrouter.ai/api/v1/systemone');
    expect(openrouter.model).toBe('typesafe/jev-1.13');
    expect(openrouter.extraHeaders['X-Title']).toBe('Craft Agents');

    const vercel = resolveDecisionEndpoint(normalizeDecisionLayerSettings({ provider: 'vercel-ai-gateway' }));
    expect(vercel.endpoint).toBe('https://ai-gateway.vercel.sh/typesafe/v1/systemone');
    expect(vercel.model).toBe('typesafe-ai/jev');
  });

  it('laya is a keyless local preset on loopback with a tighter state cap', () => {
    const laya = resolveDecisionEndpoint(normalizeDecisionLayerSettings({ provider: 'laya' }));
    expect(laya.endpoint).toBe('http://127.0.0.1:8000/v1/systemone');
    expect(laya.model).toBe('auto');
    expect(laya.preset.requiresKey).toBe(false);
    expect(laya.preset.local).toBe(true);
    expect(laya.preset.healthPath).toBe('/health');
    expect(laya.preset.maxStateBytes).toBeLessThan(50_000);
    expect(laya.preset.installHint).toContain('laya-serve');
    // a different port is an ordinary base URL override
    expect(resolveDecisionEndpoint(normalizeDecisionLayerSettings({ provider: 'laya', baseUrl: 'http://127.0.0.1:9000' })).endpoint).toBe('http://127.0.0.1:9000/v1/systemone');
  });

  it('lets a connection override the configured provider and honours base URL / model overrides', () => {
    const resolved = resolveDecisionEndpoint(normalizeDecisionLayerSettings({ provider: 'typesafe', model: 'jev-1.12.0' }), 'openrouter');
    expect(resolved.provider).toBe('openrouter');
    expect(resolved.model).toBe('jev-1.12.0');
    const custom = resolveDecisionEndpoint(normalizeDecisionLayerSettings({ provider: 'custom', baseUrl: 'http://localhost:8080/v1/systemone/' }));
    expect(custom.endpoint).toBe('http://localhost:8080/v1/systemone');
  });

  it('fails closed for custom without a base URL or with an invalid one', () => {
    expect(() => resolveDecisionEndpoint(normalizeDecisionLayerSettings({ provider: 'custom' }))).toThrow(DecisionError);
    try {
      resolveDecisionEndpoint(normalizeDecisionLayerSettings({ provider: 'custom', baseUrl: 'not a url' }));
    } catch (error) {
      expect((error as DecisionError).kind).toBe('unconfigured');
    }
  });
});

describe('providers', () => {
  it('never pins a floating model alias on hosted providers', () => {
    for (const preset of Object.values(DECISION_PROVIDER_PRESETS)) {
      expect(preset.defaultModel).not.toContain('latest');
      // local servers choose their own checkpoint (`auto` routes by language on laya-serve)
      if (!preset.local) expect(preset.defaultModel).not.toBe('auto');
    }
  });

  it('maps LLM connections to the decision provider that can reuse their key', () => {
    expect(decisionProviderForConnection('openrouter')).toBe('openrouter');
    expect(decisionProviderForConnection('vercel-ai-gateway')).toBe('vercel-ai-gateway');
    expect(decisionProviderForConnection('openai')).toBeNull();
    expect(decisionProviderForConnection(undefined)).toBeNull();
  });

  it('builds endpoints tolerant of trailing slashes and pre-suffixed URLs', () => {
    expect(buildSystemOneEndpoint('https://api.typesafe.ai/')).toBe('https://api.typesafe.ai/v1/systemone');
    expect(buildSystemOneEndpoint('https://x.test/v1/systemone')).toBe('https://x.test/v1/systemone');
    expect(() => buildSystemOneEndpoint('   ')).toThrow();
  });
});

describe('decision_api_key credential account format', () => {
  it('round-trips decision_api_key::{provider}', () => {
    const account = credentialIdToAccount({ type: 'decision_api_key', name: 'openrouter' });
    expect(account).toBe('decision_api_key::openrouter');
    expect(accountToCredentialId(account)).toEqual({ type: 'decision_api_key', name: 'openrouter' });
    expect(accountToCredentialId('decision_api_key::global')).toEqual({ type: 'decision_api_key' });
    expect(accountToCredentialId('decision_api_key::a::b')).toBeNull();
  });
});
