/**
 * The encoder's page, as one string.
 *
 * A recording's frames arrive from the main process; this turns them into a file. It is a page
 * rather than a module because `MediaRecorder` and `canvas.captureStream` are renderer APIs —
 * there is no encoder in the main process, and the app already ships the one browser it needs.
 *
 * **The canvas is sampled at a fixed rate** (`captureStream(fps)`), not asked for a frame per
 * repaint. `captureStream(0)` + `requestFrame()` would emit only when something changed, and
 * the recorder would then compress the quiet stretches out of the timeline — thirty seconds
 * with five still ones in it would come back twenty-five seconds long. At a fixed rate
 * `MediaRecorder` follows the wall clock, so the film's length is the recording's length and a
 * page that stopped moving reads as a page that stopped moving.
 *
 * **The last chunk is the one that is easy to lose.** `stop()` fires the final `dataavailable`
 * and *then* `stop`, while reading the blob is asynchronous — so a page that resolved on `stop`
 * would let main tear the window down with the tail still on its way. The sends are chained and
 * `__stop` waits for the chain, which is the whole of what makes "stop" mean "the file is
 * complete".
 */

import type { RecordingFormat } from '../shared/recording-formats.ts'

export interface EncoderPageOptions {
  /** The formats to try, best first — injected from the shared table, not written again here. */
  formats: RecordingFormat[]
  /** How many times a second the canvas is sampled. */
  fps: number
}

export function encoderPageHtml(options: EncoderPageOptions): string {
  const formats = JSON.stringify(options.formats)
  const fps = Math.max(1, Math.round(options.fps))

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}</style></head>
<body><script>
const FORMATS = ${formats}
let canvas = null
let ctx = null
let recorder = null
let stream = null
let pending = null
let draining = false
let sending = Promise.resolve()
/** The newest frame drawn, kept so it can be drawn again — see the keep-alive in __start. */
let latest = null
/** The interval that redraws it; cleared on stop. */
let keepAlive = null

/** The first format this build can record, or null — the same question the toolbar asks. */
window.__negotiate = () => {
  if (typeof MediaRecorder === 'undefined') return null
  for (const format of FORMATS) {
    try {
      if (MediaRecorder.isTypeSupported(format.mimeType)) return format
    } catch (e) {}
  }
  return null
}

/**
 * Draw what arrived, keeping only the newest frame.
 *
 * The page repaints faster than the stream samples it, so a backlog drawn in order would only
 * make the encoder fall further behind — and the frame that gets drawn late is one nobody asked
 * to see. Latest wins.
 */
function draw(data) {
  pending = data
  if (draining) return
  draining = true
  void (async () => {
    try {
      while (pending) {
        const next = pending
        pending = null
        const blob = await (await fetch('data:image/jpeg;base64,' + next)).blob()
        const bitmap = await createImageBitmap(blob)
        // The newest frame replaces the one before it. The old bitmap is closed only once its
        // replacement is in hand: the keep-alive draws the latest frame on a timer and must
        // never find that bitmap closed. (These two lines are one task, so the timer cannot
        // run between them.)
        if (latest) latest.close()
        latest = bitmap
        ctx.drawImage(latest, 0, 0, canvas.width, canvas.height)
      }
    } catch (e) {
    } finally {
      draining = false
    }
  })()
}

window.__start = (mimeType, width, height) => {
  canvas = document.createElement('canvas')
  canvas.width = Math.max(2, width | 0)
  canvas.height = Math.max(2, height | 0)
  ctx = canvas.getContext('2d', { alpha: false })
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  document.body.appendChild(canvas)

  stream = canvas.captureStream(${fps})
  recorder = new MediaRecorder(stream, { mimeType })

  recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return
    // Chained rather than concurrent: the chunks have to reach main in the order they were
    // encoded, and one of these is the last one.
    sending = sending.then(async () => {
      const bytes = new Uint8Array(await event.data.arrayBuffer())
      window.recordingEncoder.sendChunk(bytes)
    })
  }

  window.recordingEncoder.onFrame((frame) => draw(frame.data))
  recorder.start(250)

  // **A canvas nobody draws to produces no frames**, and a stream with no frames ends the film at
  // its last one — so a quiet stretch would come back *shorter* than the recording instead of
  // longer. Redrawing the newest frame at the sampling rate keeps the picture still and the clock
  // running, which is what makes the file's length the recording's length. (Measured without this:
  // a 45s recording of a page that went quiet after 9s came back 9.25s long while its own report
  // said 45s.) The first frame is what starts it, which is why the recorder seeds one before the
  // capture begins.
  keepAlive = setInterval(() => {
    if (latest) ctx.drawImage(latest, 0, 0, canvas.width, canvas.height)
  }, Math.max(10, Math.round(1000 / ${fps})))

  return true
}

/** Resolves once the tail has been handed over — see this file's header. */
window.__stop = () => new Promise((resolve) => {
  if (keepAlive) { clearInterval(keepAlive); keepAlive = null }
  if (!recorder) { resolve(false); return }
  recorder.onstop = () => { sending.then(() => resolve(true), () => resolve(true)) }
  try { recorder.stop() } catch (e) { resolve(false) }
  if (stream) for (const track of stream.getTracks()) track.stop()
})
</script></body></html>`
}
