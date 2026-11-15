/**
 * A source's sound, decoded in a window nobody sees.
 *
 * The tool layer has no decoder, so the host asks this page: read the bytes through the export
 * preload (a `file://` page cannot fetch its neighbours), decode with the platform's own
 * `decodeAudioData`, and answer an RMS envelope at a fixed bucket size.
 *
 * Only levels come back — not beats. `beats.ts` in shared code decides where the beats are, so a
 * desktop read and any future host produce the same grid from the same numbers.
 */

interface AudioJob {
  /** Absolute path — a project-relative path cannot be read from here. */
  path: string
  /** Target seconds per bucket; the page reports the resolution it actually used. */
  bucketSeconds?: number
}

interface AudioAnswer {
  ok: boolean
  duration?: number
  bucketSeconds?: number
  /** RMS amplitude per bucket, 0..1. */
  rms?: number[]
  message?: string
}

interface Bridge {
  readFile: (path: string) => Promise<Uint8Array>
}

declare global {
  interface Window {
    __audioLevels: (job: AudioJob) => Promise<AudioAnswer>
  }
}

const bridge = () => (window as unknown as { editExport: Bridge }).editExport

/** 10 ms: fine enough to place an onset, coarse enough that a song stays a small answer. */
const TARGET_BUCKET_SECONDS = 0.01
/** About five minutes at 10 ms; past this the envelope coarsens rather than growing forever. */
const MAX_BUCKETS = 30_000

window.__audioLevels = async (job: AudioJob): Promise<AudioAnswer> => {
  try {
    const bytes = await bridge().readFile(job.path)
    const context = new AudioContext()
    let audio: AudioBuffer
    try {
      // Copy: `decodeAudioData` may detach the buffer it is given.
      audio = await context.decodeAudioData(bytes.slice().buffer as ArrayBuffer)
    } finally {
      void context.close()
    }

    const channel = audio.getChannelData(0)
    const target =
      job.bucketSeconds !== undefined && job.bucketSeconds > 0
        ? job.bucketSeconds
        : TARGET_BUCKET_SECONDS
    const buckets = Math.min(MAX_BUCKETS, Math.max(8, Math.round(audio.duration / target)))
    const bucketSeconds = audio.duration / buckets
    const step = channel.length / buckets
    const rms: number[] = new Array(buckets)

    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const start = Math.floor(bucket * step)
      const stop = Math.min(channel.length, Math.max(start + 1, Math.floor((bucket + 1) * step)))
      let sum = 0
      let count = 0
      for (let index = start; index < stop; index += 1) {
        const sample = channel[index] ?? 0
        sum += sample * sample
        count += 1
      }
      rms[bucket] = Math.sqrt(sum / Math.max(1, count))
    }

    return {
      ok: true,
      duration: audio.duration,
      bucketSeconds,
      rms,
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: `${job.path}: ${why}. Chromium reads MP3, AAC/M4A, WAV and Opus; a source with no audio track has no beat grid.`,
    }
  }
}
