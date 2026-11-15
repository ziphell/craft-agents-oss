import type { CanvasNode } from '@craft-agent/shared/canvas/document'

/** AABB box of a node — optionally overridden by live drag/resize gesture offsets. */
export interface LiveBox {
  x: number
  y: number
  w: number
  h: number
}

export interface Viewport {
  x: number
  y: number
  scale: number
}

/** Screen point → canvas (world) point, through viewport's translate+scale.
 *  Zero DOM queries: callers pass pre-fetched viewport + board rect. */
export function screenToWorld(
  clientX: number,
  clientY: number,
  viewport: Viewport,
  boardRect: { left: number; top: number },
): { x: number; y: number } {
  return {
    x: (clientX - boardRect.left - viewport.x) / viewport.scale,
    y: (clientY - boardRect.top - viewport.y) / viewport.scale,
  }
}

/** Canvas (world) point → board-local screen point (for overlay positioning). */
export function worldToScreen(
  x: number,
  y: number,
  viewport: Viewport,
): { x: number; y: number } {
  return {
    x: x * viewport.scale + viewport.x,
    y: y * viewport.scale + viewport.y,
  }
}

/** Legacy wrapper — kept so existing callers compile during incremental migration. */
export function toCanvasPoint(
  event: MouseEvent | React.MouseEvent | PointerEvent,
  viewport: Viewport,
  board: HTMLDivElement | null,
): { x: number; y: number } {
  if (!board) return { x: 0, y: 0 }
  const rect = board.getBoundingClientRect()
  return screenToWorld(event.clientX, event.clientY, viewport, rect)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Cubic bezier path from source node's right midpoint to target node's left midpoint. */
export function wirePath(a: LiveBox, b: LiveBox): string {
  const x1 = a.x + a.w
  const y1 = a.y + a.h / 2
  const x2 = b.x
  const y2 = b.y + b.h / 2
  const bend = Math.max(Math.abs(x2 - x1) * 0.5, 50)
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}

/** Cubic bezier midpoint (for label placement). */
export function wireMidpoint(a: LiveBox, b: LiveBox): { x: number; y: number } {
  const x1 = a.x + a.w
  const y1 = a.y + a.h / 2
  const x2 = b.x
  const y2 = b.y + b.h / 2
  return {
    x: (x1 + 3 * x1 + 3 * x2 + x2) / 8,
    y: (y1 + y2) / 2,
  }
}

/** Overflow-aware wheel gate: returns true if the target element can still scroll in delta direction. */
export function wheelStaysInside(
  target: EventTarget | null,
  board: HTMLElement | null,
  deltaY: number,
  deltaX: number,
): boolean {
  if (!(target instanceof Element)) return false
  const stop = board ?? null
  let element: Element | null = target
  while (element && element !== stop) {
    const style = getComputedStyle(element)
    const roomY = /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
    if (roomY) {
      const atTop = element.scrollTop <= 0
      const atEnd = element.scrollTop + element.clientHeight >= element.scrollHeight - 1
      if ((deltaY < 0 && !atTop) || (deltaY > 0 && !atEnd)) return true
    }
    const roomX = /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1
    if (roomX) {
      const atStart = element.scrollLeft <= 0
      const atEnd = element.scrollLeft + element.clientWidth >= element.scrollWidth - 1
      if ((deltaX < 0 && !atStart) || (deltaX > 0 && !atEnd)) return true
    }
    element = element.parentElement
  }
  return false
}

/** Compute the live box of a node, accounting for any active drag/resize gesture. */
export function liveBox(
  node: CanvasNode,
  dragging: boolean,
  dragDx: number,
  dragDy: number,
  resizing: boolean,
  resizeBox: LiveBox | null,
): LiveBox {
  if (resizing && resizeBox) return resizeBox
  return {
    x: node.x + (dragging ? dragDx : 0),
    y: node.y + (dragging ? dragDy : 0),
    w: node.w,
    h: node.h,
  }
}
