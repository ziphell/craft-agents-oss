/**
 * Ducking — lowering the music while someone is talking.
 *
 * This follows MiniMax Design's design rather than a live sidechain: the trigger track's levels
 * are analysed once, the result is **baked into volume keyframes on the ducked clip**, and the
 * preview and the exporter only have to follow a keyframe track. That keeps the document a plain
 * JSON file, and the agent can read and rewrite the result.
 *
 * The presets and their numbers are the ones MiniMax ships (threshold in dBFS, reduction as a
 * share of the clip's level, attack/release/hold in seconds).
 *
 * Pure functions only: the panel does the decoding and hands the peaks in.
 */

export interface VolumePoint {
  /** Seconds inside the clip. */
  time: number
  /** Gain multiplier, 0..1. */
  value: number
}

export type DuckingPreset = 'subtle' | 'moderate' | 'aggressive' | 'podcast'

export interface DuckingAmounts {
  /** dBFS: a trigger level above this counts as speech. */
  threshold: number
  /** 0..1: how much of the ducked clip is removed while speech is present. */
  reduction: number
  attack: number
  release: number
  holdTime: number
}

export interface DuckingSettings extends DuckingAmounts {
  /** The track whose sound triggers the duck (dialogue, usually). */
  sourceTrackId: string
}

export const DUCKING_PRESETS: Record<DuckingPreset, { label: string; settings: DuckingAmounts }> = {
  subtle: {
    label: '轻微',
    settings: { threshold: -35, reduction: 0.4, attack: 0.15, release: 0.5, holdTime: 0.2 },
  },
  moderate: {
    label: '适中',
    settings: { threshold: -30, reduction: 0.6, attack: 0.1, release: 0.3, holdTime: 0.2 },
  },
  aggressive: {
    label: '强力',
    settings: { threshold: -25, reduction: 0.8, attack: 0.05, release: 0.2, holdTime: 0.2 },
  },
  podcast: {
    label: '播客',
    settings: { threshold: -28, reduction: 0.75, attack: 0.08, release: 0.4, holdTime: 0.3 },
  },
}

export const DEFAULT_DUCKING: DuckingAmounts = DUCKING_PRESETS.moderate.settings

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** The gain a keyframe track asks for at a moment inside the clip. */
export function automationGainAt(points: readonly VolumePoint[] | undefined, time: number): number {
  if (!points || points.length === 0) return 1
  if (time <= points[0]!.time) return points[0]!.value
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!
    const next = points[index]!
    if (time <= next.time) {
      const span = next.time - previous.time
      if (span <= 0) return next.value
      return previous.value + ((next.value - previous.value) * (time - previous.time)) / span
    }
  }
  return points[points.length - 1]!.value
}

/**
 * Turn a trigger peak track into ducking keyframes.
 *
 * `peaks` is one value per `bucketSeconds` of the ducked clip's own window (the panel builds it
 * from the trigger clips' waveforms). An empty array means the trigger never crossed the
 * threshold, which the caller reports instead of writing a flat envelope.
 */
export function duckingEnvelope(input: {
  peaks: ArrayLike<number>
  bucketSeconds: number
  duration: number
  settings: DuckingAmounts
}): VolumePoint[] {
  const { peaks, bucketSeconds, duration, settings } = input
  if (peaks.length === 0 || duration <= 0 || bucketSeconds <= 0) return []

  const threshold = 10 ** (settings.threshold / 20)
  const ducked = clamp01(1 - settings.reduction)
  const attack = Math.max(0.01, settings.attack)
  const release = Math.max(0.01, settings.release)
  const hold = Math.max(0, settings.holdTime)

  const points: VolumePoint[] = [{ time: 0, value: 1 }]
  let gain = 1
  let emitted = 1
  let holdUntil = -1
  let crossed = false

  for (let index = 0; index < peaks.length; index += 1) {
    const time = index * bucketSeconds
    if (time >= duration) break
    const peak = Math.max(0, Number(peaks[index] ?? 0))
    if (peak > threshold) {
      crossed = true
      // Stay down through the hold; the release ramp starts after it.
      holdUntil = time + hold
    }
    const target = time <= holdUntil ? ducked : 1
    const rate = target < gain ? bucketSeconds / attack : bucketSeconds / release
    gain += (target - gain) * clamp01(rate)
    if (Math.abs(gain - emitted) >= 0.01) {
      points.push({ time, value: gain })
      emitted = gain
    }
  }

  if (!crossed) return []
  const last = points[points.length - 1]!
  if (duration > last.time) points.push({ time: duration, value: gain })
  return points
}
