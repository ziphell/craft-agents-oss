/**
 * A diagram as it appears in a conversation: as big as it was drawn, in a box that scrolls.
 *
 * A window, not a canvas. The box is the browser's own scrolling box, so a drawing that does not
 * fit is pushed around by dragging and the scrollbar keeps saying how much of it there is; a drawing
 * that fits sits centred with no scrollbar at all. How big it is shown is decided by the rules this
 * already had when mermaid was the only diagram here: a *small* overflow is fitted rather than given
 * a scrollbar, a large one scrolls at the size the drawing was authored, and a wide drawing is never
 * shrunk so far that its labels stop being readable.
 *
 * **Both diagrams in a conversation come through here** — mermaid's and drawio's — which is the
 * point of it being one component: the same picture, the same mouse, the same answer to "it is too
 * wide", whichever kind of fence it was written in. The full-size windows are a different surface
 * with different rules — moved by a transform, bounded by nothing, no scrollbar — and do not use
 * this.
 */

import * as React from 'react'
import { useScrollFade } from './useScrollFade'
import { beginPan, panTravel, type PanGesture } from '../../lib/pan-gesture'

/** Minimum rendered height for diagrams. Wide horizontal diagrams are scaled up to at least this
 *  height to keep text readable, with horizontal scroll. */
const MIN_READABLE_HEIGHT = 280

/** Fade zone size for the scroll indicators (px). */
const FADE_SIZE = 32

/** Small overflow threshold — if a diagram overflows by less than this, scale to fit. */
const SMALL_OVERFLOW_THRESHOLD = 200

export interface DiagramSize {
  width: number
  height: number
}

/** The size a self-describing SVG states in its own `width`/`height` attributes. */
export function svgSize(svgString: string): DiagramSize | null {
  const widthMatch = svgString.match(/width="(\d+(?:\.\d+)?)"/)
  const heightMatch = svgString.match(/height="(\d+(?:\.\d+)?)"/)
  if (!widthMatch?.[1] || !heightMatch?.[1]) return null
  return { width: parseFloat(widthMatch[1]), height: parseFloat(heightMatch[1]) }
}

export interface InlineDiagramProps {
  /** The drawing, as markup. */
  svg: string
  /**
   * The drawing's own size, when the caller can tell — the sizing rules are all about it. Markup
   * that states no size of its own is pinned to this; markup that does is left alone.
   */
  size: DiagramSize | null
  /** A press that stayed put. The way into the full-size window, where the caller has one. */
  onActivate?: () => void
  /** Whether the block reads the mouse itself. Off where a surface owns the mouse — the editor's
   *  node views, where a click places the cursor. */
  interactive?: boolean
  /** The least height to take up, so a layout that is still settling does not jump. */
  minHeight?: number
  /** The accessible name for the press that opens the window. */
  activateLabel?: string
}

export function InlineDiagram({
  svg,
  size,
  onActivate,
  interactive = true,
  minHeight,
  activateLabel = 'Open diagram fullscreen',
}: InlineDiagramProps) {
  const { scrollRef, maskImage } = useScrollFade(FADE_SIZE)
  const drawingRef = React.useRef<HTMLDivElement>(null)

  // Stable container width — measured in a layout effect (before paint) rather than waiting for the
  // observer's first callback, which would paint one frame at the wrong size.
  const [containerWidth, setContainerWidth] = React.useState(0)

  React.useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) setContainerWidth(el.clientWidth)
  }, [svg])

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * Pin the markup to the size it was drawn at.
   *
   * Markup that carries its own `width`/`height` already renders at that size and needs nothing.
   * Markup that instead sizes itself in CSS — drawio's viewer hands back `width: 100%` plus a
   * `min-width` — would render at the width of *this* box, and the scale below would then be
   * applied to an already-sized drawing. Writing the size onto the element is what makes the box's
   * size and the drawing's size the same thing.
   */
  React.useLayoutEffect(() => {
    const element = drawingRef.current?.querySelector('svg')
    if (!element || !size) return
    element.style.width = `${size.width}px`
    element.style.height = `${size.height}px`
  }, [svg, size])

  /** How big to draw it: the drawing's own size, except where the rules above say otherwise. */
  const scaled = React.useMemo(() => {
    if (!size || !containerWidth || size.width <= 0 || size.height <= 0) return null

    const fitToContainerScale = containerWidth / size.width
    const projectedHeight = size.height * fitToContainerScale

    if (projectedHeight >= MIN_READABLE_HEIGHT) {
      const overflow = size.width - containerWidth

      // A strip of pixels is not worth a scrollbar: fit it instead.
      if (overflow > 0 && overflow < SMALL_OVERFLOW_THRESHOLD) {
        return { scale: fitToContainerScale, width: containerWidth, height: projectedHeight, needsScroll: false }
      }

      // Otherwise it is shown at the size it was drawn, and the box scrolls.
      const needsScroll = overflow > 0
      return {
        scale: 1,
        width: needsScroll ? size.width : undefined,
        height: needsScroll ? size.height : undefined,
        needsScroll,
      }
    }

    // Fitting to the box would leave it too small to read: scale up to the readable height — but
    // never past 100%, because enlarging a drawing is not what fitting is for.
    const scale = Math.min(MIN_READABLE_HEIGHT / size.height, 1)
    const scaledWidth = size.width * scale
    const overflow = scaledWidth - containerWidth

    if (overflow > 0 && overflow < SMALL_OVERFLOW_THRESHOLD) {
      return { scale: fitToContainerScale, width: containerWidth, height: projectedHeight, needsScroll: false }
    }

    return { scale, width: scaledWidth, height: size.height * scale, needsScroll: overflow > 0 }
  }, [size, containerWidth])

  // Scaling mode: when dimensions are provided OR the scale is not 1. Separate from `needsScroll`,
  // because a drawing can be scaled to fit without scrolling at all.
  const needsScaling = scaled && (scaled.width != null || scaled.scale !== 1)
  const minHeightStyle = minHeight != null ? { minHeight: `${minHeight}px` } : undefined

  /**
   * Dragging pans the drawing — the box's own scroll offset, so the scrollbar goes on saying where
   * the drawing is.
   *
   * The gesture is read whether or not there is anything to scroll: a drawing that fits cannot be
   * panned anywhere, but a hand that moved across it still made a drag, and a drag that opened the
   * window would be the drawing being opened by someone who was trying to move it. What there is to
   * scroll decides only what the mouse *looks* like it can do — the cursor, and letting the labels
   * be selected — not what counts as a click.
   *
   * The gesture is held in a ref rather than in state: this runs on every mouse move, and a render
   * per move would redraw the drawing mid-drag.
   */
  const panRef = React.useRef<PanGesture | null>(null)
  const panBase = React.useRef({ x: 0, y: 0 })
  /** Whether the gesture that just ended was a pan — the click that follows it is not one. */
  const pannedRef = React.useRef(false)
  const canPan = interactive && scaled?.needsScroll === true

  const panStart = (event: React.MouseEvent<HTMLDivElement>) => {
    pannedRef.current = false
    if (!interactive || event.button !== 0) return
    const box = event.currentTarget
    panRef.current = beginPan(event.clientX, event.clientY)
    panBase.current = { x: box.scrollLeft, y: box.scrollTop }
    if (canPan) box.style.cursor = 'grabbing'
    // Otherwise a drag selects the labels it passes over.
    event.preventDefault()
  }

  const panMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (!pan) return
    const travel = panTravel(pan, event.clientX, event.clientY)
    if (!travel) return
    // Dragged content follows the pointer: moving the pointer right shows what is to the left. A box
    // with nothing to scroll ignores the writes, which is the point — the gesture is still a pan, it
    // just has nowhere to go.
    const box = event.currentTarget
    box.scrollLeft = panBase.current.x - travel.dx
    box.scrollTop = panBase.current.y - travel.dy
  }

  const panEnd = (event: React.MouseEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (!pan) return
    panRef.current = null
    // Only put back a cursor this gesture took: where there is nothing to pan, the pointer is what
    // React renders and it was never changed.
    if (canPan) event.currentTarget.style.cursor = 'grab'
    // Read by the click that a mouseup is followed by.
    pannedRef.current = pan.moved
  }

  /**
   * A press that stayed put opens the full-size window; a press that moved is a pan and does not.
   * Both on one element, because they are one gesture: what separates them is the slop in
   * `pan-gesture.ts`, not which element the mouse happens to be over.
   */
  const activate = () => {
    if (!interactive) return
    if (pannedRef.current) {
      pannedRef.current = false
      return
    }
    onActivate?.()
  }

  return (
    /* Scroll container with a fade mask for overflow indication: the gradient fades the edges when
       there is more drawing than box. Pan and click are read here — this is the element that
       scrolls. */
    <div
      ref={scrollRef}
      onMouseDown={panStart}
      onMouseMove={panMove}
      onMouseUp={panEnd}
      onMouseLeave={panEnd}
      onClick={activate}
      role={interactive ? 'button' : undefined}
      aria-label={interactive ? activateLabel : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onActivate?.()
              }
            }
          : undefined
      }
      className={canPan ? 'select-none' : undefined}
      style={{
        overflowX: 'auto',
        overflowY: 'hidden',
        cursor: canPan ? 'grab' : interactive ? 'pointer' : undefined,
        maskImage,
        WebkitMaskImage: maskImage,
        ...minHeightStyle,
      }}
    >
      {/* Size wrapper: explicit dimensions when scaling or scrolling, flex centring for a drawing
          shown at the size it was drawn. */}
      <div
        style={{
          width: needsScaling && scaled?.width ? `${scaled.width}px` : undefined,
          height: needsScaling && scaled?.height ? `${scaled.height}px` : undefined,
          display: needsScaling ? 'block' : 'flex',
          justifyContent: needsScaling ? undefined : 'center',
          margin: needsScaling && !scaled?.needsScroll ? '0 auto' : undefined,
        }}
      >
        {/* The drawing itself. A CSS transform scales it visually, from the top-left so scaling
            expands down and to the right. */}
        <div
          ref={drawingRef}
          dangerouslySetInnerHTML={{ __html: svg }}
          style={{
            transformOrigin: 'top left',
            transform: scaled && scaled.scale !== 1 ? `scale(${scaled.scale})` : undefined,
          }}
        />
      </div>
    </div>
  )
}
