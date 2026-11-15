import { describe, expect, it } from 'bun:test'
import {
  normalizeObjectStorage,
  objectStorageUploader,
  testObjectStorage,
  validateObjectStorage,
  vendorEndpoint,
  vendorPathStyle,
  type ObjectStorageConfig,
} from '../index.ts'

const now = new Date('2024-01-02T03:04:05Z')

const config = (overrides: Partial<ObjectStorageConfig> = {}): ObjectStorageConfig =>
  normalizeObjectStorage({
    enabled: true,
    vendor: 'aliyun',
    endpoint: 'https://s3.oss-cn-hangzhou.aliyuncs.com',
    region: 'cn-hangzhou',
    bucket: 'media',
    accessKeyId: 'AKID',
    keyPrefix: 'craft-agent/references',
    pathStyle: false,
    publicBaseUrl: 'https://media.example.com',
    ...overrides,
  })

interface Call {
  url: string
  method: string
  headers: Record<string, string>
}

const fakeFetch = (calls: Call[], body = 'craft-agent'): typeof fetch => {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    if (init?.method === 'PUT') return new Response(null, { status: 200 })
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(body, { status: 200 })
  }) as typeof fetch
}

describe('object storage configuration', () => {
  it('derives vendor endpoints and addressing style', () => {
    expect(vendorEndpoint('aliyun', 'cn-hangzhou')).toBe('https://s3.oss-cn-hangzhou.aliyuncs.com')
    expect(vendorEndpoint('tencent', 'ap-guangzhou')).toBe('https://cos.ap-guangzhou.myqcloud.com')
    expect(vendorEndpoint('cloudflare', 'abc123')).toBe('https://abc123.r2.cloudflarestorage.com')
    expect(vendorEndpoint('aws', 'us-east-1')).toBe('https://s3.us-east-1.amazonaws.com')
    expect(vendorEndpoint('custom', 'x')).toBeNull()
    expect(vendorPathStyle('cloudflare')).toBe(true)
    expect(vendorPathStyle('aliyun')).toBe(false)
  })

  it('reports an incomplete configuration', () => {
    expect(validateObjectStorage(config(), 'secret')).toBeNull()
    expect(validateObjectStorage(config({ bucket: '' }), 'secret')).toBe('config')
    expect(validateObjectStorage(config({ endpoint: 'not-a-url' }), 'secret')).toBe('config')
    expect(validateObjectStorage(config(), '')).toBe('secret')
  })

  it('is off when it is not enabled', async () => {
    const upload = await objectStorageUploader({ config: config({ enabled: false }), secret: 'secret' })
    expect(upload).toBeNull()
  })
})

describe('uploading a reference', () => {
  it('signs a PUT and returns the public URL', async () => {
    const calls: Call[] = []
    const upload = await objectStorageUploader({
      config: config(),
      secret: 'secret',
      fetch: fakeFetch(calls),
      now,
    })
    const url = await upload!({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('PUT')
    expect(calls[0]!.url).toStartWith('https://media.s3.oss-cn-hangzhou.aliyuncs.com/craft-agent/references/')
    expect(calls[0]!.url).toEndWith('.png')
    expect(calls[0]!.headers.authorization).toContain(
      'AWS4-HMAC-SHA256 Credential=AKID/20240102/cn-hangzhou/s3/aws4_request',
    )
    expect(calls[0]!.headers['x-amz-content-sha256']).toHaveLength(64)
    expect(url).toStartWith('https://media.example.com/craft-agent/references/')
  })

  it('uses path-style addressing when asked', async () => {
    const calls: Call[] = []
    const upload = await objectStorageUploader({
      config: config({ vendor: 'custom', pathStyle: true, publicBaseUrl: '' }),
      secret: 'secret',
      fetch: fakeFetch(calls),
      now,
    })
    const url = await upload!({ bytes: new Uint8Array([9]), mimeType: 'image/png' })

    expect(calls[0]!.url).toStartWith('https://s3.oss-cn-hangzhou.aliyuncs.com/media/craft-agent/references/')
    expect(url).toContain('X-Amz-Signature=')
    expect(url).toContain('X-Amz-Expires=86400')
  })

  it('refuses an enabled bucket with no secret', async () => {
    await expect(
      objectStorageUploader({ config: config(), secret: null, fetch: fakeFetch([]) }),
    ).rejects.toThrow('Secret Access Key')
  })
})

describe('testing the bucket', () => {
  it('uploads a probe, reads it back and removes it', async () => {
    const calls: Call[] = []
    const result = await testObjectStorage({
      config: config(),
      secret: 'secret',
      fetch: fakeFetch(calls),
      now,
    })

    expect(result.ok).toBe(true)
    expect(calls.map((call) => call.method)).toEqual(['PUT', 'GET', 'DELETE'])
    expect(calls[1]!.url).toBe(
      'https://media.example.com/craft-agent/references/.connection-check',
    )
  })

  it('reports a public address that cannot be read', async () => {
    const calls: Call[] = []
    const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, method: init?.method ?? 'GET', headers: {} })
      if (init?.method === 'PUT') return new Response(null, { status: 200 })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return new Response('denied', { status: 403 })
    }) as typeof fetch

    const result = await testObjectStorage({
      config: config(),
      secret: 'secret',
      fetch: doFetch,
      now,
    })

    expect(result).toMatchObject({ ok: false, reason: 'read', status: 403 })
  })

  it('maps a rejected key to auth', async () => {
    const doFetch = (async () =>
      new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })) as unknown as typeof fetch
    const result = await testObjectStorage({
      config: config(),
      secret: 'secret',
      fetch: doFetch,
      now,
    })

    expect(result).toMatchObject({ ok: false, reason: 'auth', status: 403 })
  })
})
