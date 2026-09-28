/**
 * How a diagram gets onto the screen — and nothing else.
 *
 * Two ways, because they are two different things. The viewer turns a document into an SVG —
 * drawio's viewer script can only do that inside a document of its own, so a frame is kept out
 * of sight as an engine — and then shows that SVG the way this app shows anything, at whatever
 * size `view` says (`view.tsx`, which is also where the controls live). The editor is drawio's
 * own embed mode and *is* the surface, because it is for drawing in.
 *
 * The editor speaks drawio's bare JSON, which has **no request ids at all**, so each reply has
 * to be understood from local state and `init` is the only ordering either side gets.
 *
 * Neither touches a file. Reading it, writing it, and deciding what to do when it changed
 * underneath are the block's half of the job — a surface that could save would have to answer
 * "compared to what?", and that question is not a surface's to answer.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  buildDrawioLoadMessage,
  buildDrawioRenderMessage,
  drawioEditorUrl,
  drawioViewerUrl,
  parseDrawioEmbedEvent,
  parseDrawioIncoming,
  parseDrawioSvgSize,
} from '@craft-agent/shared/drawio/types'
import { type DrawioTranslate, type DrawioView } from './view'
import { beginPan, panTravel, type PanGesture } from '../../lib/pan-gesture'

/** The viewer is read at a glance, so a block gives it a box of its own. The editor is the whole
 *  surface of the window that opens it, and fills whatever it is given — there is no height here
 *  to state, because stating one is what left it short of its parent. */
const VIEWER_HEIGHT = '400px'

/**
 * The frame is reached by window identity as well as origin: the origin says which
 * document it is, the window says which frame. Checking only the origin would let a
 * second diagram's frame, or any script served from that origin, claim the handshake.
 */
function isFromFrame(
  frame: HTMLIFrameElement | null,
  event: MessageEvent,
  origin: string,
): boolean {
  return !!frame && event.source === frame.contentWindow && event.origin === origin
}

// ── Viewer: a drawing, produced by a frame that is never shown ───────────────

/**
 * A diagram, drawn.
 *
 * The frame in here is an engine, not a surface. Turning a document into an SVG can only
 * happen inside a document of drawio's own, so one is kept for exactly that and left out of
 * sight — what this renders is the SVG that frame hands back.
 *
 * Showing the frame itself was the first design, and it made the frame own the scrollbars, the
 * size and the cursor: three things this app can hold itself, argued for across a boundary
 * nothing here can measure. An SVG needs no frame to be shown. This app is a browser.
 */
export function DrawioViewer({
  onActivate,
  view,
  ...rest
}: Omit<DrawioViewerShellProps, 'children'> & {
  /** What a click on the drawing itself means where it is not already full size — see `DrawioDiagram`. */
  onActivate?: () => void
  /** How big to draw it, and what the mouse does with it — see `view.tsx`. */
  view: DrawioView
}) {
  return (
    <DrawioViewerShell {...rest}>
      {(svg) => <DrawioDiagram svg={svg} view={view} onActivate={onActivate} />}
    </DrawioViewerShell>
  )
}

interface DrawioViewerShellProps {
  origin: string
  xml: string
  dark: boolean
  title: string
  /**
   * Which page to draw, by drawio's own page id — the renderer resolves a name into it
   * (`findDrawioPage`). Absent draws the document's first page, which is the viewer's own default.
   */
  pageId?: string
  onProblem: (problem: string) => void
  /** The markup, once the engine has drawn it. How it is shown is the caller's. */
  children: (svg: string) => React.ReactNode
  /**
   * The least height to take up — a floor, not a height, and **only while there is nothing to
   * show**: it is there so a layout that is still settling does not jump while the engine loads,
   * not to size the drawing. A block wants 400px; a window fills whatever it is given, and that is
   * the `flex-1` below.
   */
  minHeight?: string
}

/**
 * The engine, and the markup it draws — with the showing left to the caller.
 *
 * Two callers, two presentations: a window (`DrawioViewer`, where the drawing is moved by its own
 * transform) and a conversation (`InlineDiagram`, where it is a picture in a box that scrolls). Both
 * need the same handshake with an off-screen drawio frame, and neither needs to know how the other
 * shows it.
 */
export function DrawioViewerShell({
  origin,
  xml,
  dark,
  title,
  pageId,
  onProblem,
  children,
  minHeight = VIEWER_HEIGHT,
}: DrawioViewerShellProps) {
  const frameRef = React.useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = React.useState(false)
  const [svg, setSvg] = React.useState<string | null>(null)
  const { t, i18n } = useTranslation()

  // A different document, page or theme invalidates the drawing: leaving the old one up would show
  // an edit — or another page — as the picture from before it.
  React.useEffect(() => setSvg(null), [xml, dark, pageId])

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isFromFrame(frameRef.current, event, origin)) return

      const message = parseDrawioIncoming(event.data)
      if (!message) return
      if (message.type === 'ready') setReady(true)
      else if (message.svg) setSvg(message.svg)
      else if (!message.ok) onProblem(message.error ?? 'The diagram could not be drawn.')
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [origin, onProblem])

  // The shell asks for a document only once it says it is ready, so the handshake is what
  // orders these two. There is no retry and no queue to get wrong.
  React.useEffect(() => {
    if (!ready) return
    frameRef.current?.contentWindow?.postMessage(buildDrawioRenderMessage(xml, dark, pageId), origin)
  }, [ready, xml, dark, pageId, origin])

  return (
    <div className="relative flex-1 min-h-0" style={svg ? undefined : { minHeight }}>
      {svg ? (
        <>{children(svg)}</>
      ) : (
        /* The viewer script is a few megabytes, so there is a moment with nothing to show.
           Saying so is this component's job: it is the one that knows the drawing arrived. */
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-[13px]">
          {t('common.loading')}
        </div>
      )}

      {/* The engine. Kept at a real size, far off-screen, rather than `display: none`: the
          viewer draws into a box, and a box with no dimensions is not one it can draw into.
          The language rides in the address because the viewer reads it as it loads — see
          `drawioViewerUrl`. */}
      <iframe
        ref={frameRef}
        src={drawioViewerUrl(origin, i18n.resolvedLanguage)}
        title={title}
        aria-hidden
        tabIndex={-1}
        className="absolute border-0 pointer-events-none"
        style={{ left: -10000, top: 0, width: 1024, height: 768, visibility: 'hidden' }}
      />
    </div>
  )
}

/**
 * The drawing itself: the picture, panned and scaled.
 *
 * Panning is a transform, so the drawing can be put anywhere — an edge pulled clear across to the
 * other side, a corner moved off a border — and there is no scroll range that stops it and no
 * scrollbar saying how much of it there is. Where `translate` is zero it sits in the middle of the
 * box, which is where a drawing that fits is centred; `reset` comes back to that.
 *
 * **The size is measured off the markup, and the zoom is a transform on it.** Neither is a
 * preference: what the viewer hands back is an SVG with **no `viewBox` and a `width: 100%` style**
 * (read off the vendored bundle, not assumed — see §7.3), so its content is drawn in pixels, and
 * stretching its box would show a bigger *window* onto the same drawing rather than a bigger
 * drawing. Pinning it to the size it was drawn at and scaling that is the only thing that changes
 * how big it is.
 */
function DrawioDiagram({
  svg,
  view,
  onActivate,
}: {
  svg: string
  view: DrawioView
  /**
   * What a press that stayed put means, where the drawing is not already the full-size one — in a
   * block it opens the window. Absent in the overlay, which *is* the window: a click there has
   * nothing to open, which is also why the reset below still has a gesture left to live on.
   */
  onActivate?: () => void
}) {
  const drawingRef = React.useRef<HTMLDivElement>(null)
  const { displaySize, translate, zoom, panTo, setContent } = view

  /**
   * The size the markup was drawn at, kept together with the markup it was measured from.
   *
   * Because the transform lands on the same element, a second measurement would read the *scaled*
   * box back — content growing by whatever the zoom is, on every zoom: a zoom that feeds itself.
   * The svg string is the identity of the thing that was measured.
   */
  const measured = React.useRef<{ svg: string; width: number; height: number } | null>(null)

  React.useLayoutEffect(() => {
    const element = drawingRef.current?.querySelector('svg')
    if (!element) {
      setContent(null)
      return
    }

    if (measured.current?.svg !== svg) {
      // Measured on the commit the markup arrives in, before anything here is written to it.
      //
      // The size the markup states is its own `min-width`/`min-height` — the drawing's bounds plus
      // its margin, which is the *drawing's* size and not the browser's idea of it — and
      // `parseDrawioSvgSize` is the one place that format is understood, because the picture in a
      // conversation reads the same two numbers the same way.
      //
      // The element's own box is only the fallback, for markup that states no size at all: with the
      // `width: 100%` the viewer also sets, an auto-width parent resolves the element to the CSS
      // default for a replaced element (300×150 measured), which says more about the box than about
      // the drawing.
      const rect = element.getBoundingClientRect()
      const size = parseDrawioSvgSize(svg) ?? { width: rect.width, height: rect.height }

      if (!(size.width > 0) || !(size.height > 0)) {
        setContent(null)
        return
      }
      measured.current = { svg, width: size.width, height: size.height }
      setContent({ width: size.width, height: size.height })
    }

    const size = measured.current
    element.style.display = 'block'
    element.style.maxWidth = 'none'
    // The viewer's own `width: 100%` would let the box resize the drawing's window; pinned to the
    // size it was drawn at, the transform below is the only thing that changes how big it is.
    element.style.width = `${size.width}px`
    element.style.height = `${size.height}px`
    element.style.transformOrigin = 'top left'
    element.style.transform = `scale(${zoom})`
  }, [svg, zoom, setContent])

  /**
   * The drag: a press that moved pans the drawing, and a press that stayed put is a click — which
   * is what `onActivate` is for, where there is something to open. The two are one gesture, so
   * which one it was is decided by the slop in `pan-gesture.ts`.
   *
   * The travel is added to the pan the press started from, and the gesture measures from the point
   * it crossed the slop at, so the drawing picks up from where it was and never jumps.
   */
  const panRef = React.useRef<PanGesture | null>(null)
  const panBase = React.useRef<DrawioTranslate>({ x: 0, y: 0 })
  /** Whether the gesture that just ended was a pan — the click that follows it is not one. */
  const pannedRef = React.useRef(false)

  const endDrag = (box: HTMLDivElement) => {
    const pan = panRef.current
    if (!pan) return
    panRef.current = null
    box.style.cursor = 'grab'
    pannedRef.current = pan.moved
  }

  const activate = () => {
    if (pannedRef.current) {
      pannedRef.current = false
      return
    }
    onActivate?.()
  }

  return (
    <div
      ref={view.boxRef}
      className="absolute inset-0 overflow-hidden select-none"
      style={{ cursor: 'grab' }}
      onMouseDown={(event) => {
        pannedRef.current = false
        if (event.button !== 0) return
        panRef.current = beginPan(event.clientX, event.clientY)
        panBase.current = translate
        event.currentTarget.style.cursor = 'grabbing'
        // Otherwise the drag selects the labels it passes over.
        event.preventDefault()
      }}
      onMouseMove={(event) => {
        const pan = panRef.current
        if (!pan) return
        const travel = panTravel(pan, event.clientX, event.clientY)
        if (!travel) return
        panTo({ x: panBase.current.x + travel.dx, y: panBase.current.y + travel.dy })
      }}
      onMouseUp={(event) => endDrag(event.currentTarget)}
      onMouseLeave={(event) => endDrag(event.currentTarget)}
      // A press that stayed put opens the window, where there is one to open; a pan is not that
      // press (see `pan-gesture.ts`).
      onClick={activate}
      // The app's other previews clear themselves the same way, and it is the one way back if a
      // drag has left the drawing somewhere unexpected. Only where a click means nothing else: in a
      // block the first click is taken, so there is no second one left for a reset.
      onDoubleClick={onActivate ? undefined : () => view.reset()}
    >
      {/* The drawing: its own box at this zoom, centred on the box's middle, then panned.
          **Centred by `left/top: 50%` and `translate(-50%, -50%)`, not by a flex parent.** A flex
          box with `justify-content: center` pins an overflown child's *start* edge, so the drawing's
          middle moves as it grows — measured at 100px of drift on a single 1.25× step, which is a
          zoom that slides out from under the pointer. Sizing the box this way keeps its middle on
          the box's middle whatever the zoom, which is the one thing the anchoring arithmetic
          assumes. */}
      <div
        ref={drawingRef}
        className="absolute left-1/2 top-1/2"
        style={{
          width: displaySize?.width,
          height: displaySize?.height,
          transform: `translate(-50%, -50%) translate(${translate.x}px, ${translate.y}px)`,
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  )
}

// ── Editor: drawio's own embed mode ──────────────────────────────────────────

export function DrawioEditorFrame({
  origin,
  xml,
  dark,
  title,
  onDocument,
}: {
  origin: string
  xml: string
  dark: boolean
  title: string
  /** Every change the editor reports — the whole document, never a diff. */
  onDocument: (document: string) => void
}) {
  const frameRef = React.useRef<HTMLIFrameElement>(null)
  const documentRef = React.useRef(onDocument)
  documentRef.current = onDocument
  const { t, i18n } = useTranslation()

  // The editor is a ~10 MB application, so there is a real wait between the frame appearing
  // and the document being taken. This frame is the only thing that knows when `init`
  // arrived, so it is the only thing that can say the wait is over — and saying it here
  // rather than through a callback keeps it true for every caller.
  const [started, setStarted] = React.useState(false)

  // Captured once, because the effect that listens cannot depend on `xml` without
  // re-running on every parent render — and re-loading mid-edit would throw away
  // whatever the person has drawn. A reload *from disk* is deliberately not this: the
  // pane remounts this frame for that, so the capture happens again.
  const initialXml = React.useRef(xml)
  // The address is captured for the same reason, and for a second one: `dark` and `origin`
  // are inputs to it, so recomputing on render would rewrite the `src` attribute — and
  // changing an iframe's src reloads it, which is the same lost edit by another route. The
  // app's language is captured with them: an editor opened in one language keeps it until it
  // is opened again, which is the price of never reloading something being worked in.
  const address = React.useRef(drawioEditorUrl(origin, dark, i18n.resolvedLanguage)).current

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isFromFrame(frameRef.current, event, origin)) return

      const message = parseDrawioEmbedEvent(event.data)
      if (!message) return

      if (message.event === 'init') {
        // Nothing may be sent before the application says it is loaded — and since this
        // exchange carries no id, that sentence is the only signal there is.
        frameRef.current?.contentWindow?.postMessage(
          buildDrawioLoadMessage(initialXml.current),
          origin,
        )
        setStarted(true)
        return
      }

      documentRef.current(message.xml)
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [origin])

  return (
    /* Fills the pane it is put in: the editor is the surface of the window, not a box inside it.
       **Both halves of `absolute inset-0 h-full w-full` are required, and measured to be so.**
       `h-full` alone resolves to `auto` here — the heights above it come from flexing against the
       overlay's `min-h-full`, which is a minimum rather than a size, so there is no definite height
       for a percentage to resolve against (measured: a 947px box with a 150px frame in it). Being
       absolutely positioned fixes that, because a percentage then resolves against the positioned
       ancestor's box. But insets alone are not enough for a *replaced* element: an iframe with
       `height: auto` keeps its intrinsic 300×150 however its four edges are pinned (measured), so
       the size has to be stated as well.
       `rounded-[12px] overflow-hidden` is drawio's own window chrome clipped to the corner the page
       editor's box already has: the editor paints its toolbar to the frame's edges, and a corner is
       what keeps the two editing surfaces in this window family looking like the same thing. */
    <div className="relative flex-1 min-h-0 rounded-[12px] overflow-hidden">
      <iframe
        ref={frameRef}
        src={address}
        title={title}
        className="absolute inset-0 h-full w-full border-0"
      />
      {!started && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/70 text-muted-foreground text-[13px]">
          {t('common.loading')}
        </div>
      )}
    </div>
  )
}
