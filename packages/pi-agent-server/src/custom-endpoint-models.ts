import {
  CUSTOM_ENDPOINT_MODEL_DEFAULTS,
  type CustomEndpointApi,
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

/** The SDK's `input` value for a user's `supportsImages` statement. */
function inputForImageSupport(supportsImages: boolean): CustomEndpointInput[] {
  return supportsImages ? ['text', 'image'] : ['text']
}

/**
 * Overlay the per-model parameters a user wrote onto a model definition.
 *
 * **This is the only place the user-facing parameter names become the SDK's**
 * (`supportsImages` → `input`, `supportsThinking` → `reasoning`), so a model we
 * build ourselves ({@link buildCustomEndpointModelDef}) and one the SDK owns (a
 * built-in provider's catalog entry, see `resolvePiModel`) cannot disagree
 * about what the user asked for. Capability flags are permissive: only an
 * explicit `false` turns one off.
 *
 * Nothing is filled in — a key the user did not write is left exactly as the
 * model had it. For a catalog model those values come from the SDK and are the
 * real fallback; for a synthetic one the caller passes
 * {@link CUSTOM_ENDPOINT_MODEL_DEFAULTS} as the base.
 */
export function applyModelOverrides<T extends object>(
  model: T,
  overrides?: CustomEndpointModelOverrides,
): T {
  if (!overrides) return model

  const next: Record<string, unknown> = { ...(model as Record<string, unknown>) }
  if (overrides.name !== undefined) next.name = overrides.name
  if (overrides.supportsImages !== undefined) next.input = inputForImageSupport(overrides.supportsImages)
  if (overrides.supportsThinking !== undefined) next.reasoning = overrides.supportsThinking
  if (overrides.contextWindow !== undefined) next.contextWindow = overrides.contextWindow
  if (overrides.maxTokens !== undefined) next.maxTokens = overrides.maxTokens
  // Pricing and compat are partial by nature: the user states what they know
  // and the rest of the model's own values stay.
  if (overrides.cost) next.cost = { ...(next.cost as object | undefined), ...overrides.cost }
  if (overrides.compat) next.compat = { ...(next.compat as object | undefined), ...overrides.compat }
  if (overrides.headers) next.headers = overrides.headers
  if (overrides.thinkingLevelMap) next.thinkingLevelMap = overrides.thinkingLevelMap

  return next as T
}

/**
 * Build a synthetic model definition for a custom endpoint.
 *
 * The constants below are only a base for {@link applyModelOverrides}: every
 * field the user can write in `config.json` wins. They exist because the
 * endpoint cannot be queried for its actual capabilities, and they default to
 * **true** (permissive) — a custom endpoint is assumed capable until the user
 * says otherwise with an explicit `false`.
 *
 * For `openai-completions` endpoints we turn off the two parts of the wire format
 * that belong to OpenAI's own platform, because an arbitrary gateway either
 * ignores them or rejects them outright:
 *
 * - `compat.supportsStore = false` omits the OpenAI-platform-only `store` param.
 *   Third-party gateways gain nothing from `store`, and strict ones reject unknown
 *   params with a 400 — which made those connections unusable. See craft-agents-oss#1022.
 * - `compat.supportsDeveloperRole = false` sends the system prompt as a `system`
 *   message rather than OpenAI's newer `developer` role. pi-ai only downgrades
 *   the role for hosts it recognizes as non-standard; an arbitrary endpoint is
 *   assumed OpenAI-like and would receive `developer`, which most gateways reject
 *   ("developer is not one of ['system', 'assistant', 'user', 'tool', 'function']").
 *
 * Both are the **lowest common denominator of the format**, unlike the capability
 * flags above which default to permissive — a wrong capability guess costs a
 * feature, a wrong format guess is a hard 400. A user-written `compat` still wins
 * over either default (see {@link applyModelOverrides}).
 */
export function buildCustomEndpointModelDef(
  id: string,
  overrides?: CustomEndpointModelOverrides,
  api?: CustomEndpointApi,
) {
  return applyModelOverrides(
    {
      id,
      name: id,
      reasoning: true,
      input: inputForImageSupport(true),
      cost: { ...ZERO_COST },
      contextWindow: CUSTOM_ENDPOINT_MODEL_DEFAULTS.contextWindow,
      maxTokens: CUSTOM_ENDPOINT_MODEL_DEFAULTS.maxTokens,
      ...(api === 'openai-completions'
        ? { compat: { supportsStore: false, supportsDeveloperRole: false } }
        : {}),
    },
    overrides,
  )
}
