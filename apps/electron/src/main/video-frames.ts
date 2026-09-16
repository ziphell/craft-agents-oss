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
 * - **the codecs are Chromium's**. A recording it cannot read (HEVC/H.265, ProRes,
 *   some `.mov` files) fails here with a message that says so, instead of quietly
 *   producing a capture of the first frame and nothing else.
 * - **seeking is not free**. A long recording sampled every second is thousands of
 *   seeks, so the step is widened until the number of samples is bounded — the
 *   ceiling on frames decides how much work the import is allowed to be.
 *
 * @see docs/prototype-workbench-plan.md §20.5
 */

import { BrowserWindow, dialog } from 'electron'
import { pathToFileURL } from 'url'

export interface VideoSampleOptions {
  /** `timeline` samples on an interval; `changes` keeps only what moved. */
  mode: 'timeline' | 'changes'
  /** Sampling interval, ms. */
  everyMs: number
  /** Ceiling on frames kept. */
  maxFrames: number
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

/** Ask the user for a recording. Null when they dismiss the dialog. */
export async function pickVideoFile(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Choose a recording to sample frames from',
    properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: ['mp4', 'm4v', 'webm', 'mov', 'mkv'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

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
function buildSamplerScript(url: string, options: VideoSampleOptions): string {
  const step = Math.max(options.everyMs, 1)
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

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  const durationMs = Math.round(video.duration * 1000)

  // Bounded work: a long recording is sampled more coarsely rather than seeking
  // thousands of times, and the reply says so through \`truncated\`.
  const budget = ${options.maxFrames} * ${SAMPLE_BUDGET_FACTOR}
  const stride = Math.max(${step}, Math.ceil(durationMs / budget) || ${step})

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

  const frames = []
  let previous = null
  let truncated = false

  for (let t = 0; t <= durationMs; t += stride) {
    await seek(t / 1000)
    context.drawImage(video, 0, 0, width, height)

    if (${JSON.stringify(options.mode)} === 'changes') {
      const pixels = context.getImageData(0, 0, width, height).data
      const ratio = diff(previous, pixels)
      previous = pixels
      if (ratio < ${VIDEO_CHANGE_THRESHOLD}) continue
    }

    if (frames.length >= ${options.maxFrames}) { truncated = true; break }
    frames.push({
      offsetMs: Math.round(video.currentTime * 1000),
      dataUrl: canvas.toDataURL('image/jpeg', ${VIDEO_FRAME_QUALITY / 100}),
    })
  }

  return { durationMs, width, height, truncated, frames }
})()`
}

function toSampledVideo(raw: SamplerReply): SampledVideo {
  if (raw?.error) {
    throw new Error(
      `Could not read the recording: ${raw.error}. Chromium decodes mp4 (H.264), webm and most mov files; ` +
        `a HEVC, ProRes or otherwise unsupported recording has to be converted first.`,
    )
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
