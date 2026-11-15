/**
 * The player's picture — a canvas that paints the composition, not a stack of DOM elements.
 *
 * This is the preview half of the same painter the exporter uses (`canvas-compositor`): at each
 * moment it asks the shared code to draw the picture under the playhead, its transition and the
 * overlays, with frames coming from hidden media elements (`frame-source`). Because the moment is
 * read from `MasterTimelineClock`, pausing on a timestamp shows the frame the file will contain.
 *
 * Overlays are still selectable: a click is turned into composition coordinates and tested against
 * each overlay's box, topmost first. The selection is outlined on the canvas.
 */

import * as React from 'react'
import {
  overlaysAt,
  resolveOverlayBox,
  type EditOverlay,
  type OverlayBox,
} from '@craft-agent/shared/reel/overlay'
import type { EditDocument } from '@craft-agent/shared/reel/document'
import {
  drawComposition,
  type Picture,
  type RenderClip,
} from '@craft-agent/shared/reel/canvas-compositor'
import { renderClipsOf } from '@craft-agent/shared/reel/render-clips'
import { FrameSourcePool } from './frame-source'

export interface PreviewStageProps {
  doc: EditDocument
  /** Timeline seconds, read from the master clock. */
  time: number
  playing: boolean
  /** Project-relative source → playable URL. */
  urlOf: (src: string) => string | null
  selectedOverlay: string | null
  onSelectOverlay: (id: string | null) => void
  /** A box being dragged on the picture: published live, committed when the gesture ends. */
  onOverlayBox?: (id: string, box: OverlayBox) => void
  onOverlayBoxEnd?: () => void
}

type DragMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** How close (in display pixels) a pointer must be to an edge to grab it. */
const HANDLE_PX = 9

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** A resized box, kept inside the frame and never smaller than 2% of it. */
function resizeBox(
  mode: DragMode,
  box: OverlayBox,
  dx: number,
  dy: number,
  aspect?: number,
): OverlayBox {
  const MIN = 0.02
  if (mode === 'move') {
    return {
      x: clamp01(box.x + dx),
      y: clamp01(box.y + dy),
      w: box.w,
      h: box.h,
    }
  }

  // A media box keeps its source's shape: growing one axis grows the other, so the picture never
  // gains letterbox bars. Shift during the drag drops the lock (free resize with a matte).
  if (aspect && aspect > 0) {
    let width = box.w
    if (mode.includes('e')) width = box.w + dx
    else if (mode.includes('w')) width = box.w - dx
    let height = box.h
    if (mode.includes('s')) height = box.h + dy
    else if (mode.includes('n')) height = box.h - dy
    const fromHeight = height * aspect
    const horizontal = mode.includes('e') || mode.includes('w')
    const vertical = mode.includes('n') || mode.includes('s')
    if (horizontal && vertical) {
      // A corner follows whichever axis the pointer moved further.
      width = Math.abs(width - box.w) >= Math.abs(fromHeight - box.w) ? width : fromHeight
    } else if (vertical) {
      width = fromHeight
    }
    width = Math.max(MIN, width)
    let h = Math.max(MIN, width / aspect)
    let x = mode.includes('w') ? box.x + box.w - width : box.x
    let y = mode.includes('n') ? box.y + box.h - h : box.y
    // Keep the box in frame without breaking the shape.
    if (x < 0) {
      width += x
      x = 0
      h = width / aspect
    }
    if (y < 0) {
      h += y
      y = 0
      width = h * aspect
    }
    if (x + width > 1) {
      width = 1 - x
      h = width / aspect
    }
    if (y + h > 1) {
      h = 1 - y
      width = h * aspect
    }
    if (width < MIN || h < MIN) return box
    return { x, y, w: width, h }
  }

  let { x, y, w, h } = box
  if (mode.includes('w')) {
    const left = Math.min(clamp01(box.x + dx), box.x + box.w - MIN)
    x = left
    w = box.x + box.w - left
  }
  if (mode.includes('e')) {
    w = Math.min(Math.max(MIN, box.w + dx), 1 - box.x)
  }
  if (mode.includes('n')) {
    const top = Math.min(clamp01(box.y + dy), box.y + box.h - MIN)
    y = top
    h = box.y + box.h - top
  }
  if (mode.includes('s')) {
    h = Math.min(Math.max(MIN, box.h + dy), 1 - box.y)
  }
  return { x, y, w, h }
}

/** Which handle (or the body) the pointer is on, in normalized coordinates. */
function modeAt(box: OverlayBox, x: number, y: number, width: number, height: number): DragMode | null {
  const px = HANDLE_PX / Math.max(1, width)
  const py = HANDLE_PX / Math.max(1, height)
  const left = box.x
  const right = box.x + box.w
  const top = box.y
  const bottom = box.y + box.h
  if (x < left - px || x > right + px || y < top - py || y > bottom + py) return null
  const vertical = Math.abs(y - top) <= py ? 'n' : Math.abs(y - bottom) <= py ? 's' : ''
  const horizontal = Math.abs(x - left) <= px ? 'w' : Math.abs(x - right) <= px ? 'e' : ''
  if (vertical && horizontal) return `${vertical}${horizontal}` as DragMode
  if (vertical) return vertical
  if (horizontal) return horizontal
  return x >= left && x <= right && y >= top && y <= bottom ? 'move' : null
}

const CURSORS: Record<DragMode, string> = {
  move: 'move',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
}

export function PreviewStage({
  doc,
  time,
  playing,
  urlOf,
  selectedOverlay,
  onSelectOverlay,
  onOverlayBox,
  onOverlayBoxEnd,
}: PreviewStageProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const poolRef = React.useRef<FrameSourcePool | null>(null)
  /** Bumped when a source finishes decoding, so a paused frame is painted once it exists. */
  const [ready, bump] = React.useReducer((value: number) => value + 1, 0)
  const sequence = React.useRef(0)
  const drag = React.useRef<{
    id: string
    mode: DragMode
    x: number
    y: number
    box: OverlayBox
    width: number
    height: number
    /** The media source's own shape, for a locked resize; undefined for text. */
    aspect?: number
  } | null>(null)
  const [cursor, setCursor] = React.useState('default')

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const pool = new FrameSourcePool(host, bump)
    poolRef.current = pool
    return () => {
      pool.dispose()
      poolRef.current = null
    }
  }, [])

  React.useEffect(() => {
    const canvas = canvasRef.current
    const pool = poolRef.current
    if (!canvas || !pool) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    const token = (sequence.current += 1)
    pool.setPlaying(playing)
    const pictureOf = (clip: RenderClip, local: number): Picture | null => {
      const url = urlOf(clip.path)
      return url ? pool.picture(clip, local, url) : null
    }
    const overlayPictureOf = (overlay: EditOverlay, local: number): Picture | null => {
      if (!overlay.src) return null
      const url = urlOf(overlay.src)
      return url ? pool.overlayPicture(overlay, local, url) : null
    }

    void (async () => {
      await drawComposition({
        ctx,
        canvas,
        clips: renderClipsOf(doc),
        overlays: doc.overlays,
        time,
        pictureOf,
        overlayPictureOf,
      })
      if (token !== sequence.current) return
      drawSelection(ctx, canvas, doc.overlays, time, selectedOverlay)
      pool.finish()
    })()
  }, [doc, time, playing, urlOf, selectedOverlay, ready])

  /** The selected overlay, when it is actually on screen at this moment. */
  const activeSelected = React.useMemo(() => {
    if (!selectedOverlay) return null
    const overlay = doc.overlays.find((item) => item.id === selectedOverlay)
    if (!overlay) return null
    if (time < overlay.start || time >= overlay.start + overlay.duration) return null
    return overlay
  }, [doc.overlays, selectedOverlay, time])

  const pointOf = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      rect,
      x: rect.width ? (event.clientX - rect.left) / rect.width : 0,
      y: rect.height ? (event.clientY - rect.top) / rect.height : 0,
    }
  }

  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const { rect, x, y } = pointOf(event)
    if (!rect.width || !rect.height) return
    // A selected box is grabbable: its body moves it, its eight edges resize it.
    if (activeSelected && onOverlayBox) {
      const box = resolveOverlayBox(activeSelected)
      const mode = modeAt(box, x, y, rect.width, rect.height)
      if (mode) {
        event.currentTarget.setPointerCapture(event.pointerId)
        // A picture-in-picture resizes around its material's shape; a text box is free.
        const mediaUrl =
          activeSelected.kind === 'media' && activeSelected.src
            ? urlOf(activeSelected.src)
            : null
        drag.current = {
          id: activeSelected.id,
          mode,
          x: event.clientX,
          y: event.clientY,
          box,
          width: rect.width,
          height: rect.height,
          ...(mediaUrl ? { aspect: poolRef.current?.aspectOf(mediaUrl) ?? undefined } : {}),
        }
        event.preventDefault()
        return
      }
    }
    // Otherwise a click selects the topmost box under it.
    const stack = overlaysAt(doc.overlays, time)
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const overlay = stack[index]!
      const box = resolveOverlayBox(overlay)
      if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
        onSelectOverlay(overlay.id)
        return
      }
    }
    onSelectOverlay(null)
  }

  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const held = drag.current
    if (!held) {
      const { rect, x, y } = pointOf(event)
      if (!activeSelected) {
        if (cursor !== 'default') setCursor('default')
        return
      }
      const mode = modeAt(resolveOverlayBox(activeSelected), x, y, rect.width, rect.height)
      const nextCursor = mode ? CURSORS[mode] : 'default'
      if (nextCursor !== cursor) setCursor(nextCursor)
      return
    }
    const dx = (event.clientX - held.x) / Math.max(1, held.width)
    const dy = (event.clientY - held.y) / Math.max(1, held.height)
    // Holding Shift drops the media aspect lock for a free box (the painter mats it).
    onOverlayBox?.(held.id, resizeBox(held.mode, held.box, dx, dy, event.shiftKey ? undefined : held.aspect))
  }

  const pointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onOverlayBoxEnd?.()
  }

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      {/* No width/height in CSS: a replaced element keeps its intrinsic (composition) shape and
          these caps fit it inside the player, so the picture never stretches to the panel. */}
      <canvas
        ref={canvasRef}
        width={doc.settings.width}
        height={doc.settings.height}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        style={{ cursor }}
        className="block max-h-full max-w-full rounded-sm"
      />
      {/* Off-screen frame sources. One element per file; nothing here is visible. */}
      <div
        ref={hostRef}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 h-px w-px overflow-hidden opacity-0"
      />
    </div>
  )
}

/** A selected overlay gets a thin outline on the canvas, the counterpart of the old DOM border. */
function drawSelection(
  ctx: CanvasRenderingContext2D,
  canvas: { width: number; height: number },
  overlays: readonly EditOverlay[],
  time: number,
  selected: string | null,
): void {
  if (!selected) return
  const overlay = overlays.find((item) => item.id === selected)
  if (!overlay) return
  if (time < overlay.start || time >= overlay.start + overlay.duration) return
  const box = resolveOverlayBox(overlay)
  ctx.save()
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.lineWidth = Math.max(2, canvas.width / 500)
  ctx.strokeRect(
    box.x * canvas.width,
    box.y * canvas.height,
    box.w * canvas.width,
    box.h * canvas.height,
  )
  // The same eight points the pointer can grab, so the affordance is visible.
  const size = Math.max(6, canvas.width / 150)
  const left = box.x * canvas.width
  const top = box.y * canvas.height
  const right = (box.x + box.w) * canvas.width
  const bottom = (box.y + box.h) * canvas.height
  const points: Array<[number, number]> = [
    [left, top],
    [(left + right) / 2, top],
    [right, top],
    [left, (top + bottom) / 2],
    [right, (top + bottom) / 2],
    [left, bottom],
    [(left + right) / 2, bottom],
    [right, bottom],
  ]
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  for (const [x, y] of points) {
    ctx.fillRect(x - size / 2, y - size / 2, size, size)
  }
  ctx.restore()
}
