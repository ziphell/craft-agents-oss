/**
 * One decode of a source's sound, as a level envelope.
 *
 * A `reel_tool` command runs in the tool layer, which has files but no audio decoder — decoding
 * needs a browser window, the same place `snapshot` and `export` do their work. The host that has
 * one installs a reader here at startup; a host with no decoder leaves it unset and `beats`
 * refuses in words instead of pretending to have listened.
 *
 * The answer is deliberately **levels, not beats**: one decode can serve beat detection, a future
 * waveform and ducking, and the rule that decides where a beat is stays in shared pure code
 * (`beats.ts`), identical on every host.
 */

export interface ReelAudioLevels {
  /** Seconds of decoded sound. */
  duration: number
  /** Seconds per bucket — the resolution the analysis and any drawing must assume. */
  bucketSeconds: number
  /** RMS amplitude per bucket, 0..1. Onset detection reads this, not the peaks. */
  rms: Float32Array
}

export type ReelAudioResult =
  | { ok: true; levels: ReelAudioLevels }
  | { ok: false; message: string }

/**
 * Decode one file's sound into an RMS envelope.
 *
 * `bucketSeconds` is a target, not a promise: a very long file is capped so the answer stays
 * small, and the returned `bucketSeconds` is the resolution actually used.
 */
export type ReelAudioReader = (
  path: string,
  options?: { bucketSeconds?: number },
) => Promise<ReelAudioResult>

let installed: ReelAudioReader | null = null

/** Give the tools a way to listen to a source, or take it away (`null`) on a host that cannot. */
export function setReelAudio(reader: ReelAudioReader | null): void {
  installed = reader
}

/** The reader in force, or null when this host has none. */
export function reelAudio(): ReelAudioReader | null {
  return installed
}
