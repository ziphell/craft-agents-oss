import { describe, expect, test } from 'bun:test'
import { fileNameForMime, speechBodyFor, synthesizeSpeechOverApi } from '../providers/api-speech.ts'
import { MediaFailure } from '../types.ts'

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const call = (fetchImpl: FetchLike, overrides: Record<string, unknown> = {}) =>
  synthesizeSpeechOverApi({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'tts-1',
    text: '你好',
    fetch: fetchImpl as unknown as typeof fetch,
    ...overrides,
  })

describe('speech bodies', () => {
  test('OpenAI speech puts the words in input and the voice beside it', () => {
    const body = speechBodyFor({
      baseUrl: '',
      apiKey: '',
      model: 'tts-1',
      text: 'hello',
      bodyShape: 'openai-speech',
      params: { voice: 'nova', format: 'wav', speed: 1.2 },
    })
    expect(body).toMatchObject({
      model: 'tts-1',
      input: 'hello',
      voice: 'nova',
      response_format: 'wav',
      speed: 1.2,
    })
  })

  test('DashScope Qwen-TTS nests text and voice under input', () => {
    const body = speechBodyFor({
      baseUrl: '',
      apiKey: '',
      model: 'qwen3-tts-flash',
      text: '你好',
      bodyShape: 'dashscope-tts',
      params: { voice: 'Cherry', language: 'zh' },
    })
    expect(body).toEqual({
      model: 'qwen3-tts-flash',
      input: { text: '你好', voice: 'Cherry', language_type: 'zh' },
    })
  })

  test('audio generation names the prompt text_prompt', () => {
    const body = speechBodyFor({
      baseUrl: '',
      apiKey: '',
      model: 'qwen-audio-3.1-tts-next',
      text: '一段轻快的爵士乐',
      bodyShape: 'audio-generation',
      params: { format: 'wav' },
    })
    expect(body).toEqual({
      model: 'qwen-audio-3.1-tts-next',
      input: { text_prompt: '一段轻快的爵士乐', format: 'wav' },
    })
  })

  test('a parameter cannot replace the words in any shape', () => {
    const dashscope = speechBodyFor({
      baseUrl: '',
      apiKey: '',
      model: 'qwen3-tts-flash',
      text: '你好',
      bodyShape: 'dashscope-tts',
      params: { text: 'other' },
    })
    expect((dashscope.input as Record<string, unknown>).text).toBe('你好')

    const generation = speechBodyFor({
      baseUrl: '',
      apiKey: '',
      model: 'music-1',
      text: '一段轻快的爵士乐',
      bodyShape: 'audio-generation',
      params: { text_prompt: 'other' },
    })
    expect((generation.input as Record<string, unknown>).text_prompt).toBe('一段轻快的爵士乐')

    const generic = speechBodyFor({
      baseUrl: '',
      apiKey: '',
      model: 'music-1',
      text: '一段轻快的爵士乐',
      bodyShape: 'prompt',
      params: { prompt: 'other', model: 'other' },
    })
    expect(generic.prompt).toBe('一段轻快的爵士乐')
    expect(generic.model).toBe('music-1')
  })

  test('Volcengine wraps the prompt, voice and audio settings in its own envelope', () => {
    const body = speechBodyFor({
      baseUrl: '',
      apiKey: '',
      model: 'seed-audio-1.0',
      text: '你好',
      bodyShape: 'volcengine-audio',
      params: { speaker: 'zh_female_x', format: 'mp3', speech_rate: 10, pitch_rate: -2 },
    })
    expect(body).toEqual({
      model: 'seed-audio-1.0',
      text_prompt: '你好',
      references: [{ speaker: 'zh_female_x' }],
      audio_config: { format: 'mp3', speech_rate: 10, pitch_rate: -2 },
    })
  })

  test('Bailian Fun-Music nests the prompt, lyrics and switches under input', () => {
    const body = speechBodyFor({
      baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com',
      apiKey: '',
      model: 'fun-music-v1',
      text: '夏日清新民谣，木吉他与口琴伴奏',
      bodyShape: 'dashscope-music',
      params: {
        lyrics: '[verse]\n清晨的阳光',
        gender: 'female',
        is_instrumental: 'true',
        format: 'mp3',
      },
    })
    expect(body).toMatchObject({
      model: 'fun-music-v1',
      input: {
        prompt: '夏日清新民谣，木吉他与口琴伴奏',
        lyrics: '[verse]\n清晨的阳光',
        gender: 'female',
        is_instrumental: true,
        format: 'mp3',
      },
    })
  })

  test('MiniMax music names the brief, the lyrics and the audio settings', () => {
    const body = speechBodyFor({
      baseUrl: 'https://api.minimax.cn/v1',
      apiKey: '',
      model: 'music-1.5',
      text: '独立民谣，忧郁，独自漫步',
      bodyShape: 'minimax-music',
      params: {
        lyrics: '[verse]\n街灯微亮',
        format: 'mp3',
        sample_rate: 44100,
        bitrate: 256000,
      },
    })
    expect(body).toMatchObject({
      model: 'music-1.5',
      prompt: '独立民谣，忧郁，独自漫步',
      lyrics: '[verse]\n街灯微亮',
      output_format: 'url',
      audio_setting: { format: 'mp3', sample_rate: 44100, bitrate: 256000 },
    })
  })

  test('MiniMax music refuses a request with no lyrics', () => {
    expect(() =>
      speechBodyFor({
        baseUrl: 'https://api.minimax.cn/v1',
        apiKey: '',
        model: 'music-1.5',
        text: '独立民谣，忧郁，独自漫步',
        bodyShape: 'minimax-music',
        params: {},
      }),
    ).toThrow(/歌词/)
  })

  test('MiniMax T2A nests the voice and audio settings, and asks for a URL', () => {
    const body = speechBodyFor({
      baseUrl: '',
      apiKey: '',
      model: 'speech-2.8-hd',
      text: '你好',
      bodyShape: 'minimax-tts',
      params: { voice: 'female-shaonv', format: 'mp3', speed: 1.2, emotion: 'happy' },
    })
    expect(body).toEqual({
      model: 'speech-2.8-hd',
      text: '你好',
      stream: false,
      output_format: 'url',
      voice_setting: { voice_id: 'female-shaonv', speed: 1.2, emotion: 'happy' },
      audio_setting: { format: 'mp3' },
    })
  })
})

describe('speech responses', () => {
  test('the file is named for the bytes, not for the request', () => {
    expect(fileNameForMime('clip.mp3', 'audio/wav')).toBe('clip.wav')
    expect(fileNameForMime('clip.mp3', 'audio/mpeg')).toBe('clip.mp3')
    expect(fileNameForMime('clip', 'audio/ogg')).toBe('clip.ogg')
    expect(fileNameForMime('clip.mp3', 'application/json')).toBe('clip.mp3')
  })

  test('a binary answer is the file, with the MIME the provider sent', async () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const result = await call(async () =>
      new Response(bytes, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }),
    )
    expect(result.via).toBe('binary')
    expect(result.mimeType).toBe('audio/mpeg')
    expect(result.filename.endsWith('.mp3')).toBe(true)
    expect([...result.bytes]).toEqual([...bytes])
  })

  test('a JSON answer is read through resultPath and downloaded', async () => {
    const urls: string[] = []
    const result = await call(
      async (url) => {
        urls.push(url)
        if (url.endsWith('/generation')) {
          return new Response(
            JSON.stringify({
              output: { audio: { url: 'https://files.example.com/a.wav', duration: 1.5 } },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]), {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        })
      },
      {
        model: 'qwen3-tts-flash',
        bodyShape: 'dashscope-tts',
        submitPath: '/services/aigc/multimodal-generation/generation',
        resultPath: 'output.audio.url',
      },
    )
    expect(urls).toEqual([
      'https://api.example.com/v1/services/aigc/multimodal-generation/generation',
      'https://files.example.com/a.wav',
    ])
    expect(result.via).toBe('url')
    expect(result.mimeType).toBe('audio/wav')
    expect(result.durationSeconds).toBe(1.5)
  })

  test('a refused key is named as the key', async () => {
    const attempt = call(async () => new Response('', { status: 401 }))
    await expect(attempt).rejects.toBeInstanceOf(MediaFailure)
    await expect(attempt).rejects.toThrow('密钥被拒绝')
  })

  test('an answer with no audio says so instead of returning an empty file', async () => {
    const attempt = call(async () =>
      new Response(JSON.stringify({ output: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await expect(attempt).rejects.toThrow('没有音频')
  })

  test("Volcengine's top-level base64 audio is accepted when no URL is named", async () => {
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45])
    const result = await call(
      async () =>
        new Response(
          JSON.stringify({
            audio: Buffer.from(bytes).toString('base64'),
            duration: 2.5,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      { model: 'seed-audio-1.0', bodyShape: 'volcengine-audio', resultPath: 'url' },
    )
    expect(result.via).toBe('b64')
    expect(result.mimeType).toBe('audio/wav')
    expect(result.durationSeconds).toBe(2.5)
    expect([...result.bytes]).toEqual([...bytes])
  })

  test('MiniMax T2A follows data.audio and reads its millisecond duration', async () => {
    const result = await call(
      async (url) => {
        if (url.endsWith('/t2a_v2')) {
          return new Response(
            JSON.stringify({
              data: { audio: 'https://cdn.example.com/a.mp3', status: 2 },
              extra_info: { audio_length: 1200, audio_format: 'mp3' },
              base_resp: { status_code: 0, status_msg: 'success' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5, 6, 7, 8, 9]), {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        })
      },
      { model: 'speech-2.8-hd', bodyShape: 'minimax-tts', submitPath: '/t2a_v2', resultPath: 'data.audio' },
    )
    expect(result.via).toBe('url')
    expect(result.mimeType).toBe('audio/mpeg')
    expect(result.durationSeconds).toBe(1.2)
  })

  test('MiniMax hex audio is decoded even when a URL was asked for', async () => {
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45])
    const hex = `${Buffer.from(bytes).toString('hex')}${'00'.repeat(100)}`
    const result = await call(
      async () =>
        new Response(
          JSON.stringify({
            data: { audio: hex, status: 2 },
            base_resp: { status_code: 0, status_msg: 'success' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      { model: 'speech-2.8-hd', bodyShape: 'minimax-tts', resultPath: 'data.audio' },
    )
    expect(result.via).toBe('b64')
    expect(result.mimeType).toBe('audio/wav')
  })

  test('MiniMax base_resp failure is named instead of "no audio"', async () => {
    const attempt = call(
      async () =>
        new Response(
          JSON.stringify({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      { model: 'speech-2.8-hd', bodyShape: 'minimax-tts', resultPath: 'data.audio' },
    )
    await expect(attempt).rejects.toThrow('insufficient balance')
  })
})
