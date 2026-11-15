import { describe, expect, it, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  languageForModel,
  localSherpaModels,
  localSherpaVadModel,
  padAndMerge,
  resolveLocalSherpaModel,
  toSrt,
  type LocalSherpaSegment,
} from '../index.ts'

const roots: string[] = []
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'craft-sherpa-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const touch = (path: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x')
}

describe('finding a local sherpa model', () => {
  it('reads a SenseVoice directory and ignores a Whisper one', () => {
    const root = tempRoot()
    touch(join(root, 'sensevoice', 'model.int8.onnx'))
    touch(join(root, 'sensevoice', 'tokens.txt'))
    touch(join(root, 'whisper-base.en', 'base.en-encoder.int8.onnx'))
    touch(join(root, 'whisper-base.en', 'base.en-decoder.int8.onnx'))
    touch(join(root, 'whisper-base.en', 'base.en-tokens.txt'))

    const models = localSherpaModels(root)
    expect(models.map((model) => model.id)).toEqual(['sensevoice'])
  })

  it('resolves by id and falls back to the first model', () => {
    const root = tempRoot()
    touch(join(root, 'sensevoice', 'model.int8.onnx'))
    touch(join(root, 'sensevoice', 'tokens.txt'))
    touch(join(root, 'sensevoice-small', 'model.onnx'))
    touch(join(root, 'sensevoice-small', 'tokens.txt'))

    expect(resolveLocalSherpaModel({ modelId: 'small', root }).id).toBe('sensevoice-small')
    expect(resolveLocalSherpaModel({ root }).id).toBe('sensevoice')
  })

  it('explains where to put a model when there is none', () => {
    const root = tempRoot()
    try {
      resolveLocalSherpaModel({ root })
      throw new Error('expected a failure')
    } catch (error) {
      expect(error).toMatchObject({ code: 'missing_model', field: 'model' })
    }
  })

  it('finds an optional Silero VAD model beside the ASR models', () => {
    const root = tempRoot()
    expect(localSherpaVadModel(root)).toBeNull()
    touch(join(root, 'silero_vad.onnx'))
    expect(localSherpaVadModel(root)).toContain('silero_vad.onnx')
  })
})

describe('VAD boundaries', () => {
  const rate = 16_000
  const speech = (count: number): Float32Array => new Float32Array(count).fill(0.5)

  it('joins utterances separated by a breath into one decode, keeping the timeline', () => {
    const chunks = padAndMerge(
      [
        { samples: speech(rate), start: 0 },
        { samples: speech(rate), start: Math.round(1.4 * rate) },
      ],
      Math.round(10 * rate),
      rate,
    )

    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.start).toBe(0)
    // 0–1 s speech, 0.4 s breath, 1.4–2.4 s speech, then the 0.45 s tail.
    expect(chunks[0]!.samples.length).toBe(Math.round(2.85 * rate))
    expect(chunks[0]!.samples[Math.round(1.2 * rate)]).toBe(0)
  })

  it('keeps a real pause apart and pads both sides of each cut', () => {
    const chunks = padAndMerge(
      [
        { samples: speech(rate), start: Math.round(2 * rate) },
        { samples: speech(rate), start: Math.round(6 * rate) },
      ],
      Math.round(10 * rate),
      rate,
    )

    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.start).toBe(Math.round(1.75 * rate))
    expect(chunks[0]!.samples.length).toBe(Math.round(1.7 * rate))
    expect(chunks[1]!.start).toBe(Math.round(5.75 * rate))
  })

  it('does not pad past the end of the recording', () => {
    const chunks = padAndMerge(
      [{ samples: speech(rate), start: Math.round(9.5 * rate) }],
      Math.round(10 * rate),
      rate,
    )

    expect(chunks[0]!.start).toBe(Math.round(9.25 * rate))
    expect(chunks[0]!.samples.length).toBe(Math.round(0.75 * rate))
  })
})

describe('the language a model can take', () => {
  it('lets SenseVoice detect, and keeps a hint it was trained for', () => {
    expect(languageForModel()).toBe('auto')
    expect(languageForModel('auto')).toBe('auto')
    expect(languageForModel('yue')).toBe('yue')
  })

  it('refuses a language SenseVoice does not know', () => {
    expect(() => languageForModel('fr')).toThrow('不认识语言')
  })
})

describe('subtitle formatting', () => {
  it('writes standard SRT cues', () => {
    const segments: LocalSherpaSegment[] = [
      { start: 0.72, end: 3.3, text: '开饭时间早上九点至下午五点' },
      { start: 65.1, end: 67.2, text: '下一段' },
    ]
    expect(toSrt(segments)).toBe(
      '1\n00:00:00,720 --> 00:00:03,300\n开饭时间早上九点至下午五点\n\n' +
        '2\n00:01:05,100 --> 00:01:07,200\n下一段\n',
    )
  })
})
