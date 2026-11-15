import { describe, expect, it, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ASR_LANGUAGES, normalizeAsrConfig, type AsrConfig } from '../asr-config.ts'
import { asrCloudChannel, asrConfigProblem, asrReady, srtOf } from '../asr.ts'

const roots: string[] = []
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'craft-asr-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const config = (overrides: Partial<AsrConfig> = {}): AsrConfig => ({
  version: 1,
  mode: 'local',
  local: {},
  cloud: {},
  ...overrides,
})

describe('speech settings on disk', () => {
  it('keeps only the fields it understands, trimmed', () => {
    expect(
      normalizeAsrConfig({
        version: 9,
        mode: 'cloud',
        local: { modelDir: '  /models  ', modelId: ' sensevoice ', language: ' zh ', extra: true },
        cloud: { provider: ' doubao ', model: ' volc.bigasr.auc ', baseUrl: 'https://x', extra: true },
      }),
    ).toEqual({
      version: 1,
      mode: 'cloud',
      local: { modelDir: '/models', modelId: 'sensevoice', language: 'zh' },
      cloud: { provider: 'doubao', baseUrl: 'https://x', model: 'volc.bigasr.auc' },
    })
  })

  it('treats a blank or broken file as the defaults', () => {
    expect(normalizeAsrConfig(undefined)).toEqual(config())
    expect(normalizeAsrConfig({ local: { modelDir: '   ' } })).toEqual(config())
  })

  it('settles a cloud mode on the provider it can call, keeping the address fields', () => {
    expect(
      normalizeAsrConfig({
        mode: 'cloud',
        cloud: {
          provider: 'openai-asr',
          model: 'whisper',
          baseUrl: 'http://127.0.0.1:9000',
          language: 'zh',
        },
      }),
    ).toEqual(
      config({
        mode: 'cloud',
        cloud: {
          provider: 'doubao',
          baseUrl: 'http://127.0.0.1:9000',
          model: 'whisper',
          language: 'zh',
        },
      }),
    )
  })

  it('offers the languages the local models know', () => {
    expect([...ASR_LANGUAGES]).toEqual(['auto', 'zh', 'en', 'ja', 'ko', 'yue'])
  })
})

describe('what is wrong with the local engine', () => {
  it('names a directory that is not there', () => {
    expect(asrConfigProblem(config({ local: { modelDir: '/nope/nowhere' } }))).toContain(
      '模型目录不存在',
    )
  })

  it('says a directory holds no model yet', () => {
    const root = tempRoot()
    expect(asrConfigProblem(config({ local: { modelDir: root } }))).toContain('没有找到本地模型')
  })

  it('accepts a SenseVoice directory, and names a model that is not in it', () => {
    const root = tempRoot()
    const model = join(root, 'sensevoice')
    mkdirSync(model, { recursive: true })
    writeFileSync(join(model, 'model.int8.onnx'), 'x')
    writeFileSync(join(model, 'tokens.txt'), 'x')

    expect(asrConfigProblem(config({ local: { modelDir: root } }))).toBeUndefined()
    expect(
      asrConfigProblem(config({ local: { modelDir: root, modelId: 'other-model' } })),
    ).toContain('other-model')
  })
})

describe('when the speech door is offered', () => {
  it('needs a local model that is actually installed', () => {
    const empty = tempRoot()
    expect(asrReady(config({ local: { modelDir: empty } }))).toBe(false)

    const model = join(empty, 'sensevoice')
    mkdirSync(model, { recursive: true })
    writeFileSync(join(model, 'model.int8.onnx'), 'x')
    writeFileSync(join(model, 'tokens.txt'), 'x')
    expect(asrReady(config({ local: { modelDir: empty } }))).toBe(true)
  })

  it('accepts cloud recognition as soon as a provider is chosen', () => {
    expect(asrReady(config({ mode: 'cloud' }))).toBe(false)
    expect(asrReady(config({ mode: 'cloud', cloud: { provider: 'doubao' } }))).toBe(true)
  })
})

describe('the cloud side', () => {
  it('needs a provider, not a local model', () => {
    expect(asrConfigProblem(config({ mode: 'cloud' }))).toContain('没有选择服务商')
    expect(asrConfigProblem(config({ mode: 'cloud', cloud: { provider: 'doubao' } }))).toBeUndefined()
  })

  it('builds the wire it wrote down itself, with the key the caller found', () => {
    const channel = asrCloudChannel(config({ mode: 'cloud', cloud: { provider: 'doubao' } }), 'k-1')
    expect(channel).toMatchObject({
      id: 'doubao',
      name: '火山豆包（录音文件极速版）',
      baseUrl: 'https://openspeech.bytedance.com',
      submitPath: '/api/v3/auc/bigmodel/recognize/flash',
      model: 'volc.bigasr.auc_turbo',
      apiKey: 'k-1',
    })
  })

  it('is null when no provider was chosen — never a fallback', () => {
    expect(asrCloudChannel(config({ mode: 'cloud' }))).toBeNull()
  })

  it('lets the OpenAI-compatible wire name its own address, model, and no key', () => {
    const channel = asrCloudChannel(
      config({
        mode: 'cloud',
        cloud: { provider: 'openai', baseUrl: 'http://127.0.0.1:9000', model: 'large-v3' },
      }),
    )
    expect(channel).toMatchObject({
      id: 'openai',
      baseUrl: 'http://127.0.0.1:9000',
      submitPath: '/v1/audio/transcriptions',
      model: 'large-v3',
    })
    expect(channel?.apiKey).toBeUndefined()
  })

  it('falls back to the wire default when no model was typed', () => {
    const channel = asrCloudChannel(config({ mode: 'cloud', cloud: { provider: 'openai' } }))
    expect(channel).toMatchObject({ baseUrl: 'http://127.0.0.1:8080', model: 'whisper-1' })
  })
})

describe('subtitles', () => {
  it('writes one cue per sentence, with SRT timestamps', () => {
    expect(
      srtOf({
        text: 'one two',
        utterances: [
          { startMs: 0, endMs: 1250, text: 'one' },
          { startMs: 1250, endMs: 3_723_456, text: ' two ' },
        ],
      }),
    ).toBe('1\n00:00:00,000 --> 00:00:01,250\none\n\n2\n00:00:01,250 --> 01:02:03,456\ntwo')
  })

  it('falls back to one whole-file cue when no timings came back', () => {
    expect(srtOf({ text: 'hello', utterances: [], durationMs: 2000 })).toBe(
      '1\n00:00:00,000 --> 00:00:02,000\nhello',
    )
  })
})
