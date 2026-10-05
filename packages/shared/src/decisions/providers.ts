/**
 * Decision layer — provider presets.
 *
 * All providers speak the same System One wire format; they differ only in
 * base URL, model id and how the key is issued and billed.
 */

import type { DecisionProviderId } from './types.ts';

export interface DecisionProviderPreset {
  id: DecisionProviderId;
  label: string;
  /** Base URL; the client appends `/v1/systemone`. Empty for `custom` (user supplies it). */
  baseUrl: string;
  /**
   * Pinned model id where the provider offers one. Never `jev-latest`: a silent
   * model change must not move decisions. Gateways that only expose an alias
   * (Vercel: `typesafe-ai/jev`) are covered by recording the reported model.
   */
  defaultModel: string;
  /** Placeholder for the key input. */
  keyPlaceholder: string;
  /** Where the user gets a key / sees usage. */
  dashboardUrl?: string;
  docsUrl?: string;
  /** Headers added to every request (e.g. OpenRouter app attribution). */
  extraHeaders?: Record<string, string>;
  /** Whether a key is mandatory. Local Jev-compatible servers may run without auth. */
  requiresKey: boolean;
  /**
   * `piAuthProvider` values of LLM connections whose stored key can be reused
   * for this provider (same account, same billing).
   */
  reusableConnectionProviders: readonly string[];
  /** Runs on the user's machine (or their own server): no account, no metering, state never leaves the host. */
  local?: boolean;
  /** Health probe path (GET) for local servers, e.g. `/health` on `laya-serve`. */
  healthPath?: string;
  /** Shell command that installs and starts the server; shown in Settings when the probe fails. */
  installHint?: string;
  /** Tighter state cap than the client default when the server enforces one. */
  maxStateBytes?: number;
}

/** `laya-serve` default bind (compose publishes it on loopback only). */
export const DEFAULT_LAYA_BASE_URL = 'http://127.0.0.1:8000';

export const DECISION_PROVIDER_PRESETS: Record<DecisionProviderId, DecisionProviderPreset> = {
  typesafe: {
    id: 'typesafe',
    label: 'TypeSafe AI (direct)',
    baseUrl: 'https://api.typesafe.ai',
    defaultModel: 'jev-1.13.0',
    keyPlaceholder: 'TypeSafe API key',
    docsUrl: 'https://docs.typesafe.ai',
    requiresKey: true,
    reusableConnectionProviders: [],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    defaultModel: 'typesafe/jev-1.13',
    keyPlaceholder: 'sk-or-v1-...',
    dashboardUrl: 'https://openrouter.ai/settings/keys',
    docsUrl: 'https://openrouter.ai/typesafe/jev-1.13',
    extraHeaders: { 'X-Title': 'Craft Agents' },
    requiresKey: true,
    reusableConnectionProviders: ['openrouter'],
  },
  'vercel-ai-gateway': {
    id: 'vercel-ai-gateway',
    label: 'Vercel AI Gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/typesafe',
    // The gateway lists only this alias (verified 2026-09-25); the served model is recorded per call.
    defaultModel: 'typesafe-ai/jev',
    keyPlaceholder: 'AI Gateway API key',
    docsUrl: 'https://vercel.com/docs/ai-gateway',
    requiresKey: true,
    reusableConnectionProviders: ['vercel-ai-gateway'],
  },
  laya: {
    id: 'laya',
    label: 'Laya (local, open source)',
    baseUrl: DEFAULT_LAYA_BASE_URL,
    // `laya-serve` maps unknown ids to its router (`auto`): English text goes to the English
    // checkpoint, everything else to the multilingual one. `english`, `multilingual` and
    // `typed-decisions` pin a checkpoint. The served checkpoint is recorded per call.
    defaultModel: 'auto',
    keyPlaceholder: 'Optional: the LAYA_API_KEY you started the server with',
    docsUrl: 'https://github.com/NandhaKishorM/laya',
    requiresKey: false,
    reusableConnectionProviders: [],
    local: true,
    healthPath: '/health',
    installHint: 'pip install "laya[serve]" && laya-serve',
    // laya-serve rejects states over 50,000 characters with 413.
    maxStateBytes: 48 * 1024,
  },
  custom: {
    id: 'custom',
    label: 'Custom (Jev-compatible server)',
    baseUrl: '',
    defaultModel: 'jev-1.13.0',
    keyPlaceholder: 'API key (optional for local servers)',
    requiresKey: false,
    reusableConnectionProviders: [],
    local: true,
    healthPath: '/health',
  },
};

export function getDecisionProviderPreset(id: DecisionProviderId): DecisionProviderPreset {
  return DECISION_PROVIDER_PRESETS[id];
}

/** Map an LLM connection's `piAuthProvider` to the decision provider that can reuse its key. */
export function decisionProviderForConnection(piAuthProvider: string | undefined): DecisionProviderId | null {
  if (!piAuthProvider) return null;
  for (const preset of Object.values(DECISION_PROVIDER_PRESETS)) {
    if (preset.reusableConnectionProviders.includes(piAuthProvider)) return preset.id;
  }
  return null;
}

/** `{base}/v1/systemone` with duplicate slashes and a trailing `/v1/systemone` tolerated. */
export function buildSystemOneEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Decision provider base URL is empty');
  if (/\/v1\/systemone$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1/systemone`;
}
