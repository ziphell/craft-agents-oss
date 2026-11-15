/**
 * The tiny bit of arithmetic a board needs to feel deliberate: dragging snaps to what is already
 * there, and a corner drag keeps a picture's shape.
 *
 * Kept apart from the canvas component because both are pure functions of numbers, and because
 * "why did it move two pixels" is a question better answered by a test than by watching a screen.
 */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** One alignment line, in canvas coordinates. */
export interface SnapGuide {
  axis: 'x' | 'y'
  at: number
}

export interface SnapResult {
  dx: number
  dy: number
  guides: SnapGuide[]
}

/**
 * The three anchors on an axis that a person reads as "aligned": middle, start, end.
 *
 * Centres come first so a tie — the same card can meet two lines by the same one-pixel nudge —
 * reads as "the middles line up", which is the alignment people mean most of the time.
 */
function anchors(box: Box, axis: 'x' | 'y'): number[] {
  return axis === 'x'
    ? [box.x + box.w / 2, box.x, box.x + box.w]
    : [box.y + box.h / 2, box.y, box.y + box.h]
}

/**
 * Pull a drag onto the nearest edge or centre.
 *
 * Each axis is decided independently, and only by the closest line within `threshold` — a board
 * where every nearby line nudges the node is harder to place than one that snaps to the obvious.
 * An infinite board has no edges, and an invisible origin is not a line anyone can see: only the
 * other cards are candidates.
 */
export function snapMove(
  box: Box,
  dx: number,
  dy: number,
  targets: Box[],
  threshold: number,
): SnapResult {
  const moved: Box = { ...box, x: box.x + dx, y: box.y + dy }
  const guides: SnapGuide[] = []
  let nextX = dx
  let nextY = dy

  for (const axis of ['x', 'y'] as const) {
    const lines = new Set<number>()
    for (const target of targets) {
      for (const line of anchors(target, axis)) lines.add(line)
    }

    let best: { delta: number; at: number } | null = null
    for (const line of lines) {
      for (const anchor of anchors(moved, axis)) {
        const delta = line - anchor
        if (Math.abs(delta) > threshold) continue
        if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, at: line }
      }
    }
    if (!best) continue
    guides.push({ axis, at: best.at })
    if (axis === 'x') nextX += best.delta
    else nextY += best.delta
  }

  return { dx: nextX, dy: nextY, guides }
}

export interface ResizeOptions {
  /** Floor in canvas pixels; a card smaller than this is not a card. */
  min?: number
  /** Width ÷ height to preserve. `null` leaves both edges free. */
  aspect?: number | null
}

/**
 * Move the dragged edges, then — when an aspect is given — let the width drive the height (or the
 * other way round for a top/bottom handle). The opposite edge stays where it was, which is what
 * makes a resize feel like pulling a corner rather than moving a box.
 */
export function resizeBox(
  start: Box,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  options: ResizeOptions = {},
): Box {
  const min = options.min ?? 24
  const aspect = options.aspect && options.aspect > 0 ? options.aspect : null
  const west = handle.includes('w')
  const east = handle.includes('e')
  const north = handle.includes('n')
  const south = handle.includes('s')

  let w = start.w
  let h = start.h
  if (east) w = Math.max(min, start.w + dx)
  if (west) w = Math.max(min, start.w - dx)
  if (south) h = Math.max(min, start.h + dy)
  if (north) h = Math.max(min, start.h - dy)

  if (aspect) {
    const heightDrives = handle === 'n' || handle === 's'
    if (heightDrives) {
      w = h * aspect
      if (w < min) {
        w = min
        h = w / aspect
      }
    } else {
      h = w / aspect
      if (h < min) {
        h = min
        w = h * aspect
      }
    }
  }

  // The anchored edge is the opposite one; an edge handle keeps the perpendicular centre still.
  const x = west
    ? start.x + start.w - w
    : east
      ? start.x
      : aspect
        ? start.x + (start.w - w) / 2
        : start.x
  const y = north
    ? start.y + start.h - h
    : south
      ? start.y
      : aspect
        ? start.y + (start.h - h) / 2
        : start.y

  return { x, y, w, h }
}

/** Whether a handle drags a horizontal edge (so the cursor should be `ew-resize`). */
export function handleCursors(handle: ResizeHandle): string {
  switch (handle) {
    case 'n':
    case 's':
      return 'ns-resize'
    case 'e':
    case 'w':
      return 'ew-resize'
    case 'nw':
    case 'se':
      return 'nwse-resize'
    default:
      return 'nesw-resize'
  }
}
