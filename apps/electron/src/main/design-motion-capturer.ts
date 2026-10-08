/**
 * Motion capture (Electron main).
 *
 * Renders a motion composition to a playable file using only machinery the app
 * already ships: the composition is loaded in the hidden window `design-exporter`
 * creates, this drives the capture with Chromium's own CDP screencast
 * (`Page.startScreencast`), and the frames go to the same hidden encoder window
 * a session recording uses (`recording-encoder.ts`) — no second renderer, no
 * ffmpeg, no new dependency.
 *
 * **Why CDP screencast and not `webContents.beginFrameSubscription`:** the
 * screencast is the path this repo has already measured on a *hidden* window
 * (`spike/capture-hidden-frames.cjs` — 120 frames per 2s, identical in the
 * visible, off-screen and hidden states) and the path the tab recorder ships
 * (`browser-cdp.ts`). It delivers JPEG, which is exactly what the encoder page
 * draws, whereas `beginFrameSubscription` hands over raw BGRA bitmaps that
 * would need their own re-encode step.
 *
 * **v1 is REALTIME:** the composition plays once while this records, and the
 * file's clock is the wall clock (`MediaRecorder`). It is not frame-exact — see
 * docs/designs.md "Motion". The composition must drive its own timeline on load
 * and need no user input; there is no host-side seek here.
 */

import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import type { DesignMotionSettings } from '@craft-agent/shared/designs/types'
import { openRecordingEncoder } from './recording-encoder.ts'

export interface CaptureMotionOptions {
  /** Resolved capture settings (fps / durationMs) from the design's `motion` hint. */
  settings: DesignMotionSettings
  /** Frame size to capture at — the composition's letterbox, in CSS px. */
  width: number
  height: number
  /** Where the finished file is written. */
  destPath: string
  log?: (message: string) => void
}

/**
 * JPEG quality for the screencast. High enough that text stays legible at
 * 1280px without the frames being large: the screencast re-encodes on every
 * paint, so this is also a per-frame cost.
 */
const SCREENCAST_QUALITY = 80

/**
 * How long to wait after the encoder's `stop()` before writing the file.
 *
 * `stop()` resolves once the encoder page's final `dataavailable` chunk has been
 * *sent* over IPC (recording-encoder-page.ts), not once the main process has
 * received it. A short settle lets that last message land so the tail is not
 * dropped — which would show up as a file that plays a fraction short.
 */
const ENCODER_TAIL_SETTLE_MS = 250

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Record the (already loaded) composition window for `durationMs` and write an
 * MP4 to `destPath`. Throws when no frames arrive or the build has no encoder,
 * rather than writing something unplayable.
 */
export async function captureMotionToFile(win: BrowserWindow, options: CaptureMotionOptions): Promise<void> {
  const wc = win.webContents
  const chunks: Uint8Array[] = []
  let endedEarly: string | null = null

  const encoder = await openRecordingEncoder({
    width: options.width,
    height: options.height,
    fps: options.settings.fps,
    onChunk: (bytes) => { chunks.push(bytes) },
    onEnd: (reason) => { endedEarly = reason },
  })
  if (!encoder) throw new Error('This build cannot record into a container it knows.')

  const cdp = wc.debugger
  if (!cdp.isAttached()) cdp.attach('1.3')

  const listener = (_event: unknown, method: string, params: any): void => {
    if (method !== 'Page.screencastFrame') return
    const data = params?.data
    if (typeof data === 'string' && data.length > 0) {
      encoder.push(Buffer.from(data, 'base64'))
    }
    // Acking is what keeps frames coming: Chromium waits for the ack between
    // frames (browser-cdp.ts makes the same point).
    cdp.sendCommand('Page.screencastFrameAck', { sessionId: params?.sessionId }).catch(() => {})
  }
  cdp.on('message', listener)

  try {
    await cdp.sendCommand('Page.startScreencast', {
      format: 'jpeg',
      quality: SCREENCAST_QUALITY,
      everyNthFrame: 1,
      maxWidth: options.width,
      maxHeight: options.height,
    })
    await delay(options.settings.durationMs)
  } finally {
    try {
      await cdp.sendCommand('Page.stopScreencast')
    } catch {
      // The window may already be gone; what was captured is what there is.
    }
    cdp.removeListener('message', listener)
  }

  try {
    await encoder.stop()
  } catch {
    // The encoder window may have died; the chunks already collected are the file.
  }
  await delay(ENCODER_TAIL_SETTLE_MS)

  if (endedEarly) options.log?.(`[design-motion] encoder ended early: ${endedEarly}`)
  if (chunks.length === 0) {
    throw new Error('The composition produced no frames — does its timeline play on load?')
  }

  writeFileSync(options.destPath, Buffer.concat(chunks))
  options.log?.(`[design-motion] recorded ${options.settings.durationMs}ms → ${options.destPath}`)
}
