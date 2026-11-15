import { describe, expect, it } from 'bun:test'
import {
  paramsForModel,
  paramSpecsOf,
  paramValue,
  pruneParams,
  wireParams,
  withParamDefaults,
} from '../params.ts'
import { MediaFailure } from '../types.ts'

describe('parameter specs', () => {
  it('turns legacy options into selects, and prefers typed specs when present', () => {
    expect(paramSpecsOf({ options: { duration: [4, 8], ratio: ['16:9'] } })).toEqual([
      { key: 'duration', type: 'select', options: [4, 8], default: 4 },
      { key: 'ratio', type: 'select', options: ['16:9'], default: '16:9' },
    ])

    const typed = [{ key: 'steps', type: 'number' as const, default: 20 }]
    expect(paramSpecsOf({ paramSpecs: typed, options: { duration: [4] } })).toBe(typed)
    // The channel's own generation default wins when it names an offered value.
    expect(paramSpecsOf({ options: { duration: [4, 8] }, params: { duration: 8 } })).toEqual([
      { key: 'duration', type: 'select', options: [4, 8], default: 8 },
    ])
    expect(paramSpecsOf({})).toBeUndefined()
  })

  it('shows only the specs a model accepts', () => {
    const specs = [
      { key: 'size', type: 'select' as const, options: ['1024'] },
      { key: 'strength', type: 'number' as const, models: ['edit-1'] },
    ]
    expect(paramsForModel(specs, 'edit-1').map((spec) => spec.key)).toEqual(['size', 'strength'])
    expect(paramsForModel(specs, 't2i-1').map((spec) => spec.key)).toEqual(['size'])
    expect(paramsForModel(specs, undefined).map((spec) => spec.key)).toEqual(['size', 'strength'])
  })

  it('keeps one spec per key when the same parameter is scoped to different models', () => {
    const specs = [
      {
        key: 'size',
        type: 'select' as const,
        options: ['1024x1024'],
        models: ['qwen-image-3.0'],
      },
      {
        key: 'size',
        type: 'select' as const,
        options: ['1024*1024'],
        models: ['wan2.5-t2i-preview'],
      },
    ]
    expect(paramsForModel(specs, 'wan2.5-t2i-preview').map((spec) => spec.options)).toEqual([
      ['1024*1024'],
    ])
    // No model named: the first declaration answers, never both.
    expect(paramsForModel(specs, undefined)).toHaveLength(1)
  })

  it('fills defaults so what the panel showed is what is sent', () => {
    const specs = [{ key: 'duration', type: 'select' as const, options: [4, 8], default: 8 }]
    expect(withParamDefaults(specs, {})).toEqual({ duration: 8 })
    expect(withParamDefaults(specs, { duration: 4 })).toEqual({ duration: 4 })
    // The merge is mechanical; the validator is what refuses an undeclared name.
    expect(withParamDefaults(specs, { seed: 7 })).toEqual({ duration: 8, seed: 7 })
  })

  it('prunes parameters the new model does not understand', () => {
    const specs = [{ key: 'size', type: 'select' as const, options: ['1024'] }]
    expect(pruneParams({ size: '1024', strength: 0.6 }, specs)).toEqual({ size: '1024' })
    expect(pruneParams({ anything: 1 }, undefined)).toEqual({ anything: 1 })
  })

  it('falls back to the first option when nothing is chosen', () => {
    expect(paramValue({ key: 'x', type: 'select', options: ['a', 'b'] }, {})).toBe('a')
    expect(paramValue({ key: 'x', type: 'number', default: 12 }, { x: 3 })).toBe(3)
  })
})

describe('the wire vocabulary', () => {
  const pixelSpecs = [
    { key: 'ratio', type: 'select' as const, options: ['16:9', '1:1'], default: '16:9' },
    {
      key: 'quality',
      type: 'select' as const,
      options: ['720P'],
      default: '720P',
      sizes: { '16:9': { '720P': '1280*720' }, '1:1': { '720P': '960*960' } },
    },
  ]

  it('turns ratio + quality into the one size a pixel-only model accepts', () => {
    expect(wireParams({ ratio: '16:9', quality: '720P' }, pixelSpecs)).toEqual({ size: '1280*720' })
  })

  it('refuses a pair the chart does not hold instead of rounding it', () => {
    expect(() => wireParams({ ratio: '1:1', quality: '4K' }, pixelSpecs)).toThrow(MediaFailure)
    expect(() => wireParams({ quality: '720P' }, pixelSpecs)).toThrow(MediaFailure)
  })

  it('renames a declared alias and leaves the other keys alone', () => {
    const specs = [
      { key: 'ratio', type: 'select' as const, options: ['16:9'] },
      { key: 'quality', type: 'select' as const, options: ['720P', '1080P'], wire: 'resolution' },
      { key: 'duration', type: 'number' as const },
    ]
    expect(wireParams({ ratio: '16:9', quality: '1080P', duration: 5 }, specs)).toEqual({
      ratio: '16:9',
      resolution: '1080P',
      duration: 5,
    })
  })
})
