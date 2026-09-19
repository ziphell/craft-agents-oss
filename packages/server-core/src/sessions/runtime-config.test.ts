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
