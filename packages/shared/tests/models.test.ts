/**
 * Tests for model detection utilities in config/models.ts
 */
import { describe, it, expect } from 'bun:test';
import {
  isClaudeModel,
  getModelShortName,
  getModelDisplayName,
  getModelContextWindow,
  getModelById,
  ANTHROPIC_MODELS,
  getModelIdByShortName,
  normalizeDeprecatedModelId,
} from '../src/config/models.ts';

describe('isClaudeModel', () => {
  // Direct Anthropic model IDs
  it('detects direct Anthropic Claude model IDs', () => {
    expect(isClaudeModel('claude-sonnet-4-6')).toBe(true);
    expect(isClaudeModel('claude-opus-4-8')).toBe(true);
    expect(isClaudeModel('claude-haiku-4-5-20251001')).toBe(true);
    expect(isClaudeModel('claude-3-5-sonnet-20241022')).toBe(true);
  });

  // OpenRouter provider-prefixed Claude IDs
  it('detects OpenRouter-prefixed Claude model IDs', () => {
    expect(isClaudeModel('anthropic/claude-sonnet-4')).toBe(true);
    expect(isClaudeModel('anthropic/claude-opus-4-7')).toBe(true);
    expect(isClaudeModel('anthropic/claude-3.5-haiku')).toBe(true);
  });

  // Non-Claude models via OpenRouter
  it('rejects non-Claude OpenRouter models', () => {
    expect(isClaudeModel('openai/gpt-5')).toBe(false);
    expect(isClaudeModel('openai/gpt-4o')).toBe(false);
    expect(isClaudeModel('google/gemini-2.5-pro')).toBe(false);
    expect(isClaudeModel('meta-llama/llama-4-maverick')).toBe(false);
    expect(isClaudeModel('deepseek/deepseek-r1')).toBe(false);
    expect(isClaudeModel('mistralai/mistral-large')).toBe(false);
  });

  // Non-Claude models via Ollama (no provider prefix)
  it('rejects non-Claude Ollama models', () => {
    expect(isClaudeModel('llama3.2')).toBe(false);
    expect(isClaudeModel('deepseek-r1')).toBe(false);
    expect(isClaudeModel('qwen3-coder')).toBe(false);
    expect(isClaudeModel('mistral')).toBe(false);
    expect(isClaudeModel('gemma2')).toBe(false);
  });

  // Bedrock-native model IDs
  it('detects Bedrock-native Claude model IDs', () => {
    expect(isClaudeModel('anthropic.claude-opus-4-8')).toBe(true);
    expect(isClaudeModel('anthropic.claude-sonnet-4-6')).toBe(true);
    expect(isClaudeModel('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(true);
  });

  // Case insensitivity
  it('handles case variations', () => {
    expect(isClaudeModel('Claude-Sonnet-4-6')).toBe(true);
    expect(isClaudeModel('CLAUDE-OPUS-4-8')).toBe(true);
    expect(isClaudeModel('Anthropic/Claude-Sonnet-4')).toBe(true);
  });
});

describe('getModelShortName', () => {
  it('returns registry shortName for known models', () => {
    expect(getModelShortName('claude-opus-4-8')).toBe('Opus');
    expect(getModelShortName('claude-sonnet-4-6')).toBe('Sonnet');
    expect(getModelShortName('claude-haiku-4-5-20251001')).toBe('Haiku');
  });

  it('strips provider prefix for slash-separated IDs', () => {
    expect(getModelShortName('openai/gpt-5.4')).toBe('gpt-5.4');
    expect(getModelShortName('anthropic/claude-sonnet-4')).toBe('claude-sonnet-4');
  });

  it('returns the id verbatim for models the registry does not know', () => {
    // Pi-catalogue and custom-endpoint ids. Prettifying these used to invent
    // names nobody has ever heard of ("Deepseek v4.flash", "Mistral large"), so
    // the id itself is the label.
    expect(getModelShortName('gpt-5.4')).toBe('gpt-5.4');
    expect(getModelShortName('glm-4.7')).toBe('glm-4.7');
    expect(getModelShortName('mistral')).toBe('mistral');
    expect(getModelShortName('gemma2')).toBe('gemma2');
    expect(getModelShortName('mistral-large')).toBe('mistral-large');
    expect(getModelShortName('deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(getModelShortName('deepseek-r1')).toBe('deepseek-r1');
  });

  it('returns an unlisted Claude id verbatim too', () => {
    // Normalization only covers the deprecated Opus aliases; anything older
    // than the registry is reported as-is rather than prettified.
    expect(getModelShortName('claude-sonnet-3-5-20241022')).toBe('claude-sonnet-3-5-20241022');
  });
});

describe('getModelDisplayName', () => {
  it('uses the registry name for known models', () => {
    expect(getModelDisplayName('claude-opus-4-8')).toBe('Opus 4.8');
  });

  it('returns the id verbatim for models the registry does not know', () => {
    expect(getModelDisplayName('deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(getModelDisplayName('qwen3-coder')).toBe('qwen3-coder');
  });
});

describe('Opus registry', () => {
  it('includes Opus 4.8 and keeps Opus 4.7 and Opus 4.6', () => {
    const ids = ANTHROPIC_MODELS.map(m => m.id);
    expect(ids).toContain('claude-opus-4-8');
    expect(ids).toContain('claude-opus-4-7');
    expect(ids).toContain('claude-opus-4-6');
  });

  it('resolves "Opus" shortName to 4.8', () => {
    expect(getModelIdByShortName('Opus')).toBe('claude-opus-4-8');
  });

  it('normalizes deprecated Opus IDs to Opus 4.8 without migrating Opus 4.7 or 4.6', () => {
    expect(normalizeDeprecatedModelId('claude-opus-4-5-20251101')).toBe('claude-opus-4-8');
    expect(normalizeDeprecatedModelId('claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(normalizeDeprecatedModelId('claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(normalizeDeprecatedModelId('pi/claude-opus-4-6')).toBe('pi/claude-opus-4-6');
    expect(normalizeDeprecatedModelId('us.anthropic.claude-opus-4-6-v1')).toBe('us.anthropic.claude-opus-4-6-v1');
  });
});

describe('Sonnet registry', () => {
  it('includes Sonnet 5 and keeps Sonnet 4.6', () => {
    const ids = ANTHROPIC_MODELS.map(m => m.id);
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('claude-sonnet-4-6');
  });

  it('resolves "Sonnet" shortName to Sonnet 5', () => {
    expect(getModelIdByShortName('Sonnet')).toBe('claude-sonnet-5');
  });

  it('exposes Sonnet 5 metadata', () => {
    expect(getModelDisplayName('claude-sonnet-5')).toBe('Sonnet 5');
    expect(getModelShortName('claude-sonnet-5')).toBe('Sonnet');
    expect(getModelContextWindow('claude-sonnet-5')).toBe(1_000_000);
  });

  it('maps Bedrock Sonnet 5 IDs back to the bare ID', () => {
    expect(getModelById('us.anthropic.claude-sonnet-5')?.id).toBe('claude-sonnet-5');
    expect(getModelById('anthropic.claude-sonnet-5')?.id).toBe('claude-sonnet-5');
  });
});
