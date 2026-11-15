import { describe, expect, test } from 'bun:test'
import { transcribeDoubaoOverApi, transcribeOpenAiOverApi } from '../providers/api-asr.ts'
import { MediaFailure } from '../types.ts'

type Init = { headers?: Record<string, string>; body?: unknown }

const bytes = new Uint8Array([1, 2, 3])
const base64 = Buffer.from(bytes).toString('base64')

const recording = {
  baseUrl: 'https://openspeech.test',
  apiKey: 'k',
  bytes,
}

const json = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

describe('Doubao flash recognition', () => {
  test('sends the recording in one request and reads the words', async () => {
    const calls: Array<{ url: string; init?: Init }> = []
    const fetchImpl = (async (url: string, init?: Init) => {
      calls.push({ url, ...(init ? { init } : {}) })
      return json(
        {
          result: {
            text: '这是字节跳动。',
            utterances: [{ start_time: 0, end_time: 1705, text: '这是字节跳动。' }],
          },
          audio_info: { duration: 1705 },
        },
        { 'X-Api-Status-Code': '20000000' },
      )
    }) as unknown as typeof fetch

    const result = await transcribeDoubaoOverApi({ ...recording, fetch: fetchImpl })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://openspeech.test/api/v3/auc/bigmodel/recognize/flash')
    expect(calls[0]!.init?.headers?.['X-Api-Resource-Id']).toBe('volc.bigasr.auc_turbo')
    const body = JSON.parse(String(calls[0]!.init?.body)) as {
      audio: { data?: string; url?: string }
    }
    expect(body.audio).toEqual({ data: base64 })
    expect(result.text).toBe('这是字节跳动。')
    expect(result.utterances).toEqual([{ startMs: 0, endMs: 1705, text: '这是字节跳动。' }])
    expect(result.durationMs).toBe(1705)
    expect(result.via).toBe('doubao-asr')
    expect(result.silent).toBe(false)
  })

  test('names Chinese apart and drops an auto hint', async () => {
    const bodies: Array<{ request?: { language?: string } }> = []
    const fetchImpl = (async (_url: string, init?: Init) => {
      bodies.push(JSON.parse(String(init?.body)) as { request?: { language?: string } })
      return json({ result: { text: 'x', utterances: [] } }, { 'X-Api-Status-Code': '20000000' })
    }) as unknown as typeof fetch

    await transcribeDoubaoOverApi({ ...recording, language: 'zh', fetch: fetchImpl })
    await transcribeDoubaoOverApi({ ...recording, language: 'auto', fetch: fetchImpl })
    await transcribeDoubaoOverApi({ ...recording, language: 'en', fetch: fetchImpl })

    expect(bodies[0]!.request?.language).toBe('zh-CN')
    expect(bodies[1]!.request?.language).toBeUndefined()
    expect(bodies[2]!.request?.language).toBe('en')
  })

  test('a silent recording is an empty transcript, not a failure', async () => {
    const fetchImpl = (async () =>
      new Response('', {
        status: 200,
        headers: { 'X-Api-Status-Code': '20000003' },
      })) as unknown as typeof fetch

    const result = await transcribeDoubaoOverApi({ ...recording, fetch: fetchImpl })
    expect(result.silent).toBe(true)
    expect(result.text).toBe('')
  })

  test('a busy service is a retryable provider refusal, with its code', async () => {
    const fetchImpl = (async () =>
      new Response('', {
        status: 200,
        headers: { 'X-Api-Status-Code': '55000031', 'X-Api-Message': 'server busy' },
      })) as unknown as typeof fetch

    const error = await transcribeDoubaoOverApi({ ...recording, fetch: fetchImpl }).catch(
      (reason) => reason,
    )
    expect(error).toBeInstanceOf(MediaFailure)
    expect(error.layer).toBe('transcribe')
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('55000031')
  })
})

describe('OpenAI-compatible speech to text', () => {
  test('takes the file as multipart, reads verbose segments, and sends no key when there is none', async () => {
    let sent: FormData | undefined
    let auth: string | undefined
    const fetchImpl = (async (_url: string, init?: Init) => {
      sent = init?.body as FormData
      auth = init?.headers?.Authorization
      return json({
        text: '你好。再见。',
        duration: 1.8,
        segments: [
          { start: 0, end: 0.9, text: '你好。' },
          { start: 0.9, end: 1.8, text: '再见。' },
        ],
      })
    }) as unknown as typeof fetch

    const result = await transcribeOpenAiOverApi({
      baseUrl: 'http://127.0.0.1:8080',
      apiKey: '',
      bytes,
      mimeType: 'audio/wav',
      fileName: 'a.wav',
      language: 'zh',
      fetch: fetchImpl,
    })

    expect(auth).toBeUndefined()
    expect(sent?.get('model')).toBe('whisper-1')
    expect(sent?.get('response_format')).toBe('verbose_json')
    expect(sent?.get('language')).toBe('zh')
    expect(result.text).toBe('你好。再见。')
    expect(result.utterances).toEqual([
      { startMs: 0, endMs: 900, text: '你好。' },
      { startMs: 900, endMs: 1800, text: '再见。' },
    ])
    expect(result.durationMs).toBe(1800)
    expect(result.via).toBe('openai-asr')
  })

  test('sends the key when one was configured', async () => {
    let auth = ''
    const fetchImpl = (async (_url: string, init?: Init) => {
      auth = init?.headers?.Authorization ?? ''
      return json({ text: 'x' })
    }) as unknown as typeof fetch

    await transcribeOpenAiOverApi({
      baseUrl: 'https://asr.test',
      apiKey: 'k',
      auth: { header: 'Authorization', prefix: 'Bearer ' },
      bytes,
      mimeType: 'audio/wav',
      fileName: 'a.wav',
      fetch: fetchImpl,
    })

    expect(auth).toBe('Bearer k')
  })

  test('a base that already ends in /v1 does not double the segment', async () => {
    let seen = ''
    const fetchImpl = (async (url: string) => {
      seen = String(url)
      return json({ text: 'x' })
    }) as unknown as typeof fetch

    await transcribeOpenAiOverApi({
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'k',
      bytes,
      mimeType: 'audio/wav',
      fileName: 'a.wav',
      fetch: fetchImpl,
    })

    expect(seen).toBe('https://api.openai.com/v1/audio/transcriptions')
  })

  test('names the server error instead of reporting an empty transcript', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'model is required' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch

    const error = await transcribeOpenAiOverApi({
      baseUrl: 'https://asr.test',
      apiKey: '',
      bytes,
      mimeType: 'audio/wav',
      fileName: 'a.wav',
      fetch: fetchImpl,
    }).catch((reason) => reason)

    expect(error).toBeInstanceOf(MediaFailure)
    expect(error.retryable).toBe(false)
    expect(error.message).toContain('model is required')
  })
})
