/**
 * Two cheap mastering passes a talking-head cut actually needs: even loudness, and less hiss.
 *
 * **Normalise** measures the decoded source once and applies a constant gain so the clip sits near
 * `NORMALIZE_TARGET_DB` RMS. It is not a broadcast LUFS meter — no K-weighting, no gating — but it
 * makes two recordings from different microphones comparable, and it is the same number in the
 * preview and the export because both read this module.
 *
 * **Denoise** is a downward expander, not spectral repair: it measures the level in short blocks,
 * opens to 1 above a threshold and settles to a floor below it, with slow attack/release. That
 * removes steady hiss between sentences; it does not remove noise under a voice. The curve is
 * computed from the source once and applied as a gain curve, so the renderer and the exporter
 * produce the same samples.
 *
 * Pure functions only: no WebAudio, no DOM. The callers build the nodes.
 */

/** RMS the normaliser aims for, in dBFS. Quiet enough for dialogue, loud enough for phones. */
export const NORMALIZE_TARGET_DB = -18
/** Below this block level the gate closes, in dBFS. */
export const GATE_THRESHOLD_DB = -45
/** How far the gate closes, in dBFS. */
export const GATE_FLOOR_DB = -18
/** One gate decision is made per this many seconds of source. */
export const GATE_BLOCK_SECONDS = 0.02

const dbToGain = (db: number): number => 10 ** (db / 20)
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** RMS of a whole buffer (all channels), with a stride so a long file stays quick to measure. */
export function audioRms(channels: readonly ArrayLike<number>[]): number {
  let sum = 0
  let counted = 0
  for (const channel of channels) {
    // Every fourth sample is 1/4 of the work and the same answer to two decimal places.
    for (let index = 0; index < channel.length; index += 4) {
      const sample = channel[index] ?? 0
      sum += sample * sample
      counted += 1
    }
  }
  return counted > 0 ? Math.sqrt(sum / counted) : 0
}

/** The constant gain that brings `rms` to the target, clamped to ±12 dB. */
export function normalizationGain(rms: number): number {
  if (!(rms > 1e-6)) return 1
  return clamp(dbToGain(NORMALIZE_TARGET_DB) / rms, dbToGain(-12), dbToGain(12))
}

/**
 * A gain curve for the noise gate, one value per 20 ms of source. The curve is what the caller
 * schedules; it is deliberately independent of playback speed (the caller resamples it).
 */
export function noiseGateCurve(
  channels: readonly ArrayLike<number>[],
  sampleRate = 48000,
): Float32Array {
  const frames = channels.reduce((longest, channel) => Math.max(longest, channel.length), 0)
  const block = Math.max(1, Math.round(GATE_BLOCK_SECONDS * Math.max(1, sampleRate)))
  const count = Math.max(1, Math.ceil(frames / block))
  const threshold = dbToGain(GATE_THRESHOLD_DB)
  const floor = dbToGain(GATE_FLOOR_DB)
  const curve = new Float32Array(count)
  let gain = 1
  for (let index = 0; index < count; index += 1) {
    const start = index * block
    const end = Math.min(frames, start + block)
    let sum = 0
    let counted = 0
    for (let frame = start; frame < end; frame += 1) {
      let peak = 0
      for (const channel of channels) {
        const value = Math.abs(channel[frame] ?? 0)
        if (value > peak) peak = value
      }
      sum += peak * peak
      counted += 1
    }
    const rms = counted > 0 ? Math.sqrt(sum / counted) : 0
    const target = rms >= threshold ? 1 : floor
    // Open quickly so a word is not clipped; close slowly so the tail is not chopped.
    gain += (target - gain) * (target > gain ? 0.55 : 0.08)
    curve[index] = gain
  }
  return curve
}

/** The gate gain at a source second; linear between the curve's 20 ms points. */
export function gateGainAt(curve: Float32Array, seconds: number): number {
  if (curve.length === 0) return 1
  const position = clamp(seconds / GATE_BLOCK_SECONDS, 0, curve.length - 1)
  const index = Math.floor(position)
  const next = Math.min(curve.length - 1, index + 1)
  const progress = position - index
  return (curve[index] ?? 1) + ((curve[next] ?? 1) - (curve[index] ?? 1)) * progress
}

/**
 * Resample a source-time gate curve for a scheduled window.
 *
 * `fromSource`/`toSource` are source seconds at the head and tail of the window; the result has
 * `samplesPerSecond` values per **timeline** second, ready for `setValueCurveAtTime`.
 */
export function gateWindowCurve(
  curve: Float32Array,
  fromSource: number,
  toSource: number,
  timelineSeconds: number,
  samplesPerSecond = 50,
): Float32Array {
  const count = Math.max(2, Math.ceil(Math.max(0, timelineSeconds) * samplesPerSecond) + 1)
  const span = toSource - fromSource
  const out = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    const progress = index / (count - 1)
    out[index] = gateGainAt(curve, fromSource + span * progress)
  }
  return out
}
