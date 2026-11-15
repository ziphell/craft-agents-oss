import { describe, expect, test } from 'bun:test'
import { mediaCapabilities, mediaToolBrief } from '../tool-brief.ts'
import type { MediaChannel, MediaKind } from '../channels.ts'

const channel = (...kinds: MediaKind[]): MediaChannel => ({
  id: `account-${kinds.join('-')}`,
  name: '账号',
  protocol: 'openai-image',
  baseUrl: 'https://api.test',
  apiKey: 'k',
  models: [],
  endpoints: kinds.map((kind) => ({ kind, models: [kind] })),
})

const briefFor = (channels: MediaChannel[]): string =>
  mediaToolBrief(mediaCapabilities(channels)) ?? ''

/** The same estimate the repo uses when it talks about prompt cost. */
const tokens = (text: string): number =>
  Math.round(text.split(/\s+/).filter(Boolean).length * 1.33)

describe('what media_tool says it can do', () => {
  test('with no account, there is no brief and no tool', () => {
    expect(mediaToolBrief(mediaCapabilities([]))).toBeNull()
    // Reading is somebody else's door, so an unconfigured machine has nothing to say here.
  })

  test('an image-only account is not described as filmed or spoken', () => {
    const brief = briefFor([channel('image')])
    expect(brief).toContain('`generate --prompt')
    expect(brief).toContain('`--kind` is `image` only here')
    expect(brief).toContain('video, music and tts are not configured')
    expect(brief).toContain('`--quality`')
    expect(brief).not.toContain('`--size`')
    expect(brief).not.toContain('`--resolution`')
    expect(brief).not.toContain('`--duration`')
    expect(brief).not.toContain('`--voice`')
  })

  test('image + video names both and still refuses to advertise sound', () => {
    const brief = briefFor([channel('image', 'video')])
    expect(brief).toContain('`--kind` is `image` / `video` here')
    expect(brief).toContain('music and tts are not configured')
    expect(brief).toContain('`--duration`')
    expect(brief).not.toContain('`--voice`')
  })

  test('a music account advertises lyrics, not a picture tier', () => {
    const brief = briefFor([channel('music')])
    expect(brief).toContain('`--lyrics`')
    expect(brief).not.toContain('`--quality`')
    expect(brief).not.toContain('`--duration`')
  })

  test('the legacy chat row is not a capability', () => {
    const legacy = { ...channel('image'), id: 'chat', preset: 'chat' }
    expect(mediaCapabilities([legacy]).generate).toEqual([])
    expect(briefFor([legacy])).not.toContain('`generate --prompt')
  })

  test('does not advertise a capability that is turned off', () => {
    const off = { ...channel('image'), enabled: false }
    expect(mediaCapabilities([off]).generate).toEqual([])
    expect(mediaToolBrief(mediaCapabilities([off]))).toBeNull()
  })

  test('capabilities read every endpoint of an account', () => {
    expect(mediaCapabilities([channel('image', 'video', 'music')])).toEqual({
      generate: ['image', 'video', 'music'],
    })
    // Two accounts add up the same way one account with two endpoints does.
    expect(mediaCapabilities([channel('image'), channel('video')]).generate).toEqual([
      'image',
      'video',
    ])
  })

  test('the fullest brief stays inside the description budget', () => {
    const brief = briefFor([channel('image', 'video', 'music', 'tts')])
    expect(tokens(brief)).toBeLessThanOrEqual(1050)
    for (const kind of ['image', 'video', 'music', 'tts']) expect(brief).toContain(`\`${kind}\``)
  })
})
