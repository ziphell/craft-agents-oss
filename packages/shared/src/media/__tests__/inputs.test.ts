import { describe, expect, it } from 'bun:test'
import {
  isSubtitleFile,
  MediaFailure,
  prepareInput,
  prepareInputs,
  ProviderRefCache,
  type InputTransport,
  type ProviderRef,
} from '../index.ts'

const bytes = (size: number, fill = 7): Uint8Array => new Uint8Array(size).fill(fill)
const file = (size = 16, mimeType = 'image/png') => ({ kind: 'bytes' as const, bytes: bytes(size), mimeType })

describe('what a file name is', () => {
  it('knows a subtitle by its extension', () => {
    expect(isSubtitleFile('assets/script.srt')).toBe(true)
    expect(isSubtitleFile('assets/script.VTT')).toBe(true)
    expect(isSubtitleFile('assets/script.txt')).toBe(false)
    expect(isSubtitleFile('assets/script.md')).toBe(false)
  })
})

describe('how a local file reaches a provider', () => {
  it('inlines bytes when the provider takes them and the file fits', async () => {
    const transport: InputTransport = { acceptsInlineBytes: true, maxInlineBytes: 1024 }
    const ref = await prepareInput('p', file(64), transport)

    expect(ref.kind).toBe('data-url')
    expect(ref.value.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('uploads when the provider only takes http', async () => {
    const uploaded: string[] = []
    const transport: InputTransport = {
      upload: async ({ bytes: data, mimeType }) => {
        expect(mimeType).toBe('image/png')
        uploaded.push(String(data.length))
        return { kind: 'url', value: 'https://provider.example/up/1.png' }
      },
    }
    const ref = await prepareInput('p', file(5000), transport)

    expect(ref).toEqual({ kind: 'url', value: 'https://provider.example/up/1.png' })
    expect(uploaded).toEqual(['5000'])
  })

  it('uploads instead of inlining when the file is too big', async () => {
    let inlined = false
    const transport: InputTransport = {
      acceptsInlineBytes: true,
      maxInlineBytes: 512,
      upload: async () => ({ kind: 'url', value: 'https://provider.example/big.png' }),
    }
    const ref = await prepareInput('p', file(4096), transport)
    expect(ref.kind).toBe('url')
    expect(inlined).toBe(false)
  })

  it('reviews an uploaded asset when the provider requires it', async () => {
    const order: string[] = []
    const transport: InputTransport = {
      upload: async () => {
        order.push('upload')
        return { kind: 'asset-id', value: 'raw-1' }
      },
      review: async (ref) => {
        order.push('review')
        return { kind: 'asset-id', value: `${ref.value}-approved` }
      },
    }
    const ref = await prepareInput('p', file(256), transport)

    expect(order).toEqual(['upload', 'review'])
    expect(ref.value).toBe('raw-1-approved')
  })

  it('passes a URL through instead of uploading it again', async () => {
    let uploads = 0
    const transport: InputTransport = {
      upload: async () => {
        uploads += 1
        return { kind: 'url', value: 'x' }
      },
    }
    const ref = await prepareInput('p', { kind: 'url', url: 'https://cdn/x.png' }, transport)
    expect(ref).toEqual({ kind: 'url', value: 'https://cdn/x.png' })
    expect(uploads).toBe(0)
  })

  it('names the layer when there is no way to deliver the file', async () => {
    const transport: InputTransport = { acceptsInlineBytes: true, maxInlineBytes: 10 }
    await expect(prepareInput('p', file(4096), transport)).rejects.toThrow(MediaFailure)
    try {
      await prepareInput('p', file(4096), transport)
    } catch (error) {
      expect((error as MediaFailure).layer).toBe('upload')
      expect(String(error)).toContain('上传失败')
    }
  })

  it('blames the review layer, not the upload, when a review rejects', async () => {
    const transport: InputTransport = {
      upload: async () => ({ kind: 'url', value: 'https://provider/up.png' }),
      review: async () => {
        throw new Error('素材含敏感内容')
      },
    }
    try {
      await prepareInput('p', file(32), transport)
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as MediaFailure).layer).toBe('review')
      expect(String(error)).toContain('审核不通过')
    }
  })

  it('stops the batch at the first input that cannot be delivered', async () => {
    const transport: InputTransport = { acceptsInlineBytes: true, maxInlineBytes: 1024 }
    await expect(
      prepareInputs('p', [file(64), file(8192)], transport),
    ).rejects.toThrow(MediaFailure)
  })
})

describe('the cache that keeps a second job from uploading twice', () => {
  it('reuses the reference for the same bytes under the same provider', async () => {
    let uploads = 0
    const transport: InputTransport = {
      upload: async () => {
        uploads += 1
        return { kind: 'url', value: `https://provider/${uploads}.png` }
      },
    }
    const cache = new ProviderRefCache()

    const first = await prepareInput('p', file(2048), transport, cache)
    const second = await prepareInput('p', file(2048), transport, cache)

    expect(uploads).toBe(1)
    expect(second).toEqual(first)
    expect(cache.size).toBe(1)
  })

  it('does not share a reference across providers', async () => {
    let uploads = 0
    const transport: InputTransport = {
      upload: async () => {
        uploads += 1
        return { kind: 'url', value: `https://provider/${uploads}.png` }
      },
    }
    const cache = new ProviderRefCache()
    await prepareInput('a', file(32), transport, cache)
    await prepareInput('b', file(32), transport, cache)
    expect(uploads).toBe(2)
  })

  it('forgets an entry once its time is up', async () => {
    const cache = new ProviderRefCache(1)
    const transport: InputTransport = {
      upload: async () => ({ kind: 'url' as const, value: 'https://x/1.png' }),
    }
    await prepareInput('p', file(16), transport, cache)
    const ref: ProviderRef = { kind: 'url', value: 'https://x/1.png' }
    expect(cache.get('p', bytes(16))).toEqual(ref)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(cache.get('p', bytes(16))).toBeNull()
  })
})
