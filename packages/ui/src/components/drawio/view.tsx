/**
 * How a drawn diagram is looked at in the full-size window — how big it is, and what the mouse does
 * with it. A diagram in a *conversation* does not use this: it is shown by `InlineDiagram`, in a box
 * that scrolls, because a window and a picture in a chat are different things to look at.
 *
 * The rules are the app's other previews' rules; where they are not, the reason is written down.
 *
 * - **100% is the drawing at the size it was authored.** Readability comes first: a diagram at its
 *   own size has its labels at the size they were drawn.
 * - **Panning is a transform, not a scroll.** The drawing is moved by `translate`, so it can be put
 *   anywhere: an edge pulled clear across to the other side, a corner moved off a border. There is
 *   no scroll range to reach and no scrollbar saying where in it you are — which is what mermaid's
 *   window and the image preview do, and the arithmetic is the same one they use
 *   (`cursorAnchoredTranslate`), so a diagram moves like the pictures beside it.
 * - **`translate: 0` is the middle of the box**, which is where a drawing that fits is centred and
 *   where `reset` puts one that does not.
 * - **The wheel is the zoom** — there is nothing else it could mean in a window — and it holds the
 *   point under the pointer. Everything else — the buttons, the presets, the keys — holds the middle
 *   of the box, so a zoom never just moves the view somewhere else.
 * - **The ladder is the app's** (`RICH_BLOCK_DEFAULTS`): 25% to 400%, steps of 1.25, presets
 *   25/50/75/100/150/200/400, "fit" at 90% of the room and never enlarged, and ⌘0/⌘+/⌘−. "Fit"
 *   recentres as well, because with a transform a recentred view *is* what fitting looks like.
 * - **Dragging pans, always** — a diagram is something to look at rather than to copy text out of —
 *   and a double-click puts it back, as the app's other previews do.
 */

import * as React from 'react'
import { ZoomControls } from '../overlay/ZoomControls'
import { RICH_BLOCK_DEFAULTS } from '../overlay/rich-block-interaction-spec'
import {
  clampScale,
  computeFitScale,
  cursorAnchoredTranslate,
} from '../overlay/useRichBlockInteractions'

export interface DrawioContentSize {
  width: number
  height: number
}

/** Where the drawing is put, in pixels from the middle of the box. */
export interface DrawioTranslate {
  x: number
  y: number
}

/**
 * What the controls drive. One of these per diagram — created by the component that shows it,
 * because that is the component whose header holds the controls.
 */
export interface DrawioView {
  /** What the controls print: 1 is the drawing at the size it was authored. */
  zoom: number
  /**
   * The size of the drawing's own box at this zoom, which the surface pins the markup to — null
   * until the drawing is known, which is before the first paint.
   */
  displaySize: DrawioContentSize | null
  /** How far the drawing is from the middle of the box. */
  translate: DrawioTranslate
  /**
   * The box the drawing is centred in. A callback ref, so the node is state rather than something
   * read out of a ref at the wrong moment — see §3.6 of the workbench notes.
   */
  boxRef: (element: HTMLDivElement | null) => void
  /** Put the drawing somewhere. Called by the surface that reads the mouse. */
  panTo: (offset: DrawioTranslate) => void
  /** The drawing's own size, as the surface measured it off the markup it was handed. */
  setContent: (size: DrawioContentSize | null) => void
  zoomIn: () => void
  zoomOut: () => void
  zoomToPreset: (percent: number) => void
  zoomToFit: () => void
  /** Back to 100% and the middle: the size it was authored at, where it started. */
  reset: () => void
  resetDisabled: boolean
}

export function useDrawioView({
  isOpen = true,
}: {
  /** Whether the window is open. The keyboard shortcuts are answered only while it is. */
  isOpen?: boolean
} = {}): DrawioView {
  const { minScale, maxScale, zoomStepFactor, wheelSensitivity } = RICH_BLOCK_DEFAULTS

  const [box, setBox] = React.useState<HTMLDivElement | null>(null)
  const [content, setContent] = React.useState<DrawioContentSize | null>(null)
  const [zoom, setZoom] = React.useState(1)
  const [translate, setTranslate] = React.useState<DrawioTranslate>({ x: 0, y: 0 })

  const boxRef = React.useCallback((element: HTMLDivElement | null) => setBox(element), [])

  const displaySize = React.useMemo(() => {
    if (!content || content.width <= 0 || content.height <= 0) return null
    return { width: content.width * zoom, height: content.height * zoom }
  }, [content, zoom])

  /**
   * Zoom to whatever `next` works out from the zoom in hand, holding one point still.
   *
   * `at` is in coordinates measured from the middle of the box, which is what the shared arithmetic
   * takes and what the pointer's position means here. `null` means the middle itself — the drawing
   * grows about its own centre, which is what a button or a preset should do.
   *
   * Both states are read through **updaters**, not from the last render: a trackpad pinch arrives as
   * a stream of wheel events and several can land before React re-renders, and reading the rendered
   * values would have each of them start over from the same place — which is felt as the drawing
   * jumping rather than zooming. This is how `useRichBlockInteractions` does it, so a diagram and
   * the pictures beside it compose a burst the same way.
   */
  const zoomTo = React.useCallback(
    (next: (previous: number) => number, at: DrawioTranslate | null) => {
      setZoom((previous) => {
        const target = clampScale(next(previous), minScale, maxScale)
        if (target === previous) return previous

        const ratio = target / previous
        setTranslate((current) =>
          at
            ? cursorAnchoredTranslate(current, at, ratio)
            : { x: current.x * ratio, y: current.y * ratio },
        )
        return target
      })
    },
    [minScale, maxScale],
  )

  const zoomIn = React.useCallback(
    () => zoomTo((zoom) => zoom * zoomStepFactor, null),
    [zoomTo, zoomStepFactor],
  )
  const zoomOut = React.useCallback(
    () => zoomTo((zoom) => zoom / zoomStepFactor, null),
    [zoomTo, zoomStepFactor],
  )
  const zoomToPreset = React.useCallback(
    (percent: number) => zoomTo(() => percent / 100, null),
    [zoomTo],
  )
  /** Everything at once, at 90% of the box — and never enlarged: finding room for something that
   *  already fits is not a reason to zoom in on it. */
  const zoomToFit = React.useCallback(() => {
    const rectangle = box?.getBoundingClientRect()
    if (!rectangle || !content || content.width <= 0 || content.height <= 0) return

    const fit = computeFitScale(
      { width: rectangle.width, height: rectangle.height },
      content,
      minScale,
      maxScale,
    )
    setZoom(Math.min(1, fit))
    setTranslate({ x: 0, y: 0 })
  }, [box, content, minScale, maxScale])

  const reset = React.useCallback(() => {
    setZoom(1)
    setTranslate({ x: 0, y: 0 })
  }, [])

  const panTo = React.useCallback((offset: DrawioTranslate) => setTranslate(offset), [])

  React.useEffect(() => {
    if (!box) return

    const onWheel = (event: WheelEvent) => {
      // The window is the whole wheel — there is nothing else it could mean there, as in every
      // other preview this app opens full size.
      event.preventDefault()

      const rectangle = box.getBoundingClientRect()
      // The pinch and the mouse are different gestures with different steps — mermaid's rule, and
      // the app's: a trackpad pinch arrives as a stream of small deltas under `ctrlKey`, while one
      // notch of a mouse wheel is one big one. Reading a notch at pinch sensitivity halves the
      // drawing per notch.
      const sensitivity = event.ctrlKey ? wheelSensitivity.trackpadPinch : wheelSensitivity.mouse
      zoomTo((zoom) => zoom * Math.pow(2, -event.deltaY * sensitivity), {
        x: event.clientX - rectangle.left - rectangle.width / 2,
        y: event.clientY - rectangle.top - rectangle.height / 2,
      })
    }

    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [box, zoomTo, wheelSensitivity])

  React.useEffect(() => {
    if (!isOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return
      if (event.key === '=' || event.key === '+') {
        event.preventDefault()
        zoomIn()
      } else if (event.key === '-') {
        event.preventDefault()
        zoomOut()
      } else if (event.key === '0') {
        event.preventDefault()
        reset()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, zoomIn, zoomOut, reset])

  return {
    zoom,
    displaySize,
    translate,
    boxRef,
    panTo,
    setContent,
    zoomIn,
    zoomOut,
    zoomToPreset,
    zoomToFit,
    reset,
    resetDisabled: zoom === 1 && translate.x === 0 && translate.y === 0,
  }
}

/** The controls, wherever the header is: the same ones in both places a diagram is shown. */
export function DrawioViewControls({ view, className }: { view: DrawioView; className?: string }) {
  return (
    <ZoomControls
      className={className}
      scale={view.zoom}
      minScale={RICH_BLOCK_DEFAULTS.minScale}
      maxScale={RICH_BLOCK_DEFAULTS.maxScale}
      zoomPresets={RICH_BLOCK_DEFAULTS.zoomPresets}
      onZoomIn={view.zoomIn}
      onZoomOut={view.zoomOut}
      onZoomToPreset={view.zoomToPreset}
      onZoomToFit={view.zoomToFit}
      onReset={view.reset}
      resetDisabled={view.resetDisabled}
    />
  )
}
