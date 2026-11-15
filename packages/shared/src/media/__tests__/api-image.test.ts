import { describe, expect, test } from 'bun:test'
import { generateImageOverApi } from '../providers/api-image.ts'
import { MediaFailure } from '../types.ts'

const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])
const b64 = Buffer.from(pngBytes).toString('base64')

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('generateImageOverApi', () => {
  test('asks the endpoint with the base URL it was given, and returns the bytes', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.url = url
      seen.init = init
      return jsonResponse({ data: [{ b64_json: b64 }] })
    }) as unknown as typeof fetch

    const result = await generateImageOverApi({
      baseUrl: 'https://relay.example.com/v1/',
      apiKey: 'sk-test',
      model: 'metaso-image-1',
      prompt: 'a red cube',
      size: '1024x1024',
      fetch: fetchImpl,
    })

    expect(seen.url).toBe('https://relay.example.com/v1/images/generations')
    const headers = seen.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
    const body = JSON.parse(String(seen.init?.body))
    expect(body).toMatchObject({ model: 'metaso-image-1', prompt: 'a red cube', n: 1, response_format: 'b64_json' })
    expect(Array.from(result.bytes)).toEqual(Array.from(pngBytes))
    expect(result.mimeType).toBe('image/png')
    expect(result.via).toBe('b64_json')
  })

  test('follows a temporary URL and downloads it while it lasts', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('/images/generations')) {
        return jsonResponse({ id: 'job-7', data: [{ url: 'https://cdn.example.com/a.png' }] })
      }
      return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } })
    }) as unknown as typeof fetch

    const result = await generateImageOverApi({
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-test',
      model: 'm',
      prompt: 'p',
      fetch: fetchImpl,
    })

    expect(result.via).toBe('url')
    expect(result.providerTaskId).toBe('job-7')
    expect(result.bytes.byteLength).toBe(pngBytes.byteLength)
  })

  test('a refused key is a sentence about the key, not a status code', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: { message: 'invalid api key' } }, 401)) as unknown as typeof fetch

    const problem = await generateImageOverApi({
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'bad',
      model: 'm',
      prompt: 'p',
      fetch: fetchImpl,
    }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(problem).toBeInstanceOf(MediaFailure)
    expect((problem as MediaFailure).layer).toBe('generate')
    expect((problem as MediaFailure).message).toContain('invalid api key')
    expect((problem as MediaFailure).message).toContain('key')
  })

  test('an empty answer says so instead of returning an empty file', async () => {
    const fetchImpl = (async () => jsonResponse({ data: [] })) as unknown as typeof fetch
    const problem = await generateImageOverApi({
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'k',
      model: 'm',
      prompt: 'p',
      fetch: fetchImpl,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    expect((problem as MediaFailure).message).toContain('没有图片')
  })

  test('MiniMax image uses its own path and aspect_ratio, then reads image_urls', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/image_generation')) {
        seen.url = url
        seen.init = init
        return jsonResponse({
          data: { image_urls: ['https://cdn.example.com/a.jpeg'] },
          metadata: { success_count: '1', failed_count: '0' },
          base_resp: { status_code: 0, status_msg: 'success' },
        })
      }
      return new Response(jpegBytes, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    }) as unknown as typeof fetch

    const result = await generateImageOverApi({
      baseUrl: 'https://api.minimax.cn/v1',
      submitPath: '/image_generation',
      bodyShape: 'minimax-image',
      apiKey: 'sk-test',
      model: 'image-01',
      prompt: 'a cat',
      params: { ratio: '16:9' },
      fetch: fetchImpl,
    })

    expect(seen.url).toBe('https://api.minimax.cn/v1/image_generation')
    const body = JSON.parse(String(seen.init?.body))
    expect(body).toMatchObject({
      model: 'image-01',
      prompt: 'a cat',
      aspect_ratio: '16:9',
      response_format: 'url',
    })
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.via).toBe('url')
  })

  test('MiniMax base_resp failure is named, not reported as an empty gallery', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        base_resp: { status_code: 1008, status_msg: 'insufficient balance' },
      })) as unknown as typeof fetch
    const problem = await generateImageOverApi({
      baseUrl: 'https://api.minimax.cn/v1',
      submitPath: '/image_generation',
      bodyShape: 'minimax-image',
      apiKey: 'k',
      model: 'image-01',
      prompt: 'p',
      fetch: fetchImpl,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    expect((problem as MediaFailure).message).toContain('insufficient balance')
  })

  test('MiniMax image sends a local reference as a data URL in subject_reference', async () => {
    const seen: { init?: RequestInit } = {}
    const dataUrl = 'data:image/png;base64,AAAA'
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/image_generation')) {
        seen.init = init
        return jsonResponse({
          data: { image_urls: ['https://cdn.example.com/a.jpeg'] },
          base_resp: { status_code: 0 },
        })
      }
      return new Response(jpegBytes, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    }) as unknown as typeof fetch

    await generateImageOverApi({
      baseUrl: 'https://api.minimax.cn/v1',
      submitPath: '/image_generation',
      bodyShape: 'minimax-image',
      apiKey: 'k',
      model: 'image-01',
      prompt: 'p',
      images: [dataUrl],
      fetch: fetchImpl,
    })

    const body = JSON.parse(String(seen.init?.body))
    expect(body.subject_reference).toEqual([{ type: 'character', image_file: dataUrl }])
  })

  test('MiniMax image says so when more than one reference is given', async () => {
    const fetchImpl = (async () => {
      throw new Error('must not reach the network')
    }) as unknown as typeof fetch
    const problem = await generateImageOverApi({
      baseUrl: 'https://api.minimax.cn/v1',
      submitPath: '/image_generation',
      bodyShape: 'minimax-image',
      apiKey: 'k',
      model: 'image-01',
      prompt: 'p',
      images: ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'],
      fetch: fetchImpl,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    expect((problem as MediaFailure).message).toContain('只支持 1 张参考图')
  })

  test('MiniMax H3 text-to-image sends area/size to the generations path and reads base64', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.url = url
      seen.init = init
      return jsonResponse({
        created: 1,
        data: [{ b64_json: b64, size: '2720x1536', revised_prompt: 'a cat' }],
        output_format: 'png',
      })
    }) as unknown as typeof fetch

    const result = await generateImageOverApi({
      baseUrl: 'https://api.minimax.cn',
      submitPath: '/v1/images/generations',
      editPath: '/v1/images/edits',
      bodyShape: 'minimax-h3-image',
      apiKey: 'k',
      model: 'MiniMax-H3-Image',
      prompt: 'a cat',
      params: { ratio: '16:9', area: '2K', format: 'png', compression: 80 },
      fetch: fetchImpl,
    })

    expect(seen.url).toBe('https://api.minimax.cn/v1/images/generations')
    const body = JSON.parse(String(seen.init?.body))
    expect(body).toMatchObject({
      model: 'MiniMax-H3-Image',
      prompt: 'a cat',
      n: 1,
      response_format: 'b64_json',
      size: 'auto',
      aspect_ratio: '16:9',
      area: '2K',
      output_format: 'png',
      output_compression: 80,
    })
    expect(body).not.toHaveProperty('images')
    expect(result.mimeType).toBe('image/png')
  })

  test('MiniMax H3 edits with references go to the edits path as image_url entries', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.url = url
      seen.init = init
      return jsonResponse({ data: [{ b64_json: b64 }], output_format: 'png' })
    }) as unknown as typeof fetch

    const first = 'data:image/png;base64,AAAA'
    const second = 'https://cdn.example.com/dog.png'
    await generateImageOverApi({
      baseUrl: 'https://api.minimax.cn',
      submitPath: '/v1/images/generations',
      editPath: '/v1/images/edits',
      bodyShape: 'minimax-h3-image',
      apiKey: 'k',
      model: 'MiniMax-H3-Image',
      prompt: '把图1里的猫换成图2里的柴犬',
      images: [first, second],
      fetch: fetchImpl,
    })

    expect(seen.url).toBe('https://api.minimax.cn/v1/images/edits')
    const body = JSON.parse(String(seen.init?.body))
    expect(body.images).toEqual([{ image_url: first }, { image_url: second }])
    expect(body).not.toHaveProperty('subject_reference')
  })

  test('MiniMax H3 with an explicit size does not also send ratio or area', async () => {
    const seen: { init?: RequestInit } = {}
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.init = init
      return jsonResponse({ data: [{ b64_json: b64 }], output_format: 'png' })
    }) as unknown as typeof fetch

    await generateImageOverApi({
      baseUrl: 'https://api.minimax.cn',
      submitPath: '/v1/images/generations',
      bodyShape: 'minimax-h3-image',
      apiKey: 'k',
      model: 'MiniMax-H3-Image',
      prompt: 'p',
      size: '1024x1024',
      params: { ratio: '16:9', area: '2K' },
      fetch: fetchImpl,
    })

    const body = JSON.parse(String(seen.init?.body))
    expect(body.size).toBe('1024x1024')
    expect(body).not.toHaveProperty('aspect_ratio')
    expect(body).not.toHaveProperty('area')
  })

  test('MiniMax H3 refuses a multi-image request, because one call writes one file', async () => {
    const fetchImpl = (async () => {
      throw new Error('must not reach the network')
    }) as unknown as typeof fetch
    const problem = await generateImageOverApi({
      baseUrl: 'https://api.minimax.cn',
      submitPath: '/v1/images/generations',
      bodyShape: 'minimax-h3-image',
      apiKey: 'k',
      model: 'MiniMax-H3-Image',
      prompt: 'p',
      params: { n: 2 },
      fetch: fetchImpl,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    expect((problem as MediaFailure).message).toContain('每次调用写一个文件')
  })

  test('Gemini image uses {model} in the path, its own header, inline references and candidates', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.url = url
      seen.init = init
      return jsonResponse({
        candidates: [{ content: { parts: [{ inlineData: { data: b64, mimeType: 'image/png' } }] } }],
      })
    }) as unknown as typeof fetch

    const result = await generateImageOverApi({
      baseUrl: 'https://generativelanguage.googleapis.com',
      submitPath: '/v1beta/models/{model}:generateContent',
      bodyShape: 'gemini',
      auth: { header: 'x-goog-api-key', prefix: '' },
      apiKey: 'gk',
      model: 'gemini-3-pro-image',
      prompt: 'a cat',
      params: { ratio: '16:9' },
      images: ['data:image/png;base64,AAAA'],
      fetch: fetchImpl,
    })

    expect(seen.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent',
    )
    const headers = seen.init?.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe('gk')
    const body = JSON.parse(String(seen.init?.body))
    expect(body.contents[0].parts[1]).toEqual({
      inline_data: { mime_type: 'image/png', data: 'AAAA' },
    })
    expect(body.generationConfig.imageConfig.aspectRatio).toBe('16:9')
    expect(Array.from(result.bytes)).toEqual(Array.from(pngBytes))
  })
})
