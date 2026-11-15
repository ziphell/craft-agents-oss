/**
 * 卡点编排 — turn a beat grid into a sequence of clips.
 *
 * The analysis decides **where** the cuts are; this module decides **what fills them**. It is the
 * arrangement half of OpenReel's auto-edit, kept pure so the same plan is produced every run and
 * a test can read it: cut points too close together are dropped, a gap longer than the maximum is
 * capped, and sources are taken in turn so a montage does not repeat the same shot back to back.
 *
 * The plan is placed at the cut points themselves (not packed end to end): a capped segment leaves
 * a short hole rather than pulling every later cut off the beat. `remove_gaps` closes those holes
 * when a packed result is wanted.
 */

export interface ArrangeSource {
  /** Project-relative path (`assets/a.mp4`). */
  src: string
  /** How much material the file holds, in seconds. */
  duration: number
}

export interface ArrangeOptions {
  /** Timeline seconds, ascending, starting at the segment start. */
  cutPoints: number[]
  sources: ArrangeSource[]
  /** Shortest clip worth placing; default 0.3s. Closer cut points are dropped. */
  minClipDuration?: number
  /** Longest clip a single cut may hold; default 10s. Longer gaps are capped, not skipped. */
  maxClipDuration?: number
  /** Timeline second the arrangement starts at; default the first cut point. */
  start?: number
  /** Stop placing clips at or after this timeline second. */
  totalDuration?: number
  /**
   * `walk` advances through each source so repeated use shows different material; `hold` always
   * starts at the source's beginning. Default `walk`.
   */
  inPoint?: 'walk' | 'hold'
}

export interface ArrangedClip {
  src: string
  /** Timeline seconds. */
  start: number
  /** Source seconds. */
  in: number
  duration: number
  /** Index of the cut point that opened this clip. */
  cutIndex: number
}

export interface ArrangePlan {
  clips: ArrangedClip[]
  /** Cut points dropped because the next one was closer than `minClipDuration`. */
  skipped: number
  /** Clips shortened because their source was shorter than the gap. */
  shortened: number
}

/**
 * Plan one clip per accepted cut point.
 *
 * `sources` must be non-empty. A source too short for its gap is skipped in favour of the next
 * one; when none is long enough the longest is used and the clip is shortened — reported in
 * `shortened`, so the caller can say what the file holds instead of guessing.
 */
export function arrangeOnCutPoints(options: ArrangeOptions): ArrangePlan {
  const clips: ArrangedClip[] = []
  if (options.sources.length === 0) return { clips, skipped: 0, shortened: 0 }

  const min = Math.max(0.02, options.minClipDuration ?? 0.3)
  const max = Math.max(min, options.maxClipDuration ?? 10)
  const start = Math.max(0, options.start ?? options.cutPoints[0] ?? 0)
  const end = options.totalDuration !== undefined ? Math.max(start, options.totalDuration) : Infinity

  const ordered = [...new Set(options.cutPoints)]
    .filter((point) => Number.isFinite(point) && point >= start - 1e-6)
    .sort((left, right) => left - right)
  const points: number[] = ordered.length && Math.abs((ordered[0] ?? 0) - start) < 1e-6
    ? ordered
    : [start, ...ordered]

  // A beat grid is often denser than a useful shot: keep the first point of each run that is at
  // least `min` away from the last accepted one.
  const accepted: number[] = []
  for (const point of points) {
    const last = accepted[accepted.length - 1]
    if (last === undefined || point - last >= min - 1e-9) accepted.push(point)
  }
  const skipped = points.length - accepted.length

  let turn = 0
  let sequence = 0
  let shortened = 0
  for (let cutIndex = 0; cutIndex < accepted.length - 1; cutIndex += 1) {
    const from = accepted[cutIndex]!
    if (from >= end) break
    const to = Math.min(accepted[cutIndex + 1]!, end)
    const gap = to - from
    if (gap < min - 1e-9) continue
    const wanted = Math.min(gap, max)

    // Take sources in turn, but never one that cannot cover the clip. If none can, use the longest
    // and shorten the clip rather than leaving the cut empty.
    let chosen = -1
    for (let tries = 0; tries < options.sources.length; tries += 1) {
      const index = (turn + tries) % options.sources.length
      if ((options.sources[index]?.duration ?? 0) >= wanted) {
        chosen = index
        break
      }
    }
    let duration = wanted
    if (chosen < 0) {
      let longest = 0
      for (let index = 1; index < options.sources.length; index += 1) {
        if ((options.sources[index]?.duration ?? 0) > (options.sources[longest]?.duration ?? 0)) {
          longest = index
        }
      }
      chosen = longest
      duration = Math.min(wanted, options.sources[longest]?.duration ?? 0)
      if (duration < min - 1e-9) continue
      shortened += 1
    }

    const source = options.sources[chosen]!
    const room = Math.max(0, source.duration - duration)
    const offset = options.inPoint === 'hold' ? 0 : room > 0 ? (sequence * duration) % room : 0
    clips.push({
      src: source.src,
      start: from,
      in: Math.min(room, Math.max(0, offset)),
      duration,
      cutIndex,
    })
    sequence += 1
    turn = chosen + 1
  }

  return { clips, skipped, shortened }
}
