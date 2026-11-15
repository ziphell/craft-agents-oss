import { describe, expect, test } from 'bun:test'
import {
  isNeutralAudioEffect,
  normalizeAudioEffect,
  resolveAudioEffect,
} from '../audio-effects.ts'

describe('audio tone — EQ and a compressor', () => {
  test('neutral means untouched, and missing values resolve to neutral', () => {
    expect(isNeutralAudioEffect(resolveAudioEffect())).toBe(true)
    expect(resolveAudioEffect({ bass: 3 })).toEqual({
      highpass: 0,
      bass: 3,
      mid: 0,
      treble: 0,
      compress: false,
      normalize: false,
      denoise: false,
    })
    expect(isNeutralAudioEffect(resolveAudioEffect({ compress: true }))).toBe(false)
    expect(isNeutralAudioEffect(resolveAudioEffect({ normalize: true }))).toBe(false)
    expect(isNeutralAudioEffect(resolveAudioEffect({ denoise: true }))).toBe(false)
  })

  test('values are clamped to what a filter can hear', () => {
    const wide = resolveAudioEffect({ highpass: 9000, bass: 40, mid: -40, treble: 12 })
    expect(wide.highpass).toBe(500)
    expect(wide.bass).toBe(12)
    expect(wide.mid).toBe(-12)
    expect(wide.treble).toBe(12)
  })

  test('a hand-written tone drops neutral values, and an empty one is no tone', () => {
    expect(normalizeAudioEffect({ highpass: 0, bass: 0, mid: 2.5, treble: 0 })).toEqual({ mid: 2.5 })
    expect(normalizeAudioEffect({ highpass: 0, bass: 0, compress: false })).toBeUndefined()
    expect(normalizeAudioEffect({ highpass: 120, compress: true })).toEqual({
      highpass: 120,
      compress: true,
    })
    expect(normalizeAudioEffect({ normalize: true, denoise: true })).toEqual({
      normalize: true,
      denoise: true,
    })
    expect(normalizeAudioEffect(null)).toBeUndefined()
  })
})
