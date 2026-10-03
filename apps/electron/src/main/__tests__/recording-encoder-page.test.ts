/**
 * The encoder page's contract — which is its own header's claim, kept honest.
 *
 * The page cannot be *run* here (no canvas, no `MediaRecorder`), so what is pinned is the piece
 * that decides how long the film is: the newest frame is redrawn on a timer at the page's own
 * sampling rate, and that timer is cleared when the recording stops. Without the redraw the
 * stream only moves when the page does, and `MediaRecorder` ends the film at its last change —
 * measured, a 45s recording of a page that went quiet after 9s came back 9.25s long.
 */

import { describe, expect, it } from 'bun:test'
import { encoderPageHtml } from '../recording-encoder-page'

/** A rate that is *not* the one in `ENCODER_FPS`, so this tests the threading, not the constant. */
const FPS = 25

const html = encoderPageHtml({
  formats: [{ mimeType: 'video/mp4;codecs=avc1.42E01E', extension: 'mp4' }],
  fps: FPS,
})

describe('the recording encoder page', () => {
  it('samples the canvas at the rate it was negotiated', () => {
    expect(html).toContain(`canvas.captureStream(${FPS})`)
  })

  it('redraws the newest frame at that rate, so the stream follows the wall clock', () => {
    expect(html).toContain('keepAlive = setInterval(')
    expect(html).toContain(`Math.max(10, Math.round(1000 / ${FPS}))`)
    expect(html).toContain('ctx.drawImage(latest, 0, 0, canvas.width, canvas.height)')
  })

  it('stops drawing when the recording stops', () => {
    expect(html).toContain('clearInterval(keepAlive)')
  })

  it('keeps the newest frame alive until its replacement is in hand', () => {
    // Closing it any earlier would leave the keep-alive drawing a closed bitmap.
    const closeAtIndex = html.indexOf('if (latest) latest.close()')
    const assignIndex = html.indexOf('latest = bitmap')
    expect(closeAtIndex).toBeGreaterThan(-1)
    expect(assignIndex).toBeGreaterThan(closeAtIndex)
  })
})
