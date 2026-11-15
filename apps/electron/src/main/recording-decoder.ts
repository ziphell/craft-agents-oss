/**
 * A recording's frames and sound, decoded by Chromium — in a hidden window on the desktop.
 *
 * The obvious alternative is ffmpeg, and the answer is no: it would be a tool the user has to have
 * installed, for a job the browser this app already ships can do. So a hidden window loads the
 * recording into a `<video>`, seeks to each sample point and copies the frame to a canvas — or
 * decodes its audio track into PCM and writes a WAV beside it.
 *
 * What the page is told to do is shared with the hub's render host
 * (`@craft-agent/shared/recording/sampler-script`, `@craft-agent/shared/recording/audio-script`): the
 * desktop answers with a window, a hub with its headless Chromium, and neither may teach the script
 * a different set of flags.
 *
 * Two consequences worth stating rather than discovering:
 *
 * - **the codecs are Chromium's**. A recording it cannot read fails here with a message that says
 *   so, instead of quietly producing a capture of the first frame and nothing else.
 * - **seeking is not free**. A long recording sampled every second is thousands of seeks, so the
 *   step is widened until the number of samples is bounded — the ceiling on frames decides how
 *   much work the import is allowed to be.
 */

import { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'url'
import {
  buildSamplerScript,
  decodeSamplerReply,
  type SamplerReply,
  type SampledVideo,
  type VideoSampleOptions,
} from '@craft-agent/shared/recording/sampler-script'
import {
  AUDIO_CHUNK_BYTES,
  audioChunkExpression,
  buildAudioExtractScript,
  decodeAudioReply,
  wavBytes,
  type AudioExtractReply,
  type ExtractedAudio,
} from '@craft-agent/shared/recording/audio-script'

export { buildSamplerScript }
export type { SampledVideo, VideoSampleOptions }

export interface ExtractedAudioFile extends ExtractedAudio {
  /** Where the WAV landed. */
  path: string
}

/**
 * One hidden window per read, and it is gone afterwards.
 *
 * The page is ours and loads exactly one local file. `webSecurity: false` is what lets those pixels
 * be read back into a canvas, and what lets the audio be read as bytes at all: under the default
 * policy a `file://` video taints the canvas and every draw throws. The hub's render host reaches
 * the same result with `--allow-file-access-from-files` and a `file://` page (see
 * `packages/render-host`).
 */
async function withDecoderWindow<T>(run: (window: BrowserWindow) => Promise<T>): Promise<T> {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      webSecurity: false,
      backgroundThrottling: false,
    },
  })

  try {
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><meta charset="utf-8"><body></body>')}`,
    )
    return await run(window)
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}

/**
 * Decode a recording into JPEG frames at (or near) the requested offsets.
 *
 * @throws when the file cannot be read at all — including "Chromium has no codec for this", which
 *   is the failure a user is most likely to hit and the one that has to name itself, because the
 *   remedy is converting the file elsewhere.
 */
export async function sampleFrames(
  filePath: string,
  options: VideoSampleOptions,
): Promise<SampledVideo> {
  return withDecoderWindow(async (window) => {
    const raw = (await window.webContents.executeJavaScript(
      buildSamplerScript(pathToFileURL(filePath).toString(), options),
      true,
    )) as SamplerReply
    return decodeSamplerReply(raw)
  })
}

/**
 * Decode a recording's sound into a 16 kHz mono WAV.
 *
 * The sound is pulled back in chunks: a long recording is tens of megabytes of PCM, and one reply
 * that size is a window that runs out of memory halfway through.
 */
export async function extractAudioFile(
  filePath: string,
  outPath: string,
  options: { sampleRate?: number } = {},
): Promise<ExtractedAudioFile> {
  return withDecoderWindow(async (window) => {
    const raw = (await window.webContents.executeJavaScript(
      buildAudioExtractScript(pathToFileURL(filePath).toString(), options.sampleRate),
      true,
    )) as AudioExtractReply
    const audio = decodeAudioReply(raw)

    const chunks: Buffer[] = []
    for (let offset = 0; offset < audio.byteLength; offset += AUDIO_CHUNK_BYTES) {
      const base64 = (await window.webContents.executeJavaScript(
        audioChunkExpression(offset, AUDIO_CHUNK_BYTES),
        true,
      )) as string
      chunks.push(Buffer.from(base64, 'base64'))
    }

    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, wavBytes(Buffer.concat(chunks), audio.sampleRate))
    return { path: outPath, ...audio }
  })
}
