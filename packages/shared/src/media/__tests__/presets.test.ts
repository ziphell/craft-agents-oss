import { describe, expect, test } from 'bun:test'
import { CHANNEL_PRESETS, GENERATION_CHANNEL_PRESETS, findChannelPreset } from '../presets.ts'
import { channelForKind, mediaChannelKinds, withPreset } from '../channels.ts'
import { prepareTaskSubmission, mediaChannelForModel } from '../generate.ts'

describe('channel presets', () => {
  test('a channel that only names a preset gets its endpoints', () => {
    const channel = withPreset({ id: 'metaso', name: '秘塔', protocol: 'openai-image', baseUrl: '', models: [], preset: 'metaso' })
    expect(channel.baseUrl).toBe('https://metaso.cn/api/minimax')
    expect(channel.pollPath).toBe('/v2/query/video_generation/{taskId}')
    expect(channel.resultPath).toBe('task.content.url')
    expect(channel.bodyShape).toBe('content')
  })

  test('what the channel says wins over the preset', () => {
    const channel = withPreset({
      id: 'metaso',
      name: '秘塔（走我的中转）',
      protocol: 'openai-image',
      baseUrl: 'https://my-relay.example.com/minimax',
      models: ['MiniMax-H3'],
      preset: 'metaso',
    })
    expect(channel.baseUrl).toBe('https://my-relay.example.com/minimax')
    expect(channel.pollPath).toBe('/v2/query/video_generation/{taskId}')
  })

  test('an unknown preset changes nothing', () => {
    const channel = { id: 'x', name: 'x', protocol: 'openai-image' as const, baseUrl: 'https://x', models: [], preset: 'nope' }
    expect(withPreset(channel).baseUrl).toBe('https://x')
  })

  test('every preset has a base url and an id that is unique', () => {
    const ids = CHANNEL_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const preset of CHANNEL_PRESETS) {
      expect(Boolean(preset.baseUrl && preset.baseUrl.length > 0)).toBe(true)
      expect(findChannelPreset(preset.id)).not.toBeNull()
    }
  })

  test('a built-in model list always names one of its own models as the default', () => {
    for (const preset of CHANNEL_PRESETS) {
      if (!preset.models || preset.models.length === 0) continue
      expect(preset.models).toContain(preset.defaultModel ?? '')
    }
  })

  test('recognition stays out of the generation account list', () => {
    // Transcription is `asr-tool`, not an account, so nothing here declares it as a kind.
    const kinds = GENERATION_CHANNEL_PRESETS.flatMap((preset) =>
      preset.endpoints?.length
        ? preset.endpoints.map((endpoint) => endpoint.kind as string)
        : [preset.kind as string | undefined],
    )
    expect(kinds).not.toContain('asr')
    // Its wire lives with the speech settings instead, not in this catalogue.
    expect(findChannelPreset('volcengine-asr')).toBeNull()
  })

  test('the Doubao music preset composes sound through the audio-generation endpoint', () => {
    const channel = withPreset({
      id: 'music',
      name: '豆包音乐',
      protocol: 'openai-image',
      baseUrl: '',
      models: [],
      preset: 'volcengine-music',
    })
    expect(channel.kind).toBe('music')
    const capability = channelForKind(channel, 'music')
    expect(capability?.submitPath).toBe('/v3/tts/create')
    expect(capability?.bodyShape).toBe('volcengine-audio')
    expect(capability?.auth?.header).toBe('X-Api-Key')
  })

  test('the Bailian video preset queues a task and carries its async header', () => {
    const channel = withPreset({
      id: 'wan',
      name: '万相',
      protocol: 'openai-image',
      baseUrl: '',
      models: [],
      preset: 'bailian-video',
    })
    const capability = channelForKind(channel, 'video')
    expect(capability?.bodyShape).toBe('dashscope-video')
    expect(capability?.submitHeaders?.['X-DashScope-Async']).toBe('enable')
    expect(capability?.taskIdPath).toBe('output.task_id')
    expect(capability?.statusPath).toBe('output.task_status')
    expect(capability?.resultPath).toBe('output.video_url')
  })

  test('one Bailian account holds image, video and speech, with per-model protocols', () => {
    const channel = withPreset({
      id: 'bailian',
      name: '百炼',
      protocol: 'openai-image',
      baseUrl: '',
      models: [],
      apiKey: 'sk-test',
      preset: 'bailian-account',
    })
    expect(mediaChannelKinds(channel).sort()).toEqual(['image', 'tts', 'video'])
    // The capability's default is the synchronous Qwen-Image door, with every image model listed.
    const image = channelForKind(channel, 'image')
    expect(image?.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(image?.pollPath).toBeUndefined()
    expect(image?.models?.length).toBe(9)
    // Sync/async is a fact of the model, not the capability: a caller that asked only the
    // capability would see no pollPath and wait for a queued Wan job.
    expect(mediaChannelForModel(image!, 'wan2.5-t2i-preview').pollPath).toBe('/tasks/{taskId}')
    expect(mediaChannelForModel(image!, 'qwen-image-3.0').pollPath).toBeUndefined()
    // A Wan model inside the same capability queues a task instead.
    const { endpoint } = prepareTaskSubmission(channel, {
      kind: 'image',
      model: 'wan2.5-t2i-preview',
      prompt: '一只橘猫',
    })
    expect(endpoint.baseUrl).toBe('https://dashscope.aliyuncs.com/api/v1')
    expect(endpoint.submitHeaders?.['X-DashScope-Async']).toBe('enable')
    expect(endpoint.resultPath).toBe('output.results.0.url')
  })

  test('a new connection enables no models, and the preset merge keeps it that way', () => {
    const channel = withPreset({
      id: 'bailian',
      name: '百炼',
      protocol: 'openai-image',
      baseUrl: '',
      models: [],
      apiKey: 'sk-test',
      preset: 'bailian-account',
      endpoints: [{ kind: 'image', models: ['qwen-image-3.0'], enabledModels: [] }],
    })
    expect(channelForKind(channel, 'image')?.models).toEqual([])
  })

  test('the Wan image preset queues a task with a pixel size derived from ratio', () => {
    const channel = withPreset({
      id: 'wan-image',
      name: '万相',
      protocol: 'openai-image',
      baseUrl: '',
      models: [],
      apiKey: 'sk-test',
      preset: 'bailian-wan-image',
    })
    const { endpoint, body } = prepareTaskSubmission(channel, {
      prompt: '一只橘猫',
      model: 'wan2.5-t2i-preview',
      params: { ratio: '16:9' },
    })
    expect(endpoint.submitHeaders?.['X-DashScope-Async']).toBe('enable')
    expect((body.input as Record<string, unknown>).prompt).toBe('一只橘猫')
    // The card says 16:9; the model only understands pixels, so the declared chart fills in.
    expect((body.parameters as Record<string, unknown>).size).toBe('1280*720')
    expect(body.parameters).not.toHaveProperty('ratio')
    expect(body.parameters).not.toHaveProperty('quality')
  })

  test('a tier is called quality above the wire and the vendor field below it', () => {
    const h3Image = findChannelPreset('minimax-h3-image')?.paramSpecs?.find(
      (spec) => spec.key === 'quality',
    )
    expect(h3Image?.wire).toBe('area')
    expect(h3Image?.options).toEqual(['1K', '2K', '4K'])

    const wanVideo = findChannelPreset('bailian-video')?.paramSpecs?.find(
      (spec) => spec.key === 'quality' && spec.models?.includes('wan3.0-video'),
    )
    expect(wanVideo?.wire).toBe('resolution')
    expect(wanVideo?.options).toEqual(['480P', '720P', '1080P'])
  })

  test('a multi-capability preset names a default each capability offers', () => {
    for (const preset of CHANNEL_PRESETS) {
      for (const endpoint of preset.endpoints ?? []) {
        if (!endpoint.models?.length) continue
        expect(endpoint.models).toContain(endpoint.defaultModel ?? '')
      }
    }
  })
})
