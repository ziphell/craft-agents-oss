/**
 * What a recording is written into — one table, because two renderers write recordings.
 *
 * The person's record button encodes in the toolbar; a conversation's is encoded by a hidden
 * window of its own (`recording-encoder.ts`). They must not each carry their own idea of what to
 * try: two copies of that answer drift into two kinds of file.
 *
 * **One container: mp4.** The second row is not a second container — it is the same container with
 * the codec left to the build. What can differ between builds is which codec gets encoded, not what
 * the file is, because the file's shape is what everything downstream depends on: a `<video>` knows
 * an mp4's duration the moment it loads, which is what `video_tool` computes its sampling step
 * from, while a webm recorded live reports `duration: Infinity` until something reads it out
 * (measured, `apps/electron/spike/recorder-formats.cjs`). A build that can record no mp4 says so —
 * `pickRecordingFormat` answers `null` — rather than quietly writing a different container that
 * every reader then has to know about.
 *
 * Where mp4 is available: on Windows and macOS the OS supplies the H.264 encoder, so it is not in
 * question (measured on Windows, `spike/recorder-formats.cjs`). On Linux it needs a platform
 * encoder, which is not always present — that is the one machine a webm fallback used to cover,
 * and refusing is a better answer than handing back a file of a different shape.
 *
 * The table is also what gets injected into the encoder's page, so the page asks the same
 * question in the same order (`recording-encoder-page.ts`).
 */
export interface RecordingFormat {
  mimeType: string
  extension: string
}

export const RECORDING_FORMATS: RecordingFormat[] = [
  { mimeType: 'video/mp4;codecs=avc1.42E01E', extension: 'mp4' },
  { mimeType: 'video/mp4', extension: 'mp4' },
]

/** The first format this build will record, or `null` when it will record none of them. */
export function pickRecordingFormat(): RecordingFormat | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const format of RECORDING_FORMATS) {
    try {
      if (MediaRecorder.isTypeSupported(format.mimeType)) return format
    } catch {
      // `isTypeSupported` can throw on a string it cannot parse; a format that cannot be
      // asked about is not a format to record into.
    }
  }
  return null
}
