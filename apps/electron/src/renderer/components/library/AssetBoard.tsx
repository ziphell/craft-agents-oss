/**
 * The asset library as a board.
 *
 * A card is an asset record, not a canvas node: its id is the project-relative path, and its place
 * comes from `layout` in the library index. There is no canvas document, no revision, and no
 * per-card generation — a card shows what the registry says is there.
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Captions,
  ChevronDown,
  ChevronUp,
  File as FileIcon,
  FileText,
  Hand,
  Image as ImageIcon,
  ImageOff,
  Loader2,
  Maximize,
  Minus,
  MousePointer2,
  Music2,
  Play,
  Plus,
  RotateCcw,
  Search,
  Upload,
  Video as VideoIcon,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Markdown } from '@craft-agent/ui'
import type { AssetKind, AssetStatus, LibraryAsset } from '@craft-agent/shared/library'
import { isSubtitleFile } from '@craft-agent/shared/media/file-kind'
import type { CanvasDoc, CanvasNode, CanvasNodeType } from '@craft-agent/shared/canvas/document'
import { DRAFT_ICON, type Draft, type DraftKind } from './asset-drafts'
import { cachedDataUrl, cachedText, TEXT_PREVIEW_BYTES } from './asset-thumb-cache'
import { ImageTools } from './ImageTools'
import type { ImageEditOp, ImageEditSpec } from '@/lib/image-edit'
import { CanvasLightbox } from '@/components/canvas/CanvasLightbox'
import { CanvasMinimap } from '@/components/canvas/CanvasMinimap'
import {
  clamp,
  screenToWorld,
  wheelStaysInside,
  wireMidpoint,
  wirePath,
  type Viewport,
} from '@/lib/canvas-coords'
import { mediaUrl } from '@/lib/media-url'
import { cn } from '@/lib/utils'

/** A picture's local actions, shared by every card that shows one. */
export interface AssetImageTools {
  /** The picture whose words are being read right now. */
  reading: string | null
  /** The picture being edited right now. */
  editing: { path: string; op: ImageEditOp } | null
  /** Something else (a recording, another picture) is running; every door is closed. */
  disabled: boolean
  onOcr: (asset: LibraryAsset) => void
  onEdit: (asset: LibraryAsset, spec: ImageEditSpec) => void
}

export interface AssetBoardProps {
  /** Whether the board is the view on screen. The grid keeps it mounted to keep its viewport. */
  active: boolean
  /** What the board draws — the whole library: the grid's filters are not a canvas state. */
  assets: LibraryAsset[]
  /** Every asset, so a reference hidden by a filter is still resolvable. */
  allAssets?: LibraryAsset[]
  projectFolder: string
  /** Write one card's place into the library index, or clear it with `null`. */
  onLayoutChange: (
    assetPath: string,
    layout: {
      x: number
      y: number
      w: number
      h: number
      z: number
      hidden?: boolean
    } | null,
  ) => void | Promise<void>
  /** Open a file the board cannot preview itself (text, other). */
  onOpen: (asset: LibraryAsset) => void
  onUpload: (files: File[]) => void
  /** Reload the library after a generation writes a task or an artifact. */
  onRefresh: () => void | Promise<void>
  /** Drafts being composed — the grid and the board share one list (`asset-drafts`). */
  drafts: Draft[]
  selectedDraftId: string | null
  onSelectDraft: (id: string | null) => void
  /** The card is placed where the person is looking: `center` is board coordinates. */
  onCreateDraft: (kind: DraftKind, center: { x: number; y: number }) => void
  /** Where the board is looking now, so a menu outside it can place a new card in view. */
  onViewCenterChange?: (center: { x: number; y: number }) => void
  /** Where the selected draft card sits on screen, so its composer can float beside it. */
  onSelectedDraftAnchorChange?: (
    anchor: { x: number; y: number; w: number; h: number } | null,
  ) => void
  /** The canvas selection, so the grid can show the same cards as checked. */
  onSelectionChange?: (assetPaths: string[]) => void
  /** A one-shot request from the grid: select these cards and frame them. */
  focusSelection?: { paths: string[]; draftIds?: string[]; nonce: number } | null
  onUpdateDraft: (id: string, patch: Partial<Draft>) => void
  /** Replace one card's tags — the same index the grid edits, from the canvas. */
  onTagsChange?: (assetPath: string, tags: string[]) => void | Promise<void>
  /** Replace one card's note — the same index the grid edits, from the canvas. */
  onNoteChange?: (assetPath: string, note: string) => void | Promise<void>
  /** Connect a draft and an asset (either direction) — the caller applies the draft's rules. */
  onLinkDraftAsset?: (draftId: string, assetPath: string) => void
  /** Break the line between a draft and one of its picks. */
  onDisconnectDraftAsset?: (draftId: string, assetPath: string) => void
  /** A link was dropped on a file that cannot be referenced yet. */
  onLinkBlocked?: (assetPath: string) => void
  /** Remove files from the project (the caller confirms and refreshes). */
  onDeleteAssets?: (assetPaths: readonly string[]) => void
  /** Remove draft cards. A draft is not a file, so this never touches the library. */
  onRemoveDraft?: (id: string) => void
  /** Put removed draft cards back (undo of a Delete). */
  onRestoreDrafts?: (drafts: Draft[]) => void
  /** A recording being read into words, and the door that starts it (`audio` cards only). */
  transcribing?: { path: string; format: 'text' | 'srt' } | null
  onTranscribe?: (asset: LibraryAsset, format: 'text' | 'srt') => void
  /** A picture's local actions (`image` cards only). */
  imageTools?: AssetImageTools
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
  z: number
}

const GAP = 28
const MAX_ROW_WIDTH = 1600
const MIN_W = 160
const MIN_H = 100

/** One set of limits for every zoom door: wheel, buttons, keyboard. */
const MIN_SCALE = 0.15
const MAX_SCALE = 2.5
/** Framing one small card should not blow it up to fill the panel. */
const FIT_MAX_SCALE = 1.4
/** The same step for the buttons and the keys. */
const ZOOM_STEP = 1.2
/**
 * The room the floating tools leave free.
 *
 * Fit and jump used the whole rectangle, so a card framed at the top-right could land underneath
 * the inspector — the view moved, but the card was still invisible.
 */
const SAFE_TOP = 64
/** Low enough to clear the minimap (104px tall) as well as the zoom bar. */
const SAFE_BOTTOM = 128
const SAFE_LEFT = 16
const SAFE_RIGHT = 16
/** A checked card opens the inspector on the right; framed content must stay clear of it. */
const SAFE_RIGHT_INSPECTOR = 272
/** A jump should land at a readable size, not at the 15% overview. */
const JUMP_MIN_SCALE = 0.6

const DEFAULT_SIZE: Record<AssetKind, { w: number; h: number }> = {
  image: { w: 300, h: 220 },
  video: { w: 340, h: 200 },
  // Taller than the player alone: an audio card carries its own toolbar (transcribe as text or
  // subtitles), and a player squeezed under it is harder to use than the height is worth.
  audio: { w: 340, h: 148 },
  text: { w: 340, h: 240 },
  other: { w: 260, h: 170 },
}

const absolute = (projectFolder: string, relative: string): string =>
  `${projectFolder.replace(/[\\/]+$/, '')}/${relative.replace(/^[\\/]+/, '')}`

const nodeTypeOf = (kind: AssetKind): CanvasNodeType =>
  kind === 'image' || kind === 'video' || kind === 'audio' ? kind : 'text'

const sizeOf = (asset: LibraryAsset): { w: number; h: number } => {
  const base = DEFAULT_SIZE[asset.kind]
  return {
    w: asset.layout?.w ?? base.w,
    h: asset.layout?.h ?? base.h,
  }
}

function StatusFace({ status }: { status: AssetStatus }) {
  if (status === 'ready') return null
  if (status === 'pending') {
    return <Loader2 className="h-5 w-5 animate-spin text-foreground/30" />
  }
  if (status === 'failed') {
    return <AlertCircle className="h-5 w-5 text-destructive/60" />
  }
  return <ImageOff className="h-5 w-5 text-foreground/30" />
}

function KindFace({ asset }: { asset: LibraryAsset }) {
  if (asset.status !== 'ready') {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <StatusFace status={asset.status} />
      </div>
    )
  }
  const Icon =
    asset.kind === 'video'
      ? VideoIcon
      : asset.kind === 'audio'
        ? Music2
        : asset.kind === 'text'
          ? FileText
          : asset.kind === 'image'
            ? ImageIcon
            : FileIcon
  return (
    <div className="flex h-full w-full items-center justify-center">
      <Icon className="h-7 w-7 text-foreground/30" />
    </div>
  )
}

function BoardImage({ asset, projectFolder }: { asset: LibraryAsset; projectFolder: string }) {
  const [url, setUrl] = React.useState<string | null>(null)
  const [failed, setFailed] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    setUrl(null)
    setFailed(false)
    if (asset.status !== 'ready') return
    const element = ref.current
    if (!element) return
    let cancelled = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        const file = absolute(projectFolder, asset.path)
        void cachedDataUrl(`${file}:${asset.modifiedAt ?? ''}`, () =>
          window.electronAPI.readFileDataUrl(file),
        )
          .then((value) => {
            if (!cancelled) setUrl(value)
          })
          .catch(() => {
            if (!cancelled) setFailed(true)
          })
      },
      { rootMargin: '320px' },
    )
    observer.observe(element)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [asset.modifiedAt, asset.path, asset.status, projectFolder])

  return (
    <div ref={ref} className="flex h-full w-full items-center justify-center overflow-hidden">
      {url ? (
        <img src={url} alt={asset.name} className="h-full w-full object-contain" draggable={false} />
      ) : failed ? (
        <ImageOff className="h-5 w-5 text-foreground/30" />
      ) : asset.status === 'ready' ? (
        <Loader2 className="h-5 w-5 animate-spin text-foreground/30" />
      ) : (
        <StatusFace status={asset.status} />
      )}
    </div>
  )
}

function BoardVideo({ asset, projectFolder }: { asset: LibraryAsset; projectFolder: string }) {
  /** A clip whose first frame the host could not decode still has a face of its own. */
  const [posterFailed, setPosterFailed] = React.useState(false)
  React.useEffect(() => {
    setPosterFailed(false)
  }, [asset.path, asset.modifiedAt])
  if (asset.status !== 'ready') return <KindFace asset={asset} />
  const poster = `thumbnail://thumb/${encodeURIComponent(absolute(projectFolder, asset.path))}`
  return (
    <div className="relative h-full w-full overflow-hidden bg-foreground/[0.04]">
      {posterFailed ? (
        <KindFace asset={asset} />
      ) : (
        <>
          <img
            key={`${asset.path}:${asset.modifiedAt}`}
            src={poster}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            draggable={false}
            onError={() => setPosterFailed(true)}
          />
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white/90">
              <Play className="h-4 w-4" />
            </span>
          </span>
        </>
      )}
    </div>
  )
}

function BoardAudio({ asset, projectFolder }: { asset: LibraryAsset; projectFolder: string }) {
  if (asset.status !== 'ready') return <KindFace asset={asset} />
  return (
    <div className="flex h-full w-full items-center px-3" data-no-drag data-no-zoom>
      <audio controls src={mediaUrl(absolute(projectFolder, asset.path))} className="w-full" />
    </div>
  )
}

function BoardText({ asset, projectFolder }: { asset: LibraryAsset; projectFolder: string }) {
  const [content, setContent] = React.useState<string | null>(null)

  React.useEffect(() => {
    setContent(null)
    if (asset.status !== 'ready') return
    let live = true
    // Only the head of the file: a card draws a few lines, not a 50 MB transcript.
    const file = absolute(projectFolder, asset.path)
    void cachedText(`${file}:${asset.modifiedAt ?? ''}`, () =>
      window.electronAPI.readFile(file, TEXT_PREVIEW_BYTES + 1),
    )
      .then((value) => {
        if (live) {
          setContent(
            value.length > TEXT_PREVIEW_BYTES
              ? `${value.slice(0, TEXT_PREVIEW_BYTES)}…`
              : value,
          )
        }
      })
      .catch(() => {
        if (live) setContent('')
      })
    return () => {
      live = false
    }
  }, [asset.modifiedAt, asset.path, asset.status, projectFolder])

  if (asset.status !== 'ready') return <KindFace asset={asset} />
  if (content === null) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-foreground/30" />
      </div>
    )
  }
  return (
    <div className="pointer-events-none h-full w-full overflow-hidden px-3 py-2 text-[13px]" data-no-zoom>
      <Markdown mode="minimal" baseDir={projectFolder}>
        {content}
      </Markdown>
    </div>
  )
}

function AssetCard({
  asset,
  rect,
  selected,
  active,
  scale,
  projectFolder,
  transcribing,
  onTranscribe,
  imageTools,
  onRetryTask,
  taskBusyPath,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onResizeStart,
  onResizeMove,
  onResizeUp,
  onDoubleClick,
  onContextMenu,
  connectTarget = false,
  connectBlocked = false,
  onConnectStart,
  onConnectMove,
  onConnectEnd,
}: {
  asset: LibraryAsset
  rect: Rect
  selected: boolean
  active: boolean
  /** Board zoom, so the resize handle keeps roughly the same size on screen. */
  scale: number
  projectFolder: string
  transcribing: { path: string; format: 'text' | 'srt' } | null
  onTranscribe?: (asset: LibraryAsset, format: 'text' | 'srt') => void
  imageTools?: AssetImageTools
  /** Start a failed task again from the request it stored. */
  onRetryTask?: (asset: LibraryAsset) => void
  taskBusyPath?: string | null
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void
  onResizeMove: (event: React.PointerEvent<HTMLDivElement>) => void
  onResizeUp: (event: React.PointerEvent<HTMLDivElement>) => void
  onDoubleClick: () => void
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void
  /** A link is hovering this card as its lander. */
  connectTarget?: boolean
  /** A link is hovering this card but cannot land (file not ready). */
  connectBlocked?: boolean
  onConnectStart: (event: React.PointerEvent<HTMLDivElement>) => void
  onConnectMove: (event: React.PointerEvent<HTMLDivElement>) => void
  onConnectEnd: (event: React.PointerEvent<HTMLDivElement>) => void
}) {
  const { t } = useTranslation()
  const running = transcribing?.path === asset.path ? transcribing.format : null
  const busy = transcribing !== null

  return (
    <div
      data-asset-path={asset.path}
      className={cn(
        'group absolute flex flex-col overflow-hidden rounded-xl border bg-background shadow-minimal transition-shadow',
        selected ? 'border-primary/70 shadow-strong ring-2 ring-primary/20' : 'border-border/60 hover:border-border',
        connectTarget && 'border-primary ring-2 ring-primary/50',
        connectBlocked && 'border-destructive ring-2 ring-destructive/40',
        active && 'cursor-grabbing',
      )}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex: active ? 1000 : Math.max(1, rect.z),
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div className="flex h-9 shrink-0 cursor-grab items-center gap-2 border-b border-border/50 px-3 active:cursor-grabbing">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={asset.name}>
          {asset.name}
        </span>
        {asset.status !== 'ready' ? (
          <span className="shrink-0" title={asset.status}>
            <StatusFace status={asset.status} />
          </span>
        ) : null}
      </div>

      {/* A pending card cannot be stopped — the provider is already working and has no cancel
          endpoint. A failed one can be started again. `data-no-drag` keeps the toolbar from
          starting a drag. */}
      {asset.status === 'pending' || asset.status === 'failed' ? (
        <div
          data-no-drag
          className="flex shrink-0 items-center justify-end gap-1 border-b border-border/50 px-2 py-1"
        >
          {asset.status === 'pending' ? (
            asset.cancellable === false ? (
              <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                {t('library.taskNoCancel')}
              </span>
            ) : null
          ) : (
            <button
              type="button"
              disabled={taskBusyPath === asset.path}
              title={t('library.taskRetry')}
              onClick={() => onRetryTask?.(asset)}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              {taskBusyPath === asset.path ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RotateCcw className="h-3 w-3" />
              )}
              {t('library.taskRetry')}
            </button>
          )}
        </div>
      ) : null}

      {/* A recording's actions sit under its title, where the card's own toolbar belongs: they are
          about this file, and a board full of cards should not have to be clicked into to find
          them. `data-no-drag` keeps the toolbar from starting a drag. */}
      {asset.kind === 'audio' && asset.status === 'ready' && onTranscribe ? (
        <div
          data-no-drag
          className="flex shrink-0 items-center justify-end gap-1 border-b border-border/50 px-2 py-1"
        >
          <button
            type="button"
            disabled={busy}
            title={t('library.transcribeText')}
            onClick={() => onTranscribe(asset, 'text')}
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running === 'text' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <FileText className="h-3 w-3" />
            )}
            {t('library.transcribeText')}
          </button>
          <button
            type="button"
            disabled={busy}
            title={t('library.transcribeSrt')}
            onClick={() => onTranscribe(asset, 'srt')}
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running === 'srt' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Captions className="h-3 w-3" />
            )}
            {t('library.transcribeSrt')}
          </button>
        </div>
      ) : null}

      {/* A picture's toolbar: the same two doors as the detail column, on the card itself. */}
      {asset.kind === 'image' && asset.status === 'ready' && imageTools ? (
        <div
          data-no-drag
          className="flex shrink-0 items-center justify-end gap-1 border-b border-border/50 px-2 py-1"
        >
          <ImageTools
            compact
            reading={imageTools.reading === asset.path}
            editing={imageTools.editing?.path === asset.path}
            disabled={
              imageTools.disabled || imageTools.reading !== null || imageTools.editing !== null
            }
            onOcr={() => imageTools.onOcr(asset)}
            onEdit={(spec) => imageTools.onEdit(asset, spec)}
          />
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {asset.kind === 'image' ? (
          <BoardImage asset={asset} projectFolder={projectFolder} />
        ) : asset.kind === 'video' ? (
          <BoardVideo asset={asset} projectFolder={projectFolder} />
        ) : asset.kind === 'audio' ? (
          <BoardAudio asset={asset} projectFolder={projectFolder} />
        ) : asset.kind === 'text' ? (
          <BoardText asset={asset} projectFolder={projectFolder} />
        ) : (
          <KindFace asset={asset} />
        )}
      </div>

      {/* Link out: drag this dot to a draft to add this asset as its reference. */}
      <div
        data-no-drag
        onPointerDown={onConnectStart}
        onPointerMove={onConnectMove}
        onPointerUp={onConnectEnd}
        onPointerCancel={onConnectEnd}
        onClick={(event) => event.stopPropagation()}
        style={{ width: Math.max(14, 18 / scale), height: Math.max(14, 18 / scale) }}
        className={cn(
          'absolute right-1 top-1/2 z-10 flex -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full border border-primary/60 bg-background shadow-minimal transition-opacity',
          // A selected card keeps its handle out: hover is hard to aim at while the pointer is
          // already busy, and a selection is exactly when a link is likely.
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        <span className="h-1 w-1 rounded-full bg-primary/70" />
      </div>

      <div
        data-no-drag
        className="absolute bottom-0 right-0 cursor-nwse-resize"
        style={{ width: Math.max(14, 18 / scale), height: Math.max(14, 18 / scale) }}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      >
        <span className="pointer-events-none absolute bottom-0.5 right-0.5 h-2 w-2 rounded-tl border-l border-t border-foreground/30" />
      </div>
    </div>
  )
}

/**
 * What a draft card calls itself.
 *
 * The prompt while there is one; otherwise the file the card was given (a reference, a frame, a
 * text port), because "加入图片" is the action that made the card, not a name for what is in it.
 */
function draftTitleOf(draft: Draft, fallback: string): string {
  const prompt = draft.prompt.trim()
  if (prompt) return prompt
  const attached = draft.firstFrame ?? draft.lastFrame ?? draft.textSource ?? draft.references[0]
  return attached?.split(/[\\/]/).pop() || fallback
}

function DraftCard({
  draft,
  label,
  selected,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onClick,
  connectTarget = false,
  scale,
  onConnectStart,
  onConnectMove,
  onConnectEnd,
}: {
  draft: Draft
  label: string
  selected: boolean
  /** Board zoom, so the handle keeps roughly the same size on screen. */
  scale: number
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void
  /** A link is hovering this draft as its lander. */
  connectTarget?: boolean
  onConnectStart: (event: React.PointerEvent<HTMLDivElement>) => void
  onConnectMove: (event: React.PointerEvent<HTMLDivElement>) => void
  onConnectEnd: (event: React.PointerEvent<HTMLDivElement>) => void
}) {
  const Icon = DRAFT_ICON[draft.kind]
  return (
    <div
      className={cn(
        'group absolute flex flex-col overflow-hidden rounded-xl border-2 border-dashed bg-background/85 shadow-minimal',
        selected ? 'border-primary/70' : 'border-border/70',
        connectTarget && 'border-primary bg-primary/[0.04]',
      )}
      style={{ left: draft.x, top: draft.y, width: draft.w, height: draft.h, zIndex: draft.z }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onClick}
    >
      {/* Link in: drag a media card's dot onto this side to attach it as a reference. */}
      <div
        data-no-drag
        onPointerDown={onConnectStart}
        onPointerMove={onConnectMove}
        onPointerUp={onConnectEnd}
        onPointerCancel={onConnectEnd}
        onClick={(event) => event.stopPropagation()}
        style={{ width: Math.max(14, 18 / scale), height: Math.max(14, 18 / scale) }}
        className={cn(
          'absolute left-1 top-1/2 z-10 flex -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full border border-primary/60 bg-background shadow-minimal transition-opacity',
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        <span className="h-1 w-1 rounded-full bg-primary/70" />
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-dashed border-border/50 px-3">
        <Icon className="h-3.5 w-3.5 text-foreground/50" />
        <span className="min-w-0 flex-1 truncate text-xs">{draft.prompt.trim() || label}</span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        {draft.generating ? (
          <Loader2 className="h-5 w-5 animate-spin text-foreground/30" />
        ) : (
          <Icon className="h-7 w-7 text-foreground/20" />
        )}
      </div>
    </div>
  )
}

function ToolButton({
  active,
  title,
  onClick,
  children,
}: {
  active?: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        'flex size-8 items-center justify-center rounded-lg text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground',
        active && 'bg-foreground/[0.09] text-foreground',
      )}
    >
      {children}
    </button>
  )
}

export function AssetBoard({
  active,
  assets,
  allAssets,
  projectFolder,
  onLayoutChange,
  onOpen,
  onUpload,
  onRefresh,
  drafts,
  selectedDraftId,
  onSelectDraft,
  onCreateDraft,
  onUpdateDraft,
  onTagsChange,
  onNoteChange,
  onLinkDraftAsset,
  onDisconnectDraftAsset,
  onLinkBlocked,
  onDeleteAssets,
  onRemoveDraft,
  onRestoreDrafts,
  onViewCenterChange,
  onSelectedDraftAnchorChange,
  onSelectionChange,
  focusSelection,
  transcribing,
  onTranscribe,
  imageTools,
}: AssetBoardProps) {
  const { t } = useTranslation()
  const libraryAssets = allAssets ?? assets
  const boardRef = React.useRef<HTMLDivElement>(null)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const [boardSize, setBoardSize] = React.useState({ width: 900, height: 600 })
  /** Whether the board has been laid out at least once — a hidden board measures 0×0. */
  const [boardMeasured, setBoardMeasured] = React.useState(false)
  const [viewport, setViewport] = React.useState<Viewport>({ x: 0, y: 0, scale: 1 })
  const [positions, setPositions] = React.useState<Record<string, Rect>>({})
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set())
  /** Drafts picked alongside files: a marquee or a modified click may take several at once. */
  const [selectedDraftIds, setSelectedDraftIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [tool, setTool] = React.useState<'select' | 'pan'>('select')
  const [spaceHeld, setSpaceHeld] = React.useState(false)
  const [previewPath, setPreviewPath] = React.useState<string | null>(null)
  const [drag, setDrag] = React.useState<{ dx: number; dy: number; paths: string[] } | null>(null)
  const [resize, setResize] = React.useState<{ path: string; w: number; h: number } | null>(null)
  /**
   * Where every card is drawn right now, including an in-flight drag or resize.
   *
   * The stores (`positions`) only change on drop. Wires, the minimap and search outlines read this
   * instead, so a dragged card does not leave its lines behind until the pointer is released.
   */
  const displayRects = React.useMemo<Record<string, Rect>>(() => {
    if (!drag && !resize) return positions
    const next = { ...positions }
    if (drag) {
      for (const path of drag.paths) {
        const rect = next[path]
        if (rect) next[path] = { ...rect, x: rect.x + drag.dx, y: rect.y + drag.dy }
      }
    }
    if (resize) {
      const rect = next[resize.path]
      if (rect) next[resize.path] = { ...rect, w: resize.w, h: resize.h }
    }
    return next
  }, [drag, positions, resize])

  // Latest values for the effects and frame loops below, which must not re-run on every pan.
  const positionsRef = React.useRef(positions)
  const viewportRef = React.useRef(viewport)
  const boardSizeRef = React.useRef(boardSize)
  const [dropping, setDropping] = React.useState(false)
  /** The card whose stop/retry call is in flight, so its toolbar can say so. */
  const [taskBusyPath, setTaskBusyPath] = React.useState<string | null>(null)
  /** A card menu lives at the pointer; a selection is the set of cards it may act on. */
  const [menu, setMenu] = React.useState<{ path: string; x: number; y: number } | null>(null)
  const [tagDraft, setTagDraft] = React.useState('')
  /** The tag the group inspector is about to add to every selected card. */
  const [batchTagDraft, setBatchTagDraft] = React.useState('')
  /** Finding a card by name: a jump list, never a filter — the board still draws everything. */
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  /** -1 means "found but not jumped to yet", so the first Enter lands on the first hit. */
  const [matchCursor, setMatchCursor] = React.useState(-1)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  /** The draft wire the pointer has rested on; its disconnect button replaces the index badge. */
  const [edgeHint, setEdgeHint] = React.useState<string | null>(null)
  const edgeHintTimerRef = React.useRef<number | null>(null)
  const edgeHideTimerRef = React.useRef<number | null>(null)

  const selectOnly = React.useCallback((path: string) => {
    setSelected(new Set([path]))
  }, [])

  const toggleSelected = React.useCallback((path: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const clearSelection = React.useCallback(() => setSelected(new Set()), [])
  const clearDraftSelection = React.useCallback(() => setSelectedDraftIds(new Set()), [])

  /** A drag on empty canvas selects what it covers (marquee). */
  const [marquee, setMarquee] = React.useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const marqueeRef = React.useRef<{
    startClientX: number
    startClientY: number
    /** The anchor in canvas coordinates, so edge panning grows the box instead of sliding it. */
    startWorld: { x: number; y: number }
    base: ReadonlySet<string>
    baseDrafts: ReadonlySet<string>
  } | null>(null)
  /** Edge panning while marquee-selecting; filled in after the pan loop is declared. */
  const marqueeAutoPanRef = React.useRef<{
    update: (clientX: number, clientY: number) => void
    stop: () => void
  } | null>(null)
  const suppressBoardClickRef = React.useRef(false)

  /**
   * A link being dragged from a card handle.
   *
   * The rule of *what may connect to what* stays with the draft (it already exists in the
   * composer); the board only finds the card under the pointer and names both ends.
   */
  const [connection, setConnection] = React.useState<{
    sourceKind: 'draft' | 'asset'
    from: { x: number; y: number }
    to: { x: number; y: number }
    target: string | null
    /** A file under the pointer that cannot be referenced yet (pending/missing). */
    blocked: string | null
  } | null>(null)
  const connectRef = React.useRef<{
    source: { kind: 'draft'; id: string } | { kind: 'asset'; path: string }
    startClientX: number
    startClientY: number
    moved: boolean
    pointerId: number
  } | null>(null)

  /** Start a failed task again from the request it stored. Stopping is not offered: a card owns one
   * task, and a submitted async job cannot be stopped by the providers we use. */
  const retryTask = React.useCallback(
    async (asset: LibraryAsset) => {
      setTaskBusyPath(asset.path)
      try {
        const reply = await window.electronAPI.retryMediaTask(absolute(projectFolder, asset.path))
        if (reply.ok) toast.success(t('library.taskRetryStarted'))
        else toast.error(reply.message ?? t('canvas.generateFailed'))
        await onRefresh()
      } finally {
        setTaskBusyPath(null)
      }
    },
    [onRefresh, projectFolder, t],
  )

  const dragRef = React.useRef<{
    paths: string[]
    /** The rect each dragged card commits to (z already lifted). */
    rects: Record<string, Rect>
    /** Where each card was before the gesture, for undo. */
    before: Record<string, Rect>
    startX: number
    startY: number
    /** Where the gesture started, in screen pixels — the drag threshold compares against it. */
    clientX: number
    clientY: number
    /** Where the pointer is now; auto-pan keeps the held card under it. */
    pointerX: number
    pointerY: number
    dx: number
    dy: number
    moved: boolean
    boardRect: { left: number; top: number }
    pointerId: number
  } | null>(null)
  /**
   * Panning while a card is held against an edge of the board.
   *
   * Without it, moving a card across a board larger than the window means dropping it, scrolling,
   * and picking it up again.
   */
  const autoPanRef = React.useRef<{ frame: number | null; vx: number; vy: number }>({
    frame: null,
    vx: 0,
    vy: 0,
  })
  const resizeRef = React.useRef<{
    path: string
    startX: number
    startY: number
    w: number
    h: number
    rect: Rect
    moved: boolean
    boardRect: { left: number; top: number }
    pointerId: number
  } | null>(null)
  const panRef = React.useRef<{
    startX: number
    startY: number
    originX: number
    originY: number
    pointerId: number
  } | null>(null)
  /**
   * The newest pointer position, painted at most once per frame.
   *
   * A trackpad can report more moves than a frame has time to draw, and every painted move
   * re-renders the whole board. Keeping only the newest point in a ref turns a burst into one
   * update, with the last position winning.
   */
  const panPointRef = React.useRef<{ x: number; y: number } | null>(null)
  const panFrameRef = React.useRef<number | null>(null)
  const marqueePointRef = React.useRef<{ x: number; y: number } | null>(null)
  const marqueeFrameRef = React.useRef<number | null>(null)
  const draftDragRef = React.useRef<{
    /** Every draft the gesture moves, with where it started: a pick inside a group takes it along. */
    before: Record<string, { x: number; y: number }>
    startX: number
    startY: number
    /** Where the gesture started, in screen pixels — the drag threshold compares against it. */
    clientX: number
    clientY: number
    /** Where the pointer is now; auto-pan keeps the held card under it. */
    pointerX: number
    pointerY: number
    moved: boolean
    boardRect: { left: number; top: number }
    pointerId: number
  } | null>(null)
  const didFit = React.useRef(false)
  /**
   * One step of layout history, per gesture.
   *
   * A card or draft that was moved or resized by mistake is one keystroke away from where it was.
   * The stack is the board's own: it is view state, like the viewport, not a document history.
   */
  const undoRef = React.useRef<
    Array<
      | { kind: 'asset'; path: string; before: Rect }
      | { kind: 'assets'; before: Record<string, Rect> }
      | { kind: 'draft'; id: string; before: { x: number; y: number } }
      | { kind: 'drafts'; before: Record<string, { x: number; y: number }> }
      | {
          kind: 'draftPicks'
          id: string
          before: Pick<Draft, 'references' | 'firstFrame' | 'lastFrame' | 'textSource'>
        }
      | { kind: 'draftsRemoved'; drafts: Draft[] }
    >
  >([])
  /** A click after a draft drag is the drag ending, not a request to open its editor. */
  const suppressDraftClickRef = React.useRef(false)

  // A queued frame outliving the board would paint into nothing.
  React.useEffect(
    () => () => {
      if (panFrameRef.current !== null) cancelAnimationFrame(panFrameRef.current)
      if (marqueeFrameRef.current !== null) cancelAnimationFrame(marqueeFrameRef.current)
    },
    [],
  )

  // A card made on the board lands where the person is looking; the library's grid has no view of
  // its own, so it asks without a centre and the draft starts near the board's origin.
  const createDraftAtCenter = React.useCallback(
    (kind: DraftKind) => {
      onCreateDraft(kind, {
        x: (boardSize.width / 2 - viewport.x) / viewport.scale,
        y: (boardSize.height / 2 - viewport.y) / viewport.scale,
      })
      clearSelection()
    },
    [boardSize.height, boardSize.width, clearSelection, onCreateDraft, viewport.scale, viewport.x, viewport.y],
  )

  // The library's own "generate" menu sits outside the board; it asks here where "here" is, so a
  // card started from that menu lands in view instead of at the board's origin.
  React.useEffect(() => {
    if (!active || !boardMeasured) return
    onViewCenterChange?.({
      x: (boardSize.width / 2 - viewport.x) / viewport.scale,
      y: (boardSize.height / 2 - viewport.y) / viewport.scale,
    })
  }, [
    active,
    boardMeasured,
    boardSize.height,
    boardSize.width,
    onViewCenterChange,
    viewport.scale,
    viewport.x,
    viewport.y,
  ])

  // The composer floats beside the card it writes. The board owns the transform, so it is the one
  // that can say where that card currently is on screen — and it says so again on every pan, zoom
  // or drag, so the two never drift apart.
  React.useEffect(() => {
    if (!onSelectedDraftAnchorChange) return
    const draft = selectedDraftId ? drafts.find((entry) => entry.id === selectedDraftId) : null
    const board = boardRef.current
    if (!active || !draft || !board) {
      onSelectedDraftAnchorChange(null)
      return
    }
    const rect = board.getBoundingClientRect()
    onSelectedDraftAnchorChange({
      x: rect.left + viewport.x + draft.x * viewport.scale,
      y: rect.top + viewport.y + draft.y * viewport.scale,
      w: draft.w * viewport.scale,
      h: draft.h * viewport.scale,
    })
  }, [
    active,
    boardMeasured,
    drafts,
    onSelectedDraftAnchorChange,
    selectedDraftId,
    viewport.scale,
    viewport.x,
    viewport.y,
  ])

  // Board size drives fit and the minimap.
  React.useEffect(() => {
    const element = boardRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      setBoardSize({ width: rect.width, height: rect.height })
      setBoardMeasured(rect.width > 0 && rect.height > 0)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // React's wheel listener is passive at the root; a native one is what can actually stop the
  // page from scrolling while the board pans.
  //
  // The wheel is a scroll gesture first — a canvas is a surface you move around — so it pans by
  // default, vertically; Shift makes it horizontal, and Ctrl (or the pinch gesture macOS reports
  // as Ctrl+wheel) is the one that zooms.
  //
  // Scroll containers under the pointer win first: a composer or an inspector scrolls itself to its
  // edge, and only then does the canvas take over. Nothing scrolls "through" a panel.
  React.useEffect(() => {
    const board = boardRef.current
    if (!board) return

    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null
      // Panels, players and sliders own the wheel inside their own bounds.
      if (target?.closest('[data-no-zoom]')) return

      // Lines (a mouse notch in some platforms) need a pixel step; a trackpad already reports
      // pixels. A horizontal trackpad gesture keeps working without Shift.
      const unit = event.deltaMode === 1 ? 16 : 1
      const dx = event.shiftKey
        ? event.deltaX !== 0
          ? event.deltaX
          : event.deltaY
        : event.deltaX
      const dy = event.shiftKey ? 0 : event.deltaY
      const zooming = event.ctrlKey || event.metaKey

      // A nested scroller scrolls first, until it reaches its edge.
      if (!zooming && wheelStaysInside(target, board, dy, dx)) return

      event.preventDefault()
      const rect = board.getBoundingClientRect()

      if (zooming) {
        const px = event.clientX - rect.left
        const py = event.clientY - rect.top
        // Exponential, so a mouse notch and a trackpad's small deltas both feel proportional.
        const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015))
        setViewport((current) => {
          const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE)
          const worldX = (px - current.x) / current.scale
          const worldY = (py - current.y) / current.scale
          return { scale, x: px - worldX * scale, y: py - worldY * scale }
        })
        return
      }

      if (dx === 0 && dy === 0) return
      setViewport((current) => ({
        ...current,
        x: current.x - dx * unit,
        y: current.y - dy * unit,
      }))
    }
    board.addEventListener('wheel', onWheel, { passive: false })
    return () => board.removeEventListener('wheel', onWheel)
  }, [])

  // Layout is the index's, or a shelf for cards nobody has placed yet.
  React.useEffect(() => {
    setPositions((previous) => {
      const next: Record<string, Rect> = {}
      let shelfX = 0
      let shelfY = 0
      let rowH = 0
      const layoutBottom = assets.reduce((bottom, asset) => {
        // A card taken off the board does not reserve space on the shelf.
        if (!asset.layout || asset.layout.hidden) return bottom
        const size = sizeOf(asset)
        return Math.max(bottom, asset.layout.y + size.h)
      }, 0)
      if (layoutBottom > 0) shelfY = layoutBottom + 64

      for (const asset of assets) {
        // Removed from the board on purpose: the file stays an asset, the canvas does not draw it.
        if (asset.layout?.hidden) continue
        const size = sizeOf(asset)
        if (asset.layout) {
          next[asset.path] = {
            x: asset.layout.x,
            y: asset.layout.y,
            w: size.w,
            h: size.h,
            z: asset.layout.z ?? 0,
          }
          continue
        }
        const previousRect = previous[asset.path]
        if (previousRect) {
          next[asset.path] = previousRect
          continue
        }
        if (shelfX > 0 && shelfX + size.w > MAX_ROW_WIDTH) {
          shelfX = 0
          shelfY += rowH + GAP
          rowH = 0
        }
        next[asset.path] = { x: shelfX, y: shelfY, w: size.w, h: size.h, z: 0 }
        shelfX += size.w + GAP
        rowH = Math.max(rowH, size.h)
      }
      return next
    })
  }, [assets])

  /**
   * The part of the board the floating tools leave free.
   *
   * Everything that frames content — fit, a search jump, a newly added card — works against this
   * rectangle. Using the whole board meant a card framed at the top-right could sit underneath the
   * inspector: the view had moved, but the card was still invisible.
   */
  const safeArea = React.useMemo(() => {
    const right = onTagsChange && selected.size > 0 ? SAFE_RIGHT_INSPECTOR : SAFE_RIGHT
    return {
      left: SAFE_LEFT,
      top: SAFE_TOP,
      width: Math.max(1, boardSize.width - SAFE_LEFT - right),
      height: Math.max(1, boardSize.height - SAFE_TOP - SAFE_BOTTOM),
    }
  }, [boardSize.height, boardSize.width, onTagsChange, selected.size])

  const fit = React.useCallback(() => {
    // Drafts are board content too: framing only the files leaves a draft dragged far away out of
    // sight, and a draft has no minimap entry of its own otherwise.
    const rects = [
      ...Object.values(displayRects),
      ...drafts.map((draft) => ({ x: draft.x, y: draft.y, w: draft.w, h: draft.h })),
    ]
    if (!rects.length) {
      setViewport({ x: 0, y: 0, scale: 1 })
      return
    }
    const left = Math.min(...rects.map((rect) => rect.x))
    const top = Math.min(...rects.map((rect) => rect.y))
    const right = Math.max(...rects.map((rect) => rect.x + rect.w))
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.h))
    const width = Math.max(1, right - left)
    const height = Math.max(1, bottom - top)
    const scale = clamp(
      Math.min(safeArea.width / width, safeArea.height / height, FIT_MAX_SCALE),
      MIN_SCALE,
      MAX_SCALE,
    )
    setViewport({
      scale,
      x: safeArea.left + safeArea.width / 2 - (left + width / 2) * scale,
      y: safeArea.top + safeArea.height / 2 - (top + height / 2) * scale,
    })
  }, [displayRects, drafts, safeArea])

  // The first framed view is the board as a whole; later pan/zoom is the person's. A board kept
  // mounted behind the grid measures 0×0, so the first fit waits until it is actually on screen.
  React.useEffect(() => {
    if (!active || !boardMeasured || didFit.current) return
    if (!Object.keys(positions).length && drafts.length === 0) return
    didFit.current = true
    fit()
  }, [active, boardMeasured, drafts.length, fit, positions])

  // A resize keeps whatever was in the middle in the middle: growing the panel should reveal more
  // board, not slide every card toward the top-left.
  const previousBoardSizeRef = React.useRef<{ width: number; height: number } | null>(null)
  React.useEffect(() => {
    if (!boardMeasured) return
    const previous = previousBoardSizeRef.current
    previousBoardSizeRef.current = boardSize
    if (!previous || previous.width === 0 || previous.height === 0) return
    const dx = (boardSize.width - previous.width) / 2
    const dy = (boardSize.height - previous.height) / 2
    if (dx === 0 && dy === 0) return
    setViewport((current) => ({ ...current, x: current.x + dx, y: current.y + dy }))
  }, [boardMeasured, boardSize])

  /** Put the last moved/resized card or draft back where it was. */
  const undoLayout = React.useCallback(() => {
    const entry = undoRef.current.pop()
    if (!entry) return
    if (entry.kind === 'asset') {
      setPositions((current) => ({ ...current, [entry.path]: entry.before }))
      void onLayoutChange(entry.path, entry.before)
    } else if (entry.kind === 'assets') {
      setPositions((current) => ({ ...current, ...entry.before }))
      for (const [path, rect] of Object.entries(entry.before)) void onLayoutChange(path, rect)
    } else if (entry.kind === 'drafts') {
      for (const [id, point] of Object.entries(entry.before)) onUpdateDraft(id, point)
    } else if (entry.kind === 'draftPicks') {
      onUpdateDraft(entry.id, entry.before)
    } else if (entry.kind === 'draftsRemoved') {
      onRestoreDrafts?.(entry.drafts)
    } else {
      onUpdateDraft(entry.id, { x: entry.before.x, y: entry.before.y })
    }
  }, [onLayoutChange, onRestoreDrafts, onUpdateDraft])

  /**
   * Break one of a draft's lines.
   *
   * The picks are snapshotted first, so the same Cmd/Ctrl+Z that puts a card back also puts the
   * reference back.
   */
  const disconnectEdge = (draftId: string, assetPath: string) => {
    const draft = drafts.find((entry) => entry.id === draftId)
    if (!draft) return
    undoRef.current.push({
      kind: 'draftPicks',
      id: draftId,
      before: {
        references: draft.references,
        firstFrame: draft.firstFrame,
        lastFrame: draft.lastFrame,
        textSource: draft.textSource,
      },
    })
    if (undoRef.current.length > 50) undoRef.current.shift()
    onDisconnectDraftAsset?.(draftId, assetPath)
  }

  /**
   * Resting on a wire for a moment reveals its disconnect button.
   *
   * Cutting the line on a plain click was too eager — a wire crosses the canvas and a stray click
   * removed a reference. Waiting for the pointer makes the action deliberate, and a click on the
   * line (for touch, which has no hover) only reveals the button.
   */
  const armEdgeHint = (key: string) => {
    if (edgeHideTimerRef.current !== null) {
      window.clearTimeout(edgeHideTimerRef.current)
      edgeHideTimerRef.current = null
    }
    if (edgeHintTimerRef.current !== null) window.clearTimeout(edgeHintTimerRef.current)
    edgeHintTimerRef.current = window.setTimeout(() => {
      edgeHintTimerRef.current = null
      setEdgeHint(key)
    }, 400)
  }

  const disarmEdgeHint = () => {
    if (edgeHintTimerRef.current !== null) {
      window.clearTimeout(edgeHintTimerRef.current)
      edgeHintTimerRef.current = null
    }
  }

  /** Keep the button while the pointer crosses the gap between the line and the button. */
  const leaveEdgeHint = () => {
    disarmEdgeHint()
    if (edgeHideTimerRef.current !== null) window.clearTimeout(edgeHideTimerRef.current)
    edgeHideTimerRef.current = window.setTimeout(() => {
      edgeHideTimerRef.current = null
      setEdgeHint(null)
    }, 260)
  }

  const keepEdgeHint = () => {
    if (edgeHideTimerRef.current !== null) {
      window.clearTimeout(edgeHideTimerRef.current)
      edgeHideTimerRef.current = null
    }
  }

  React.useEffect(
    () => () => {
      if (edgeHintTimerRef.current !== null) window.clearTimeout(edgeHintTimerRef.current)
      if (edgeHideTimerRef.current !== null) window.clearTimeout(edgeHideTimerRef.current)
    },
    [],
  )

  const closeMenu = React.useCallback(() => setMenu(null), [])

  /** Lift the given cards above the others. The z is persisted with their layout, like a drag. */
  const bringToFront = React.useCallback(
    (paths: readonly string[]) => {
      if (!paths.length) return
      const topZ = Object.values(positions).reduce((max, entry) => Math.max(max, entry.z), 0)
      const next: Record<string, Rect> = {}
      let z = topZ
      for (const path of paths) {
        const rect = positions[path]
        if (!rect) continue
        z += 1
        next[path] = { ...rect, z }
      }
      if (!Object.keys(next).length) return
      setPositions((current) => ({ ...current, ...next }))
      for (const [path, rect] of Object.entries(next)) void onLayoutChange(path, rect)
    },
    [onLayoutChange, positions],
  )

  /** Put cards back on the shelf: the files stay assets, their places on the board do not. */
  const resetPosition = React.useCallback(
    (paths: readonly string[]) => {
      const before: Record<string, Rect> = {}
      for (const path of paths) {
        const rect = positions[path]
        if (rect) before[path] = rect
      }
      if (!Object.keys(before).length) return
      undoRef.current.push({ kind: 'assets', before })
      if (undoRef.current.length > 50) undoRef.current.shift()
      setPositions((current) => {
        const next = { ...current }
        for (const path of Object.keys(before)) delete next[path]
        return next
      })
      for (const path of Object.keys(before)) void onLayoutChange(path, null)
    },
    [onLayoutChange, positions],
  )

  /**
   * Take cards off the board.
   *
   * Not a delete and not a reset: the file stays an asset, and the place is kept in the index with
   * `hidden`, so putting the card back returns it to where it was. Marking it hidden is what makes
   * the automatic shelf stop re-placing it — "no layout" alone means "never placed yet".
   */
  const hideFromBoard = React.useCallback(
    (paths: readonly string[]) => {
      const before: Record<string, Rect> = {}
      for (const path of paths) {
        const rect = positions[path]
        if (rect) before[path] = rect
      }
      if (!Object.keys(before).length) return
      undoRef.current.push({ kind: 'assets', before })
      if (undoRef.current.length > 50) undoRef.current.shift()
      setPositions((current) => {
        const next = { ...current }
        for (const path of Object.keys(before)) delete next[path]
        return next
      })
      // A card that is no longer drawn must not keep an inspector open for it.
      setSelected((current) => {
        const next = new Set(current)
        for (const path of Object.keys(before)) next.delete(path)
        return next
      })
      for (const [path, rect] of Object.entries(before)) {
        void onLayoutChange(path, { ...rect, hidden: true })
      }
    },
    [onLayoutChange, positions],
  )

  React.useEffect(() => {
    if (!menu) return
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-board-menu]')) return
      setMenu(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }
    const close = () => setMenu(null)
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  // A menu belongs to the board, not to the grid in front of it.
  React.useEffect(() => {
    if (!active) setMenu(null)
  }, [active])

  /** Move the selected card or draft by one step, so fine placement does not need a drag. */
  const nudgeSelection = React.useCallback(
    (dx: number, dy: number) => {
      const remember = () => {
        if (undoRef.current.length > 50) undoRef.current.shift()
      }
      const draftIds =
        selectedDraftIds.size > 0
          ? [...selectedDraftIds]
          : selectedDraftId
            ? [selectedDraftId]
            : []
      if (draftIds.length) {
        const before: Record<string, { x: number; y: number }> = {}
        for (const id of draftIds) {
          const draft = drafts.find((entry) => entry.id === id)
          if (!draft) continue
          before[id] = { x: draft.x, y: draft.y }
          onUpdateDraft(id, { x: draft.x + dx, y: draft.y + dy })
        }
        const ids = Object.keys(before)
        if (!ids.length) return
        undoRef.current.push(
          ids.length === 1
            ? { kind: 'draft', id: ids[0], before: before[ids[0]] }
            : { kind: 'drafts', before },
        )
        remember()
        return
      }
      if (selected.size === 0) return
      const paths = [...selected].filter((path) => positions[path])
      if (!paths.length) return
      const before: Record<string, Rect> = {}
      const next: Record<string, Rect> = {}
      for (const path of paths) {
        const rect = positions[path]
        if (!rect) continue
        before[path] = rect
        next[path] = { ...rect, x: rect.x + dx, y: rect.y + dy }
      }
      undoRef.current.push({ kind: 'assets', before })
      remember()
      setPositions((current) => ({ ...current, ...next }))
      for (const [path, rect] of Object.entries(next)) void onLayoutChange(path, rect)
    },
    [drafts, onLayoutChange, onUpdateDraft, positions, selected, selectedDraftId, selectedDraftIds],
  )

  React.useEffect(() => {
    if (!active) return
    const down = (event: KeyboardEvent) => {
      // The lightbox is a window of its own: its arrows and Escape are not the board's.
      if (previewPath) return
      const target = event.target as HTMLElement | null
      const typing = !!target?.closest('input, textarea, select, [contenteditable="true"]')
      // Find is the board's own: filtering is the grid's, jumping is the canvas's.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setSearchOpen(true)
        return
      }
      if (event.key === 'Escape' && searchOpen) {
        event.preventDefault()
        setSearchOpen(false)
        setSearchQuery('')
        return
      }
      // Undo a layout gesture. Inside a field Cmd/Ctrl+Z belongs to the text, not the board.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        if (typing) return
        event.preventDefault()
        undoLayout()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        if (typing) return
        event.preventDefault()
        setSelected(new Set(assets.map((asset) => asset.path)))
        setSelectedDraftIds(new Set(drafts.map((draft) => draft.id)))
        return
      }
      if (!typing && (event.key === 'Delete' || event.key === 'Backspace')) {
        const draftIds = new Set(selectedDraftIds)
        if (selectedDraftId) draftIds.add(selectedDraftId)
        if (selected.size === 0 && draftIds.size === 0) return
        event.preventDefault()
        // Cards come off the board (the files stay assets); one undo puts them back.
        if (selected.size > 0) hideFromBoard([...selected])
        // A draft is not a file and has no shelf: Delete takes the card away, which is the one
        // action that means the same thing here as it does in the composer.
        if (draftIds.size > 0 && onRemoveDraft) {
          // Keep the cards themselves, so Cmd/Ctrl+Z brings back their prompt, picks and frames —
          // a draft is not recoverable from any file once it is gone.
          const removed = drafts.filter((draft) => draftIds.has(draft.id))
          if (removed.length && onRestoreDrafts) {
            undoRef.current.push({ kind: 'draftsRemoved', drafts: removed })
            if (undoRef.current.length > 50) undoRef.current.shift()
          }
          for (const id of draftIds) onRemoveDraft(id)
          onSelectDraft(null)
          clearDraftSelection()
        }
        return
      }
      if (!typing && event.key.startsWith('Arrow')) {
        const step = event.shiftKey ? 10 : 1
        const delta =
          event.key === 'ArrowLeft'
            ? { dx: -step, dy: 0 }
            : event.key === 'ArrowRight'
              ? { dx: step, dy: 0 }
              : event.key === 'ArrowUp'
                ? { dx: 0, dy: -step }
                : event.key === 'ArrowDown'
                  ? { dx: 0, dy: step }
                  : null
        if (delta) {
          event.preventDefault()
          nudgeSelection(delta.dx, delta.dy)
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        onSelectDraft(null)
        clearSelection()
        clearDraftSelection()
        return
      }
      if (event.code !== 'Space' || event.repeat) return
      if (target?.closest('input, textarea, select, button, a, [contenteditable="true"]')) return
      event.preventDefault()
      setSpaceHeld(true)
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [active, assets, clearDraftSelection, clearSelection, drafts, hideFromBoard, nudgeSelection, onRemoveDraft, onRestoreDrafts, onSelectDraft, previewPath, resetPosition, searchOpen, selected, selectedDraftId, selectedDraftIds, undoLayout])

  const zoomAt = React.useCallback((factor: number, clientX?: number, clientY?: number) => {
    const board = boardRef.current
    if (!board) return
    const rect = board.getBoundingClientRect()
    const px = clientX === undefined ? rect.width / 2 : clientX - rect.left
    const py = clientY === undefined ? rect.height / 2 : clientY - rect.top
    setViewport((current) => {
      const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE)
      const worldX = (px - current.x) / current.scale
      const worldY = (py - current.y) / current.scale
      return { scale, x: px - worldX * scale, y: py - worldY * scale }
    })
  }, [])

  const resetZoom = React.useCallback(() => {
    const board = boardRef.current
    if (!board) return
    const rect = board.getBoundingClientRect()
    setViewport((current) => {
      const px = rect.width / 2
      const py = rect.height / 2
      const worldX = (px - current.x) / current.scale
      const worldY = (py - current.y) / current.scale
      return { scale: 1, x: px - worldX, y: py - worldY }
    })
  }, [])

  // Viewport keys, the ones a canvas is expected to answer: +, -, 0 (fit), 1 (100%).
  React.useEffect(() => {
    if (!active || previewPath) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        zoomAt(ZOOM_STEP)
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        zoomAt(1 / ZOOM_STEP)
      } else if (event.key === '0') {
        event.preventDefault()
        fit()
      } else if (event.key === '1') {
        event.preventDefault()
        resetZoom()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, fit, previewPath, resetZoom, zoomAt])

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    const button = event.button
    const wantsPan = tool === 'pan' || spaceHeld || button === 1
    if (!wantsPan || (button !== 0 && button !== 1)) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    panRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
      pointerId: event.pointerId,
    }
  }

  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!panRef.current) return
    panPointRef.current = { x: event.clientX, y: event.clientY }
    if (panFrameRef.current !== null) return
    panFrameRef.current = requestAnimationFrame(() => {
      panFrameRef.current = null
      const pan = panRef.current
      const point = panPointRef.current
      if (!pan || !point) return
      setViewport((current) => ({
        ...current,
        x: pan.originX + (point.x - pan.startX),
        y: pan.originY + (point.y - pan.startY),
      }))
    })
  }

  const endPan = () => {
    const pan = panRef.current
    const point = panPointRef.current
    panRef.current = null
    panPointRef.current = null
    if (panFrameRef.current !== null) {
      cancelAnimationFrame(panFrameRef.current)
      panFrameRef.current = null
    }
    // The last move may still be waiting for a frame; apply it so the view does not snap back.
    if (pan && point) {
      setViewport((current) => ({
        ...current,
        x: pan.originX + (point.x - pan.startX),
        y: pan.originY + (point.y - pan.startY),
      }))
    }
  }

  const startMarquee = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || tool !== 'select' || spaceHeld) return
    if (event.target !== event.currentTarget) return
    const board = boardRef.current
    if (!board) return
    const rect = board.getBoundingClientRect()
    const additive = event.metaKey || event.ctrlKey || event.shiftKey
    marqueeRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWorld: screenToWorld(event.clientX, event.clientY, viewport, rect),
      base: additive ? selected : new Set(),
      baseDrafts: additive ? selectedDraftIds : new Set(),
    }
    suppressBoardClickRef.current = false
    setMarquee({
      left: event.clientX - rect.left,
      top: event.clientY - rect.top,
      width: 0,
      height: 0,
    })
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  /** Paint the marquee and its selection from the newest pointer position. */
  const applyMarquee = () => {
    const current = marqueeRef.current
    const board = boardRef.current
    const point = marqueePointRef.current
    if (!current || !board || !point) return
    const rect = board.getBoundingClientRect()
    // Draw from the world anchor's current screen position: when the board pans under a held
    // pointer, the box must grow from where the selection began, not from a fixed screen pixel.
    const scale = viewportRef.current.scale
    const startClientX = rect.left + current.startWorld.x * scale + viewportRef.current.x
    const startClientY = rect.top + current.startWorld.y * scale + viewportRef.current.y
    const left = Math.min(startClientX, point.x) - rect.left
    const top = Math.min(startClientY, point.y) - rect.top
    const width = Math.abs(point.x - startClientX)
    const height = Math.abs(point.y - startClientY)
    setMarquee({ left, top, width, height })
    if (!suppressBoardClickRef.current) return
    // The frame in world coordinates, for a containing hit test.
    const end = screenToWorld(point.x, point.y, viewportRef.current, rect)
    const x1 = Math.min(current.startWorld.x, end.x)
    const y1 = Math.min(current.startWorld.y, end.y)
    const x2 = Math.max(current.startWorld.x, end.x)
    const y2 = Math.max(current.startWorld.y, end.y)
    const hits = new Set(current.base)
    for (const [path, box] of Object.entries(positionsRef.current)) {
      if (box.x < x2 && box.x + box.w > x1 && box.y < y2 && box.y + box.h > y1) hits.add(path)
    }
    setSelected(hits)
    // Drafts are refs to a draft, not board files: they keep the same selection rules.
    const draftHits = new Set(current.baseDrafts)
    for (const draft of drafts) {
      if (
        draft.x < x2 &&
        draft.x + draft.w > x1 &&
        draft.y < y2 &&
        draft.y + draft.h > y1
      ) {
        draftHits.add(draft.id)
      }
    }
    setSelectedDraftIds(draftHits)
  }

  const moveMarquee = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = marqueeRef.current
    if (!current) return
    const width = Math.abs(event.clientX - current.startClientX)
    const height = Math.abs(event.clientY - current.startClientY)
    if (width > 3 || height > 3) suppressBoardClickRef.current = true
    marqueePointRef.current = { x: event.clientX, y: event.clientY }
    // Reach the edge and the board starts moving, so a selection can extend past the window.
    marqueeAutoPanRef.current?.update(event.clientX, event.clientY)
    if (marqueeFrameRef.current !== null) return
    marqueeFrameRef.current = requestAnimationFrame(() => {
      marqueeFrameRef.current = null
      applyMarquee()
    })
  }

  const endMarquee = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!marqueeRef.current) return
    marqueeAutoPanRef.current?.stop()
    if (marqueeFrameRef.current !== null) {
      cancelAnimationFrame(marqueeFrameRef.current)
      marqueeFrameRef.current = null
    }
    // Apply the last position before the frame is dropped, then stop drawing the box.
    applyMarquee()
    marqueeRef.current = null
    marqueePointRef.current = null
    setMarquee(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    // Let the click that follows a real drag be swallowed; a plain click still clears the selection.
    if (suppressBoardClickRef.current) {
      setTimeout(() => {
        suppressBoardClickRef.current = false
      }, 0)
    }
  }

  const draftAnchorOf = (id: string): { x: number; y: number } | null => {
    const draft = drafts.find((entry) => entry.id === id)
    return draft ? { x: draft.x, y: draft.y + draft.h / 2 } : null
  }

  const assetAnchorOf = (path: string): { x: number; y: number } | null => {
    const box = positions[path]
    return box ? { x: box.x + box.w, y: box.y + box.h / 2 } : null
  }

  /** The card under the pointer that the link may land on, topmost first. */
  const linkTargetAt = (
    sourceKind: 'draft' | 'asset',
    point: { x: number; y: number },
  ): { target: string | null; blocked: string | null } => {
    let target: string | null = null
    let blocked: string | null = null
    let bestZ = -Infinity
    if (sourceKind === 'draft') {
      for (const [path, box] of Object.entries(positions)) {
        if (point.x < box.x || point.x > box.x + box.w || point.y < box.y || point.y > box.y + box.h) continue
        const asset = assets.find((entry) => entry.path === path)
        if (!asset || box.z < bestZ) continue
        if (asset.status === 'ready') {
          target = path
          blocked = null
        } else {
          target = null
          blocked = path
        }
        bestZ = box.z
      }
      return { target, blocked }
    }
    for (const draft of drafts) {
      if (point.x < draft.x || point.x > draft.x + draft.w || point.y < draft.y || point.y > draft.y + draft.h) continue
      if (draft.z >= bestZ) {
        bestZ = draft.z
        target = draft.id
      }
    }
    return { target, blocked: null }
  }

  const startConnection = (
    event: React.PointerEvent<HTMLDivElement>,
    source: { kind: 'draft'; id: string } | { kind: 'asset'; path: string },
  ) => {
    if (event.button !== 0 || tool !== 'select' || spaceHeld) return
    const board = boardRef.current
    if (!board) return
    const from = source.kind === 'draft' ? draftAnchorOf(source.id) : assetAnchorOf(source.path)
    if (!from) return
    const point = screenToWorld(event.clientX, event.clientY, viewport, board.getBoundingClientRect())
    connectRef.current = {
      source,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
      pointerId: event.pointerId,
    }
    setConnection({ sourceKind: source.kind, from, to: point, target: null, blocked: null })
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveConnection = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = connectRef.current
    const board = boardRef.current
    if (!current || !board) return
    if (
      Math.abs(event.clientX - current.startClientX) > 3 ||
      Math.abs(event.clientY - current.startClientY) > 3
    ) {
      current.moved = true
    }
    const point = screenToWorld(event.clientX, event.clientY, viewport, board.getBoundingClientRect())
    const hit = linkTargetAt(current.source.kind, point)
    setConnection((previous) =>
      previous ? { ...previous, to: point, target: hit.target, blocked: hit.blocked } : previous,
    )
  }

  const endConnection = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = connectRef.current
    if (!current) return
    connectRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setConnection(null)
    if (!current.moved || !onLinkDraftAsset) return
    const board = boardRef.current
    if (!board) return
    const point = screenToWorld(event.clientX, event.clientY, viewport, board.getBoundingClientRect())
    const hit = linkTargetAt(current.source.kind, point)
    if (!hit.target) {
      if (hit.blocked) onLinkBlocked?.(hit.blocked)
      return
    }
    if (current.source.kind === 'draft') onLinkDraftAsset(current.source.id, hit.target)
    else onLinkDraftAsset(hit.target, current.source.path)
  }

  /**
   * Pan the board when a held card reaches an edge.
   *
   * The card's delta is recomputed from its last pointer position against the new viewport, so the
   * card keeps following the cursor while the surface slides underneath it.
   */
  const stopAutoPan = () => {
    const state = autoPanRef.current
    state.vx = 0
    state.vy = 0
    if (state.frame !== null) {
      cancelAnimationFrame(state.frame)
      state.frame = null
    }
  }

  const stepAutoPan = () => {
    const state = autoPanRef.current
    if (state.vx === 0 && state.vy === 0) {
      state.frame = null
      return
    }
    const nextViewport = {
      ...viewportRef.current,
      x: viewportRef.current.x + state.vx,
      y: viewportRef.current.y + state.vy,
    }
    viewportRef.current = nextViewport
    setViewport(nextViewport)

    // A marquee grows with the board: the pointer stays put while the world slides under it.
    if (marqueeRef.current) applyMarquee()

    const assetDrag = dragRef.current
    if (assetDrag) {
      const point = screenToWorld(
        assetDrag.pointerX,
        assetDrag.pointerY,
        nextViewport,
        assetDrag.boardRect,
      )
      assetDrag.dx = point.x - assetDrag.startX
      assetDrag.dy = point.y - assetDrag.startY
      setDrag({ dx: assetDrag.dx, dy: assetDrag.dy, paths: assetDrag.paths })
    }
    const draftDrag = draftDragRef.current
    if (draftDrag) {
      const point = screenToWorld(
        draftDrag.pointerX,
        draftDrag.pointerY,
        nextViewport,
        draftDrag.boardRect,
      )
      const dx = point.x - draftDrag.startX
      const dy = point.y - draftDrag.startY
      for (const [id, origin] of Object.entries(draftDrag.before)) {
        onUpdateDraft(id, { x: origin.x + dx, y: origin.y + dy })
      }
    }
    state.frame = requestAnimationFrame(stepAutoPan)
  }

  /** Aim the auto-pan from the pointer; `0/0` stops the loop. */
  const updateAutoPan = (clientX: number, clientY: number) => {
    const board = boardRef.current
    if (!board) return
    const rect = board.getBoundingClientRect()
    const edge = 56
    const speed = 10
    // Left/top edges push the content inward, which reveals what is beyond them.
    const vx = clientX < rect.left + edge ? speed : clientX > rect.right - edge ? -speed : 0
    const vy = clientY < rect.top + edge ? speed : clientY > rect.bottom - edge ? -speed : 0
    const state = autoPanRef.current
    state.vx = vx
    state.vy = vy
    if ((vx !== 0 || vy !== 0) && state.frame === null) {
      state.frame = requestAnimationFrame(stepAutoPan)
    } else if (vx === 0 && vy === 0 && state.frame !== null) {
      cancelAnimationFrame(state.frame)
      state.frame = null
    }
  }

  React.useEffect(() => () => stopAutoPan(), [])

  // The marquee handlers are declared before the pan loop; they reach it through this ref.
  React.useEffect(() => {
    marqueeAutoPanRef.current = { update: updateAutoPan, stop: stopAutoPan }
  })

  const startDrag = (event: React.PointerEvent<HTMLDivElement>, asset: LibraryAsset) => {
    if (event.button !== 0 || tool !== 'select' || spaceHeld) return
    const target = event.target as HTMLElement
    if (target.closest('[data-no-drag]')) return
    const rect = positions[asset.path]
    const board = boardRef.current
    if (!rect || !board) return

    // A modifier click is a selection gesture, not the start of a drag.
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      toggleSelected(asset.path)
      onSelectDraft(null)
      event.stopPropagation()
      return
    }

    const paths = selected.has(asset.path) ? [...selected] : [asset.path]
    if (!selected.has(asset.path)) selectOnly(asset.path)
    // A pointer on a card is not an edit of a draft: the composer closes with its selection.
    onSelectDraft(null)

    const boardRect = board.getBoundingClientRect()
    const point = screenToWorld(event.clientX, event.clientY, viewport, boardRect)
    // A gesture on a card takes it (and everything selected with it) to the top: overlapping
    // cards must not stay unreachable.
    const topZ = Object.values(positions).reduce((max, entry) => Math.max(max, entry.z), 0)
    const rects: Record<string, Rect> = {}
    const before: Record<string, Rect> = {}
    let z = topZ
    for (const path of paths) {
      const origin = positions[path]
      if (!origin) continue
      before[path] = origin
      z += 1
      rects[path] = { ...origin, z: Math.max(origin.z, z) }
    }
    if (!Object.keys(rects).length) return
    dragRef.current = {
      paths: Object.keys(rects),
      rects,
      before,
      startX: point.x,
      startY: point.y,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerX: event.clientX,
      pointerY: event.clientY,
      dx: 0,
      dy: 0,
      moved: false,
      boardRect,
      pointerId: event.pointerId,
    }
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragRef.current
    if (!dragState) return
    dragState.pointerX = event.clientX
    dragState.pointerY = event.clientY
    updateAutoPan(event.clientX, event.clientY)
    const point = screenToWorld(event.clientX, event.clientY, viewport, dragState.boardRect)
    dragState.dx = point.x - dragState.startX
    dragState.dy = point.y - dragState.startY
    // Threshold in screen pixels: 2 world px is a third of a pixel at 15% zoom.
    if (
      Math.abs(event.clientX - dragState.clientX) > 3 ||
      Math.abs(event.clientY - dragState.clientY) > 3
    ) {
      dragState.moved = true
    }
    setDrag({ dx: dragState.dx, dy: dragState.dy, paths: dragState.paths })
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragRef.current
    if (!dragState) return
    stopAutoPan()
    dragRef.current = null
    setDrag(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!dragState.moved) return
    undoRef.current.push({ kind: 'assets', before: dragState.before })
    if (undoRef.current.length > 50) undoRef.current.shift()
    const next: Record<string, Rect> = {}
    for (const [path, rect] of Object.entries(dragState.rects)) {
      next[path] = { ...rect, x: rect.x + dragState.dx, y: rect.y + dragState.dy }
    }
    setPositions((current) => ({ ...current, ...next }))
    for (const [path, rect] of Object.entries(next)) void onLayoutChange(path, rect)
  }

  const startResize = (event: React.PointerEvent<HTMLDivElement>, asset: LibraryAsset) => {
    if (event.button !== 0 || tool !== 'select' || spaceHeld) return
    const rect = positions[asset.path]
    const board = boardRef.current
    if (!rect || !board) return
    const boardRect = board.getBoundingClientRect()
    const point = screenToWorld(event.clientX, event.clientY, viewport, boardRect)
    resizeRef.current = {
      path: asset.path,
      startX: point.x,
      startY: point.y,
      w: rect.w,
      h: rect.h,
      rect,
      moved: false,
      boardRect,
      pointerId: event.pointerId,
    }
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const resizeState = resizeRef.current
    if (!resizeState) return
    const point = screenToWorld(event.clientX, event.clientY, viewport, resizeState.boardRect)
    resizeState.w = Math.max(MIN_W, resizeState.rect.w + (point.x - resizeState.startX))
    resizeState.h = Math.max(MIN_H, resizeState.rect.h + (point.y - resizeState.startY))
    resizeState.moved = true
    setResize({ path: resizeState.path, w: resizeState.w, h: resizeState.h })
  }

  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const resizeState = resizeRef.current
    if (!resizeState) return
    resizeRef.current = null
    setResize(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!resizeState.moved) return
    undoRef.current.push({ kind: 'asset', path: resizeState.path, before: resizeState.rect })
    if (undoRef.current.length > 50) undoRef.current.shift()
    const next: Rect = {
      ...resizeState.rect,
      w: resizeState.w,
      h: resizeState.h,
    }
    setPositions((current) => ({ ...current, [resizeState.path]: next }))
    onLayoutChange(resizeState.path, { x: next.x, y: next.y, w: next.w, h: next.h, z: next.z })
  }

  const startDraftDrag = (event: React.PointerEvent<HTMLDivElement>, draft: Draft) => {
    if (event.button !== 0 || tool !== 'select' || spaceHeld) return
    const board = boardRef.current
    if (!board) return
    const boardRect = board.getBoundingClientRect()
    const point = screenToWorld(event.clientX, event.clientY, viewport, boardRect)
    // A draft is above the asset cards; the gesture still brings it above the other drafts.
    const topZ = drafts.reduce((max, entry) => Math.max(max, entry.z), 2000)
    const groupIds =
      selectedDraftIds.has(draft.id) && selectedDraftIds.size > 1
        ? [...selectedDraftIds].filter((id) => drafts.some((entry) => entry.id === id))
        : [draft.id]
    const before: Record<string, { x: number; y: number }> = {}
    groupIds.forEach((id, index) => {
      const entry = drafts.find((candidate) => candidate.id === id)
      if (!entry) return
      before[id] = { x: entry.x, y: entry.y }
      onUpdateDraft(id, { z: topZ + 1 + index })
    })
    if (!before[draft.id]) return
    suppressDraftClickRef.current = false
    draftDragRef.current = {
      before,
      startX: point.x,
      startY: point.y,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerX: event.clientX,
      pointerY: event.clientY,
      moved: false,
      boardRect,
      pointerId: event.pointerId,
    }
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveDraftDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = draftDragRef.current
    if (!dragState) return
    dragState.pointerX = event.clientX
    dragState.pointerY = event.clientY
    updateAutoPan(event.clientX, event.clientY)
    const point = screenToWorld(event.clientX, event.clientY, viewport, dragState.boardRect)
    const dx = point.x - dragState.startX
    const dy = point.y - dragState.startY
    if (
      Math.abs(event.clientX - dragState.clientX) > 3 ||
      Math.abs(event.clientY - dragState.clientY) > 3
    ) {
      dragState.moved = true
      suppressDraftClickRef.current = true
    }
    for (const [id, origin] of Object.entries(dragState.before)) {
      onUpdateDraft(id, { x: origin.x + dx, y: origin.y + dy })
    }
  }

  const endDraftDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = draftDragRef.current
    if (!dragState) return
    stopAutoPan()
    draftDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (dragState.moved) {
      const ids = Object.keys(dragState.before)
      undoRef.current.push(
        ids.length === 1
          ? { kind: 'draft', id: ids[0], before: dragState.before[ids[0]] }
          : { kind: 'drafts', before: dragState.before },
      )
      if (undoRef.current.length > 50) undoRef.current.shift()
      // The click that ends a drag is dispatched after this handler; clear the flag after it, so a
      // gesture that never produced a click cannot swallow the next real one.
      setTimeout(() => {
        suppressDraftClickRef.current = false
      }, 0)
    }
  }

  const previewAssets = React.useMemo(
    () => assets.filter((asset) => (asset.kind === 'image' || asset.kind === 'video') && asset.status === 'ready'),
    [assets],
  )
  const menuAsset = menu ? (assets.find((asset) => asset.path === menu.path) ?? null) : null
  /** Selecting one card inside a group and right-clicking acts on the whole group. */
  const menuTargets = menuAsset ? (selected.has(menuAsset.path) ? [...selected] : [menuAsset.path]) : []

  /** The one card the tag inspector speaks for; a group gets the batch form below. */
  const selectedAsset =
    selected.size === 1 ? (assets.find((asset) => selected.has(asset.path)) ?? null) : null
  const selectedAssets = React.useMemo(
    () => assets.filter((asset) => selected.has(asset.path)),
    [assets, selected],
  )
  /** The words every selected card already carries — the only ones a group can remove together. */
  const commonTags = React.useMemo(
    () =>
      selectedAssets.length > 1
        ? selectedAssets.reduce<string[]>(
            (shared, asset) => shared.filter((value) => asset.tags.includes(value)),
            selectedAssets[0]?.tags ?? [],
          )
        : [],
    [selectedAssets],
  )

  React.useEffect(() => {
    setTagDraft('')
  }, [selectedAsset?.path])

  // An asset deleted or renamed outside the app must not stay "selected" in a set nobody can see.
  React.useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current
      const alive = new Set(assets.map((asset) => asset.path))
      const next = new Set([...current].filter((path) => alive.has(path)))
      return next.size === current.size ? current : next
    })
  }, [assets])

  // A draft removed from the composer leaves no card for a selection to point at.
  React.useEffect(() => {
    setSelectedDraftIds((current) => {
      if (current.size === 0) return current
      const alive = new Set(drafts.map((draft) => draft.id))
      const next = new Set([...current].filter((id) => alive.has(id)))
      return next.size === current.size ? current : next
    })
  }, [drafts])

  const addTag = React.useCallback(() => {
    if (!selectedAsset || !onTagsChange) return
    const value = tagDraft.trim()
    if (!value || selectedAsset.tags.includes(value)) {
      setTagDraft('')
      return
    }
    setTagDraft('')
    void onTagsChange(selectedAsset.path, [...selectedAsset.tags, value])
  }, [onTagsChange, selectedAsset, tagDraft])

  const removeTag = React.useCallback(
    (tag: string) => {
      if (!selectedAsset || !onTagsChange) return
      void onTagsChange(
        selectedAsset.path,
        selectedAsset.tags.filter((value) => value !== tag),
      )
    },
    [onTagsChange, selectedAsset],
  )

  /** A tag written once and applied to every selected card. */
  const addTagToSelection = React.useCallback(() => {
    if (!onTagsChange || selectedAssets.length < 2) return
    const value = batchTagDraft.trim()
    if (!value) return
    setBatchTagDraft('')
    for (const asset of selectedAssets) {
      if (!asset.tags.includes(value)) void onTagsChange(asset.path, [...asset.tags, value])
    }
  }, [batchTagDraft, onTagsChange, selectedAssets])

  const removeTagFromSelection = React.useCallback(
    (tag: string) => {
      if (!onTagsChange) return
      for (const asset of selectedAssets) {
        if (asset.tags.includes(tag)) {
          void onTagsChange(asset.path, asset.tags.filter((value) => value !== tag))
        }
      }
    },
    [onTagsChange, selectedAssets],
  )
  const preview = previewPath ? previewAssets.find((asset) => asset.path === previewPath) ?? null : null
  const previewNodes = React.useMemo<CanvasNode[]>(
    () =>
      previewAssets.map((asset) => ({
        id: asset.path,
        type: asset.kind === 'image' ? 'image' : 'video',
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        z: 0,
        src: asset.path,
        title: asset.name,
      })),
    [previewAssets],
  )

  const draftRects = React.useMemo<Record<string, Rect>>(
    () =>
      Object.fromEntries(
        drafts.map((draft) => [draft.id, { x: draft.x, y: draft.y, w: draft.w, h: draft.h, z: draft.z }]),
      ),
    [drafts],
  )

  /**
   * What the search box found.
   *
   * The grid's filters are not the board's business — hiding cards would rearrange the canvas — but
   * "take me to that card" is: a query is a jump list. Every match is outlined and Enter walks
   * them, which is also why the board can search without filtering.
   */
  const searchMatches = React.useMemo(() => {
    const needle = searchQuery.trim().toLowerCase()
    if (!needle) return []
    const hits: Array<{ key: string; rect: Rect }> = []
    for (const asset of assets) {
      const rect = displayRects[asset.path]
      if (!rect) continue
      const hay = [
        asset.name,
        asset.path,
        asset.note,
        ...asset.tags,
        asset.source?.prompt ?? '',
      ]
        .join(' ')
        .toLowerCase()
      if (hay.includes(needle)) hits.push({ key: asset.path, rect })
    }
    for (const draft of drafts) {
      const rect = draftRects[draft.id]
      if (!rect) continue
      const hay = [draftTitleOf(draft, draft.kind), draft.prompt, ...draft.references]
        .join(' ')
        .toLowerCase()
      if (hay.includes(needle)) hits.push({ key: draft.id, rect })
    }
    return hits
  }, [assets, displayRects, draftRects, drafts, searchQuery])

  // A new query starts before the first hit, so Enter means "go to the first one" rather than
  // skipping it for the second.
  React.useEffect(() => {
    setMatchCursor(-1)
  }, [searchQuery])

  const activeMatch =
    searchMatches.length === 0
      ? null
      : searchMatches[matchCursor < 0 ? 0 : Math.min(matchCursor, searchMatches.length - 1)]

  /**
   * Bring one card into the middle of the free area.
   *
   * `minScale` is for jumps: landing at the 15% overview is technically "centred" and practically
   * unreadable, so a jump first resolves into something a person can see.
   */
  const centerOnRect = React.useCallback(
    (rect: Rect, minScale = 0) => {
      setViewport((current) => {
        const scale = Math.min(MAX_SCALE, Math.max(current.scale, minScale))
        return {
          scale,
          x: safeArea.left + safeArea.width / 2 - (rect.x + rect.w / 2) * scale,
          y: safeArea.top + safeArea.height / 2 - (rect.y + rect.h / 2) * scale,
        }
      })
    },
    [safeArea],
  )

  // Latest values for the effects below, which must not re-run on every pan or layout write.
  React.useEffect(() => {
    positionsRef.current = positions
  }, [positions])
  React.useEffect(() => {
    viewportRef.current = viewport
  }, [viewport])
  React.useEffect(() => {
    boardSizeRef.current = boardSize
  }, [boardSize])

  /**
   * Report the canvas selection upward.
   *
   * The grid and the board are two views of one library, so checking a card in either place should
   * be the same fact. The first run is skipped: mounting the board must not clear what the grid had
   * checked before the switch.
   */
  const reportedSelectionRef = React.useRef(false)
  React.useEffect(() => {
    if (!reportedSelectionRef.current) {
      reportedSelectionRef.current = true
      return
    }
    onSelectionChange?.([...selected])
  }, [onSelectionChange, selected])

  /**
   * A card that just appeared and is out of sight gets a look.
   *
   * Uploads and finished generations land on the shelf, which can be far from where the person is
   * working. Jumping only when the card is actually outside the viewport keeps a visible result
   * from yanking the canvas away.
   */
  const seenPathsRef = React.useRef<ReadonlySet<string> | null>(null)
  React.useEffect(() => {
    if (!active) return
    const current = new Set(
      assets.filter((asset) => !asset.layout?.hidden).map((asset) => asset.path),
    )
    const previous = seenPathsRef.current
    if (!previous) {
      seenPathsRef.current = current
      return
    }
    const added = [...current].filter((path) => !previous.has(path))
    if (!added.length) {
      // Keep the set current: a deleted path must not make a future file with that name look old.
      seenPathsRef.current = current
      return
    }
    // A file is listed before its layout is computed; wait one turn rather than losing the jump.
    const ready = added.filter((path) => positionsRef.current[path])
    if (!ready.length) return
    seenPathsRef.current = current
    // A watcher can report a finished generation mid-gesture; moving the canvas then would snatch
    // the card out from under the pointer.
    if (dragRef.current || resizeRef.current || panRef.current || draftDragRef.current) return
    const view = viewportRef.current
    const size = boardSizeRef.current
    const left = -view.x / view.scale
    const top = -view.y / view.scale
    const right = left + size.width / view.scale
    const bottom = top + size.height / view.scale
    const outside = ready
      .map((path) => positionsRef.current[path])
      .filter(
        (rect) =>
          rect.x + rect.w < left || rect.x > right || rect.y + rect.h < top || rect.y > bottom,
      )
    if (!outside.length) return
    // Several files can land together (a multi-file upload); frame the group, not just the first.
    const boxLeft = Math.min(...outside.map((rect) => rect.x))
    const boxTop = Math.min(...outside.map((rect) => rect.y))
    const boxRight = Math.max(...outside.map((rect) => rect.x + rect.w))
    const boxBottom = Math.max(...outside.map((rect) => rect.y + rect.h))
    centerOnRect(
      { x: boxLeft, y: boxTop, w: boxRight - boxLeft, h: boxBottom - boxTop, z: 0 },
      JUMP_MIN_SCALE,
    )
  }, [active, assets, centerOnRect, positions])

  /** The grid asking the canvas to show the cards (and drafts) it has checked. */
  const focusNonceRef = React.useRef<number | null>(null)
  React.useEffect(() => {
    if (!focusSelection) return
    const assetPaths = focusSelection.paths ?? []
    const draftIds = focusSelection.draftIds ?? []
    if (!assetPaths.length && !draftIds.length) return
    if (focusNonceRef.current === focusSelection.nonce) return
    const assetRects = assetPaths
      .map((path) => positionsRef.current[path])
      .filter((rect): rect is Rect => !!rect)
    const pickedDraftRects = draftIds
      .map((id) => draftRects[id])
      .filter((rect): rect is Rect => !!rect)
    const rects = [...assetRects, ...pickedDraftRects]
    // Positions arrive on the first layout pass; leave the request pending until they do.
    if (!rects.length) return
    focusNonceRef.current = focusSelection.nonce
    setSelected(new Set(assetPaths.filter((path) => positionsRef.current[path])))
    setSelectedDraftIds(new Set(draftIds.filter((id) => draftRects[id])))
    const left = Math.min(...rects.map((rect) => rect.x))
    const top = Math.min(...rects.map((rect) => rect.y))
    const right = Math.max(...rects.map((rect) => rect.x + rect.w))
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.h))
    centerOnRect({ x: left, y: top, w: right - left, h: bottom - top, z: 0 }, JUMP_MIN_SCALE)
  }, [centerOnRect, draftRects, focusSelection, positions])

  const stepMatch = React.useCallback(
    (delta: number) => {
      if (!searchMatches.length) return
      const next =
        matchCursor < 0
          ? delta > 0
            ? 0
            : searchMatches.length - 1
          : (matchCursor + delta + searchMatches.length) % searchMatches.length
      setMatchCursor(next)
      centerOnRect(searchMatches[next].rect, JUMP_MIN_SCALE)
    },
    [centerOnRect, matchCursor, searchMatches],
  )

  // Opening the box puts the caret in it: Cmd/Ctrl+F then typing is one gesture.
  React.useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  // Provenance is read off `.gen.json`, never drawn by hand: a line exists because the note says
  // the target was built from the source. Drafts draw the same lines from their current picks, so
  // the order a person is about to send is visible before the run.
  const boardEdges = React.useMemo(() => {
    const edges: Array<{ from: string; to: string; key: string; label: string }> = []
    const seen = new Set<string>()
    const add = (from: string, to: string, label: string) => {
      const key = `${from}->${to}`
      if (seen.has(key)) return
      seen.add(key)
      edges.push({ from, to, key, label })
    }
    // A text node feeding a card is a port: lyrics on a music card, context on a picture or clip.
    // It is not one of the numbered media references.
    const labelOf = (from: string, to: string, index: number) => {
      const source = libraryAssets.find((asset) => asset.path === from)
      if (source?.kind !== 'text') return String(index + 1)
      return libraryAssets.find((asset) => asset.path === to)?.kind === 'audio' ? 'T' : 'C'
    }
    for (const asset of libraryAssets) {
      const record = asset.source
      if (!record) continue
      // Frames are roles, so they win over the same file appearing in the numbered list.
      if (record.firstFrame) add(record.firstFrame, asset.path, 'F')
      if (record.lastFrame) add(record.lastFrame, asset.path, 'L')
      record.references.forEach((from, index) => add(from, asset.path, labelOf(from, asset.path, index)))
    }
    for (const draft of drafts) {
      if (draft.firstFrame) add(draft.firstFrame, draft.id, 'F')
      if (draft.lastFrame) add(draft.lastFrame, draft.id, 'L')
      // The fixed port takes plain text only: a subtitle is not a source the target can read, so
      // the board must not draw a line the run would then ignore.
      if (draft.textSource) {
        const source = libraryAssets.find((asset) => asset.path === draft.textSource)
        if (source?.kind === 'text' && !isSubtitleFile(source.path)) {
          add(draft.textSource, draft.id, draft.kind === 'audio' ? 'T' : 'C')
        }
      }
      draft.references
        .filter((path) => path !== draft.firstFrame && path !== draft.lastFrame)
        // A media card's numbered references are media bytes; a text file there is not sent at all,
        // so it must not look like an edge either. A text card keeps its text references.
        .filter((path) => {
          const source = libraryAssets.find((asset) => asset.path === path)
          return !(draft.kind !== 'text' && source?.kind === 'text')
        })
        .forEach((from, index) => add(from, draft.id, labelOf(from, draft.id, index)))
    }
    return edges
  }, [drafts, libraryAssets])

  const minimapDoc = React.useMemo<CanvasDoc>(
    () => ({
      version: 3,
      revision: 0,
      name: '',
      viewport: { ...viewport },
      nodes: [
        ...assets.flatMap((asset) => {
          const rect = displayRects[asset.path]
          if (!rect) return []
          return [
            {
              id: asset.path,
              type: nodeTypeOf(asset.kind),
              x: rect.x,
              y: rect.y,
              w: rect.w,
              h: rect.h,
              z: rect.z,
              src: asset.path,
              title: asset.name,
            },
          ]
        }),
        // Drafts are content of the board, not annotations: a draft dragged out of view must be
        // findable on the map exactly like a file.
        ...drafts.map((draft) => ({
          id: draft.id,
          type: nodeTypeOf(draft.kind),
          x: draft.x,
          y: draft.y,
          w: draft.w,
          h: draft.h,
          z: draft.z,
          title: draftTitleOf(draft, draft.kind),
        })),
      ],
      edges: [],
    }),
    [assets, displayRects, drafts, viewport],
  )

  /** Full-window viewing is a button, so double-click means the same thing in grid and board. */
  const openPreview = (asset: LibraryAsset) => {
    if ((asset.kind === 'image' || asset.kind === 'video') && asset.status === 'ready') {
      setPreviewPath(asset.path)
    }
  }

  if (!assets.length && !drafts.length) {
    if (allAssets?.length) {
      return (
        <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border/70 text-sm text-muted-foreground">
          {t('library.noMatch')}
        </div>
      )
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/70 text-sm text-muted-foreground">
        <Upload className="h-6 w-6 opacity-40" />
        <span>{t('canvas.emptyBoardHint')}</span>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-[8px] bg-background px-3 py-1.5 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.03]">
          <Upload className="h-3.5 w-3.5" />
          {t('library.upload')}
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              if (files.length) onUpload(files)
            }}
          />
        </label>
        <div className="flex items-center gap-1.5">
          <ToolButton title={t('canvas.addImage')} onClick={() => createDraftAtCenter('image')}>
            <ImageIcon className="h-4 w-4" />
          </ToolButton>
          <ToolButton title={t('canvas.addVideo')} onClick={() => createDraftAtCenter('video')}>
            <VideoIcon className="h-4 w-4" />
          </ToolButton>
          <ToolButton title={t('canvas.addAudio')} onClick={() => createDraftAtCenter('audio')}>
            <Music2 className="h-4 w-4" />
          </ToolButton>
          <ToolButton title={t('canvas.addText')} onClick={() => createDraftAtCenter('text')}>
            <FileText className="h-4 w-4" />
          </ToolButton>
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border border-border/60 bg-foreground/[0.02]">
      <div
        ref={boardRef}
        className={cn(
          'absolute inset-0 overflow-hidden',
          tool === 'pan' || spaceHeld ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        )}
        style={{
          backgroundImage:
            'radial-gradient(circle, oklch(from var(--foreground) l c h / 0.10) 1px, transparent 1px)',
          backgroundSize: `${24 * viewport.scale}px ${24 * viewport.scale}px`,
          backgroundPosition: `${viewport.x}px ${viewport.y}px`,
        }}
        onPointerDown={(event) => {
          startPan(event)
          startMarquee(event)
        }}
        onPointerMove={(event) => {
          movePan(event)
          moveMarquee(event)
        }}
        onPointerUp={(event) => {
          endPan()
          endMarquee(event)
        }}
        onPointerCancel={(event) => {
          endPan()
          endMarquee(event)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDropping(false)
          const files = Array.from(event.dataTransfer.files)
          if (files.length) onUpload(files)
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return
          if (suppressBoardClickRef.current) {
            suppressBoardClickRef.current = false
            return
          }
          clearSelection()
          clearDraftSelection()
          onSelectDraft(null)
        }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}
        >
          <svg
            className="pointer-events-none absolute left-0 top-0 overflow-visible"
            width={1}
            height={1}
            aria-hidden="true"
          >
            {boardEdges.map((edge) => {
              const from = displayRects[edge.from] ?? draftRects[edge.from]
              const to = displayRects[edge.to] ?? draftRects[edge.to]
              if (!from || !to) return null
              const middle = wireMidpoint(from, to)
              // Only a draft's line is a choice the person can undo; provenance is read from disk.
              const draftEdge = drafts.some((draft) => draft.id === edge.to)
              // The badge is a screen-sized button, so its radius has to undo the board's zoom.
              const hintRadius = 10 / viewport.scale
              const hintArmed = draftEdge && edgeHint === edge.key
              return (
                <g key={edge.key}>
                  <path
                    d={wirePath(from, to)}
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                  {draftEdge && onDisconnectDraftAsset ? (
                    <path
                      d={wirePath(from, to)}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={16}
                      vectorEffect="non-scaling-stroke"
                      className="pointer-events-auto cursor-pointer"
                      onPointerEnter={() => armEdgeHint(edge.key)}
                      onPointerLeave={leaveEdgeHint}
                      // A plain click only reveals the button: cutting a reference on one click was
                      // too easy to do by accident.
                      onClick={(event) => {
                        event.stopPropagation()
                        keepEdgeHint()
                        setEdgeHint(edge.key)
                      }}
                    >
                      <title>{t('library.disconnect')}</title>
                    </path>
                  ) : null}
                  {hintArmed ? (
                    <g
                      className="pointer-events-auto cursor-pointer"
                      onPointerEnter={keepEdgeHint}
                      onPointerLeave={leaveEdgeHint}
                      onClick={(event) => {
                        event.stopPropagation()
                        keepEdgeHint()
                        setEdgeHint(null)
                        disconnectEdge(edge.to, edge.from)
                      }}
                    >
                      <title>{t('library.disconnect')}</title>
                      <circle
                        cx={middle.x}
                        cy={middle.y}
                        r={hintRadius}
                        fill="var(--background)"
                        stroke="var(--primary)"
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                      />
                      <path
                        d={`M ${middle.x - hintRadius * 0.35} ${middle.y - hintRadius * 0.35} L ${middle.x + hintRadius * 0.35} ${middle.y + hintRadius * 0.35} M ${middle.x + hintRadius * 0.35} ${middle.y - hintRadius * 0.35} L ${middle.x - hintRadius * 0.35} ${middle.y + hintRadius * 0.35}`}
                        stroke="var(--primary)"
                        strokeWidth={1.75}
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  ) : (
                    <>
                      <circle
                        cx={middle.x}
                        cy={middle.y}
                        r={8}
                        fill="var(--background)"
                        stroke="var(--border)"
                        vectorEffect="non-scaling-stroke"
                      />
                      <text
                        x={middle.x}
                        y={middle.y}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={9}
                        fill="var(--foreground)"
                      >
                        {edge.label}
                      </text>
                    </>
                  )}
                </g>
              )
            })}

            {connection ? (
              <g>
                <path
                  d={wirePath(
                    { x: connection.from.x, y: connection.from.y, w: 0, h: 0 },
                    { x: connection.to.x, y: connection.to.y, w: 0, h: 0 },
                  )}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                />
                <circle cx={connection.to.x} cy={connection.to.y} r={4} fill="var(--primary)" />
              </g>
            ) : null}
          </svg>

          {assets.map((asset) => {
            const live = displayRects[asset.path]
            if (!live) return null
            return (
              <AssetCard
                key={asset.path}
                asset={asset}
                rect={live}
                selected={selected.has(asset.path)}
                active={drag?.paths.includes(asset.path) === true || resize?.path === asset.path}
                scale={viewport.scale}
                projectFolder={projectFolder}
                transcribing={transcribing ?? null}
                onTranscribe={onTranscribe}
                imageTools={imageTools}
                onRetryTask={retryTask}
                taskBusyPath={taskBusyPath}
                onPointerDown={(event) => startDrag(event, asset)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onResizeStart={(event) => startResize(event, asset)}
                onResizeMove={moveResize}
                onResizeUp={endResize}
                onDoubleClick={() => onOpen(asset)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  // Right-clicking inside a multi-selection keeps it; outside starts a new one.
                  if (!selected.has(asset.path)) selectOnly(asset.path)
                  onSelectDraft(null)
                  clearDraftSelection()
                  setMenu({ path: asset.path, x: event.clientX, y: event.clientY })
                }}
                connectTarget={connection?.sourceKind === 'draft' && connection.target === asset.path}
                connectBlocked={connection?.sourceKind === 'draft' && connection.blocked === asset.path}
                onConnectStart={(event) => startConnection(event, { kind: 'asset', path: asset.path })}
                onConnectMove={moveConnection}
                onConnectEnd={endConnection}
              />
            )
          })}

          {drafts.map((draft) => (
            <DraftCard
              key={draft.id}
              draft={draft}
              label={draftTitleOf(
                draft,
                draft.kind === 'image'
                  ? t('canvas.addImage')
                  : draft.kind === 'video'
                    ? t('canvas.addVideo')
                    : draft.kind === 'audio'
                      ? t('canvas.addAudio')
                      : t('canvas.addText'),
              )}
              selected={selectedDraftId === draft.id || selectedDraftIds.has(draft.id)}
              onPointerDown={(event) => startDraftDrag(event, draft)}
              onPointerMove={moveDraftDrag}
              onPointerUp={endDraftDrag}
              onClick={(event) => {
                // A click that ended a drag is not a request to open the editor.
                if (suppressDraftClickRef.current) {
                  suppressDraftClickRef.current = false
                  return
                }
                const additive = event.metaKey || event.ctrlKey || event.shiftKey
                onSelectDraft(draft.id)
                clearSelection()
                setSelectedDraftIds((current) => {
                  if (!additive) return new Set([draft.id])
                  const next = new Set(current)
                  if (next.has(draft.id)) next.delete(draft.id)
                  else next.add(draft.id)
                  return next
                })
              }}
              connectTarget={connection?.sourceKind === 'asset' && connection.target === draft.id}
              scale={viewport.scale}
              onConnectStart={(event) => startConnection(event, { kind: 'draft', id: draft.id })}
              onConnectMove={moveConnection}
              onConnectEnd={endConnection}
            />
          ))}

          {/* The search outlines sit above the cards: a hit near the top of a stack must still be
              visible, and an outline is not a place to click. */}
          {searchMatches.length > 0 ? (
            <svg
              className="pointer-events-none absolute left-0 top-0 overflow-visible"
              width={1}
              height={1}
              aria-hidden="true"
            >
              {searchMatches.map((match) => {
                const current = match.key === activeMatch?.key
                return (
                  <rect
                    key={`match:${match.key}`}
                    x={match.rect.x - 5}
                    y={match.rect.y - 5}
                    width={match.rect.w + 10}
                    height={match.rect.h + 10}
                    rx={14}
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth={current ? 2.5 : 1.5}
                    strokeDasharray={current ? undefined : '5 4'}
                    opacity={current ? 1 : 0.4}
                    vectorEffect="non-scaling-stroke"
                  />
                )
              })}
            </svg>
          ) : null}
        </div>

        {marquee ? (
          <div
            className="pointer-events-none absolute z-30 border border-primary/60 bg-primary/10"
            style={marquee}
          />
        ) : null}

        {dropping ? (
          <div className="pointer-events-none absolute inset-2 z-50 rounded-2xl border-2 border-dashed border-primary/50 bg-primary/5" />
        ) : null}
      </div>

      <div
        data-no-zoom
        className="pointer-events-auto absolute left-4 top-4 z-40 flex items-center gap-1 rounded-xl border border-border/60 bg-background/90 p-1 shadow-minimal backdrop-blur"
      >
        <ToolButton title={t('canvas.addImage')} onClick={() => createDraftAtCenter('image')}>
          <ImageIcon className="h-4 w-4" />
        </ToolButton>
        <ToolButton title={t('canvas.addVideo')} onClick={() => createDraftAtCenter('video')}>
          <VideoIcon className="h-4 w-4" />
        </ToolButton>
        <ToolButton title={t('canvas.addAudio')} onClick={() => createDraftAtCenter('audio')}>
          <Music2 className="h-4 w-4" />
        </ToolButton>
        <ToolButton title={t('canvas.addText')} onClick={() => createDraftAtCenter('text')}>
          <FileText className="h-4 w-4" />
        </ToolButton>
        <span className="mx-1 h-5 w-px bg-border/60" />
        {searchOpen ? (
          <>
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  stepMatch(event.shiftKey ? -1 : 1)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setSearchOpen(false)
                  setSearchQuery('')
                }
              }}
              placeholder={t('canvas.search')}
              aria-label={t('canvas.search')}
              className="h-8 w-48 rounded-md border border-border/60 bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/60"
            />
            {searchQuery.trim() ? (
              <span
                className={cn(
                  'min-w-[42px] text-center text-[11px] tabular-nums',
                  searchMatches.length === 0 ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {searchMatches.length === 0
                  ? t('canvas.searchEmpty')
                  : `${matchCursor < 0 ? 1 : Math.min(matchCursor + 1, searchMatches.length)}/${searchMatches.length}`}
              </span>
            ) : null}
            <ToolButton title={t('canvas.findPrev')} onClick={() => stepMatch(-1)}>
              <ChevronUp className="h-4 w-4" />
            </ToolButton>
            <ToolButton title={t('canvas.findNext')} onClick={() => stepMatch(1)}>
              <ChevronDown className="h-4 w-4" />
            </ToolButton>
            <ToolButton
              title={t('common.close')}
              onClick={() => {
                setSearchOpen(false)
                setSearchQuery('')
              }}
            >
              <X className="h-4 w-4" />
            </ToolButton>
          </>
        ) : (
          <ToolButton title={t('canvas.search')} onClick={() => setSearchOpen(true)}>
            <Search className="h-4 w-4" />
          </ToolButton>
        )}
      </div>
      {selected.size > 1 && onTagsChange ? (
        <div
          data-no-zoom
          className="pointer-events-auto absolute right-4 top-4 z-40 w-60 rounded-xl border border-border/60 bg-background/95 p-3 shadow-modal-small backdrop-blur"
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {t('library.selectedCount', { count: selected.size })}
            </span>
            <button
              type="button"
              onClick={clearSelection}
              title={t('common.close')}
              className="flex size-5 shrink-0 items-center justify-center rounded text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {commonTags.length === 0 ? (
              <span className="text-[11px] text-muted-foreground">{t('library.noCommonTags')}</span>
            ) : (
              commonTags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-foreground/80"
                >
                  <span className="truncate">{tag}</span>
                  <button
                    type="button"
                    onClick={() => removeTagFromSelection(tag)}
                    className="text-foreground/40 hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))
            )}
          </div>
          <div className="flex gap-1">
            <input
              value={batchTagDraft}
              onChange={(event) => setBatchTagDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                addTagToSelection()
              }}
              placeholder={t('library.addTag')}
              className="h-7 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 text-[11px] outline-none placeholder:text-muted-foreground/60"
            />
            <button
              type="button"
              onClick={addTagToSelection}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : selectedAsset && onTagsChange ? (
        <div
          data-no-zoom
          className="pointer-events-auto absolute right-4 top-4 z-40 w-60 rounded-xl border border-border/60 bg-background/95 p-3 shadow-modal-small backdrop-blur"
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-medium" title={selectedAsset.name}>
              {selectedAsset.name}
            </span>
            {(selectedAsset.kind === 'image' || selectedAsset.kind === 'video') &&
            selectedAsset.status === 'ready' ? (
              <button
                type="button"
                onClick={() => openPreview(selectedAsset)}
                title={t('canvas.preview')}
                className="flex size-5 shrink-0 items-center justify-center rounded text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <Maximize className="h-3 w-3" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={clearSelection}
              title={t('common.close')}
              className="flex size-5 shrink-0 items-center justify-center rounded text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {selectedAsset.tags.length === 0 ? (
              <span className="text-[11px] text-muted-foreground">{t('library.noTags')}</span>
            ) : (
              selectedAsset.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-foreground/80"
                >
                  <span className="truncate">{tag}</span>
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    className="text-foreground/40 hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))
            )}
          </div>
          <div className="flex gap-1">
            <input
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                addTag()
              }}
              placeholder={t('library.addTag')}
              className="h-7 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 text-[11px] outline-none placeholder:text-muted-foreground/60"
            />
            <button
              type="button"
              onClick={addTag}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          {onNoteChange ? (
            <div className="mt-2">
              <div className="mb-1 text-[11px] font-medium text-foreground/60">{t('library.note')}</div>
              <input
                defaultValue={selectedAsset.note}
                key={`${selectedAsset.path}:${selectedAsset.note}`}
                placeholder={t('library.notePlaceholder')}
                className="h-7 w-full rounded-md border border-border/60 bg-background px-2 text-[11px] outline-none placeholder:text-muted-foreground/60"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                }}
                onBlur={(event) => {
                  if (event.target.value !== selectedAsset.note) {
                    void onNoteChange(selectedAsset.path, event.target.value)
                  }
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        data-no-zoom
        className="pointer-events-auto absolute bottom-4 left-4 flex items-center gap-1 rounded-xl border border-border/60 bg-background/90 p-1 shadow-minimal backdrop-blur"
      >
        <ToolButton active={tool === 'select'} title={t('canvas.toolSelect')} onClick={() => setTool('select')}>
          <MousePointer2 className="h-4 w-4" />
        </ToolButton>
        <ToolButton active={tool === 'pan'} title={t('canvas.toolHand')} onClick={() => setTool('pan')}>
          <Hand className="h-4 w-4" />
        </ToolButton>
        <span className="mx-1 h-5 w-px bg-border/60" />
        <ToolButton title={t('canvas.zoomOut')} onClick={() => zoomAt(1 / ZOOM_STEP)}>
          <Minus className="h-4 w-4" />
        </ToolButton>
        <span className="min-w-[42px] text-center text-xs tabular-nums text-muted-foreground">
          {Math.round(viewport.scale * 100)}%
        </span>
        <ToolButton title={t('canvas.zoomIn')} onClick={() => zoomAt(ZOOM_STEP)}>
          <Plus className="h-4 w-4" />
        </ToolButton>
        <ToolButton title={t('canvas.fit')} onClick={fit}>
          <Maximize className="h-4 w-4" />
        </ToolButton>
      </div>

      {Object.keys(positions).length > 0 || drafts.length > 0 ? (
        <div data-no-zoom className="pointer-events-auto absolute bottom-4 right-4">
          <CanvasMinimap
            doc={minimapDoc}
            viewport={viewport}
            board={boardSize}
            label={t('canvas.minimap')}
            onFit={fit}
            fitLabel={t('canvas.fit')}
            onNavigate={(x, y) =>
              setViewport((current) => ({
                ...current,
                x: safeArea.left + safeArea.width / 2 - x * current.scale,
                y: safeArea.top + safeArea.height / 2 - y * current.scale,
              }))
            }
          />
        </div>
      ) : null}


      {preview ? (
        <CanvasLightbox
          node={previewNodes.find((node) => node.id === preview.path)!}
          nodes={previewNodes}
          projectFolder={projectFolder}
          onChange={(id) => setPreviewPath(id)}
          onClose={() => setPreviewPath(null)}
          onShowInFolder={(node) => {
            if (node.src) void window.electronAPI.showInFolder(absolute(projectFolder, node.src))
          }}
        />
      ) : null}

      {menu && menuAsset
        ? createPortal(
            <div
              data-board-menu
              style={{
                position: 'fixed',
                left: Math.min(menu.x, window.innerWidth - 200),
                top: Math.min(menu.y, window.innerHeight - 190),
              }}
              className="z-[90] w-48 overflow-hidden rounded-lg border border-border/60 bg-popover p-1 shadow-modal-small"
            >
              <button
                type="button"
                onClick={() => {
                  onOpen(menuAsset)
                  closeMenu()
                }}
                className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs hover:bg-foreground/[0.06]"
              >
                {t('library.open')}
              </button>
              <button
                type="button"
                onClick={() => {
                  void window.electronAPI.showInFolder(absolute(projectFolder, menuAsset.path))
                  closeMenu()
                }}
                className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs hover:bg-foreground/[0.06]"
              >
                {t('canvas.showInFolder')}
              </button>
              <div className="my-1 border-t border-border/60" />
              <button
                type="button"
                onClick={() => {
                  bringToFront(menuTargets)
                  closeMenu()
                }}
                className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs hover:bg-foreground/[0.06]"
              >
                {t('library.bringToFront')}
              </button>
              <button
                type="button"
                onClick={() => {
                  resetPosition(menuTargets)
                  closeMenu()
                }}
                className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs hover:bg-foreground/[0.06]"
              >
                {t('library.resetPosition')}
              </button>
              <button
                type="button"
                onClick={() => {
                  hideFromBoard(menuTargets)
                  closeMenu()
                }}
                className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs hover:bg-foreground/[0.06]"
              >
                {t('library.hideFromBoard')}
              </button>
              {onDeleteAssets ? (
                <>
                  <div className="my-1 border-t border-border/60" />
                  <button
                    type="button"
                    onClick={() => {
                      onDeleteAssets(menuTargets)
                      closeMenu()
                    }}
                    className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-destructive hover:bg-destructive/[0.08]"
                  >
                    {menuTargets.length > 1
                      ? t('library.deleteFiles', { count: menuTargets.length })
                      : t('library.deleteFile')}
                  </button>
                </>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
