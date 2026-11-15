/**
 * One picture or clip, as large as the window — the counterpart to a card, which is a thumbnail.
 *
 * A board is for arranging; this is for looking. It is deliberately not an editor: the controls are
 * the ones a viewer needs (zoom, fit, previous/next) plus the two ways a file leaves the app (copy,
 * show in folder). Everything else belongs to the card's composer or its right-click menu.
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderOpen,
  Maximize,
  Minus,
  Plus,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type { CanvasNode } from '@craft-agent/shared/canvas/document'
import { cn } from '@/lib/utils'
import { mediaUrl } from '@/lib/media-url'

interface CanvasLightboxProps {
  node: CanvasNode
  /** Every image/video card on the board, in paint order, for the arrows. */
  nodes: CanvasNode[]
  projectFolder: string
  onChange: (id: string) => void
  onClose: () => void
  /** Reveal the file in the OS file manager. */
  onShowInFolder: (node: CanvasNode) => void
}

const MIN_SCALE = 0.2
const MAX_SCALE = 6

function absolute(projectFolder: string, relative: string): string {
  return `${projectFolder.replace(/[\\/]+$/, '')}/${relative.replace(/^[\\/]+/, '')}`
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function CanvasLightbox({
  node,
  nodes,
  projectFolder,
  onChange,
  onClose,
  onShowInFolder,
}: CanvasLightboxProps) {
  const { t } = useTranslation()
  const index = nodes.findIndex((candidate) => candidate.id === node.id)
  const previous = index > 0 ? nodes[index - 1] : nodes[nodes.length - 1]
  const next = index >= 0 && index < nodes.length - 1 ? nodes[index + 1] : nodes[0]
  const [scale, setScale] = React.useState(1)
  const [offset, setOffset] = React.useState({ x: 0, y: 0 })
  const drag = React.useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  const path = node.src ? absolute(projectFolder, node.src) : ''
  const url = path ? mediaUrl(path) : ''

  // A new picture starts fitted; keeping the last zoom would make switching feel broken.
  React.useEffect(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [node.id])

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'ArrowLeft' && nodes.length > 1) {
        event.preventDefault()
        onChange(previous!.id)
        return
      }
      if (event.key === 'ArrowRight' && nodes.length > 1) {
        event.preventDefault()
        onChange(next!.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, nodes.length, onClose, onChange, previous])

  // A picture that is being fitted has nothing to pan; keeping an old offset would make "fit" look
  // like a crop.
  React.useEffect(() => {
    if (scale <= 1) setOffset({ x: 0, y: 0 })
  }, [scale])

  if (!url) return null

  const zoom = (factor: number) => {
    setScale((current) => clamp(current * factor, MIN_SCALE, MAX_SCALE))
  }

  const copy = async () => {
    try {
      const blob = await (await fetch(url)).blob()
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
      toast.success(t('canvas.copied'))
    } catch {
      toast.error(t('canvas.copyFailed'))
    }
  }

  const isImage = node.type === 'image'

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('canvas.preview')}
      className="fixed inset-0 z-[200] flex flex-col bg-black/88 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-12 shrink-0 items-center gap-3 px-4 text-white/80"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="min-w-0 flex-1 truncate text-xs">
          {node.src?.split(/[\\/]/).pop()}
          {nodes.length > 1 ? (
            <span className="ml-2 tabular-nums text-white/45">
              {index + 1} / {nodes.length}
            </span>
          ) : null}
        </span>
        {isImage ? (
          <button
            type="button"
            title={t('canvas.copyImage')}
            className="rounded p-1.5 hover:bg-white/10 hover:text-white"
            onClick={() => void copy()}
          >
            <Copy className="h-4 w-4" />
          </button>
        ) : null}
        <button
          type="button"
          title={t('canvas.showInFolder')}
          className="rounded p-1.5 hover:bg-white/10 hover:text-white"
          onClick={() => onShowInFolder(node)}
        >
          <FolderOpen className="h-4 w-4" />
        </button>
        <button
          type="button"
          title={t('common.close')}
          className="rounded p-1.5 hover:bg-white/10 hover:text-white"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {isImage ? (
          <img
            key={node.id}
            src={url}
            alt=""
            draggable={false}
            onWheel={(event) => {
              event.preventDefault()
              event.stopPropagation()
              zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1)
            }}
            onDoubleClick={(event) => {
              event.stopPropagation()
              setScale((current) => (current === 1 ? 2 : 1))
              setOffset({ x: 0, y: 0 })
            }}
            onPointerDown={(event) => {
              event.stopPropagation()
              if (scale <= 1) return
              event.currentTarget.setPointerCapture(event.pointerId)
              drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
            }}
            onPointerMove={(event) => {
              if (!drag.current) return
              setOffset({
                x: drag.current.ox + (event.clientX - drag.current.x),
                y: drag.current.oy + (event.clientY - drag.current.y),
              })
            }}
            onPointerUp={() => {
              drag.current = null
            }}
            onClick={(event) => event.stopPropagation()}
            className={cn(
              'max-h-full max-w-full select-none object-contain',
              scale <= 1 ? 'cursor-zoom-in' : 'cursor-grab active:cursor-grabbing',
            )}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
          />
        ) : (
          <video
            key={node.id}
            src={url}
            controls
            autoPlay
            loop
            playsInline
            onClick={(event) => event.stopPropagation()}
            className="max-h-full max-w-full bg-black"
          />
        )}

        {nodes.length > 1 ? (
          <>
            <button
              type="button"
              aria-label={t('canvas.previous')}
              className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white/80 hover:bg-black/70 hover:text-white"
              onClick={(event) => {
                event.stopPropagation()
                onChange(previous!.id)
              }}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-label={t('canvas.next')}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white/80 hover:bg-black/70 hover:text-white"
              onClick={(event) => {
                event.stopPropagation()
                onChange(next!.id)
              }}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        ) : null}
      </div>

      <div
        className="flex h-12 shrink-0 items-center justify-center gap-2 text-white/70"
        onClick={(event) => event.stopPropagation()}
      >
        {isImage ? (
          <>
            <button type="button" className="rounded p-1.5 hover:bg-white/10" onClick={() => zoom(1 / 1.15)}>
              <Minus className="h-4 w-4" />
            </button>
            <span className="w-12 text-center text-xs tabular-nums">{Math.round(scale * 100)}%</span>
            <button type="button" className="rounded p-1.5 hover:bg-white/10" onClick={() => zoom(1.15)}>
              <Plus className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="rounded p-1.5 hover:bg-white/10"
              title={t('canvas.fit')}
              onClick={() => {
                setScale(1)
                setOffset({ x: 0, y: 0 })
              }}
            >
              <Maximize className="h-4 w-4" />
            </button>
            <span className="ml-2 text-[11px] text-white/40">{t('canvas.lightboxHint')}</span>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
