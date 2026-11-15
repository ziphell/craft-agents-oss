/**
 * Beats from a level envelope — the "cut on the beat" analysis a timeline editor runs before it
 * slices a music-driven cut.
 *
 * Two levels of answer live here, and they share one decode:
 *
 * - `beatTimes` is the cheap one: a beat is a **rise** in level that clears its local surroundings
 *   and is spaced away from the last accepted one. No tempo, no downbeats — the panel cuts on it.
 * - `analyzeBeats` is the fuller one, ported from OpenReel's detector: onsets from a smoothed RMS
 *   envelope and an adaptive threshold, a tempo histogram over the gaps between onsets, then a
 *   beat grid fitted to that tempo and snapped to nearby onsets. It reports strength and
 *   downbeats, which is what makes "every four beats" and 卡点 arrangement possible.
 *
 * No FFT and no library: a beat is a rise in energy, and the answers are the same every run — the
 * same rule this project keeps for fades, ducking and transitions.
 *
 * Pure functions only: the host decodes the sound, this module decides where the beats are.
 */

export interface BeatAnalysisOptions {
  /** Seconds per bucket in `peaks` — the waveform's own bucket length, not assumed to be 1/50. */
  bucketSeconds: number
  /** Minimum seconds between two accepted beats; default 0.25 (nothing faster than 240 BPM). */
  minSpacing?: number
  /** How far above its local baseline a rise must be; default 1.4 (1 would accept any bump). */
  sensitivity?: number
  /** Buckets on each side that form the baseline; default 8 (about a third of a second). */
  window?: number
  /** Only report beats at or after this time, in seconds. */
  from?: number
  /** Only report beats at or before this time, in seconds. */
  to?: number
}

/**
 * Beat times, in seconds, in order.
 *
 * A bucket counts when it is louder than the mean of its neighbourhood by `sensitivity`, louder
 * than the bucket before it (the arriving edge of a hit, not its tail), and clear of the previous
 * accepted beat by `minSpacing`. When two hits fall in one slot the stronger one wins, so a grid
 * never shifts just because a kick and a snare are close together.
 */
export function beatTimes(
  peaks: Float32Array | readonly number[],
  options: BeatAnalysisOptions,
): number[] {
  const step = options.bucketSeconds
  if (!(step > 0) || peaks.length < 3) return []

  const spacing = Math.max(step, options.minSpacing ?? 0.25)
  const margin = Math.max(1, options.sensitivity ?? 1.4)
  const window = Math.max(1, Math.round(options.window ?? 8))
  const from = options.from ?? 0
  const to = options.to ?? Number.POSITIVE_INFINITY

  let loudest = 0
  for (const value of peaks) {
    if (value > loudest) loudest = value
  }
  // A rise in near-silence is noise, not a beat.
  if (!(loudest > 0)) return []
  const floor = loudest * 0.08

  const found: number[] = []
  for (let index = window; index < peaks.length - window; index += 1) {
    const value = peaks[index] ?? 0
    if (value < floor || value <= (peaks[index - 1] ?? 0)) continue

    let baseline = 0
    for (let around = index - window; around <= index + window; around += 1) {
      baseline += peaks[around] ?? 0
    }
    baseline /= window * 2 + 1
    if (value < baseline * margin) continue

    const time = index * step
    if (time < from || time > to) continue

    const last = found[found.length - 1]
    if (last !== undefined && time - last < spacing) {
      const lastIndex = Math.round(last / step)
      if (value > (peaks[lastIndex] ?? 0)) found[found.length - 1] = time
      continue
    }
    found.push(time)
  }
  return found
}

/** One point on the fitted beat grid. */
export interface BeatPoint {
  /** Source seconds. */
  time: number
  /** 1 when the grid snapped to a real onset, 0.5 when it is a filled-in beat. */
  strength: number
  /** Position in the grid, from 0. */
  index: number
}

export interface BeatAnalysis {
  /** 0 when the material has no steady pulse; the onsets are still reported. */
  bpm: number
  /** 0..1 — how well the grid's beat count agrees with the onsets found. */
  confidence: number
  duration: number
  /** Attacks, in source seconds, before any grid is fitted. */
  onsets: number[]
  beats: BeatPoint[]
  /** Every fourth beat, in source seconds — a bar grid, not a musical downbeat detector. */
  downbeats: number[]
}

export interface BeatAnalyzeOptions {
  /** Seconds per bucket in `levels` — the decoder's own bucket length. */
  bucketSeconds: number
  /** 0 strict (few onsets) … 1 loose (many); default 0.5. */
  sensitivity?: number
  /** Tempo search bounds; default 60–200. */
  minBpm?: number
  maxBpm?: number
  /** Buckets on each side that form the local baseline; default 50 (half a second at 100/s). */
  window?: number
  /** Minimum seconds between two onsets; default 0.1. */
  minSpacing?: number
}

const emptyAnalysis = (duration: number): BeatAnalysis => ({
  bpm: 0,
  confidence: 0,
  duration,
  onsets: [],
  beats: [],
  downbeats: [],
})

/** The median of a window, copied so the caller's array is never reordered. */
function medianOf(values: ArrayLike<number>, start: number, end: number): number {
  const slice: number[] = []
  for (let index = start; index < end; index += 1) slice.push(values[index] ?? 0)
  slice.sort((left, right) => left - right)
  if (slice.length === 0) return 0
  const mid = slice.length >> 1
  return slice.length % 2 === 1
    ? slice[mid]!
    : ((slice[mid - 1] ?? 0) + (slice[mid] ?? 0)) / 2
}

/**
 * The fuller analysis: onsets, tempo, beat grid and downbeats.
 *
 * The steps are the ones OpenReel runs, in JS rather than a WASM module:
 * smooth the RMS envelope, compare each bucket with a median/mean baseline shaped by
 * `sensitivity`, keep local maxima that rise sharply enough and are far enough apart, histogram
 * the gaps into a tempo, then lay a grid at that tempo and snap each point to a nearby onset.
 * A material with no steady pulse reports `bpm: 0` and no grid, but still lists its onsets.
 */
export function analyzeBeats(
  levels: Float32Array | readonly number[],
  options: BeatAnalyzeOptions,
): BeatAnalysis {
  const step = options.bucketSeconds
  const count = levels.length
  if (!(step > 0) || count < 8) return emptyAnalysis(count * (step > 0 ? step : 0))

  const duration = count * step
  const sensitivity = Math.min(1, Math.max(0, options.sensitivity ?? 0.5))
  const window = Math.max(1, Math.round(options.window ?? 50))
  const minBpm = Math.max(1, options.minBpm ?? 60)
  const maxBpm = Math.max(minBpm + 1, options.maxBpm ?? 200)
  const minSpacing = Math.max(step, options.minSpacing ?? 0.1)

  // Five-bucket smoothing: an attack survives it, a single noisy bucket does not.
  const smooth = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    let sum = 0
    let used = 0
    for (let around = index - 2; around <= index + 2; around += 1) {
      if (around < 0 || around >= count) continue
      sum += levels[around] ?? 0
      used += 1
    }
    smooth[index] = used > 0 ? sum / used : 0
  }

  let loudest = 0
  for (const value of smooth) if (value > loudest) loudest = value
  if (!(loudest > 0)) return emptyAnalysis(duration)
  const floor = loudest * 0.08

  // Adaptive threshold, shaped by sensitivity: a strict setting sits closer to the mean, a loose
  // one closer to the median, and the multiplier lowers the bar as sensitivity rises.
  const thresholds = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    const start = Math.max(0, index - window)
    const end = Math.min(count, index + window + 1)
    const median = medianOf(smooth, start, end)
    let sum = 0
    for (let around = start; around < end; around += 1) sum += smooth[around] ?? 0
    const mean = sum / Math.max(1, end - start)
    thresholds[index] =
      (median + (mean - median) * (1 - sensitivity)) * (1.5 - sensitivity * 0.5)
  }

  const minFrames = Math.max(1, Math.round(minSpacing / step))
  const onsets: number[] = []
  let lastOnsetFrame = -minFrames
  for (let index = 1; index < count - 1; index += 1) {
    const value = smooth[index] ?? 0
    if (value < floor) continue
    if (!(value > (smooth[index - 1] ?? 0) && value >= (smooth[index + 1] ?? 0))) continue
    const threshold = thresholds[index] ?? 0
    if (value < threshold) continue
    // The arriving edge of a hit, not its sustained tail.
    if (value - (smooth[index - 1] ?? 0) < threshold * 0.3) continue
    if (index - lastOnsetFrame < minFrames) continue
    onsets.push(index * step)
    lastOnsetFrame = index
  }

  if (onsets.length < 4) {
    return { ...emptyAnalysis(duration), onsets }
  }

  // Tempo: the most common gap between onsets, with half and double tempo counted as weaker votes
  // so a snare-heavy bar does not report double time as the answer.
  const minInterval = 60 / maxBpm
  const maxInterval = 60 / minBpm
  const votes = new Map<number, number>()
  const vote = (bpm: number, weight: number): void => {
    if (!Number.isFinite(bpm) || bpm < minBpm || bpm > maxBpm) return
    votes.set(bpm, (votes.get(bpm) ?? 0) + weight)
  }
  for (let index = 1; index < onsets.length; index += 1) {
    const gap = (onsets[index] ?? 0) - (onsets[index - 1] ?? 0)
    if (gap < minInterval || gap > maxInterval) continue
    vote(Math.round(60 / gap), 1)
    vote(Math.round(120 / gap), 0.5)
    vote(Math.round(30 / gap), 0.3)
  }
  let bpm = 0
  let best = 0
  for (const [candidate, score] of votes) {
    if (score > best) {
      best = score
      bpm = candidate
    }
  }
  if (!bpm) {
    return { ...emptyAnalysis(duration), onsets }
  }

  // Grid: fixed tempo, phase set by the first onset, each point pulled onto an onset within 0.3
  // of a beat. Unsnapped points are kept at half strength so a bar stays continuous.
  const interval = 60 / bpm
  let first = onsets[0] ?? 0
  first -= Math.round(first / interval) * interval
  while (first < 0) first += interval

  const beats: BeatPoint[] = []
  let cursor = 0
  for (let index = 0; first + index * interval <= duration + 1e-6; index += 1) {
    const at = first + index * interval
    while (cursor + 1 < onsets.length && (onsets[cursor + 1] ?? 0) <= at) cursor += 1
    let snapped: number | null = null
    for (const candidateIndex of [cursor, cursor + 1]) {
      const candidate = onsets[candidateIndex]
      if (candidate === undefined) continue
      if (Math.abs(candidate - at) <= interval * 0.3) {
        snapped = candidate
        break
      }
    }
    beats.push({
      time: snapped ?? at,
      strength: snapped === null ? 0.5 : 1,
      index,
    })
  }

  // Bars: every fourth beat, starting at the first snapped one. This is a grid, not a musical
  // downbeat detector — said plainly so no one expects a meter analysis.
  const strongAt = beats.findIndex((beat) => beat.strength >= 0.7)
  const barStart = strongAt >= 0 ? strongAt : 0
  const downbeats = beats
    .filter((_, index) => index >= barStart && (index - barStart) % 4 === 0)
    .map((beat) => beat.time)

  const expected = (duration * bpm) / 60
  const confidence =
    expected > 0
      ? Math.min(1, Math.max(0, 1 - Math.abs(expected - onsets.length) / expected))
      : 0

  return { bpm, confidence, duration, onsets, beats, downbeats }
}

/**
 * The moments a beat-driven arrangement cuts at: the start, plus the selected beats.
 *
 * `beats` keeps beats strong enough for the sensitivity, `downbeats` cuts once a bar, and
 * `segments` cuts every `beatsPerCut` beats. The start is always included and duplicates are
 * dropped, so the answer is a strictly increasing list.
 */
export function cutPointsFromBeats(
  analysis: BeatAnalysis,
  options: {
    mode?: 'beats' | 'downbeats' | 'segments'
    sensitivity?: number
    beatsPerCut?: number
    start?: number
  } = {},
): number[] {
  const mode = options.mode ?? 'beats'
  const start = Math.max(0, options.start ?? 0)
  const sensitivity = Math.min(1, Math.max(0, options.sensitivity ?? 0.5))
  let chosen: number[]
  if (mode === 'downbeats') {
    chosen = analysis.downbeats
  } else if (mode === 'segments') {
    const every = Math.max(2, Math.round(options.beatsPerCut ?? 4))
    chosen = analysis.beats.filter((_, index) => index % every === 0).map((beat) => beat.time)
  } else {
    const strength = 1 - sensitivity
    chosen = analysis.beats
      .filter((beat) => beat.strength >= strength)
      .map((beat) => beat.time)
  }
  const points = [start, ...chosen.filter((time) => time > start + 1e-6)]
  points.sort((left, right) => left - right)
  const unique: number[] = []
  for (const point of points) {
    const last = unique[unique.length - 1]
    if (last === undefined || point - last > 1e-6) unique.push(point)
  }
  return unique
}

/**
 * A source's analysis, put on the timeline where a clip uses it.
 *
 * Speed is part of the mapping: a clip at 2× plays a longer source window in half the timeline
 * time, so a source second is half a timeline second. Ignoring it — as this used to — put every
 * beat after the first one further right than it is heard.
 */
export function clipBeatsOf(
  clip: { start: number; in: number; duration: number; speed?: number },
  analysis: BeatAnalysis,
): BeatAnalysis {
  const speed =
    clip.speed !== undefined && Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1
  const from = clip.in
  const to = clip.in + clip.duration * speed
  const inside = (time: number): boolean => time >= from - 1e-9 && time <= to + 1e-9
  const map = (time: number): number => clip.start + (time - from) / speed
  return {
    ...analysis,
    duration: clip.duration,
    onsets: analysis.onsets.filter(inside).map(map),
    beats: analysis.beats.filter((beat) => inside(beat.time)).map((beat) => ({ ...beat, time: map(beat.time) })),
    downbeats: analysis.downbeats.filter(inside).map(map),
  }
}

/**
 * The beats of a clip's source, put on the timeline where that clip uses them.
 *
 * Beats outside the clip's own window are dropped: a background track that starts at 0:30 has its
 * grid only where it is heard, so a cut never lands where the music is not playing.
 */
export function clipBeatTimes(
  clip: { start: number; in: number; duration: number; speed?: number },
  peaks: Float32Array | readonly number[],
  options: BeatAnalysisOptions,
): number[] {
  const speed =
    clip.speed !== undefined && Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1
  const from = clip.in
  const to = clip.in + clip.duration * speed
  return beatTimes(peaks, {
    ...options,
    from,
    to,
  }).map((time) => clip.start + (time - from) / speed)
}
