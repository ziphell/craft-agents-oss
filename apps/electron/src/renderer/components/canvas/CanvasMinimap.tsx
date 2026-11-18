/**
 * The board in miniature, with the part you are looking at outlined.
 *
 * A board is usually larger than the window; without this the only way to know where you are is to
 * pan until something familiar appears. Clicking the map centres the view there, dragging scrubs it.
 */

import { viewportPxToOwnPx } from '@/lib/input-viewport'
import * as React from 'react'
import { Maximize } from 'lucide-react'
import type { CanvasDoc, CanvasViewport } from '@craft-agent/shared/canvas/document'
import { cn } from '@/lib/utils'

const WIDTH = 168
const HEIGHT = 104
/** Room around the content so a card on the edge is not pinned to the frame. */
const PAD = 60

interface CanvasMinimapProps {
  doc: CanvasDoc
  viewport: CanvasViewport
  /** The board's on-screen size, in CSS pixels. */
  board: { width: number; height: number }
  /** Centre the view on a point in canvas coordinates. */
  onNavigate: (x: number, y: number) => void
  label: string
  /** Frame all content again — the way back after panning into empty space. */
  onFit?: () => void
  fitLabel?: string
}

export function CanvasMinimap({ doc, viewport, board, onNavigate, label, onFit, fitLabel }: CanvasMinimapProps) {
  const frame = React.useMemo(() => {
    // The map frames what the person can see as well as what exists: panning away from every card
    // should still show where the viewport went, not push it outside the little box.
    const view = {
      x: -viewport.x / viewport.scale,
      y: -viewport.y / viewport.scale,
      w: board.width / viewport.scale,
      h: board.height / viewport.scale,
    }
    const left = Math.min(...doc.nodes.map((node) => node.x), view.x) - PAD
    const top = Math.min(...doc.nodes.map((node) => node.y), view.y) - PAD
    const right = Math.max(...doc.nodes.map((node) => node.x + node.w), view.x + view.w) + PAD
    const bottom = Math.max(...doc.nodes.map((node) => node.y + node.h), view.y + view.h) + PAD
    const width = Math.max(1, right - left)
    const height = Math.max(1, bottom - top)
    const scale = Math.min(WIDTH / width, HEIGHT / height)
    return {
      left,
      top,
      width,
      height,
      scale,
      x: (WIDTH - width * scale) / 2,
      y: (HEIGHT - height * scale) / 2,
    }
  }, [board.height, board.width, doc.nodes, viewport.scale, viewport.x, viewport.y])

  const place = (x: number, y: number, w: number, h: number) => ({
    left: frame.x + (x - frame.left) * frame.scale,
    top: frame.y + (y - frame.top) * frame.scale,
    width: Math.max(2, w * frame.scale),
    height: Math.max(2, h * frame.scale),
  })

  const navigate = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    // 指针是视口 px，frame 是子树 px
    const x = (viewportPxToOwnPx(event.clientX - rect.left) - frame.x) / frame.scale + frame.left
    const y = (viewportPxToOwnPx(event.clientY - rect.top) - frame.y) / frame.scale + frame.top
    onNavigate(x, y)
  }

  return (
    <div
      title={label}
      aria-label={label}
      className="relative overflow-hidden rounded-lg border border-border/60 bg-background/85 shadow-minimal backdrop-blur"
      style={{ width: WIDTH, height: HEIGHT }}
      onPointerDown={(event) => {
        event.stopPropagation()
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        navigate(event)
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) navigate(event)
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {doc.nodes.map((node) => (
        <div
          key={node.id}
          className={cn(
            'absolute rounded-[2px]',
            node.type === 'text'
              ? 'bg-emerald-500/60'
              : node.type === 'video'
                ? 'bg-sky-500/60'
                : node.type === 'audio'
                  ? 'bg-amber-500/60'
                  : 'bg-foreground/30',
          )}
          style={place(node.x, node.y, node.w, node.h)}
        />
      ))}
      <div
        className="pointer-events-none absolute rounded-[2px] border border-primary/80 bg-primary/10"
        style={place(
          -viewport.x / viewport.scale,
          -viewport.y / viewport.scale,
          board.width / viewport.scale,
          board.height / viewport.scale,
        )}
      />
      {onFit ? (
        <button
          type="button"
          title={fitLabel}
          aria-label={fitLabel}
          // The map itself navigates on pointer down; this button must not move the view first.
          onPointerDown={(event) => {
            event.stopPropagation()
            event.preventDefault()
          }}
          onClick={(event) => {
            event.stopPropagation()
            onFit()
          }}
          className="absolute right-1 top-1 flex size-5 items-center justify-center rounded bg-background/80 text-foreground/50 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <Maximize className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  )
}
