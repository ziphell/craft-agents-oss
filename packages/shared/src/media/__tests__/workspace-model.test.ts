import { describe, expect, test } from 'bun:test'
import {
  evaluateUnderstandCapabilities,
  omniPayloadProblem,
  pickOmniConnection,
  pickVisionConnection,
  OMNI_MAX_AUDIO_BYTES,
  OMNI_MAX_MEDIA_BASE64_BYTES,
  OMNI_MAX_VIDEO_BYTES,
} from '../workspace-model.ts'

const connections = [
  { slug: 'a', models: [{ id: 'text-only', supportsImages: false }] },
  { slug: 'b', models: [{ id: 'vision', supportsImages: true }] },
  { slug: 'c', models: [{ id: 'other' }] },
]

describe('which model answers a picture question', () => {
  test('a named connection wins even if it cannot see', () => {
    expect(pickVisionConnection(connections, 'c')?.slug).toBe('c')
  })

  test('otherwise the first that says it can see images', () => {
    expect(pickVisionConnection(connections)?.slug).toBe('b')
  })

  test('a declared vision model counts as able to see', () => {
    expect(
      pickVisionConnection([
        connections[0]!,
        { slug: 'd', visionModel: 'vision-1', models: [{ id: 'vision-1' }] },
      ])?.slug,
    ).toBe('d')
  })

  test('with nothing that can see, the first connection is still better than nothing', () => {
    expect(pickVisionConnection([connections[0]!, connections[2]!])?.slug).toBe('a')
  })

  test('no connections at all is null, not a crash', () => {
    expect(pickVisionConnection([])).toBeNull()
  })
})

describe('which model listens to a recording', () => {
  test('only a connection that named an omni model is picked', () => {
    expect(pickOmniConnection(connections)).toBeNull()
    expect(
      pickOmniConnection([
        connections[0]!,
        { slug: 'voice', omniModel: 'qwen-omni', models: [{ id: 'qwen-omni' }] },
      ])?.slug,
    ).toBe('voice')
  })

  test('a named connection wins over the first that can listen', () => {
    const list = [
      { slug: 'first', omniModel: 'omni-a' },
      { slug: 'second', omniModel: 'omni-b' },
    ]
    expect(pickOmniConnection(list, 'second')?.slug).toBe('second')
  })

  test('no omni pick means no fallback to the text model', () => {
    expect(pickOmniConnection([connections[0]!])).toBeNull()
  })

  test('an omni pick the wire cannot carry is skipped, and the next connection is used', () => {
    const claude = { slug: 'claude', omniModel: 'qwen-omni', piAuthProvider: 'anthropic' }
    const voice = { slug: 'voice', omniModel: 'qwen-omni' }
    expect(pickOmniConnection([claude, voice])?.slug).toBe('voice')
    expect(pickOmniConnection([claude])).toBeNull()
  })

  test('capabilities do not count a pick the wire cannot carry', () => {
    const claude = [{ slug: 'claude', omniModel: 'qwen-omni', piAuthProvider: 'anthropic' }]
    expect(evaluateUnderstandCapabilities(claude, false).omni).toBe(false)
  })
})

describe('what understand can do', () => {
  test('a main model that can see counts with no vision role', () => {
    const main = [{ slug: 'main', defaultModel: 'main-model', models: [{ id: 'main-model' }] }]
    expect(evaluateUnderstandCapabilities(main, false)).toMatchObject({ vision: true, omni: false, asr: false })
  })

  test('a main model flagged as not accepting images does not count', () => {
    const flagged = [
      {
        slug: 'main',
        defaultModel: 'main-model',
        models: [{ id: 'main-model', supportsImages: false }],
      },
    ]
    expect(evaluateUnderstandCapabilities(flagged, false).vision).toBe(false)
  })

  test('an omni role alone can still read frames', () => {
    const omniOnly = [{ slug: 'voice', omniModel: 'qwen-omni', models: [{ id: 'qwen-omni' }] }]
    expect(evaluateUnderstandCapabilities(omniOnly, false)).toMatchObject({ omni: true })
  })
})

describe('how much media one omni request may carry', () => {
  test('a video over the app ceiling is refused before any upload', () => {
    expect(omniPayloadProblem({ videoBytes: OMNI_MAX_VIDEO_BYTES + 1 })).toContain('超过单次请求')
  })

  test('an audio over the ceiling is refused', () => {
    expect(omniPayloadProblem({ audioBytes: OMNI_MAX_AUDIO_BYTES + 1 })).toContain('音频')
  })

  test('a clip at the ceiling is accepted', () => {
    expect(omniPayloadProblem({ videoBytes: OMNI_MAX_VIDEO_BYTES })).toBeUndefined()
  })

  test('a video plus a separate soundtrack is refused', () => {
    expect(omniPayloadProblem({ videoBytes: 1024, audioBytes: 1024 })).toContain(
      '一次只能带一个媒体文件',
    )
  })

  test('an image whose base64 string is over 10 MB is refused', () => {
    expect(
      omniPayloadProblem({ largestImageChars: OMNI_MAX_MEDIA_BASE64_BYTES + 1 }),
    ).toContain('单张图片')
  })

  test('the combined base64 body stays under the request ceiling', () => {
    // A clip at the media ceiling is already a 10 MB string; 55 MB of images no longer fits.
    expect(
      omniPayloadProblem({ videoBytes: OMNI_MAX_VIDEO_BYTES, imageChars: 55 * 1024 * 1024 }),
    ).toContain('媒体合计')
  })

  test('a small clip with a prompt passes', () => {
    expect(
      omniPayloadProblem({ videoBytes: 5 * 1024 * 1024, instructionChars: 200 }),
    ).toBeUndefined()
  })
})
