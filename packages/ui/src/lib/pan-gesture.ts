/**
 * One mouse gesture, read as either a pan or a click.
 *
 * They are not different events: a pan ends in a `click` like any other press — the browser does not
 * tell them apart — so a box that both pans and acts on a click has to decide for itself which one
 * it just had. Both of the app's diagram blocks want the same reading of the same gesture, so it
 * lives here instead of in each of them: a threshold that differed between two diagrams would be
 * felt as one of them being wrong.
 *
 * A hand that shakes by a pixel while pressing is not asking to pan, so nothing is reported until
 * the pointer has travelled `PAN_SLOP_PX`. From there the gesture measures from the point it
 * crossed at, which is why the move that makes it a pan reports no travel at all: the drawing
 * follows the pointer from where it was, and never jumps by the slop that started it.
 *
 * What the travel is applied to is the caller's business — a scroll offset for a page that scrolls,
 * a transform for a drawing that is moved.
 */

/** How far the pointer must travel before a press counts as a pan rather than a click. */
export const PAN_SLOP_PX = 4

/** A press in progress. Held in a ref — this is written on every mouse move. */
export interface PanGesture {
  /** Where the gesture last measured from; re-based when it becomes a pan. */
  x: number
  y: number
  /** Whether the gesture has travelled far enough to be a pan. */
  moved: boolean
}

export function beginPan(x: number, y: number): PanGesture {
  return { x, y, moved: false }
}

/**
 * Continue a gesture. Returns how far the pointer has travelled since the gesture became a pan —
 * `{ dx: 0, dy: 0 }` for the move that makes it one — or `null` while the press is still a click,
 * which is what the click that follows a mouseup is supposed to read.
 */
export function panTravel(
  pan: PanGesture,
  x: number,
  y: number,
): { dx: number; dy: number } | null {
  if (!pan.moved) {
    if (Math.abs(x - pan.x) < PAN_SLOP_PX && Math.abs(y - pan.y) < PAN_SLOP_PX) return null
    pan.moved = true
    pan.x = x
    pan.y = y
    return { dx: 0, dy: 0 }
  }

  return { dx: x - pan.x, dy: y - pan.y }
}
