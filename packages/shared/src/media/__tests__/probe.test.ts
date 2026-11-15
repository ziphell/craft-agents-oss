import { describe, expect, test } from 'bun:test'
import { probeChannelAccount, type ChannelProbeRequest } from '../probe.ts'

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const probe = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, overrides: Partial<ChannelProbeRequest> = {}) =>
  probeChannelAccount({
    baseUrl: 'https://relay.example.com/v1',
    apiKey: 'sk-test',
    fetch: fetchImpl as unknown as typeof fetch,
    ...overrides,
  })

describe('channel probe', () => {
  test('lists an OpenAI-shaped account and accepts a model it contains', async () => {
    const result = await probe(async () => reply({ data: [{ id: 'image-a' }, { id: 'image-b' }] }), {
      model: 'image-b',
    })
    expect(result.ok).toBe(true)
    expect(result.reason).toBeUndefined()
    expect(result.models).toEqual(['image-a', 'image-b'])
  })

  test('says the model is wrong when the account does not list it', async () => {
    const result = await probe(async () => reply({ data: [{ id: 'image-a' }] }), { model: 'image-z' })
    expect(result.ok).toBe(true)
    expect(result.reason).toBe('model')
    expect(result.models).toEqual(['image-a'])
  })

  test('reads Gemini model names without their prefix', async () => {
    const result = await probe(
      async () => reply({ models: [{ name: 'models/gemini-3-pro-image' }] }),
      { auth: { header: 'x-goog-api-key' } },
    )
    expect(result.ok).toBe(true)
    expect(result.models).toEqual(['gemini-3-pro-image'])
  })

  test('a rejected key is named as the key, not as a network problem', async () => {
    const result = await probe(async () => new Response('', { status: 401 }))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('key')
    expect(result.status).toBe(401)
  })

  test('a provider without a model list is reachable but unverifiable', async () => {
    const result = await probe(async () => new Response('', { status: 404 }))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unsupported')
  })

  test('an unreachable host is its own reason', async () => {
    const result = await probe(async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('network')
  })
})
