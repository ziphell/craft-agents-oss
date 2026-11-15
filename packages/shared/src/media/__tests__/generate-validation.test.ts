import { describe, expect, it } from 'bun:test'
import { MediaFailure, generateMedia, type MediaChannel } from '../index.ts'

const channel: MediaChannel = {
  id: 'relay',
  name: '中转',
  protocol: 'openai-image',
  baseUrl: 'https://api.test/v1',
  apiKey: 'k',
  kind: 'image',
  models: ['image-1'],
  defaultModel: 'image-1',
  options: { size: ['1024x1024', '1024x1536'], ratio: ['16:9', '9:16'] },
}

describe('a synchronous request is checked before it is sent', () => {
  it('refuses a ratio the channel does not offer without calling the provider', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as typeof fetch

    try {
      await generateMedia({
        channel,
        prompt: 'a wave',
        params: { ratio: '4:3' },
        fetch: fetchImpl,
      })
      throw new Error('expected the request to be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(MediaFailure)
      expect((error as MediaFailure).code).toBe('invalid_request')
      expect((error as MediaFailure).field).toBe('ratio')
    }
    expect(called).toBe(false)
  })

  it('accepts a size the channel offered and reaches the provider', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }),
        { headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const result = await generateMedia({
      channel,
      prompt: 'a wave',
      params: { size: '1024x1024' },
      fetch: fetchImpl,
    })

    expect(called).toBe(true)
    expect(result.bytes.byteLength).toBeGreaterThan(0)
  })

  it('sends a size outside the suggestions, because a size list is open', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }),
        { headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    await generateMedia({
      channel,
      prompt: 'a wave',
      params: { size: '2048x2048' },
      fetch: fetchImpl,
    })

    expect(called).toBe(true)
  })
})
