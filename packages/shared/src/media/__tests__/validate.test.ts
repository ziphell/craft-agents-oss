import { describe, expect, it } from 'bun:test'
import {
  MediaFailure,
  capabilitiesOf,
  validateMediaRequest,
  type MediaChannel,
} from '../index.ts'

const channel = (overrides: Partial<MediaChannel> = {}): MediaChannel => ({
  id: 'minimax',
  name: 'MiniMax',
  protocol: 'openai-image',
  baseUrl: 'https://api.test',
  kind: 'video',
  models: ['MiniMax-H3'],
  defaultModel: 'MiniMax-H3',
  modelCatalogId: { 'MiniMax-H3': 'minimax-h3' },
  options: {
    duration: [4, 5, 6],
    resolution: ['768P', '2K'],
    ratio: ['16:9', '9:16'],
  },
  ...overrides,
})

const failureOf = (run: () => void): MediaFailure => {
  try {
    run()
  } catch (error) {
    if (error instanceof MediaFailure) return error
    throw error
  }
  throw new Error('expected a MediaFailure')
}

describe('capability lookup', () => {
  it('finds the catalogue entry through the channel mapping', () => {
    expect(capabilitiesOf(channel(), 'MiniMax-H3')?.maxReferences).toBe(12)
    expect(capabilitiesOf(channel({ modelCatalogId: {} }), 'relay-model')).toBeNull()
  })
})

describe('parameter choices', () => {
  it('accepts the values the channel listed', () => {
    expect(() =>
      validateMediaRequest(channel(), {
        prompt: 'a wave at dusk',
        params: { duration: 5, resolution: '768P', ratio: '16:9' },
      }),
    ).not.toThrow()
  })

  it('refuses a duration the model does not offer', () => {
    const failure = failureOf(() =>
      validateMediaRequest(channel(), { prompt: 'x', params: { duration: 7 } }),
    )
    expect(failure.code).toBe('invalid_request')
    expect(failure.field).toBe('duration')
    expect(failure.detail).toContain('7')
  })

  it('refuses a ratio the model does not offer', () => {
    const failure = failureOf(() =>
      validateMediaRequest(channel(), { prompt: 'x', params: { ratio: '4:3' } }),
    )
    expect(failure.field).toBe('ratio')
  })

  it('accepts a voice outside the suggestions while keeping closed lists strict', () => {
    const tts = channel({
      kind: 'tts',
      options: undefined,
      paramSpecs: [
        { key: 'voice', type: 'select', options: ['Cherry', 'Serena'], allowCustom: true },
        { key: 'format', type: 'select', options: ['mp3', 'wav'] },
      ],
    })
    expect(() =>
      validateMediaRequest(tts, { prompt: 'hello', params: { voice: 'my-cloned-voice' } }),
    ).not.toThrow()
    expect(
      failureOf(() => validateMediaRequest(tts, { prompt: 'hello', params: { format: 'ogg' } }))
        .field,
    ).toBe('format')
  })

  it('treats a legacy voice list as suggestions', () => {
    const tts = channel({ kind: 'tts', options: { voice: ['Cherry', 'Serena'] } })
    expect(() =>
      validateMediaRequest(tts, { prompt: 'hello', params: { voice: 'custom-voice' } }),
    ).not.toThrow()
  })

  it('refuses a parameter the model never declared', () => {
    const failure = failureOf(() =>
      validateMediaRequest(channel(), { prompt: 'x', params: { seed: 7 } }),
    )
    expect(failure.code).toBe('invalid_request')
    expect(failure.field).toBe('seed')
    // The refusal says what is available, so the caller does not have to guess a vendor schema.
    expect(failure.detail).toContain('duration')
  })

  it('refuses a parameter declared only for another model', () => {
    const typed = channel({
      options: undefined,
      paramSpecs: [{ key: 'strength', type: 'number', models: ['edit-1'] }],
    })
    expect(
      failureOf(() => validateMediaRequest(typed, { prompt: 'x', params: { strength: 0.5 } })).field,
    ).toBe('strength')
  })

  it('leaves a channel that declares no parameters alone', () => {
    const open = channel({ options: undefined, paramSpecs: undefined })
    expect(() =>
      validateMediaRequest(open, { prompt: 'x', params: { anything: 1 } }),
    ).not.toThrow()
  })

  it('honours numeric bounds when a parameter is typed', () => {
    const typed = channel({
      options: undefined,
      paramSpecs: [{ key: 'duration', type: 'number', min: 5, max: 10 }],
    })
    expect(() => validateMediaRequest(typed, { prompt: 'x', params: { duration: 7 } })).not.toThrow()
    expect(failureOf(() => validateMediaRequest(typed, { prompt: 'x', params: { duration: 3 } })).field).toBe(
      'duration',
    )
  })

  it('requires a prompt', () => {
    const failure = failureOf(() => validateMediaRequest(channel(), { prompt: '   ' }))
    expect(failure.code).toBe('invalid_request')
    expect(failure.field).toBe('prompt')
  })
})

describe('reference counts', () => {
  it('refuses more images than the model accepts', () => {
    const failure = failureOf(() =>
      validateMediaRequest(channel(), { prompt: 'x', counts: { image: 10 } }),
    )
    expect(failure.code).toBe('invalid_request')
    expect(failure.field).toBe('references')
    expect(failure.detail).toContain('9')
  })

  it('refuses more references in total than the model accepts', () => {
    const failure = failureOf(() =>
      validateMediaRequest(channel(), {
        prompt: 'x',
        counts: { image: 9, video: 3, audio: 1 },
      }),
    )
    expect(failure.detail).toContain('12')
  })

  it('does not invent limits for an uncatalogued relay model', () => {
    const relay = channel({
      models: ['relay-video-v9'],
      defaultModel: 'relay-video-v9',
      modelCatalogId: undefined,
    })
    expect(() =>
      validateMediaRequest(relay, { prompt: 'x', counts: { image: 100, video: 20, audio: 5 } }),
    ).not.toThrow()
  })
})

describe('video edit inputs', () => {
  const editing = channel({ modelModes: { 'MiniMax-H3': 'video-edit' } })

  it('needs exactly one video', () => {
    const failure = failureOf(() => validateMediaRequest(editing, { prompt: 'x' }))
    expect(failure.field).toBe('inputs')
    expect(failure.detail).toContain('一个视频')
  })

  it('does not accept anything beside the clip', () => {
    const failure = failureOf(() =>
      validateMediaRequest(editing, { prompt: 'x', counts: { video: 1, image: 1 } }),
    )
    expect(failure.detail).toContain('只接收一个视频')
  })

  it('accepts exactly one video', () => {
    expect(() =>
      validateMediaRequest(editing, { prompt: 'x', counts: { video: 1 } }),
    ).not.toThrow()
  })
})
