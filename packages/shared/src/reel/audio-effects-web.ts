/**
 * The WebAudio half of a clip's tone: a low-cut, three shelves and a compressor.
 *
 * Kept apart from `audio-effects.ts` because that module is compiled for Node too (the agent reads
 * the same document), where the WebAudio globals do not exist. The preview builds this chain once
 * per scheduled clip; the exporter builds it once per sound per chunk. Same numbers, same order.
 */

import { AUDIO_BANDS, resolveAudioEffect, type AudioEffect } from './audio-effects.ts'

export interface AudioEffectChain {
  /** Feed the source in here. */
  input: AudioNode
  /** Connect this to the gain stage (or straight to the destination). */
  output: AudioNode
  /** Re-point every filter at a new tone. Cheap: no nodes are rebuilt. */
  update: (effect?: AudioEffect) => void
}

/** Compressor settings when it is switched on (and a transparent setting when it is off). */
const COMPRESSOR_ON = { threshold: -24, knee: 30, ratio: 4, attack: 0.003, release: 0.25 }
const COMPRESSOR_OFF = { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.25 }

/**
 * Build the chain: low-cut, low shelf, mid peak, high shelf, compressor. The compressor is always
 * present but transparent while switched off, so toggling never rebuilds the graph.
 */
export function createAudioEffectChain(
  context: BaseAudioContext,
  effect?: AudioEffect,
): AudioEffectChain {
  const highpass = context.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.Q.value = 0.707

  const low = context.createBiquadFilter()
  low.type = 'lowshelf'
  low.frequency.value = AUDIO_BANDS.low

  const mid = context.createBiquadFilter()
  mid.type = 'peaking'
  mid.frequency.value = AUDIO_BANDS.mid
  mid.Q.value = AUDIO_BANDS.midQ

  const high = context.createBiquadFilter()
  high.type = 'highshelf'
  high.frequency.value = AUDIO_BANDS.high

  const compressor = context.createDynamicsCompressor()

  highpass.connect(low)
  low.connect(mid)
  mid.connect(high)
  high.connect(compressor)

  const update = (next?: AudioEffect) => {
    const value = resolveAudioEffect(next)
    // A filter at 20 Hz is below anything we care about: the cut is off, not bypassed.
    highpass.frequency.value = value.highpass > 0 ? value.highpass : 20
    low.gain.value = value.bass
    mid.gain.value = value.mid
    high.gain.value = value.treble
    const settings = value.compress ? COMPRESSOR_ON : COMPRESSOR_OFF
    compressor.threshold.value = settings.threshold
    compressor.knee.value = settings.knee
    compressor.ratio.value = settings.ratio
    compressor.attack.value = settings.attack
    compressor.release.value = settings.release
  }
  update(effect)

  return { input: highpass, output: compressor, update }
}
