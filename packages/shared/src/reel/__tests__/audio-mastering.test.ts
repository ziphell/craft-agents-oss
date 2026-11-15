import { describe, expect, test } from 'bun:test'
import {
  audioRms,
  gateGainAt,
  gateWindowCurve,
  noiseGateCurve,
  normalizationGain,
} from '../audio-mastering.ts'

const constant = (value: number, seconds: number, sampleRate = 48000) =>
  new Float32Array(Math.round(seconds * sampleRate)).fill(value)

describe('mastering — even loudness and a noise gate', () => {
  test('RMS measures a constant source, and the normaliser aims at -18 dBFS', () => {
    expect(audioRms([constant(0.5, 1)])).toBeCloseTo(0.5, 4)
    expect(audioRms([constant(0, 1)])).toBe(0)
    // -18 dBFS ≈ 0.126; a source at 0.5 needs about -12 dB of make-up.
    expect(normalizationGain(0.5)).toBeCloseTo(0.2518, 3)
    // A silent source is left alone instead of boosted to noise.
    expect(normalizationGain(0)).toBe(1)
  })

  test('the gate closes on silence and opens on speech-level sound', () => {
    const sampleRate = 48000
    const silence = constant(0.001, 0.5, sampleRate)
    const speech = constant(0.2, 0.5, sampleRate)
    const channels = [new Float32Array([...silence, ...speech])]
    const curve = noiseGateCurve(channels, sampleRate)

    expect(gateGainAt(curve, 0.45)).toBeLessThan(0.5)
    expect(gateGainAt(curve, 0.9)).toBeGreaterThan(0.9)
  })

  test('a window curve has both ends and a value per sample', () => {
    const curve = noiseGateCurve([constant(0.2, 1)], 48000)
    const window = gateWindowCurve(curve, 0, 0.5, 0.5, 50)
    expect(window.length).toBe(26)
    expect(window[0]).toBeCloseTo(gateGainAt(curve, 0), 5)
    expect(window[window.length - 1]).toBeCloseTo(gateGainAt(curve, 0.5), 5)
  })
})
