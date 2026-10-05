/**
 * Decision layer — status + connectivity test for the Settings UI (and RPC).
 */

import { getCredentialManager, type CredentialManager } from '../credentials/index.ts';
import { getDecisionLayerSettings, getLlmConnections } from '../config/storage.ts';
import { DECISION_PROVIDER_IDS, toDecisionFailure, type DecisionFailure, type DecisionProviderId, type DecisionRequest } from './types.ts';
import { DECISION_PROVIDER_PRESETS, decisionProviderForConnection } from './providers.ts';
import { getDecisionRecorder } from './records.ts';
import { resolveDecisionClient } from './resolve.ts';
import { normalizeDecisionLayerSettings, type DecisionLayerSettings, type DecisionLayerSettingsPatch } from './settings.ts';

export interface DecisionProviderPresetSummary {
  id: DecisionProviderId;
  label: string;
  baseUrl: string;
  defaultModel: string;
  keyPlaceholder: string;
  dashboardUrl?: string;
  docsUrl?: string;
  requiresKey: boolean;
  /** Runs on the user's machine; the Settings card shows a server probe instead of a key hint. */
  local?: boolean;
  installHint?: string;
}

export interface DecisionReusableConnection {
  slug: string;
  name: string;
  provider: DecisionProviderId;
}

export interface DecisionLayerStatus {
  settings: DecisionLayerSettings;
  /** Providers with a stored `decision_api_key`. */
  providersWithKey: DecisionProviderId[];
  /** LLM connections whose key can be reused (OpenRouter, Vercel AI Gateway). */
  reusableConnections: DecisionReusableConnection[];
  presets: DecisionProviderPresetSummary[];
}

export async function getDecisionLayerStatus(credentialManager: CredentialManager = getCredentialManager()): Promise<DecisionLayerStatus> {
  const providersWithKey: DecisionProviderId[] = [];
  for (const provider of DECISION_PROVIDER_IDS) {
    if (await credentialManager.getDecisionApiKey(provider)) providersWithKey.push(provider);
  }

  const reusableConnections: DecisionReusableConnection[] = [];
  for (const connection of getLlmConnections()) {
    const provider = decisionProviderForConnection(connection.piAuthProvider);
    if (provider) reusableConnections.push({ slug: connection.slug, name: connection.name, provider });
  }

  return {
    settings: getDecisionLayerSettings(),
    providersWithKey,
    reusableConnections,
    presets: DECISION_PROVIDER_IDS.map(id => {
      const preset = DECISION_PROVIDER_PRESETS[id];
      const summary: DecisionProviderPresetSummary = {
        id,
        label: preset.label,
        baseUrl: preset.baseUrl,
        defaultModel: preset.defaultModel,
        keyPlaceholder: preset.keyPlaceholder,
        requiresKey: preset.requiresKey,
      };
      if (preset.dashboardUrl) summary.dashboardUrl = preset.dashboardUrl;
      if (preset.docsUrl) summary.docsUrl = preset.docsUrl;
      if (preset.local) summary.local = true;
      if (preset.installHint) summary.installHint = preset.installHint;
      return summary;
    }),
  };
}

export type DecisionTestResult =
  | { ok: true; provider: DecisionProviderId; endpoint: string; model: string; latencyMs: number; noul: number }
  | { ok: false; provider?: DecisionProviderId; endpoint?: string; failure: DecisionFailure };

export interface DecisionTestOptions {
  /** Unsaved edits from the Settings form, applied over the stored settings (`null` clears a field). */
  settings?: DecisionLayerSettingsPatch;
  /** Unsaved key typed into the Settings form. */
  apiKey?: string;
  credentialManager?: CredentialManager;
  fetch?: typeof globalThis.fetch;
}

/** One canned noul question; the answer is expected to lean "yes". */
export const DECISION_TEST_REQUEST: DecisionRequest = {
  state: 'Deployment finished. All 42 checks passed and the service is serving traffic.',
  questions: {
    succeeded: {
      type: 'noul',
      instructions: 'Did the deployment succeed?',
    },
  },
  deadlineMs: 10_000,
};

/**
 * Round-trip one canned question through the configured provider. Works with
 * the master switch off (skipGates) so users can verify a key before enabling.
 */
export async function testDecisionConnection(options: DecisionTestOptions = {}): Promise<DecisionTestResult> {
  const stored = getDecisionLayerSettings();
  // Spread the patch over the stored settings; normalize() drops `null`, which is
  // exactly the "clear this field" meaning the patch gives it.
  const settings = options.settings
    ? normalizeDecisionLayerSettings({
        ...stored,
        ...(options.settings as Record<string, unknown>),
        features: { ...stored.features, ...(options.settings.features ?? {}) },
      } as Parameters<typeof normalizeDecisionLayerSettings>[0])
    : stored;

  const resolution = await resolveDecisionClient({
    settings,
    credentialManager: options.credentialManager,
    skipGates: true,
    apiKeyOverride: options.apiKey,
    fetch: options.fetch,
  });
  if (!resolution.ok) return { ok: false, failure: resolution.failure };

  const { client, provider, endpoint } = resolution.value;
  const recorder = getDecisionRecorder();
  const startedAt = performance.now();
  try {
    const result = await client.decide(DECISION_TEST_REQUEST);
    void recorder.record({ feature: 'settings_test', provider, model: endpoint.model, questions: DECISION_TEST_REQUEST.questions, result });
    const answer = result.answers.succeeded;
    return {
      ok: true,
      provider,
      endpoint: endpoint.endpoint,
      model: result.model,
      latencyMs: result.latencyMs,
      noul: answer?.type === 'noul' ? answer.noul : 0,
    };
  } catch (error) {
    void recorder.record({
      feature: 'settings_test',
      provider,
      model: endpoint.model,
      questions: DECISION_TEST_REQUEST.questions,
      error,
      latencyMs: Math.round(performance.now() - startedAt),
    });
    return { ok: false, provider, endpoint: endpoint.endpoint, failure: toDecisionFailure(error) };
  }
}
