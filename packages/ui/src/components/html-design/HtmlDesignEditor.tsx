/**
 * The visual HTML editor, bound to one file on disk.
 *
 * Editing is not done in the message the preview belongs to: the block stays a
 * picture, and the pencil opens this in the overlay. That is the same split the
 * diagram editor uses, for the same reason — a page editor wedged into a message
 * would take the page out of the conversation.
 *
 * Three decisions are *not* made here: **when to write**, **whether the write will be
 * allowed** (never pre-checked — the host's refusal comes back as the refusal) and
 * **what to do when the file changed underneath** are `useFileWriter`, the same chain
 * the diagram editor and the markdown pane answer those three with, so the three cannot
 * drift. What is here is the page editor itself: the toolbar and the line beside it, the
 * selection and the history, and the source patches a frame's edits are applied as.
 *
 * The frame is cross-origin on purpose (see `design-document.ts`): it can draw the
 * selection and report what changed, and it cannot reach the app. So everything the
 * editor knows about the document arrives as a message, and every change is applied
 * to the *source* — the frame's DOM already looks right, while the file is what has
 * to stay right, and only the changed span is written.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bold,
  Italic,
  Minus,
  Plus,
  Redo2,
  Send,
  Strikethrough,
  Trash2,
  Underline,
  Undo2,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { usePlatform } from '../../context/PlatformContext'
import { useFileWriter } from '../editors/useFileWriter'
import { FileSaveStatus } from '../editors/FileSaveStatus'
import { HTML_EDIT_MESSAGE_KEY, buildDesignDoc, type RestoreScroll } from '../../lib/html-edit/design-document'
import {
  indexHtml,
  patchInnerText,
  patchStyleAttr,
  removeElementFromSource,
} from '../../lib/html-edit/source-edits'

/** How long the frame gets to say `ready` after loading before the probe is called dead. */
const PROBE_TIMEOUT_MS = 600
/** How long the frame gets to answer a scroll question before the rebuild goes on without it. */
const SCROLL_REPLY_TIMEOUT_MS = 300
/** Whole-source snapshots. Small strings, and a page editor without undo is not one. */
const MAX_HISTORY = 50

interface SelRect {
  x: number
  y: number
  w: number
  h: number
}

interface FmtState {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
}

interface FrameMessage {
  action?: string
  path?: string
  tag?: string
  text?: string
  attrStyle?: string
  rect?: SelRect
  style?: FmtState
  frac?: number
}

function newToken(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())
}

export interface HtmlDesignEditorProps {
  /** Absolute path of the HTML file being edited. */
  src: string
  /**
   * The pixel offset the preview was scrolled to.
   *
   * The caller measures it on the frame it was drawing, because that frame is same-origin and this
   * one deliberately is not. Pixels rather than a fraction because it is the *same page in the same
   * box*: the same offset is the same place, exactly — which is the point of opening the editor
   * without moving the document the person was reading. Read once, on mount.
   */
  initialScrollPx?: number
  /**
   * Every version that reached the disk, including the one this editor writes on its
   * way out. A caller that showed the page read-only needs the newest document, and
   * the editor is the only thing holding it.
   */
  onSaved?: (html: string) => void
}

export function HtmlDesignEditor({ src, initialScrollPx = 0, onSaved }: HtmlDesignEditorProps) {
  const { t } = useTranslation()
  const { onSendToChat } = usePlatform()
  /** The chain: the file, when it is written, and what a competing write means. */
  const { document, problem, report, saveState, conflict, keepMine, reloadFromDisk, flush, reloadToken } =
    useFileWriter(src, onSaved)

  const [token] = React.useState(newToken)
  const [status, setStatus] = React.useState<{ kind: 'error' | 'hint'; text: string } | null>(null)
  const [ready, setReady] = React.useState(false)
  /** The frame's document and the key that remounts it. Rebuilt only for undo/redo or an outside write. */
  const [frame, setFrame] = React.useState<{ html: string; key: number } | null>(null)

  const [selPath, setSelPath] = React.useState('')
  const [selTag, setSelTag] = React.useState('')
  /** Where the selected element is in the frame, which is where the controls go. */
  const [selRect, setSelRect] = React.useState<SelRect | null>(null)
  const [selStyle, setSelStyle] = React.useState<FmtState>({})
  /** Depths of the history stacks. They are refs, so their sizes are mirrored here to render. */
  const [history, setHistory] = React.useState({ undo: 0, redo: 0 })
  /** The bar's own size and the box it is placed in, both measured: it must fit inside the page. */
  const [placement, setPlacement] = React.useState({ barW: 0, barH: 0, boxW: 0 })

  const iframeRef = React.useRef<HTMLIFrameElement>(null)
  /** The page's box, and the controls that are placed inside it. */
  const boxRef = React.useRef<HTMLDivElement>(null)
  const barRef = React.useRef<HTMLDivElement>(null)

  /** The working copy: patched locally on every committed edit, so each patch re-parses the newest state. */
  const draftRef = React.useRef('')
  const statusTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const probeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameKeyRef = React.useRef(0)
  const readyRef = React.useRef(false)

  const undoRef = React.useRef<string[]>([])
  const redoRef = React.useRef<string[]>([])
  const pendingScrollRef = React.useRef<((frac: number) => void) | null>(null)
  /**
   * Held rather than read from the prop each build, and cleared after the first: the effect below
   * must not depend on this value, or a later change to it would re-read the file and throw away
   * whatever is being edited.
   */
  const initialScrollRef = React.useRef(initialScrollPx)

  const flash = React.useCallback((kind: 'error' | 'hint', text: string) => {
    setStatus({ kind, text })
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => setStatus(null), 3000)
  }, [])

  /**
   * The two sizes placing the controls needs: the bar's own, and the page's.
   *
   * Written only when they change, so measuring after every render cannot feed itself — and
   * measured at all because neither is knowable in CSS: the bar's width is what its buttons add up
   * to, and the page's is whatever the window gave it.
   */
  React.useLayoutEffect(() => {
    const barW = barRef.current?.offsetWidth ?? 0
    const barH = barRef.current?.offsetHeight ?? 0
    const boxW = boxRef.current?.offsetWidth ?? 0
    setPlacement((previous) =>
      previous.barW === barW && previous.barH === barH && previous.boxW === boxW
        ? previous
        : { barW, barH, boxW },
    )
  })

  const buildFrame = React.useCallback(
    (source: string, scroll: RestoreScroll = {}) => {
      frameKeyRef.current += 1
      readyRef.current = false
      setReady(false)
      setFrame({ html: buildDesignDoc(source, token, scroll), key: frameKeyRef.current })
    },
    [token],
  )

  const postToFrame = React.useCallback((action: string, extra?: Record<string, unknown>) => {
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { [HTML_EDIT_MESSAGE_KEY]: token, action, ...(extra ?? {}) },
        '*',
      )
    } catch {
      /* the frame is gone */
    }
  }, [token])

  /** The fraction of the document the frame is scrolled to, asked of the frame itself. */
  const captureScrollFrac = React.useCallback((): Promise<number> => {
    return new Promise((resolve) => {
      if (!readyRef.current) return resolve(0)
      pendingScrollRef.current = (frac) => resolve(frac)
      postToFrame('report-scroll')
      setTimeout(() => {
        if (pendingScrollRef.current) {
          pendingScrollRef.current = null
          resolve(0)
        }
      }, SCROLL_REPLY_TIMEOUT_MS)
    })
  }, [postToFrame])

  /**
   * The write loop lives in `useFileWriter` — `report` is the whole of what this editor has to say
   * to it. What stays on this side is the working copy (`draftRef`), which the chain knows nothing
   * about because a frame's edit arrives as a patch to the source rather than as a new document,
   * and the history that makes those patches undoable.
   */

  const refreshHistory = React.useCallback(() => {
    setHistory({ undo: undoRef.current.length, redo: redoRef.current.length })
  }, [])

  const pushUndo = React.useCallback(() => {
    const stack = undoRef.current
    undoRef.current = stack.length >= MAX_HISTORY ? stack.slice(1) : stack
    undoRef.current = [...undoRef.current, draftRef.current]
    redoRef.current = []
    refreshHistory()
  }, [refreshHistory])

  const clearSelectionState = React.useCallback(() => {
    setSelPath('')
    setSelTag('')
    setSelRect(null)
    setSelStyle({})
  }, [])

  const rebuildWithScroll = React.useCallback(
    async (source: string) => {
      const frac = await captureScrollFrac()
      draftRef.current = source
      buildFrame(source, { frac })
    },
    [buildFrame, captureScrollFrac],
  )

  const applySnapshot = React.useCallback(
    async (next: string) => {
      await rebuildWithScroll(next)
      report(next)
      clearSelectionState()
    },
    [clearSelectionState, rebuildWithScroll, report],
  )

  const doUndo = React.useCallback(() => {
    const prev = undoRef.current[undoRef.current.length - 1]
    if (prev === undefined) return
    undoRef.current = undoRef.current.slice(0, -1)
    redoRef.current = [...redoRef.current, draftRef.current]
    refreshHistory()
    void applySnapshot(prev)
  }, [applySnapshot, refreshHistory])

  const doRedo = React.useCallback(() => {
    const next = redoRef.current[redoRef.current.length - 1]
    if (next === undefined) return
    redoRef.current = redoRef.current.slice(0, -1)
    undoRef.current = [...undoRef.current, draftRef.current]
    refreshHistory()
    void applySnapshot(next)
  }, [applySnapshot, refreshHistory])

  /**
   * Record a source patch — the one place a new source becomes *the* source: the history, the
   * working copy, and the write that follows. It returns whether the patch applied, so a caller can
   * skip the rest of its own work when it could not be located.
   *
   * Nothing is applied optimistically on this side: the frame is ahead of the source by one edit,
   * and when the patch cannot be located the frame is the one that has to undo it.
   *
   * A patch that produced the source we are already holding **changed nothing**, and is not
   * recorded: applying the same style twice, or saving text nobody touched, would otherwise leave a
   * step on the undo stack that undoes nothing and ask the file to be written with what it already
   * has. Asking "is this different from what we hold" once, here, is what keeps the three patch
   * paths from answering it three different ways.
   */
  const commitPatch = React.useCallback(
    (patched: string | null, revertAction: string): boolean => {
      if (patched === null) {
        postToFrame(revertAction)
        flash('error', t('preview.htmlEditPatchFailed'))
        return false
      }
      if (patched === draftRef.current) return true
      pushUndo()
      draftRef.current = patched
      report(patched)
      return true
    },
    [flash, postToFrame, pushUndo, report, t],
  )

  const applyStyleFromReply = React.useCallback(
    (path: string, attrStyle: string, rect?: SelRect, style?: FmtState) => {
      const info = indexHtml(draftRef.current).get(path)
      const patched = info ? patchStyleAttr(draftRef.current, info, attrStyle) : null
      // Through `commitPatch`, so a style that is already what the source says is not a change.
      if (!commitPatch(patched, 'revert-style')) return
      if (rect) setSelRect(rect)
      if (style) setSelStyle(style)
    },
    [commitPatch],
  )

  // The frame talks; this is the only place that hears it. Registered once and reading
  // refs, so a long-lived listener cannot act on a stale draft or token.
  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const message = event.data as Record<string, unknown> | null
      if (!message || message[HTML_EDIT_MESSAGE_KEY] !== token) return
      const m = message as FrameMessage

      switch (m.action) {
        case 'ready':
          readyRef.current = true
          setReady(true)
          break
        case 'select':
          setSelPath(String(m.path ?? ''))
          setSelTag(String(m.tag ?? ''))
          if (m.rect) setSelRect(m.rect)
          if (m.style) setSelStyle(m.style)
          break
        case 'select-move':
          if (m.rect) setSelRect(m.rect)
          break
        case 'clear-select':
          clearSelectionState()
          break
        case 'not-editable':
          flash('hint', t('preview.htmlEditNotEditable'))
          break
        case 'text-committed': {
          const info = indexHtml(draftRef.current).get(String(m.path ?? ''))
          const patched = info ? patchInnerText(draftRef.current, info, String(m.text ?? '')) : null
          commitPatch(patched, 'revert-text')
          break
        }
        case 'style-applied':
          applyStyleFromReply(String(m.path ?? ''), String(m.attrStyle ?? ''), m.rect, m.style)
          break
        case 'style-reverted':
          if (m.rect) setSelRect(m.rect)
          if (m.style) setSelStyle(m.style)
          flash('error', t('preview.htmlEditPatchFailed'))
          break
        case 'element-removed': {
          const info = indexHtml(draftRef.current).get(String(m.path ?? ''))
          const patched = info ? removeElementFromSource(draftRef.current, info) : null
          if (!commitPatch(patched, 'restore-element')) break
          clearSelectionState()
          break
        }
        case 'scroll-report': {
          const resolve = pendingScrollRef.current
          pendingScrollRef.current = null
          if (resolve) {
            const frac = Number(m.frac)
            resolve(Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0)
          }
          break
        }
        case 'undo':
          doUndo()
          break
        case 'redo':
          doRedo()
          break
        // The key was pressed in the frame, where no window listener can hear it: the editor saves
        // now, exactly as ⌘S in the app's own document would (`useFileWriter`'s `flush`).
        case 'save':
          flush()
          break
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [
    applyStyleFromReply,
    clearSelectionState,
    commitPatch,
    doRedo,
    doUndo,
    flash,
    flush,
    t,
    token,
  ])

  /**
   * Every version the chain hands over is drawn into the frame, and becomes the working copy the
   * next patch is applied to. Reading the file — first, on a change from outside, or on a reload
   * after a conflict — is `useFileWriter`'s; what this editor does with the result is this effect.
   *
   * The reload token is part of the dependency for a reason the text alone cannot carry: reloading
   * from disk can hand back a version this editor has already been given, and the frame still has
   * to be rebuilt. The frame is *ahead* of the source by one edit — that is what applying a patch
   * means — so it cannot be brought up to date by passing it a new string.
   */
  React.useEffect(() => {
    if (document === null) return
    draftRef.current = document
    // Where to open, on the first draw only: it describes the preview this editor replaced, not
    // anything about the document. After that the frame is the only thing that knows where it is,
    // and a rebuild asks it rather than being told (`rebuildWithScroll`).
    buildFrame(document, { px: initialScrollRef.current })
    initialScrollRef.current = 0
  }, [document, reloadToken, buildFrame])

  // A different file is a different page: its history and its selection belong to the document that
  // was open, not to the one that just opened, and the old frame is not something to show meanwhile.
  React.useEffect(() => {
    undoRef.current = []
    redoRef.current = []
    refreshHistory()
    clearSelectionState()
    setFrame(null)
  }, [src, clearSelectionState, refreshHistory])

  React.useEffect(
    () => () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
      if (probeTimerRef.current) clearTimeout(probeTimerRef.current)
    },
    [],
  )

  const sendSelectionToChat = React.useCallback(() => {
    if (!onSendToChat || !selPath) return
    const info = indexHtml(draftRef.current).get(selPath)
    if (!info) return
    onSendToChat({ path: src, html: draftRef.current.slice(info.start, info.end) })
  }, [onSendToChat, selPath, src])

  const sendStyle = (op: string, value?: string) => {
    if (!selPath) return
    postToFrame('style', { op, value })
  }

  // Escape peels one layer: with something selected it clears that selection and stops
  // there, so the overlay is not closed by the keypress that was meant to deselect.
  // Undo/redo has to be answered here too, because focus can be on the app document.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!selPath) return
        event.preventDefault()
        event.stopImmediatePropagation()
        postToFrame('clear-select')
        return
      }
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      event.preventDefault()
      if ((key === 'y' && !event.shiftKey) || (key === 'z' && event.shiftKey)) doRedo()
      else doUndo()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [doRedo, doUndo, postToFrame, selPath])

  const handleFrameLoad = React.useCallback(() => {
    if (probeTimerRef.current) clearTimeout(probeTimerRef.current)
    // A document with its own CSP can forbid the probe. Failing silently would leave
    // a page that looks editable and is not, so a missing handshake is said out loud.
    probeTimerRef.current = setTimeout(() => {
      if (!readyRef.current) flash('error', t('preview.htmlEditProbeBlocked'))
    }, PROBE_TIMEOUT_MS)
  }, [flash, t])

  /**
   * What the page's own corner says: which element is selected, what a click would do with it, and
   * the two things said instead of a page — a notice from the editor, and the wait for one to load.
   *
   * The save is deliberately not in this list. It is news about the *file*, and a save is only a
   * word in the surface's top-right corner (`FileSaveStatus`) — while the corner here is for
   * readings of the content, which is also why a notice outranks the selection.
   */
  const statusLine =
    status
      ? status.text
      : !ready
        ? t('common.loading')
        : selPath
          ? selTag
          : t('preview.htmlEditHint')

  /**
   * Where to put the controls: just above the selected element's own box, inside the page.
   *
   * Above because that is where a tool palette belongs relative to what it acts on, and *below* the
   * box when there is no room above it (an element at the top of a page has none) — the two rules
   * open-webui settled on. The frame fills the same box the controls are drawn in, so the rect the
   * frame reports is already in this coordinate space, and the only arithmetic left is keeping the
   * bar inside the page's edges when the selection sits against one.
   */
  const barPosition = React.useMemo(() => {
    if (!selRect) return null
    const gap = 8
    const edge = 4
    // Before the first measurement the bar is not on screen yet; its own width would be 0 and the
    // clamp would be meaningless, so it is placed at the selection's left edge and corrected.
    const left = placement.boxW > 0
      ? Math.max(edge, Math.min(selRect.x, placement.boxW - placement.barW - edge))
      : selRect.x
    const above = selRect.y - placement.barH - gap
    return { left, top: above < edge ? selRect.y + selRect.h + gap : above }
  }, [selRect, placement])

  if (problem) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center px-6 text-center">
        <span className="text-destructive/70 text-[13px]">{problem}</span>
      </div>
    )
  }

  const hasSelection = Boolean(selPath)
  const canUndo = history.undo > 0
  const canRedo = history.redo > 0

  return (
    /* The page's box, and nothing else: the editor draws the same document in the same frame the
       preview drew, at the same size, so opening it moves nothing. The controls are inside this box
       rather than above it — they come and go with the selection, and a row that appeared would
       take a strip of the page with it every time somebody clicked an element. */
    <div ref={boxRef} className="relative flex-1 min-h-0 rounded-[12px] overflow-hidden bg-white shadow-minimal">
      {frame && (
        <iframe
          key={frame.key}
          ref={iframeRef}
          sandbox="allow-scripts allow-forms"
          srcDoc={frame.html}
          onLoad={handleFrameLoad}
          title={src}
          className="absolute inset-0 h-full w-full border-0"
        />
      )}

      {/* What is selected, and what a click does: the page's own bottom-left corner, which is where
          the element picker puts its chip and out of the way of the thing it names. Not interactive
          — a chip that swallowed a click aimed at the page would be worse than no chip. */}
      <div className="absolute bottom-2 left-2 max-w-[70%] flex items-center gap-2 px-2 py-0.5 rounded-[6px] text-[12px] bg-background/85 backdrop-blur-sm shadow-minimal text-muted-foreground pointer-events-none">
        <span className={cn('truncate', status?.kind === 'error' && 'text-destructive/80')}>{statusLine}</span>
      </div>

      {/* The file: a word at the top-right, and the decision in the middle if it changed on disk
          under edits of our own. */}
      <FileSaveStatus
        saveState={saveState}
        conflict={conflict !== null}
        onReloadFromDisk={reloadFromDisk}
        onKeepMine={keepMine}
      />

      {/* The controls, over the page, following what they act on. Positioned, not laid out: the
          page behind them is never resized by their appearing. */}
      {hasSelection && barPosition && (
        <div
          ref={barRef}
          style={{ left: barPosition.left, top: barPosition.top }}
          className="absolute z-10 flex items-center gap-1 px-1 py-0.5 rounded-[8px] border bg-background/90 backdrop-blur-sm shadow-minimal"
        >
          <FormatButton label={t('editor.bold')} active={selStyle.bold} onClick={() => sendStyle('bold')}>
            <Bold className="w-3.5 h-3.5" />
          </FormatButton>
          <FormatButton label={t('editor.italic')} active={selStyle.italic} onClick={() => sendStyle('italic')}>
            <Italic className="w-3.5 h-3.5" />
          </FormatButton>
          <FormatButton label={t('editor.underline')} active={selStyle.underline} onClick={() => sendStyle('underline')}>
            <Underline className="w-3.5 h-3.5" />
          </FormatButton>
          <FormatButton label={t('editor.strikethrough')} active={selStyle.strike} onClick={() => sendStyle('strike')}>
            <Strikethrough className="w-3.5 h-3.5" />
          </FormatButton>
          <FormatButton label={t('preview.htmlEditSmaller')} onClick={() => sendStyle('fontSize', '-')}>
            <Minus className="w-3.5 h-3.5" />
          </FormatButton>
          <FormatButton label={t('preview.htmlEditBigger')} onClick={() => sendStyle('fontSize', '+')}>
            <Plus className="w-3.5 h-3.5" />
          </FormatButton>

          <span className="mx-1 h-4 w-px bg-border" />

          <FormatButton label={t('menu.undo')} disabled={!canUndo} onClick={doUndo}>
            <Undo2 className="w-3.5 h-3.5" />
          </FormatButton>
          <FormatButton label={t('menu.redo')} disabled={!canRedo} onClick={doRedo}>
            <Redo2 className="w-3.5 h-3.5" />
          </FormatButton>

          <FormatButton
            label={t('preview.htmlEditSendToChat')}
            disabled={!onSendToChat}
            onClick={sendSelectionToChat}
          >
            <Send className="w-3.5 h-3.5" />
          </FormatButton>

          <span className="mx-1 h-4 w-px bg-border" />

          <FormatButton label={t('common.delete')} onClick={() => postToFrame('remove-selection')}>
            <Trash2 className="w-3.5 h-3.5" />
          </FormatButton>
        </div>
      )}
    </div>
  )
}

function FormatButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'p-1 rounded-[6px] transition-all select-none',
        'text-muted-foreground/60 hover:text-foreground',
        active && 'bg-background shadow-minimal text-foreground',
        'disabled:opacity-30 disabled:hover:text-muted-foreground/60',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      )}
    >
      {children}
    </button>
  )
}
