/**
 * `getVisionModel` / `resolveImageModel` — the capability-checked chain that
 * decides which model reads images / video frames.
 *
 * The chain is what lets "the main model can see, the small one cannot" work
 * with no extra configuration, and what keeps `call_llm` / `understand` from
 * ever handing pictures to a model that cannot accept them.
 */

import { describe, it, expect } from 'bun:test'
import { getVisionModel, resolveImageModel, type LlmConnection } from '../llm-connections.ts'

function conn(overrides: Partial<LlmConnection>): LlmConnection {
  return {
    slug: 'c',
    name: 'C',
    providerType: 'pi_compat',
    authType: 'api_key_with_endpoint',
    createdAt: 0,
    ...overrides,
  } as LlmConnection
}

describe('getVisionModel', () => {
  it('returns the pick when it is listed and can see', () => {
    const c = conn({
      models: [{ id: 'text', supportsImages: false }, { id: 'vision', supportsImages: true }],
      visionModel: 'vision',
    })
    expect(getVisionModel(c)).toBe('vision')
  })

  it('returns undefined when unset', () => {
    expect(getVisionModel(conn({ models: ['vision'] }))).toBeUndefined()
  })

  it('returns undefined when the pick is no longer listed', () => {
    const c = conn({ models: [{ id: 'vision', supportsImages: true }], visionModel: 'gone' })
    expect(getVisionModel(c)).toBeUndefined()
  })

  it('returns undefined when the pick is itself flagged as no-images', () => {
    const c = conn({ models: [{ id: 'vision', supportsImages: false }], visionModel: 'vision' })
    expect(getVisionModel(c)).toBeUndefined()
  })
})

describe('resolveImageModel', () => {
  it('prefers the explicit vision model over everything else', () => {
    const c = conn({
      models: [{ id: 'vision', supportsImages: true }, { id: 'small', supportsImages: true }],
      visionModel: 'vision',
      fastModel: 'small',
      defaultModel: 'small',
    })
    expect(resolveImageModel(c, 'small')).toBe('vision')
  })

  it('uses the small model when it can see', () => {
    const c = conn({
      models: [{ id: 'main', supportsImages: true }, { id: 'small', supportsImages: true }],
      fastModel: 'small',
      defaultModel: 'main',
    })
    expect(resolveImageModel(c, 'main')).toBe('small')
  })

  it('falls through a blind small model to the main model', () => {
    const c = conn({
      models: [{ id: 'main', supportsImages: true }, { id: 'blind', supportsImages: false }],
      fastModel: 'blind',
      defaultModel: 'blind',
    })
    expect(resolveImageModel(c, 'main')).toBe('main')
  })

  it('uses the connection default when no main model is given', () => {
    const c = conn({ models: [{ id: 'def', supportsImages: true }], defaultModel: 'def' })
    expect(resolveImageModel(c)).toBe('def')
  })

  it('returns undefined when nothing on the connection can see', () => {
    const c = conn({
      models: [{ id: 'a', supportsImages: false }, { id: 'b', supportsImages: false }],
      fastModel: 'a',
      defaultModel: 'b',
    })
    expect(resolveImageModel(c, 'a')).toBeUndefined()
  })
})
