import { describe, expect, it } from 'bun:test'
import {
  buildCustomEndpointModelDef,
  normalizeCustomEndpointModelEntry,
  stripPiPrefix,
} from './custom-endpoint-models.ts'

describe('normalizeCustomEndpointModelEntry', () => {
  it('strips pi/ prefixes from string model IDs', () => {
    expect(stripPiPrefix('pi/my-model')).toBe('my-model')
    expect(normalizeCustomEndpointModelEntry('pi/my-model')).toEqual({ id: 'my-model' })
  })

  it('preserves per-model image support when enabled', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/vision-model',
      supportsImages: true,
    })).toEqual({
      id: 'vision-model',
      supportsImages: true,
    })
  })

  it('preserves explicit per-model image support when disabled', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/text-only-model',
      supportsImages: false,
    })).toEqual({
      id: 'text-only-model',
      supportsImages: false,
    })
  })

  it('preserves context window and image support together', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/vision-model',
      contextWindow: 262_144,
      supportsImages: true,
    })).toEqual({
      id: 'vision-model',
      contextWindow: 262_144,
      supportsImages: true,
    })
  })

  it('preserves every per-model parameter and only normalizes the id', () => {
    const params = {
      name: 'Qwen3 Coder',
      supportsImages: false,
      supportsThinking: true,
      contextWindow: 1_000_000,
      maxTokens: 32_768,
      cost: { input: 0.3, output: 1.2 },
      headers: { 'X-Gateway-Token': 'abc' },
      compat: { maxTokensField: 'max_tokens' },
      thinkingLevelMap: { off: null, high: 'high' },
    }

    expect(normalizeCustomEndpointModelEntry({ id: 'pi/qwen3-coder', ...params })).toEqual({
      id: 'qwen3-coder',
      ...params,
    })
  })
})

describe('buildCustomEndpointModelDef – per-model parameters', () => {
  it('falls back to the built-in defaults when nothing is set', () => {
    const model = buildCustomEndpointModelDef('plain-model')

    expect(model).toEqual({
      id: 'plain-model',
      name: 'plain-model',
      // Capability flags are permissive by default; only an explicit false
      // turns them off.
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 393_216,
    })
  })

  it('lets every user-written parameter win over the fallback', () => {
    const model = buildCustomEndpointModelDef('qwen3-coder', {
      name: 'Qwen3 Coder',
      supportsImages: true,
      supportsThinking: true,
      contextWindow: 262_144,
      maxTokens: 32_768,
      cost: { input: 0.3, output: 1.2 },
      headers: { 'X-Gateway-Token': 'abc' },
      compat: { maxTokensField: 'max_tokens' },
      thinkingLevelMap: { off: null, high: 'high' },
    })

    expect(model.name).toBe('Qwen3 Coder')
    expect(model.input).toEqual(['text', 'image'])
    // The user-facing name is translated to the SDK's flag at this boundary.
    expect(model.reasoning).toBe(true)
    expect(model.contextWindow).toBe(262_144)
    expect(model.maxTokens).toBe(32_768)
    // Unset rates keep the zero fallback rather than becoming undefined.
    expect(model.cost).toEqual({ input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 })
    expect(model.headers).toEqual({ 'X-Gateway-Token': 'abc' })
    expect(model.compat).toEqual({ maxTokensField: 'max_tokens' })
    expect(model.thinkingLevelMap).toEqual({ off: null, high: 'high' })
  })

  it('defaults reasoning to true, and honours an explicit false', () => {
    expect(buildCustomEndpointModelDef('plain-model').reasoning).toBe(true)
    expect(buildCustomEndpointModelDef('off-model', { supportsThinking: false }).reasoning).toBe(false)
  })

  it('omits pass-through fields the user did not write', () => {
    const model = buildCustomEndpointModelDef('plain-model', { maxTokens: 4_096 })

    expect('headers' in model).toBe(false)
    expect('compat' in model).toBe(false)
    expect('thinkingLevelMap' in model).toBe(false)
  })
})

describe('buildCustomEndpointModelDef – image input', () => {
  it('defaults to text + image input', () => {
    expect(buildCustomEndpointModelDef('my-model').input).toEqual(['text', 'image'])
  })

  it('turns image input off only on an explicit false', () => {
    expect(buildCustomEndpointModelDef('text-only-model', { supportsImages: false }).input).toEqual(['text'])
    expect(buildCustomEndpointModelDef('vision-model', { supportsImages: true }).input).toEqual(['text', 'image'])
  })

  it('carries a custom context window alongside image input', () => {
    const model = buildCustomEndpointModelDef('vision-model', { supportsImages: true, contextWindow: 262_144 })
    expect(model.input).toEqual(['text', 'image'])
    expect(model.contextWindow).toBe(262_144)
  })
})
