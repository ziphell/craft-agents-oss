/**
 * The sound's tone — a small EQ and a compressor, applied to one clip's own audio.
 *
 * This module holds the **shape and its numbers**: what a tone is, how it resolves, and where the
 * bands sit. The WebAudio nodes live in `audio-effects-web.ts`, because the shared package is also
 * compiled for Node (the agent), where `AudioNode` does not exist. Both the panel and the exporter
 * call the same chain builder, so what you hear is what is written.
 *
 * Nothing here normalises loudness — a person set the gain, and it stays set.
 */

export interface AudioEffect {
  /** Low-cut in Hz: rumble and handling noise below it disappear. 0 or omitted is off. */
  highpass?: number
  /** Low / mid / high gain in dB, -12..12. 0 is untouched. */
  bass?: number
  mid?: number
  treble?: number
  /** A gentle compressor, to even out speech. */
  compress?: boolean
  /** Bring the clip to a common RMS, so two recordings sit at the same level. */
  normalize?: boolean
  /** Gate steady hiss between sentences (a downward expander, not spectral repair). */
  denoise?: boolean
}

export interface ResolvedAudioEffect {
  highpass: number
  bass: number
  mid: number
  treble: number
  compress: boolean
  normalize: boolean
  denoise: boolean
}

export const NEUTRAL_AUDIO_EFFECT: ResolvedAudioEffect = {
  highpass: 0,
  bass: 0,
  mid: 0,
  treble: 0,
  compress: false,
  normalize: false,
  denoise: false,
}

/** Where the three shelves sit. One place, so the preview and the export cannot disagree. */
export const AUDIO_BANDS = { low: 180, mid: 1200, high: 6000, midQ: 1 } as const

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export function resolveAudioEffect(effect?: AudioEffect): ResolvedAudioEffect {
  if (!effect) return NEUTRAL_AUDIO_EFFECT
  return {
    highpass: effect.highpass ? clamp(effect.highpass, 20, 500) : 0,
    bass: clamp(effect.bass ?? 0, -12, 12),
    mid: clamp(effect.mid ?? 0, -12, 12),
    treble: clamp(effect.treble ?? 0, -12, 12),
    compress: effect.compress === true,
    normalize: effect.normalize === true,
    denoise: effect.denoise === true,
  }
}

export function isNeutralAudioEffect(effect: ResolvedAudioEffect): boolean {
  return (
    effect.highpass === 0 &&
    effect.bass === 0 &&
    effect.mid === 0 &&
    effect.treble === 0 &&
    !effect.compress &&
    !effect.normalize &&
    !effect.denoise
  )
}

/** A hand-written tone becomes a usable one; values at neutral are dropped. */
export function normalizeAudioEffect(raw: unknown): AudioEffect | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const effect: AudioEffect = {}

  const highpass = finite(value.highpass)
  if (highpass !== undefined && highpass > 0) effect.highpass = clamp(highpass, 20, 500)
  for (const key of ['bass', 'mid', 'treble'] as const) {
    const gain = finite(value[key])
    if (gain !== undefined && gain !== 0) effect[key] = clamp(gain, -12, 12)
  }
  if (value.compress === true) effect.compress = true
  if (value.normalize === true) effect.normalize = true
  if (value.denoise === true) effect.denoise = true
  return Object.keys(effect).length > 0 ? effect : undefined
}
