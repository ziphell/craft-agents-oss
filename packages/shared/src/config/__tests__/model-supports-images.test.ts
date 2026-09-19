import { describe, expect, it } from 'bun:test'
import { modelSupportsImages, type LlmConnection } from '../llm-connections.ts'

const BASE_COMPAT: LlmConnection = {
  slug: 'custom',
  name: 'Custom',
  providerType: 'pi_compat',
  authType: 'api_key_with_endpoint',
  baseUrl: 'http://localhost:8080',
  customEndpoint: { api: 'openai-completions' },
  createdAt: 1,
}

describe('modelSupportsImages — pi_compat', () => {
  it('returns true when the model entry opts into image input', () => {
    const conn: LlmConnection = {
      ...BASE_COMPAT,
      models: [{ id: 'vision', supportsImages: true }],
    }
    expect(modelSupportsImages(conn, 'vision')).toBe(true)
  })

  it('returns false when the model entry opts out', () => {
    const conn: LlmConnection = {
      ...BASE_COMPAT,
      models: [{ id: 'text-only', supportsImages: false }],
    }
    expect(modelSupportsImages(conn, 'text-only')).toBe(false)
  })

  it('defaults to true when the model entry does not declare it', () => {
    const conn: LlmConnection = { ...BASE_COMPAT, models: ['plain'] }
    expect(modelSupportsImages(conn, 'plain')).toBe(true)
  })

  it('defaults to true when the model is not in models[] at all', () => {
    const conn: LlmConnection = { ...BASE_COMPAT, models: ['plain'] }
    expect(modelSupportsImages(conn, 'unknown')).toBe(true)
  })
})

describe('modelSupportsImages — the model entry wins on every connection type', () => {
  it('honours an explicit false on an anthropic connection', () => {
    const conn: LlmConnection = {
      slug: 'a', name: 'a', providerType: 'anthropic', authType: 'api_key',
      models: [{ id: 'claude-haiku', supportsImages: false }],
      createdAt: 1,
    }
    expect(modelSupportsImages(conn, 'claude-haiku')).toBe(false)
  })

  it('honours an explicit false on a pi connection', () => {
    const conn: LlmConnection = {
      slug: 'p', name: 'p', providerType: 'pi', authType: 'api_key',
      models: [{ id: 'gpt-x', supportsImages: false }],
      createdAt: 1,
    }
    expect(modelSupportsImages(conn, 'gpt-x')).toBe(false)
  })

  it('defaults to true for a built-in entry that says nothing (upstream catalog decides)', () => {
    const conn: LlmConnection = {
      slug: 'a', name: 'a', providerType: 'anthropic', authType: 'api_key',
      models: ['claude-opus-4-8'],
      createdAt: 1,
    }
    expect(modelSupportsImages(conn, 'claude-opus-4-8')).toBe(true)
  })
})
