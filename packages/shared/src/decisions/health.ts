/**
 * Decision layer — local server probe.
 *
 * `laya-serve` (and many Jev-compatible clones) expose `GET /health`. The
 * Settings card uses this to tell the user whether their local server is up
 * and which checkpoints it has loaded. Best effort: never throws, short
 * timeout, no auth (health endpoints are unauthenticated on laya-serve).
 */

import { getDecisionLayerSettings } from '../config/storage.ts';
import { DECISION_PROVIDER_PRESETS } from './providers.ts';
import type { DecisionLayerSettings } from './settings.ts';
import type { DecisionProviderId } from './types.ts';

export const DECISION_PROBE_TIMEOUT_MS = 2_000;

export interface DecisionServerProbe {
  provider: DecisionProviderId;
  baseUrl: string;
  /** The URL that was requested. */
  url: string;
  /** TCP+HTTP round trip succeeded (any status). */
  reachable: boolean;
  status?: number;
  /** Parsed `laya-serve` health body when the server returned one. */
  health?: { status?: string; loaded?: string[]; device?: string };
  /** Safe to show: never contains a key. */
  message?: string;
  latencyMs: number;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Probe a Jev-compatible server's health endpoint. Never throws. */
export async function probeDecisionServer(
  provider: DecisionProviderId,
  baseUrl: string,
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number; healthPath?: string } = {},
): Promise<DecisionServerProbe> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const healthPath = options.healthPath ?? DECISION_PROVIDER_PRESETS[provider].healthPath ?? '/health';
  const startedAt = performance.now();
  let url: string;
  try {
    url = joinUrl(baseUrl, healthPath);
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    return { provider, baseUrl, url: baseUrl, reachable: false, message: 'Base URL is not a valid URL', latencyMs: 0 };
  }

  try {
    const response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(options.timeoutMs ?? DECISION_PROBE_TIMEOUT_MS) });
    const latencyMs = Math.round(performance.now() - startedAt);
    const probe: DecisionServerProbe = { provider, baseUrl, url, reachable: true, status: response.status, latencyMs };
    if (response.ok) {
      try {
        const body = (await response.json()) as Record<string, unknown>;
        if (body && typeof body === 'object') {
          probe.health = {
            ...(typeof body.status === 'string' ? { status: body.status } : {}),
            ...(Array.isArray(body.loaded) ? { loaded: body.loaded.filter((x): x is string => typeof x === 'string') } : {}),
            ...(typeof body.device === 'string' ? { device: body.device } : {}),
          };
        }
      } catch {
        probe.message = 'Server is up but its health endpoint did not return JSON';
      }
    } else if (response.status === 404) {
      probe.message = 'Server is reachable but has no health endpoint';
    } else {
      probe.message = `Health endpoint answered HTTP ${response.status}`;
    }
    return probe;
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const name = error instanceof Error ? error.name : '';
    const message = name === 'TimeoutError' || name === 'AbortError'
      ? `No answer within ${options.timeoutMs ?? DECISION_PROBE_TIMEOUT_MS} ms`
      : 'Could not connect';
    return { provider, baseUrl, url, reachable: false, message, latencyMs };
  }
}

/** Probe the server the current settings point at (a local preset or a custom base URL). */
export async function probeConfiguredDecisionServer(
  settings: DecisionLayerSettings = getDecisionLayerSettings(),
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number; baseUrlOverride?: string } = {},
): Promise<DecisionServerProbe> {
  const preset = DECISION_PROVIDER_PRESETS[settings.provider];
  const baseUrl = options.baseUrlOverride?.trim() || settings.baseUrl || preset.baseUrl;
  if (!baseUrl) {
    return { provider: settings.provider, baseUrl: '', url: '', reachable: false, message: 'No base URL configured', latencyMs: 0 };
  }
  return probeDecisionServer(settings.provider, baseUrl, { fetch: options.fetch, timeoutMs: options.timeoutMs });
}
