import { describe, expect, test } from 'bun:test'
import {
  analyzeBeats,
  beatTimes,
  clipBeatTimes,
  clipBeatsOf,
  cutPointsFromBeats,
} from '../beats.ts'

/** An envelope of quiet buckets with a few loud ones — what the waveform's peaks look like. */
const envelope = (spikes: number[], length = 200, base = 0.1, level = 1) => {
  const values = new Float32Array(length).fill(base)
  for (const index of spikes) values[index] = level
  return values
}

describe('beats — the grid a music cut is cut on', () => {
  test('a hit is where the level rises, reported at the bucket it rises on', () => {
    const peaks = envelope([20, 60, 100, 140])
    const beats = beatTimes(peaks, { bucketSeconds: 0.02 })
    expect(beats).toHaveLength(4)
    ;[0.4, 1.2, 2, 2.8].forEach((time, index) => expect(beats[index]).toBeCloseTo(time))
  })

  test('silence has no beats', () => {
    expect(beatTimes(new Float32Array(120), { bucketSeconds: 0.02 })).toEqual([])
    expect(beatTimes([], { bucketSeconds: 0.02 })).toEqual([])
  })

  test('hits closer than the spacing share one slot, and the stronger one wins', () => {
    const peaks = envelope([40, 43], 120, 0.1, 0.5)
    peaks[43] = 1
    const beats = beatTimes(peaks, { bucketSeconds: 0.02, minSpacing: 0.25 })
    expect(beats).toHaveLength(1)
    expect(beats[0]).toBeCloseTo(0.86)
  })

  test('a clip only reports the beats inside its own window, moved onto the timeline', () => {
    // Beats at 0.4, 1.2, 2, 2.8s in the source.
    const peaks = envelope([20, 60, 100, 140])
    // The clip uses 1.0–2.5s of it and sits at 10s.
    expect(clipBeatTimes({ start: 10, in: 1, duration: 1.5 }, peaks, { bucketSeconds: 0.02 })).toEqual([
      10.2, 11,
    ])
  })

  test('a speeded clip maps a source beat to the timeline moment it is heard', () => {
    const peaks = envelope([20, 60, 100, 140])
    // At 2× this clip plays the 1–4s window in 1.5 timeline seconds, so the source beats at
    // 1.2 / 2.0 / 2.8s are heard at 10.1 / 10.5 / 10.9s.
    const beats = clipBeatTimes({ start: 10, in: 1, duration: 1.5, speed: 2 }, peaks, {
      bucketSeconds: 0.02,
    })
    expect(beats).toHaveLength(3)
    ;[10.1, 10.5, 10.9].forEach((time, index) => expect(beats[index]).toBeCloseTo(time, 5))
  })
})

/** A synthetic click track: a quiet floor with a sharp attack every half second at 120 BPM. */
const clickTrack = (seconds = 20, bpm = 120, step = 0.01) => {
  const count = Math.round(seconds / step)
  const rms = new Float32Array(count).fill(0.02)
  const gap = 60 / bpm
  for (let time = 0.5; time < seconds; time += gap) {
    const index = Math.round(time / step)
    rms[index] = 1
    if (index + 1 < count) rms[index + 1] = 0.35
    if (index + 2 < count) rms[index + 2] = 0.15
  }
  return { rms, step }
}

describe('beat analysis — tempo and a fitted grid', () => {
  test('finds 120 BPM, a half-second grid and downbeats every four beats', () => {
    const { rms, step } = clickTrack()
    const analysis = analyzeBeats(rms, { bucketSeconds: step })

    expect(analysis.bpm).toBe(120)
    expect(analysis.confidence).toBeGreaterThan(0.5)
    expect(analysis.beats.length).toBeGreaterThanOrEqual(38)
    expect(analysis.beats[1]!.time - analysis.beats[0]!.time).toBeCloseTo(0.5, 2)
    // Every fourth beat is a bar point, starting at the first snapped one (0.5s here).
    expect(analysis.downbeats.length).toBe(Math.ceil((analysis.beats.length - 1) / 4))
    expect(analysis.downbeats[0]).toBeCloseTo(analysis.beats[1]!.time, 3)
  })

  test('a track with no pulse reports onsets, not a made-up tempo', () => {
    const analysis = analyzeBeats(new Float32Array(400).fill(0.5), { bucketSeconds: 0.01 })
    expect(analysis.bpm).toBe(0)
    expect(analysis.beats).toEqual([])
    expect(analysis.downbeats).toEqual([])
  })

  test('cut points follow the mode, and the start is always included', () => {
    const { rms, step } = clickTrack()
    const analysis = analyzeBeats(rms, { bucketSeconds: step })

    const beats = cutPointsFromBeats(analysis, { mode: 'beats', sensitivity: 1 })
    expect(beats[0]).toBe(0)
    // The grid already starts at 0, so the start is the first beat rather than an extra point.
    expect(beats.length).toBe(analysis.beats.length)

    const bars = cutPointsFromBeats(analysis, { mode: 'downbeats' })
    expect(bars.length).toBe(analysis.downbeats.length + 1)

    const segments = cutPointsFromBeats(analysis, { mode: 'segments', beatsPerCut: 4 })
    expect(segments.length).toBe(analysis.downbeats.length + 1)
  })

  test('a clip maps the analysis onto the timeline, speed included', () => {
    const { rms, step } = clickTrack()
    const analysis = analyzeBeats(rms, { bucketSeconds: step })
    // A 2× clip plays the source 2–8s window in 3 timeline seconds, starting at 10.
    const mapped = clipBeatsOf({ start: 10, in: 2, duration: 3, speed: 2 }, analysis)
    expect(mapped.beats[0]!.time).toBeGreaterThanOrEqual(10)
    expect(mapped.beats[mapped.beats.length - 1]!.time).toBeLessThanOrEqual(13)
    // The first source beat at or after 2s (2.0s) is heard 10s into the timeline at 2×.
    expect(mapped.beats[0]!.time).toBeCloseTo(10, 2)
  })
})
