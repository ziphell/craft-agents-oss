import { describe, expect, test } from 'bun:test'
import { automationGainAt, duckingEnvelope, type VolumePoint } from '../ducking.ts'

const BUCKET = 1 / 50
const AMOUNTS = { threshold: -30, reduction: 0.6, attack: 0.1, release: 0.3, holdTime: 0.2 }

/** Peaks at 50 a second: loud where `speaking` says so, nearly silent elsewhere. */
function peaksOf(speaking: (time: number) => boolean, seconds: number): Float32Array {
  const values = new Float32Array(Math.ceil(seconds / BUCKET))
  for (let index = 0; index < values.length; index += 1) {
    values[index] = speaking(index * BUCKET) ? 0.5 : 0.001
  }
  return values
}

describe('ducking, the way MiniMax bakes it', () => {
  test('keyframes interpolate linearly and hold their ends', () => {
    const points: VolumePoint[] = [
      { time: 0, value: 1 },
      { time: 2, value: 0.5 },
      { time: 4, value: 1 },
    ]
    expect(automationGainAt(undefined, 1)).toBe(1)
    expect(automationGainAt(points, -1)).toBe(1)
    expect(automationGainAt(points, 1)).toBeCloseTo(0.75)
    expect(automationGainAt(points, 2)).toBeCloseTo(0.5)
    expect(automationGainAt(points, 3)).toBeCloseTo(0.75)
    expect(automationGainAt(points, 9)).toBe(1)
  })

  test('speech above the threshold lowers the clip, and silence releases it', () => {
    // Speech from 1s to 3s of a 5s clip.
    const points = duckingEnvelope({
      peaks: peaksOf((time) => time >= 1 && time < 3, 5),
      bucketSeconds: BUCKET,
      duration: 5,
      settings: AMOUNTS,
    })

    expect(points.length).toBeGreaterThan(2)
    expect(points[0]!.value).toBe(1)
    // Sorted by time, and never below 1 - reduction.
    const times = points.map((point) => point.time)
    expect(times).toEqual([...times].sort((left, right) => left - right))
    expect(Math.min(...points.map((point) => point.value))).toBeGreaterThanOrEqual(0.4 - 0.02)
    expect(Math.min(...points.map((point) => point.value))).toBeLessThan(0.55)

    const at = (time: number) => automationGainAt(points, time)
    expect(at(0.5)).toBeGreaterThan(0.9)
    expect(at(2)).toBeLessThan(0.6)
    // After the hold and the release, the music is back.
    expect(at(5)).toBeGreaterThan(0.95)
    expect(points[points.length - 1]!.time).toBe(5)
  })

  test('a trigger that never crosses the threshold produces no keyframes', () => {
    const points = duckingEnvelope({
      peaks: peaksOf(() => false, 3),
      bucketSeconds: BUCKET,
      duration: 3,
      settings: AMOUNTS,
    })
    expect(points).toEqual([])
  })
})
