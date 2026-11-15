import { describe, expect, test } from 'bun:test'
import {
  channelForKind,
  enabledChannelsFor,
  endpointsOf,
  mediaChannelKinds,
  mediaKindOfDeclaration,
  withPreset,
  type MediaChannel,
} from '../channels.ts'
import { prepareTaskSubmission } from '../generate.ts'

/** A channel written before capabilities existed: one kind, one set of paths. */
const legacy: MediaChannel = {
  id: 'relay',
  name: '中转',
  protocol: 'openai-image',
  baseUrl: 'https://api.test/v1',
  apiKey: 'k',
  kind: 'video',
  models: ['vid-1'],
  defaultModel: 'vid-1',
  submitPath: '/videos',
  pollPath: '/videos/{taskId}',
  taskIdPath: 'task_id',
  statusPath: 'status',
  resultPath: 'output.url',
  bodyShape: 'prompt',
}

/** One key, two capabilities: a picture endpoint and a video task endpoint. */
const account: MediaChannel = {
  id: 'mm',
  name: 'MiniMax',
  protocol: 'openai-image',
  baseUrl: 'https://api.test',
  apiKey: 'k',
  models: [],
  endpoints: [
    {
      kind: 'video',
      models: ['vid-1'],
      defaultModel: 'vid-1',
      submitPath: '/v2/video_generation',
      pollPath: '/v2/query/video_generation/{taskId}',
      statusPath: 'task.status',
      resultPath: 'task.content.url',
      bodyShape: 'content',
    },
    {
      kind: 'image',
      models: ['img-1'],
      defaultModel: 'img-1',
      submitPath: '/v1/image_generation',
      pollPath: '/v1/image_generation/{taskId}',
      statusPath: 'status',
      resultPath: 'data.url',
      bodyShape: 'prompt',
    },
  ],
}

describe('one account, several capabilities', () => {
  test('a legacy channel is the one endpoint its fields describe', () => {
    const endpoints = endpointsOf(legacy)
    expect(endpoints).toHaveLength(1)
    expect(endpoints[0]!.kind).toBe('video')
    expect(endpoints[0]!.models).toEqual(['vid-1'])
    expect(mediaChannelKinds(legacy)).toEqual(['video'])
  })

  test('a legacy channel still answers for its own kind', () => {
    const capability = channelForKind(legacy, 'video')
    expect(capability?.submitPath).toBe('/videos')
    expect(capability?.pollPath).toBe('/videos/{taskId}')
    expect(capability?.models).toEqual(['vid-1'])
  })

  test('a legacy channel refuses a kind it does not make', () => {
    expect(channelForKind(legacy, 'image')).toBeNull()
  })

  test('a multi-capability account offers each kind, in declaration order', () => {
    expect(mediaChannelKinds(account)).toEqual(['video', 'image'])
    expect(endpointsOf(account)).toHaveLength(2)
  })

  test('each kind is handed its own wire and models', () => {
    const video = channelForKind(account, 'video')
    const image = channelForKind(account, 'image')
    expect(video?.submitPath).toBe('/v2/video_generation')
    expect(video?.resultPath).toBe('task.content.url')
    expect(video?.models).toEqual(['vid-1'])
    expect(image?.submitPath).toBe('/v1/image_generation')
    expect(image?.resultPath).toBe('data.url')
    expect(image?.models).toEqual(['img-1'])
    // The sibling's fields must not leak through the shared account object.
    expect(image?.bodyShape).toBe('prompt')
    expect(video?.bodyShape).toBe('content')
  })

  test('the submit body follows the kind that was asked for', () => {
    const video = prepareTaskSubmission(account, { prompt: 'a wave', kind: 'video' })
    expect(video.endpoint.submitPath).toBe('/v2/video_generation')
    expect(video.endpoint.pollPath).toBe('/v2/query/video_generation/{taskId}')
    expect(video.body.model).toBe('vid-1')
    expect(Array.isArray(video.body.content)).toBe(true)

    const image = prepareTaskSubmission(account, { prompt: 'a cat', kind: 'image' })
    expect(image.endpoint.submitPath).toBe('/v1/image_generation')
    expect(image.endpoint.pollPath).toBe('/v1/image_generation/{taskId}')
    expect(image.body.model).toBe('img-1')
    expect(image.body.prompt).toBe('a cat')
    expect(image.body.content).toBeUndefined()
  })

  test('a kind the account does not offer is refused, not served by a sibling', () => {
    expect(() => prepareTaskSubmission(account, { prompt: 'hello', kind: 'music' })).toThrow()
  })
})

describe('choosing an account', () => {
  test('never offers one that was turned off', () => {
    expect(enabledChannelsFor([{ ...legacy, enabled: false }], 'video')).toEqual([])
  })

  test('prefers the account that lists the model the caller named', () => {
    const a: MediaChannel = { ...legacy, id: 'a', models: ['vid-a'], defaultModel: 'vid-a' }
    const b: MediaChannel = { ...legacy, id: 'b', models: ['vid-b'], defaultModel: 'vid-b' }
    expect(enabledChannelsFor([a, b], 'video', 'vid-b').map((channel) => channel.id)).toEqual([
      'b',
      'a',
    ])
  })

  test('prefers an account that can run over one that cannot', () => {
    const keyless: MediaChannel = { ...legacy, id: 'keyless', apiKey: undefined }
    const ready: MediaChannel = { ...legacy, id: 'ready' }
    expect(enabledChannelsFor([keyless, ready], 'video')[0]?.id).toBe('ready')
  })

  test('keeps file order when nothing distinguishes two accounts', () => {
    const first: MediaChannel = { ...legacy, id: 'first' }
    const second: MediaChannel = { ...legacy, id: 'second' }
    expect(enabledChannelsFor([first, second], 'video').map((channel) => channel.id)).toEqual([
      'first',
      'second',
    ])
  })
})

describe('the body a task submission sends', () => {
  test('fills the parameter defaults the panel shows', () => {
    const channel: MediaChannel = {
      ...account,
      endpoints: [
        {
          kind: 'image',
          models: ['img-1'],
          defaultModel: 'img-1',
          submitPath: '/images/generations',
          pollPath: '/tasks/{taskId}',
          bodyShape: 'prompt',
          paramSpecs: [
            { key: 'ratio', type: 'select', options: ['16:9', '9:16'], default: '16:9' },
          ],
        },
      ],
    }
    const { body } = prepareTaskSubmission(channel, { prompt: 'a cat', kind: 'image' })
    expect(body.ratio).toBe('16:9')
  })

  test('does not send a model-scoped default to a model that does not accept it', () => {
    const channel: MediaChannel = {
      ...account,
      endpoints: [
        {
          kind: 'image',
          models: ['img-1', 'edit-1'],
          defaultModel: 'img-1',
          submitPath: '/images/generations',
          pollPath: '/tasks/{taskId}',
          bodyShape: 'prompt',
          paramSpecs: [{ key: 'strength', type: 'number', default: 0.6, models: ['edit-1'] }],
        },
      ],
    }
    const { body } = prepareTaskSubmission(channel, { prompt: 'a cat', kind: 'image' })
    expect(body.strength).toBeUndefined()
  })

  test('a parameter cannot replace the model, the prompt or the content array', () => {
    const { body } = prepareTaskSubmission(account, {
      prompt: 'a wave',
      kind: 'video',
      params: { model: 'other', content: 'other', duration: 8 },
    })
    expect(body.model).toBe('vid-1')
    expect(Array.isArray(body.content)).toBe(true)
    expect(body.duration).toBe(8)
  })

  test('a Gemini task carries the same config the synchronous path builds', () => {
    const gemini: MediaChannel = {
      id: 'gemini',
      name: 'Gemini',
      protocol: 'openai-image',
      baseUrl: 'https://g.test',
      apiKey: 'k',
      models: ['img-1'],
      defaultModel: 'img-1',
      submitPath: '/v1beta/models/{model}:generateContent',
      pollPath: '/tasks/{taskId}',
      bodyShape: 'gemini',
    }
    const { body } = prepareTaskSubmission(gemini, {
      prompt: 'a cat',
      kind: 'image',
      params: { ratio: '16:9', resolution: '2K' },
    })
    const config = body.generationConfig as Record<string, unknown>
    expect((config.imageConfig as Record<string, unknown>).aspectRatio).toBe('16:9')
    expect(config.resolution).toBe('2K')
  })
})

describe('kinds saved before speech and music split', () => {
  test('an audio declaration is read as the capability its wire describes', () => {
    expect(mediaKindOfDeclaration('audio', 'minimax-tts')).toBe('tts')
    expect(mediaKindOfDeclaration('audio', 'openai-speech')).toBe('tts')
    // Composition is the older default: an audio endpoint with no speech shape makes sound, not words.
    expect(mediaKindOfDeclaration('audio', 'audio-generation')).toBe('music')
    expect(mediaKindOfDeclaration('audio', undefined)).toBe('music')
    // Transcription is not a media capability any more.
    expect(mediaKindOfDeclaration('transcribe', undefined)).toBeNull()
    expect(mediaKindOfDeclaration('tts', undefined)).toBe('tts')
  })

  test('an old endpoint finds the preset endpoint it belongs to', () => {
    const channel = withPreset({
      id: 'mm',
      name: 'MiniMax',
      protocol: 'openai-image',
      baseUrl: '',
      models: [],
      preset: 'minimax-account',
      // Cast: a file on disk may still say `audio`, which the type no longer offers. The saved
      // endpoint carries the wire it was written with, which is what names the capability.
      endpoints: [
        {
          kind: 'audio' as never,
          bodyShape: 'minimax-tts',
          models: ['speech-2.8-hd'],
          defaultModel: 'speech-2.8-hd',
        },
      ],
    })
    const speech = channelForKind(channel, 'tts')
    expect(speech?.submitPath).toBe('/v1/t2a_v2')
    expect(speech?.bodyShape).toBe('minimax-tts')
  })
})

describe('presets and capabilities', () => {
  test('a preset that declares several capabilities fills each one', () => {
    const channel = withPreset({
      id: 'mm',
      name: 'MiniMax',
      protocol: 'openai-image',
      baseUrl: '',
      models: [],
      preset: 'minimax-account',
    })
    expect(mediaChannelKinds(channel)).toEqual(['video', 'image', 'tts', 'music'])
    expect(channel.baseUrl).toBe('https://api.minimax.cn')
    expect(channelForKind(channel, 'video')?.pollPath).toBe('/v2/query/video_generation/{taskId}')
    expect(channelForKind(channel, 'image')?.submitPath).toBe('/v1/images/generations')
    expect(channelForKind(channel, 'image')?.editPath).toBe('/v1/images/edits')
    expect(channelForKind(channel, 'tts')?.bodyShape).toBe('minimax-tts')
    expect(channelForKind(channel, 'music')?.submitPath).toBe('/v1/music_generation')
  })

  test('what the channel wrote wins, while the preset keeps filling the rest', () => {
    const channel = withPreset({
      ...account,
      preset: 'minimax-account',
      // The page edits models; it does not edit the wire.
      endpoints: [
        { kind: 'video', models: ['MiniMax-H3-Lite'], defaultModel: 'MiniMax-H3-Lite' },
        { kind: 'image', models: ['image-01-live'], defaultModel: 'image-01-live' },
      ],
    })
    expect(mediaChannelKinds(channel)).toEqual(['video', 'image'])
    const video = channelForKind(channel, 'video')
    expect(video?.models).toEqual(['MiniMax-H3-Lite'])
    expect(video?.pollPath).toBe('/v2/query/video_generation/{taskId}')
    expect(video?.bodyShape).toBe('content')
    // The capability the person removed is gone, not resurrected by the preset.
    expect(channelForKind(channel, 'tts')).toBeNull()
  })
})
