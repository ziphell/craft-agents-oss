/**
 * A source's duration and picture size, read from its container — no window, no decoder.
 *
 * MediaBunny parses containers in plain Node, so this runs in the main process. That matters for a
 * batch: `add_clip` may name ten files with no durations, and opening ten hidden windows would
 * cost ten seconds where reading ten headers costs milliseconds.
 *
 * A file that cannot be parsed answers `duration: null` with the reason, never an exception — the
 * tool reports it beside the clip that needed it.
 */

import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny'
import type { ReelProbe, ReelSourceInfo } from '@craft-agent/shared/reel/probe'

export const probeReelSources: ReelProbe = async (
  paths: string[],
  options?: { stats?: boolean },
): Promise<ReelSourceInfo[]> =>
  Promise.all(paths.map((path) => probeOne(path, { stats: options?.stats === true })))

async function probeOne(path: string, options: { stats: boolean }): Promise<ReelSourceInfo> {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(path) })
  try {
    // The header first: it is what a camera or an encoder writes, and it costs one read. A file
    // without one falls back to scanning its packets.
    const fromMetadata = await input.getDurationFromMetadata(undefined, { skipLiveWait: true })
    const duration = fromMetadata ?? (await input.computeDuration(undefined, { skipLiveWait: true }))
    const video = await input.getPrimaryVideoTrack()
    const audio = await input.getPrimaryAudioTrack()
    const info: ReelSourceInfo = {
      path,
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
      hasAudio: audio !== null,
    }
    if (video) {
      info.width = await video.getDisplayWidth()
      info.height = await video.getDisplayHeight()
      if (options.stats) {
        info.codec = (await video.getCodec()) ?? undefined
        // Reading packets is a parse, not a decode: one pass over the file, no frames come out.
        const stats = await video.computePacketStats()
        if (stats.packetCount > 0) {
          info.frameCount = stats.packetCount
          info.fps = Number(stats.averagePacketRate.toFixed(3))
        }
      }
    }
    return info
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return { path, duration: null, message: `${path}: ${why}` }
  } finally {
    input.dispose()
  }
}
