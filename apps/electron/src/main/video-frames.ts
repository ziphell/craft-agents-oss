/**
 * Video frames, decoded by Chromium.
 *
 * The obvious alternative is ffmpeg, and the answer is no: it would be a tool the
 * user has to have installed, for a job the browser this app already ships can do.
 * So a hidden window loads the recording into a `<video>`, seeks to each sample
 * point and copies the frame to a canvas.
 *
 * Two consequences worth stating rather than discovering:
 *
 * - **the codecs are Chromium's**. A recording it cannot read fails here with a message
 *   that says so, instead of quietly producing a capture of the first frame and nothing
 *   else. Which ones those are is not a property of the browser version: HEVC is decoded
 *   by the platform's hardware decoder when the machine has one and by nothing otherwise
 *   (measured — `canPlayType` and `VideoDecoder.isConfigSupported` agree on this machine
 *   for both `hvc1` and `hev1`), and ProRes has no decoder at all.
 * - **seeking is not free**. A long recording sampled every second is thousands of
 *   seeks, so the step is widened until the number of samples is bounded — the
 *   ceiling on frames decides how much work the import is allowed to be.
 */

import { BrowserWindow } from 'electron'
import { pathToFileURL } from 'url'

export interface VideoSampleOptions {
  /** `timeline` samples on an interval; `changes` keeps only what moved. */
  mode: 'timeline' | 'changes'
  /** Sampling interval, ms. */
  everyMs: number
  /** Ceiling on frames kept. */
  maxFrames: number
  /**
   * How much of a frame has to change for `changes` mode to keep it — `(0, 1]`.
   *
   * Smaller keeps more. Defaults to {@link VIDEO_CHANGE_THRESHOLD}, which is what this mode
   * always used before it was a parameter, so omitting it changes nothing.
   */
  changeThreshold?: number
  /** Where to start sampling, ms. Omitted, from the beginning. */
  fromMs?: number
  /**
   * Where to stop, ms. **Omitted means to the end** — the caller cannot name a duration it does
   * not know yet, so "to the end" has to be what not passing this means.
   */
  toMs?: number
  /**
   * The first frame of the recording, and/or the last, **and nothing else**.
   *
   * Not a range: a range is "scan this stretch on an interval", which on a 30s recording with a
   * 2s interval is fifteen frames. These ask for the two ends specifically, so they replace the
   * interval scan rather than being added to it.
   */
  first?: boolean
  last?: boolean
  /** Longest edge of the output, in pixels. Scales down only, aspect preserved. */
  maxEdge?: number
}

export interface SampledVideoFrame {
  /** Position in the recording, ms. */
  offsetMs: number
  bytes: Buffer
}

export interface SampledVideo {
  durationMs: number
  /** The video's size in device pixels. */
  viewport: { width: number; height: number } | null
  /** True when the ceiling was reached: this is a sample of the recording. */
  truncated: boolean
  frames: SampledVideoFrame[]
}

/**
 * How much of the frame has to change for `changes` mode to keep it.
 *
 * Higher than the live capture's threshold: a video is re-encoded, so every sample
 * differs from the last by compression noise, and a tighter threshold would keep
 * all of them.
 *
 * The default, not the only value: `changeThreshold` in the options overrides it, and the
 * caller's value is clamped to something a ratio comparison can mean.
 */
const VIDEO_CHANGE_THRESHOLD = 0.01

/** JPEG quality for a sampled frame — the same as a live frame. */
const VIDEO_FRAME_QUALITY = 70

/**
 * Cap on how many samples are taken, as a multiple of the frames that can be kept.
 *
 * The slack is for `changes` mode, which has to look at a sample before it can
 * decide to drop it; without it, a recording that never changes would still cost
 * one seek per interval.
 */
const SAMPLE_BUDGET_FACTOR = 4

/**
 * Decode a recording into JPEG frames at (or near) the requested offsets.
 *
 * @throws when the file cannot be read at all — including "Chromium has no codec
 *   for this", which is the failure a user is most likely to hit and the one that
 *   has to name itself, because the remedy is converting the file elsewhere.
 */
export async function sampleVideoFrames(
  filePath: string,
  options: VideoSampleOptions,
): Promise<SampledVideo> {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      // The page is ours and loads exactly one local file. `webSecurity: false` is
      // what lets those pixels be read back into a canvas: under the default
      // policy a `file://` video taints the canvas and every draw throws.
      webSecurity: false,
      backgroundThrottling: false,
    },
  })

  try {
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><meta charset="utf-8"><body></body>')}`,
    )
    const raw = (await window.webContents.executeJavaScript(
      buildSamplerScript(pathToFileURL(filePath).toString(), options),
      true,
    )) as SamplerReply
    return toSampledVideo(raw)
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}

interface SamplerReply {
  error?: string
  /**
   * What kind of failure it was, when it was not about decoding.
   *
   * `file` is "this recording is not usable as a recording" — it says nothing about its
   * length, or there is nothing in it — and the codec advice below would be wrong for it.
   */
  errorKind?: 'file'
  durationMs?: number
  width?: number
  height?: number
  truncated?: boolean
  frames?: Array<{ offsetMs: number; dataUrl: string }>
}

/**
 * The sampler, as a script for the decoding window.
 *
 * A single expression that runs to completion: one call rather than a round trip
 * per frame, because each trip would be a chance for the window to be gone.
 */
export function buildSamplerScript(url: string, options: VideoSampleOptions): string {
  const step = Math.max(options.everyMs, 1)
  const ceilingFrames = Math.max(1, Math.round(options.maxFrames))
  /**
   * How many samples the walk is allowed, which is not the same as how many it keeps.
   *
   * A **timeline** keeps every sample it takes, so the two are the same number, and the span is
   * divided by exactly this — the frames are spread over the whole recording, coarser than the
   * interval asked for when they have to be. A **changes** read is different: it has to *see* a
   * movement before it can keep one, and most samples in a recording like that are ones it skips,
   * so it walks a few times finer than it keeps and still fills its ceiling with the moments that
   * moved.
   */
  const budget = options.mode === 'changes' ? ceilingFrames * SAMPLE_BUDGET_FACTOR : ceilingFrames
  // The comparison it feeds is a ratio, so a caller's value only means something in (0, 1]:
  // one outside that is clamped rather than passed into a test that would never (or always)
  // match. The floor keeps a zero from turning "keep what changed" into "keep all of it".
  const changeThreshold = Math.min(1, Math.max(0.0005, options.changeThreshold ?? VIDEO_CHANGE_THRESHOLD))
  return `(async () => {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.style.display = 'none'
  document.body.appendChild(video)

  const failed = new Promise((_, reject) => {
    video.addEventListener('error', () => {
      const code = video.error ? video.error.code : 0
      reject(new Error('this browser cannot decode the recording (media error ' + code + ')'))
    }, { once: true })
  })

  video.src = ${JSON.stringify(url)}
  try {
    await Promise.race([
      new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true })),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the recording did not load in time')), 30000)),
      failed,
    ])
  } catch (err) {
    return { error: String((err && err.message) || err) }
  }

  const width = video.videoWidth
  const height = video.videoHeight
  if (!width || !height) return { error: 'the recording reports no picture size' }

  // The canvas is what the frames come out at, and it is the only place the output gets smaller:
  // scaling here means the JPEG is encoded small rather than made big and then shrunk. **Only
  // down** — a request for a larger edge than the recording has would be upscaling, which adds
  // bytes and no detail.
  const edge = ${options.maxEdge ?? 0}
  let canvasWidth = width
  let canvasHeight = height
  if (edge > 0 && Math.max(width, height) > edge) {
    const scale = edge / Math.max(width, height)
    canvasWidth = Math.max(2, Math.round(width * scale))
    canvasHeight = Math.max(2, Math.round(height * scale))
  }

  const canvas = document.createElement('canvas')
  canvas.width = canvasWidth
  canvas.height = canvasHeight
  const context = canvas.getContext('2d')

  // How long it is, which is not always something the file says yet. A recording written
  // live by \`MediaRecorder\` has its header written before its length is known, so
  // \`duration\` is \`Infinity\` — measured, see apps/electron/spike/recorder-formats.cjs. An
  // unresolved duration is not a slower sample: as a step size it is \`Infinity\`, and the
  // loop below would then seek to no particular place, doing it over and over. So it is
  // resolved first, by asking to play past the end — the one way to make the browser read
  // the rest of the file — and a recording that still will not say is reported, not guessed
  // at.
  let durationMs = Math.round(video.duration * 1000)
  if (!Number.isFinite(durationMs)) {
    await new Promise((resolve) => {
      const done = () => {
        video.removeEventListener('durationchange', done)
        clearTimeout(timeout)
        resolve(true)
      }
      const timeout = setTimeout(done, 5000)
      video.addEventListener('durationchange', done)
      try {
        video.currentTime = 1e101
      } catch {
        done()
      }
    })
    durationMs = Math.round(video.duration * 1000)
  }
  if (!Number.isFinite(durationMs)) return { error: 'the recording does not say how long it is', errorKind: 'file' }
  if (durationMs <= 0) return { error: 'the recording is empty', errorKind: 'file' }

  const frames = []
  // What \`changes\` mode compares against: the pixels of the last frame it **kept**. Null until
  // there is one, which makes the first sample the opening state of the recording.
  let baseline = null
  let truncated = false

  // What was asked to be looked at, clamped to the recording. **\`to\` omitted means the end** —
  // see VideoSampleOptions: a caller cannot name a duration it does not know yet.
  const rangeStart = Math.max(0, Math.min(${options.fromMs ?? 0}, durationMs))
  const rangeEnd = Math.max(rangeStart, Math.min(${options.toMs ?? 'durationMs'}, durationMs))

  const seek = (seconds) => new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(true) }
    video.addEventListener('seeked', done)
    video.currentTime = Math.min(seconds, Math.max(0, (durationMs - 40) / 1000))
    setTimeout(done, 3000)
  })

  const diff = (a, b) => {
    if (!a || a.length !== b.length) return 1
    let sampled = 0, changed = 0
    for (let i = 0; i < b.length; i += 64) { sampled += 1; if (a[i] !== b[i]) changed += 1 }
    return sampled === 0 ? 0 : changed / sampled
  }

  const keep = () => frames.push({
    offsetMs: Math.round(video.currentTime * 1000),
    dataUrl: canvas.toDataURL('image/jpeg', ${VIDEO_FRAME_QUALITY / 100}),
  })

  // The two ends, and nothing else. These **replace** the interval scan rather than adding to
  // it: "the last frame" is one picture, not fifteen of them plus one.
  if (${options.first ? 'true' : 'false'} || ${options.last ? 'true' : 'false'}) {
    const marks = []
    if (${options.first ? 'true' : 'false'}) marks.push(rangeStart)
    if (${options.last ? 'true' : 'false'}) marks.push(rangeEnd)
    for (const ms of marks) {
      await seek(ms / 1000)
      context.drawImage(video, 0, 0, canvasWidth, canvasHeight)
      keep()
    }
    return { durationMs, width, height, truncated: false, frames }
  }

  // The frames are **spread across the whole span**: at the interval asked for when that fits inside
  // the ceiling, and wider when it does not. A recording too long to hold at that detail is read
  // *coarsely throughout* rather than finely at the start and then abandoned partway — stopping at
  // the ceiling is what this used to do (measured: a ceiling of 3 over a 6s recording gave the
  // first three seconds, and the rest was never opened).
  //
  // Counted over the range being looked at, not over the whole recording — a three-second window
  // out of a long one is not a reason to sample it every step.
  const ceiling = ${ceilingFrames}
  const budget = ${budget}
  const span = Math.max(0, rangeEnd - rangeStart)
  const stride = Math.max(${step}, Math.ceil(span / budget) || ${step})

  for (let t = rangeStart; t <= rangeEnd; t += stride) {
    await seek(t / 1000)
    context.drawImage(video, 0, 0, canvasWidth, canvasHeight)

    if (${JSON.stringify(options.mode)} === 'changes') {
      const pixels = context.getImageData(0, 0, canvasWidth, canvasHeight).data
      // Against the last frame **kept**, not against the previous sample. That is the difference
      // between noticing a change and noticing a rate: a page drifting by less than the threshold
      // per sample never differs from its neighbour, so a neighbour comparison reports a recording
      // that changed a great deal as one that never changed — and the slow, self-driven page is
      // exactly what this mode is for. Against the kept frame the drift adds up until it crosses.
      // The kept frames are then the successive states, so each neighbouring pair is a before and
      // an after: what changed, and between which two times.
      if (baseline && diff(baseline, pixels) < ${changeThreshold}) continue
      baseline = pixels
    }

    // Reached only when there was still range left to look at: a timeline spreads its frames to fit
    // the ceiling, so it arrives at the end of the range rather than at the ceiling.
    if (frames.length >= ceiling) { truncated = t + stride <= rangeEnd; break }
    keep()
  }

  return { durationMs, width, height, truncated, frames }
})()`
}

function toSampledVideo(raw: SamplerReply): SampledVideo {
  if (raw?.error) {
    const codecAdvice =
      raw.errorKind === 'file'
        ? ''
        : ' Chromium reads mp4 (H.264), webm and most mov files. HEVC reads only where the machine has a hardware decoder for it, and ProRes does not read at all — a file that will not open has to be converted first.'
    throw new Error(`Could not read the recording: ${raw.error}.${codecAdvice}`)
  }

  const frames = (raw.frames ?? []).map((frame) => ({
    offsetMs: frame.offsetMs,
    bytes: Buffer.from(frame.dataUrl.split(',')[1] ?? '', 'base64'),
  }))

  return {
    durationMs: raw.durationMs ?? 0,
    viewport: raw.width && raw.height ? { width: raw.width, height: raw.height } : null,
    truncated: raw.truncated === true,
    frames,
  }
}
