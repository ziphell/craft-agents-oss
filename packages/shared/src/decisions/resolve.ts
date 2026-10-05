/**
 * Decision layer — resolve a ready-to-use client from settings + credentials.
 *
 * Gate order (all must pass, otherwise `{ ok: false }`):
 *   1. `DecisionLayerSettings.enabled` — the Settings > AI switch is the only master gate
 *   2. the requested feature toggle (optional)
 *   3. a key: from an LLM connection (`connectionSlug`) or `decision_api_key::{provider}`
 *   4. a valid endpoint (custom provider needs a base URL)
 *
 * Callers on hot paths use `getDecisionClient()` and treat `null` as "behave as
 * before" (invariant 2). Callers that explain themselves (Settings → Test) use
 * `resolveDecisionClient()` and read the failure.
 */

import { getCredentialManager, type CredentialManager } from '../credentials/index.ts';
import { getDecisionLayerSettings, getLlmConnection } from '../config/storage.ts';
import { SystemOneClient } from './client.ts';
import { DECISION_PROVIDER_PRESETS, decisionProviderForConnection } from './providers.ts';
import { resolveDecisionEndpoint, type DecisionLayerFeature, type DecisionLayerSettings, type ResolvedDecisionEndpoint } from './settings.ts';
import { isDecisionError, type DecisionFailure, type DecisionProviderId } from './types.ts';

export interface ResolvedDecisionClient {
  client: SystemOneClient;
  settings: DecisionLayerSettings;
  provider: DecisionProviderId;
  endpoint: ResolvedDecisionEndpoint;
  /** Where the key came from. `none` only for providers that do not require one. */
  keySource: 'connection' | 'provider' | 'none';
}

export type DecisionClientResolution =
  | { ok: true; value: ResolvedDecisionClient }
  | { ok: false; failure: DecisionFailure };

export interface ResolveDecisionClientOptions {
  /** Defaults to the stored settings. */
  settings?: DecisionLayerSettings;
  credentialManager?: CredentialManager;
  /** Also require this feature toggle to be on. */
  feature?: DecisionLayerFeature;
  /** Skip the enabled + feature gates (Settings → Test must work before enabling). */
  skipGates?: boolean;
  /** Use this key instead of looking one up (unsaved key typed into Settings). */
  apiKeyOverride?: string;
  fetch?: typeof globalThis.fetch;
}

/** Master switch on. Sync; no key check. */
export function isDecisionLayerActive(settings: DecisionLayerSettings = getDecisionLayerSettings()): boolean {
  return settings.enabled;
}

/** Master switch on AND the feature toggle on. Sync; no key check. */
export function isDecisionFeatureActive(feature: DecisionLayerFeature, settings: DecisionLayerSettings = getDecisionLayerSettings()): boolean {
  return isDecisionLayerActive(settings) && settings.features[feature];
}

function fail(failure: DecisionFailure): DecisionClientResolution {
  return { ok: false, failure };
}

export async function resolveDecisionClient(options: ResolveDecisionClientOptions = {}): Promise<DecisionClientResolution> {
  const settings = options.settings ?? getDecisionLayerSettings();

  if (!options.skipGates) {
    if (!settings.enabled) {
      return fail({ kind: 'disabled', message: 'The decision model is disabled in Settings > AI' });
    }
    if (options.feature && !settings.features[options.feature]) {
      return fail({ kind: 'disabled', message: `The decision model feature '${options.feature}' is disabled in Settings > AI` });
    }
  }

  const credentialManager = options.credentialManager ?? getCredentialManager();
  let provider: DecisionProviderId = settings.provider;
  let apiKey: string | undefined;
  let keySource: ResolvedDecisionClient['keySource'] = 'none';

  if (options.apiKeyOverride?.trim()) {
    apiKey = options.apiKeyOverride.trim();
    keySource = 'provider';
  } else if (settings.connectionSlug) {
    const connection = getLlmConnection(settings.connectionSlug);
    if (!connection) {
      return fail({ kind: 'unconfigured', message: `Decision model: LLM connection '${settings.connectionSlug}' no longer exists` });
    }
    const derived = decisionProviderForConnection(connection.piAuthProvider);
    if (!derived) {
      return fail({ kind: 'unconfigured', message: `Decision model: connection '${connection.name}' is not an OpenRouter or Vercel AI Gateway connection` });
    }
    provider = derived;
    const key = await credentialManager.getLlmApiKey(connection.slug);
    if (!key) {
      return fail({ kind: 'unconfigured', message: `Decision model: connection '${connection.name}' has no API key stored` });
    }
    apiKey = key;
    keySource = 'connection';
  } else {
    const key = await credentialManager.getDecisionApiKey(provider);
    if (key) {
      apiKey = key;
      keySource = 'provider';
    } else if (DECISION_PROVIDER_PRESETS[provider].requiresKey) {
      return fail({
        kind: 'unconfigured',
        message: `Decision model: no API key stored for ${DECISION_PROVIDER_PRESETS[provider].label}. Add one in Settings > AI > Decision model`,
      });
    }
  }

  let endpoint: ResolvedDecisionEndpoint;
  try {
    endpoint = resolveDecisionEndpoint(settings, provider);
  } catch (error) {
    if (isDecisionError(error)) return fail(error.toFailure());
    throw error;
  }

  const client = new SystemOneClient({
    baseUrl: endpoint.baseUrl,
    apiKey,
    model: endpoint.model,
    defaultDeadlineMs: settings.deadlineMs,
    extraHeaders: endpoint.extraHeaders,
    // Some servers enforce a smaller state cap than the client default (laya-serve: 50k chars).
    maxStateBytes: endpoint.preset.maxStateBytes,
    fetch: options.fetch,
  });

  return { ok: true, value: { client, settings, provider, endpoint, keySource } };
}

/** Fail-closed convenience: `null` whenever the layer cannot be used. */
export async function getDecisionClient(options: ResolveDecisionClientOptions = {}): Promise<ResolvedDecisionClient | null> {
  try {
    const resolution = await resolveDecisionClient(options);
    return resolution.ok ? resolution.value : null;
  } catch {
    return null;
  }
}
