import {
  CUSTOM_ENDPOINT_MODEL_DEFAULTS,
  type CustomEndpointModelConfig,
  type CustomEndpointModelEntry,
  type CustomEndpointModelParams,
} from '../../shared/src/config/llm-connections.ts';

export type CustomEndpointInput = 'text' | 'image'

/**
 * The parameter shape is defined once in shared config — the host, the UI and
 * this server all read the same type, so a new parameter cannot be dropped on
 * the way here without a type error.
 */
export type { CustomEndpointModelConfig, CustomEndpointModelEntry, CustomEndpointModelParams }

/** Per-model parameter overrides, applied on top of {@link buildCustomEndpointModelDef}. */
export type CustomEndpointModelOverrides = CustomEndpointModelParams

/** Strip bare model IDs (remove pi/ prefix if present). */
export function stripPiPrefix(id: string): string {
  return id.startsWith('pi/') ? id.slice(3) : id
}

/**
 * Normalize a user-configured custom endpoint model for Pi SDK registration.
 *
 * Keeps every per-model parameter intact — including explicit `false` values
 * such as `supportsImages: false`, which are the user stating the model cannot
 * take images — and only normalizes the id.
 */
export function normalizeCustomEndpointModelEntry(model: CustomEndpointModelConfig): CustomEndpointModelEntry {
  if (typeof model === 'string') {
    return { id: stripPiPrefix(model) }
  }

  return { ...model, id: stripPiPrefix(model.id) }
}

/** Fallbacks for parameters a user did not set. */
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * Build a synthetic model definition for a custom endpoint.
 *
 * Every field the user can write in `config.json` wins over the fallback below;
 * the fallbacks exist because the endpoint cannot be queried for its actual
 * capabilities. Capability flags default to **true** (permissive): a custom
 * endpoint is assumed capable until the user says otherwise with an explicit
 * `false`.
 *
 * The user-facing `supportsThinking` becomes the SDK's `reasoning` here — this
 * is the only place the SDK's name for it appears.
 */
export function buildCustomEndpointModelDef(
  id: string,
  overrides?: CustomEndpointModelOverrides,
) {
  const supportsImages = overrides?.supportsImages ?? true
  const input: CustomEndpointInput[] = supportsImages ? ['text', 'image'] : ['text']

  return {
    id,
    name: overrides?.name ?? id,
    reasoning: overrides?.supportsThinking ?? true,
    input,
    cost: { ...ZERO_COST, ...(overrides?.cost ?? {}) },
    contextWindow: overrides?.contextWindow ?? CUSTOM_ENDPOINT_MODEL_DEFAULTS.contextWindow,
    maxTokens: overrides?.maxTokens ?? CUSTOM_ENDPOINT_MODEL_DEFAULTS.maxTokens,
    ...(overrides?.headers ? { headers: overrides.headers } : {}),
    ...(overrides?.compat ? { compat: overrides.compat } : {}),
    ...(overrides?.thinkingLevelMap ? { thinkingLevelMap: overrides.thinkingLevelMap } : {}),
  }
}
