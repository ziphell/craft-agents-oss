/**
 * Tests for LLM connection utilities (llm-connections.ts).
 *
 * Focuses on getMiniModel() / findSmallModel() — the small-model resolution
 * used for title generation, summarization, and call_llm.
 *
 * `fastModel` is an explicit pick: without it, a built-in catalog is guessed at
 * by name ("haiku" / "mini" / "flash") while a custom endpoint follows the
 * connection's default model.
 */
import { describe, it, expect } from 'bun:test';
import {
  getMiniModel,
  getSummarizationModel,
  guessSmallModelId,
  isDeniedMiniModelId,
} from '../src/config/llm-connections.ts';
import type { LlmProviderType } from '../src/config/llm-connections.ts';

// ============================================================
// Helpers
// ============================================================

function makeConnection(overrides: {
  models?: string[];
  piAuthProvider?: string;
  fastModel?: string;
  defaultModel?: string;
  providerType?: LlmProviderType;
} = {}) {
  return { providerType: 'pi' as LlmProviderType, ...overrides };
}

// ============================================================
// getMiniModel / findSmallModel
// ============================================================

describe('getMiniModel()', () => {
  // --- No pick: the name-based guess applies (unchanged behaviour) ---

  it('finds haiku for anthropic provider', () => {
    const conn = makeConnection({
      providerType: 'anthropic',
      models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
      defaultModel: 'claude-opus-4-7',
    });
    expect(getMiniModel(conn)).toBe('claude-haiku-4-5-20251001');
  });

  it('finds mini for pi provider', () => {
    const conn = makeConnection({ models: ['pi/gpt-5.2-codex', 'pi/gpt-5.1-codex-mini'] });
    expect(getMiniModel(conn)).toBe('pi/gpt-5.1-codex-mini');
  });

  it('falls back to the last model when nothing matches by name', () => {
    const conn = makeConnection({
      models: ['pi/gpt-5', 'pi/claude-sonnet-4.6', 'pi/o3'],
      defaultModel: 'pi/gpt-5',
    });
    // The guess's trailing fallback, not the default model — that is what the
    // pre-pick behaviour was, and built-in connections keep it.
    expect(getMiniModel(conn)).toBe('pi/o3');
  });

  it('answers with the default model when there is no model list', () => {
    expect(getMiniModel(makeConnection({ models: [], defaultModel: 'claude-opus-4-7' })))
      .toBe('claude-opus-4-7');
  });

  it('returns undefined when there is neither a list nor a default model', () => {
    expect(getMiniModel(makeConnection({ models: [] }))).toBeUndefined();
    expect(getMiniModel(makeConnection({ providerType: 'anthropic' }))).toBeUndefined();
  });
});

// ============================================================
// Custom endpoints — the model list is the user's own, so there is no guess
// ============================================================

describe('getMiniModel() — custom endpoint', () => {
  it('follows the default model instead of guessing by name', () => {
    const conn = makeConnection({
      providerType: 'pi_compat',
      models: ['qwen-max', 'qwen-turbo-mini'],
      defaultModel: 'qwen-max',
    });
    expect(getMiniModel(conn)).toBe('qwen-max');
  });

  it('falls back to the last entry when there is no default model either', () => {
    const conn = makeConnection({
      providerType: 'pi_compat',
      models: ['qwen-max', 'qwen-turbo'],
    });
    expect(getMiniModel(conn)).toBe('qwen-turbo');
  });

  it('treats an empty fastModel as not picked', () => {
    const conn = makeConnection({
      providerType: 'pi_compat',
      models: ['qwen-max', 'qwen-mini'],
      defaultModel: 'qwen-max',
      fastModel: '',
    });
    expect(getMiniModel(conn)).toBe('qwen-max');
  });
});

// ============================================================
// Explicit fastModel pick — the user's choice always wins
// ============================================================

describe('getMiniModel() — explicit fastModel', () => {
  it('wins over the guess and over the default model', () => {
    const conn = makeConnection({
      providerType: 'pi_compat',
      models: ['qwen-turbo-mini', 'qwen-plus', 'qwen-turbo'],
      defaultModel: 'qwen-plus',
      fastModel: 'qwen-turbo',
    });
    expect(getMiniModel(conn)).toBe('qwen-turbo');
  });

  it('wins even when it does not look like a small model by name', () => {
    const conn = makeConnection({
      models: ['pi/gpt-5', 'pi/gpt-5-mini'],
      defaultModel: 'pi/gpt-5',
      fastModel: 'pi/gpt-5',
    });
    expect(getMiniModel(conn)).toBe('pi/gpt-5');
  });

  it('honours the pick when the connection lists no models at all', () => {
    const conn = makeConnection({ providerType: 'anthropic', fastModel: 'claude-haiku-4-5' });
    expect(getMiniModel(conn)).toBe('claude-haiku-4-5');
  });

  it('trims a hand-written pick', () => {
    const conn = makeConnection({ models: ['pi/gpt-5'], fastModel: '  pi/gpt-5  ' });
    expect(getMiniModel(conn)).toBe('pi/gpt-5');
  });

  it('falls back to the guess when the pick is no longer in the list', () => {
    // The row was removed: a dangling pick behaves as if it were unset rather
    // than pointing the SDK at a model the connection does not have.
    const conn = makeConnection({
      models: ['pi/gpt-5', 'pi/gpt-5-mini'],
      defaultModel: 'pi/gpt-5',
      fastModel: 'pi/removed-model',
    });
    expect(getMiniModel(conn)).toBe('pi/gpt-5-mini');
  });

  it('falls back to the guess when the auth flavor rejects the pick', () => {
    const conn = makeConnection({
      models: ['pi/gpt-5', 'pi/gpt-5-mini', 'pi/gpt-5.1-codex-mini'],
      piAuthProvider: 'openai-codex',
      fastModel: 'pi/gpt-5.1-codex-mini',
    });
    expect(getMiniModel(conn)).toBe('pi/gpt-5-mini');
  });
});

// ============================================================
// Cleared pick — the same as never having picked one
// ============================================================

describe('getMiniModel() — empty fastModel', () => {
  it('is treated as not picked (built-in: the guess still applies)', () => {
    const conn = makeConnection({
      models: ['qwen-max', 'qwen-mini'],
      defaultModel: 'qwen-max',
      fastModel: '',
    });
    expect(getMiniModel(conn)).toBe('qwen-mini');
  });

  it('is treated as not picked (custom endpoint: the default model)', () => {
    const conn = makeConnection({
      providerType: 'pi_compat',
      models: ['qwen-max', 'qwen-mini'],
      defaultModel: 'qwen-max',
      fastModel: '   ',
    });
    expect(getMiniModel(conn)).toBe('qwen-max');
  });
});

// ============================================================
// getSummarizationModel (same logic, but separate function)
// ============================================================

describe('getSummarizationModel()', () => {
  it('returns same result as getMiniModel (shared implementation)', () => {
    const conn = makeConnection({
      models: ['pi/gpt-5', 'pi/gpt-5-mini'],
      defaultModel: 'pi/gpt-5',
      fastModel: 'pi/gpt-5-mini',
    });
    expect(getSummarizationModel(conn)).toBe(getMiniModel(conn));
    expect(getSummarizationModel(conn)).toBe('pi/gpt-5-mini');
  });
});

// ============================================================
// guessSmallModelId — exported because the editor pre-selects its answer
// ============================================================

describe('guessSmallModelId()', () => {
  it('returns undefined without a model list', () => {
    expect(guessSmallModelId(makeConnection({ models: [] }))).toBeUndefined();
    expect(guessSmallModelId(makeConnection({}))).toBeUndefined();
  });

  it('returns undefined for a custom endpoint — there is nothing to guess', () => {
    const conn = makeConnection({
      providerType: 'pi_compat',
      models: ['qwen-max', 'qwen-turbo-mini'],
    });
    expect(guessSmallModelId(conn)).toBeUndefined();
  });

  it('ignores the default model — it is a name-based guess only', () => {
    const conn = makeConnection({
      providerType: 'anthropic',
      models: ['claude-opus-4-7', 'claude-haiku-4-5'],
      defaultModel: 'claude-opus-4-7',
    });
    expect(guessSmallModelId(conn)).toBe('claude-haiku-4-5');
  });
});

// ============================================================
// Auth-flavor awareness — see isDeniedMiniModelId
// ============================================================

describe('getMiniModel() — auth-flavor awareness', () => {
  it('skips *codex-mini* variants under openai-codex auth', () => {
    // Reproduces the bug surfaced as:
    //   "The 'gpt-5.1-codex-mini' model is not supported when using Codex
    //    with a ChatGPT account."
    // The keyword search would otherwise pick gpt-5.1-codex-mini first.
    const conn = makeConnection({
      models: ['pi/gpt-5.2-codex', 'pi/gpt-5.1-codex-mini', 'pi/gpt-5-mini'],
      piAuthProvider: 'openai-codex',
    });
    expect(getMiniModel(conn)).toBe('pi/gpt-5-mini');
  });

  it('still returns *codex-mini* variants under regular openai (API-key) auth', () => {
    const conn = makeConnection({
      models: ['pi/gpt-5.2-codex', 'pi/gpt-5.1-codex-mini'],
      piAuthProvider: 'openai',
    });
    expect(getMiniModel(conn)).toBe('pi/gpt-5.1-codex-mini');
  });

  it('falls back to the last allowed model when every mini candidate is denied', () => {
    const conn = makeConnection({
      models: ['pi/gpt-5', 'pi/gpt-5.1-codex-mini', 'pi/gpt-5.2-codex'],
      piAuthProvider: 'openai-codex',
    });
    expect(getMiniModel(conn)).toBe('pi/gpt-5.2-codex');
  });
});

// ============================================================
// isDeniedMiniModelId — re-exported from this module so getMiniModel and
// the pi-agent-server queryLlm guard share one source of truth.
// ============================================================

describe('isDeniedMiniModelId()', () => {
  it('always denies codex-mini-latest', () => {
    expect(isDeniedMiniModelId('codex-mini-latest')).toBe(true);
    expect(isDeniedMiniModelId('pi/codex-mini-latest')).toBe(true);
    expect(isDeniedMiniModelId('codex-mini-latest', 'openai')).toBe(true);
  });

  it('denies *codex-mini* variants only under openai-codex auth', () => {
    expect(isDeniedMiniModelId('gpt-5.1-codex-mini', 'openai-codex')).toBe(true);
    expect(isDeniedMiniModelId('pi/gpt-5.1-codex-mini', 'openai-codex')).toBe(true);
    expect(isDeniedMiniModelId('gpt-5.1-codex-mini', 'openai')).toBe(false);
    expect(isDeniedMiniModelId('gpt-5.1-codex-mini')).toBe(false);
  });

  it('does not deny non-codex-mini models', () => {
    expect(isDeniedMiniModelId('gpt-5-mini', 'openai-codex')).toBe(false);
    expect(isDeniedMiniModelId('claude-haiku-4-5', 'openai-codex')).toBe(false);
    expect(isDeniedMiniModelId('gpt-5.1-codex', 'openai-codex')).toBe(false);
  });
});
