/**
 * The window that turns a tab's frames into a file.
 *
 * A recording's picture arrives as JPEG frames (CDP screencast, `browser-cdp.ts`), and a file
 * needs an encoder. There is none in the main process, and the app does not ship ffmpeg — so
 * this is a **hidden window**, the same answer `video-frames.ts` gives for decoding a recording
 * and `drawio-render.ts` gives for drawing one: the browser the app already ships does the job.
 *
 * **One window per recording**, opened when the recording starts and destroyed when it stops —
 * the shape `video-frames.ts` uses for its decoder ("one job, one window, torn down in a
 * `finally`"). Two tabs recorded at once are two windows, which is exactly what a registry keyed
 * by `(owner, tab)` expects.
 *
 * **The container is negotiated before the file is made.** The extension has to be known when the
 * file is created (`TabRecorder.nextRecordingPath` claims the name with `wx`), so the window is
 * asked first — it picks from the same table the person's record button picks from
 * (`shared/recording-formats.ts`), which is how both places agree on the one container and on
 * whether this build can record at all. A build that can record nothing is reported as such
 * instead of producing a file nobody can play.
 *
 * What it does *not* do: decide where the file goes, or write it. Chunks come back through
 * {@link OpenRecordingEncoderOptions.onChunk} and go wherever the caller is appending — the
 * recording is the caller's, this is only the encoders.
 */

import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import { join } from 'node:path'
import { RECORDING_FORMATS, type RecordingFormat } from '../shared/recording-formats.ts'
import { ENCODER_CHUNK_CHANNEL, ENCODER_FRAME_CHANNEL } from '../shared/recording-encoder-channels.ts'
import { encoderPageHtml } from './recording-encoder-page.ts'

/**
 * How many times a second the canvas is sampled.
 *
 * The screencast delivers up to ~60fps while the page repaints (measured: 120 frames per 2s,
 * `spike/capture-hidden-frames.cjs`), and the canvas publishes the newest of them at *this* rate —
 * so it is a sampling rate, not a limit on the page. 30 is half the screencast's own rate: enough
 * that a scroll or an animation reads as motion rather than as steps, and still cheap, because a
 * recording is a log of what happened and the reader (`video_tool`) takes a frame a second by
 * default.
 *
 * It is also the rate at which a **still** picture is redrawn to keep the stream — and so the
 * film's clock — running (`recording-encoder-page.ts`), so this number decides the cost of holding
 * an unchanging screen as well as the cost of motion. It is a constant rather than a flag because
 * nothing has yet needed a different one.
 */
export const ENCODER_FPS = 30

/** How long a window is given to negotiate and start before the recording is called off. */
const ENCODER_START_TIMEOUT_MS = 10_000

export interface OpenRecordingEncoderOptions {
  /** The frame size to encode at — the tab's view, in device pixels. */
  width: number
  height: number
  /**
   * How many times a second the canvas is sampled (see {@link ENCODER_FPS}).
   * Defaults to {@link ENCODER_FPS}; a motion export passes its own `fps` so the
   * file's frame rate follows the composition's hint.
   */
  fps?: number
  /** Each encoded chunk, in the order the recorder produced it. */
  onChunk: (bytes: Uint8Array) => void
  /**
   * The stream ended without being asked to — the window went away, or its renderer died.
   * A recording whose frames (or whose file) stop arriving is over, so the caller is told
   * rather than left appending to nothing.
   */
  onEnd: (reason: string) => void
}

/** A running encoder: what it is writing, and how to feed it and finish it. */
export interface RecordingEncoder {
  /** The extension for what this build negotiated — the container it will write. */
  extension: string
  /** One frame, in the order it came off the page. */
  push(frame: Buffer): void
  /** Finish the file: waits for the last chunk to be handed over before the window goes. */
  stop(): Promise<void>
}

interface LiveEncoder {
  window: BrowserWindow
  onChunk: (bytes: Uint8Array) => void
  onEnd: (reason: string) => void
  /** True once someone asked for this to end, so its teardown is not reported as a surprise. */
  closing: boolean
}

/** The windows that are encoding right now, by their webContents id — who a chunk came from. */
const encoders = new Map<number, LiveEncoder>()
let ipcRegistered = false

/**
 * Route chunks back to the encoder that produced them.
 *
 * Registered once for the process rather than per window: `ipcMain.on` is global, so adding a
 * listener per recording would leave every finished recording's listener behind and hand each
 * chunk to all of them.
 */
function registerIpcOnce(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  ipcMain.on(ENCODER_CHUNK_CHANNEL, (event: IpcMainEvent, chunk: Uint8Array) => {
    const encoder = encoders.get(event.sender.id)
    if (!encoder || !chunk || chunk.length === 0) return
    encoder.onChunk(chunk)
  })
}

/** Take a window down, and say why if nobody asked for it. */
function teardown(id: number, reason: string): void {
  const encoder = encoders.get(id)
  if (!encoder) return
  encoders.delete(id)

  if (!encoder.window.isDestroyed()) encoder.window.destroy()
  if (!encoder.closing) encoder.onEnd(reason)
}

/**
 * Open an encoder, and answer with what it negotiated.
 *
 * `null` means this build records into no container it knows — which is a real answer for a
 * stripped-down runtime, and much better said now than discovered as an empty file.
 */
export async function openRecordingEncoder(
  options: OpenRecordingEncoderOptions,
): Promise<RecordingEncoder | null> {
  registerIpcOnce()

  const width = Math.max(2, Math.round(options.width))
  const height = Math.max(2, Math.round(options.height))

  const window = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: {
      preload: join(__dirname, 'recording-encoder-preload.cjs'),
      // The page is ours, hidden, and loads no remote content. It needs no node, and the
      // preload is the only thing it can reach.
      contextIsolation: true,
      nodeIntegration: false,
      // Not a window anyone can see: it must keep painting while nothing is looking at it.
      backgroundThrottling: false,
      offscreen: false,
    },
  })

  const id = window.webContents.id
  const live: LiveEncoder = { window, onChunk: options.onChunk, onEnd: options.onEnd, closing: false }
  encoders.set(id, live)

  window.on('closed', () => teardown(id, 'the encoder window closed'))
  window.webContents.on('render-process-gone', () => teardown(id, 'the encoder window crashed'))

  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
      encoderPageHtml({ formats: RECORDING_FORMATS, fps: options.fps ?? ENCODER_FPS }),
    )}`)

    const format = (await withTimeout(
      window.webContents.executeJavaScript('window.__negotiate()'),
      'the encoder did not answer',
    )) as RecordingFormat | null

    if (!format?.mimeType) {
      live.closing = true
      teardown(id, 'this build records into no container it knows')
      return null
    }

    await withTimeout(
      window.webContents.executeJavaScript(
        `window.__start(${JSON.stringify(format.mimeType)}, ${width}, ${height})`,
      ),
      'the encoder did not start',
    )

    return {
      extension: format.extension,
      push: (frame: Buffer) => {
        if (window.isDestroyed()) return
        // base64 because that is how the frame arrived and how it crosses: the page needs a
        // string it can hand to `fetch`, and converting it twice would only cost twice.
        window.webContents.send(ENCODER_FRAME_CHANNEL, { data: frame.toString('base64') })
      },
      stop: async () => {
        try {
          // Waits for the tail: the page resolves this only once every chunk has been sent
          // (`recording-encoder-page.ts`), and destroying the window first would drop the last
          // one — a file that plays and stops a second early.
          await window.webContents.executeJavaScript('window.__stop()')
        } catch {
          // The window may already be gone; what was written is what there is.
        }
        live.closing = true
        teardown(id, 'stopped')
      },
    }
  } catch (error) {
    live.closing = true
    teardown(id, 'the encoder could not start')
    throw error
  }
}

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${what} (within ${ENCODER_START_TIMEOUT_MS}ms)`)), ENCODER_START_TIMEOUT_MS)
    }),
  ])
}

/** How many encoders are running — the load the status面 reports. */
export function encoderCount(): number {
  return encoders.size
}
