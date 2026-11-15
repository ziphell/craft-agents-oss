/**
 * What a source file is, without decoding it.
 *
 * `add_clip` used to require the caller to state how long the source is — a number an agent can
 * only get by asking another tool first, and one it guesses when it forgets. The host already has
 * the container parser, so it reads the answer out of the file instead.
 *
 * Container metadata is the cheap half: it answers in milliseconds and is accurate for anything a
 * camera or an encoder wrote. `computeDuration` is the fallback for a file whose header omits it.
 */

export interface ReelSourceInfo {
  /** The file as it was asked about (an absolute path). */
  path: string
  /** Seconds, or null when the container does not say and its tracks cannot be read. */
  duration: number | null
  width?: number
  height?: number
  /** Average video packet rate — one packet per frame for the codecs we handle. */
  fps?: number
  /** Video packet count; with `fps`, this is how many frames the material holds. */
  frameCount?: number
  /** The video codec the container names (`avc`, `hevc`, `prores`, …). */
  codec?: string
  /** Whether the file carries an audio track. */
  hasAudio?: boolean
  /** Why nothing could be read, when nothing could. */
  message?: string
}

/**
 * Probe one or more files. Answers in the order asked, never throws for one bad file.
 *
 * `stats` asks for the expensive half — the packet scan behind `fps` / `frameCount` / `codec`.
 * `add_clip`'s automatic duration only needs the header, so it leaves this off.
 */
export type ReelProbe = (
  paths: string[],
  options?: { stats?: boolean },
) => Promise<ReelSourceInfo[]>

let installed: ReelProbe | null = null

/** Give the tools a way to read a source's shape, or take it away (`null`) on a host that cannot. */
export function setReelProbe(probe: ReelProbe | null): void {
  installed = probe
}

/** The probe in force, or null when this host has none. */
export function reelProbe(): ReelProbe | null {
  return installed
}
