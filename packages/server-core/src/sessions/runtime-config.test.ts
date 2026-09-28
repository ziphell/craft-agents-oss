import { describe, expect, it } from 'bun:test'
import type { LlmConnection } from '@craft-agent/shared/config'
import type { FileAttachment } from '@craft-agent/shared/protocol'
import { buildBackendRuntimeSignature, filterAttachmentsForModelInput } from './runtime-config'

const baseCompat: LlmConnection = {
  slug: 'local',
  name: 'Local',
  providerType: 'pi_compat',
  authType: 'none',
  createdAt: 1,
  baseUrl: 'http://127.0.0.1:1234/v1',
  defaultModel: 'gemma',
  piAuthProvider: 'openai',
  customEndpoint: { api: 'openai-completions' },
  models: [{ id: 'gemma', supportsImages: true }],
}

/** A built-in Pi provider: the SDK owns the catalog, the connection lists ids. */
const baseBuiltIn: LlmConnection = {
  slug: 'pi-api-key',
  name: 'Craft Agents Backend (API Key)',
  providerType: 'pi',
  authType: 'api_key',
  createdAt: 1,
  baseUrl: 'https://api.deepseek.com',
  defaultModel: 'pi/deepseek-v4-flash',
  piAuthProvider: 'deepseek',
  models: ['pi/deepseek-v4-pro', 'pi/deepseek-v4-flash'],
}

function sig(connection: LlmConnection) {
  return buildBackendRuntimeSignature({
    connection,
    provider: 'pi',
    authType: 'api_key',
    resolvedModel: 'gemma',
  })
}

const imageAttachment: FileAttachment = {
  type: 'image',
  path: '/tmp/image.png',
  name: 'image.png',
  mimeType: 'image/png',
  size: 123,
  base64: 'abc',
}

const textAttachment: FileAttachment = {
  type: 'text',
  path: '/tmp/note.txt',
  name: 'note.txt',
  mimeType: 'text/plain',
  size: 12,
  text: 'hello',
}

describe('buildBackendRuntimeSignature', () => {
  it('changes when a custom endpoint model image override changes', () => {
    const enabled = sig(baseCompat)
    const disabled = sig({
      ...baseCompat,
      models: [{ id: 'gemma', supportsImages: false }],
    })

    expect(disabled).not.toBe(enabled)
  })

  it('ignores non-runtime metadata such as lastUsedAt', () => {
    expect(sig({ ...baseCompat, lastUsedAt: 1 })).toBe(sig({ ...baseCompat, lastUsedAt: 2 }))
  })

  // A built-in provider's catalog belongs to the SDK, but the connection's model
  // entries still carry what the user stated about those models, and
  // `resolvePiModel` applies it — so a change there has to refresh live sessions.
  it('changes when a built-in provider model parameter changes', () => {
    const withOverride = sig({
      ...baseBuiltIn,
      models: ['pi/deepseek-v4-pro', { id: 'pi/deepseek-v4-flash', supportsImages: true }],
    })

    expect(withOverride).not.toBe(sig(baseBuiltIn))
  })

  it('ignores id-only churn on a built-in provider', () => {
    // `automaticallySyncedFromProvider` connections get their whole catalog
    // written to `models[]` on every refresh; the ids alone change nothing for a
    // built-in provider (unlike a custom endpoint, where they are its model set).
    const resynced = sig({
      ...baseBuiltIn,
      models: [...(baseBuiltIn.models ?? []), 'pi/deepseek-v4-flash-vision-exp'],
    })

    expect(resynced).toBe(sig(baseBuiltIn))
  })
})

describe('filterAttachmentsForModelInput', () => {
  it('omits images for pi_compat text-only models while preserving other attachments', () => {
    const result = filterAttachmentsForModelInput(
      [imageAttachment, textAttachment],
      { ...baseCompat, models: [{ id: 'gemma', supportsImages: false }] },
      'gemma',
    )

    expect(result.omittedImages.map(a => a.name)).toEqual(['image.png'])
    expect(result.attachments?.map(a => a.name)).toEqual(['note.txt'])
  })

  it('keeps images when the per-model override enables images', () => {
    const result = filterAttachmentsForModelInput([imageAttachment], baseCompat, 'gemma')

    expect(result.omittedImages).toHaveLength(0)
    expect(result.attachments).toEqual([imageAttachment])
  })

  it('keeps images when the model entry does not declare image support (defaults to capable)', () => {
    const result = filterAttachmentsForModelInput(
      [imageAttachment],
      { ...baseCompat, models: ['gemma'] },
      'gemma',
    )

    expect(result.omittedImages).toHaveLength(0)
    expect(result.attachments).toEqual([imageAttachment])
  })

  it('honours an explicit supportsImages: false on a built-in connection too', () => {
    const result = filterAttachmentsForModelInput(
      [imageAttachment],
      {
        slug: 'anthropic', name: 'Anthropic', providerType: 'anthropic', authType: 'api_key',
        models: [{ id: 'claude-haiku', supportsImages: false }],
        createdAt: 1,
      },
      'claude-haiku',
    )

    expect(result.omittedImages).toEqual([imageAttachment])
    expect(result.attachments).toBeUndefined()
  })
})
