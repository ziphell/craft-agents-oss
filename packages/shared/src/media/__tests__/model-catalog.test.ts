import { describe, expect, it } from 'bun:test'
import {
  catalogIdOf,
  mediaModelCatalogEntry,
  modelIdSourceOf,
  providerTypeOf,
  recognizeModelId,
  withPreset,
} from '../index.ts'
import type { MediaChannel } from '../channels.ts'

const channel = (overrides: Partial<MediaChannel>): MediaChannel => ({
  id: 'c',
  name: 'c',
  protocol: 'openai-image',
  baseUrl: 'https://api.test',
  models: [],
  ...overrides,
})

describe('recognising a model id', () => {
  it('finds exact ids and vendor spellings', () => {
    expect(recognizeModelId('minimax-h3')).toBe('minimax-h3')
    expect(recognizeModelId('MiniMax-H3')).toBe('minimax-h3')
    expect(recognizeModelId('MiniMax-H3-Max')).toBe('minimax-h3-max')
  })

  it('recognises a relay id without rewriting it', () => {
    const id = 'bytedance/seedance-2.5/image-to-video'
    expect(recognizeModelId(id)).toBe('seedance-2.5')
    // The caller keeps the vendor's id; only the catalogue lookup used the match.
    expect(id).toBe('bytedance/seedance-2.5/image-to-video')
  })

  it('ignores a date suffix but keeps the longer model', () => {
    expect(recognizeModelId('doubao-seedream-5-0-260128')).toBe('seedream-5.0')
    expect(recognizeModelId('doubao-seedance-2-5-260628')).toBe('seedance-2.5')
    expect(recognizeModelId('tts-1-hd')).toBe('tts-1-hd')
  })

  it('leaves unknown ids alone', () => {
    expect(recognizeModelId('my-relay-model-v9')).toBeNull()
    expect(recognizeModelId('')).toBeNull()
  })
})

describe('a channel declares its catalogue mapping', () => {
  it('takes the provider type and id source from the preset', () => {
    const preset = withPreset(channel({ preset: 'minimax-video', models: ['MiniMax-H3'] }))
    expect(providerTypeOf(preset)).toBe('minimax')
    expect(modelIdSourceOf(preset)).toBe('registered')
    expect(catalogIdOf(preset, 'MiniMax-H3')).toBe('minimax-h3')
  })

  it('treats a hand-written channel as open until it says otherwise', () => {
    const custom = channel({})
    expect(providerTypeOf(custom)).toBe('custom')
    expect(modelIdSourceOf(custom)).toBe('open')
    expect(providerTypeOf({ providerType: 'my-relay', preset: 'openai-image' })).toBe('my-relay')
  })

  it('prefers the declared mapping over recognition', () => {
    const mapped = channel({
      preset: 'minimax-video',
      modelCatalogId: { 'MiniMax-H3': 'image-01' },
    })
    expect(catalogIdOf(mapped, 'MiniMax-H3')).toBe('image-01')
    expect(catalogIdOf(mapped, 'MiniMax-H3-Max')).toBe('minimax-h3-max')
  })

  it('has a catalogue entry for everything it recognises', () => {
    const id = recognizeModelId('gemini-3-pro-image')
    expect(mediaModelCatalogEntry(id)?.kind).toBe('image')
  })
})
