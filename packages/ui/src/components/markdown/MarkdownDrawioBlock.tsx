/**
 * MarkdownDrawioBlock - Renders the drawio diagram a ```drawio-preview block names.
 *
 * The block draws; it never *is* the editor. Drawing a diagram here is what a conversation is
 * for, and a ten-megabyte drawing application wedged into a message is not — so both ways to
 * look closer (the pencil and the full-screen button) open the same `DrawioOverlay`, and the
 * pencil opens it in edit mode rather than turning the block into a canvas.
 *
 * What is on screen always comes from the file: this reads it, follows it when an agent writes
 * to it mid-conversation, and takes the newest document back from the editor on its way out.
 *
 * Expected spec (the same shape the sibling preview blocks accept):
 *
 * {
 *   "src": "/absolute/path/to/flow.drawio",
 *   "title": "Checkout flow",
 *   "page": "v2 split payment"
 * }
 *
 * One file per block, and **the file's pages are the only axis it has**: they are shown along the top
 * and `page` chooses which one the block opens on. No `items` — the pages are the document's own, and
 * a spec does not need to say a second time what the file already says. `page` is a page's **name**,
 * because the name is what the document itself says; a number would point somewhere else the moment a
 * page is inserted.
 */

import * as React from 'react'
import { Maximize2, Pencil, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  describeDrawioPageProblem,
  drawioPages,
  findDrawioPage,
  parseDrawioSvgSize,
} from '@craft-agent/shared/drawio/types'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { usePlatform } from '../../context/PlatformContext'
import {
  DrawioOverlay,
  DrawioPages,
  DrawioViewerShell,
  useDrawioOrigin,
} from '../drawio'
import { InlineDiagram } from './InlineDiagram'
import { useProjectFilesWatch } from '../../hooks/useProjectFilesWatch'
import { parseMarkdownPreviewSpec } from './markdown-preview-helpers'

// ── Error boundary ───────────────────────────────────────────────────────────

class DrawioBlockErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch(error: Error) {
    console.warn('[MarkdownDrawioBlock] Render failed, falling back to CodeBlock:', error)
  }
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

// ── Main component ───────────────────────────────────────────────────────────

export interface MarkdownDrawioBlockProps {
  code: string
  className?: string
  /** Whether the picture reads the mouse itself — see `InlineDiagram`. Off in the editor's node
   *  views, where a click places the cursor. */
  interactive?: boolean
}

export function MarkdownDrawioBlock({ code, className, interactive = true }: MarkdownDrawioBlockProps) {
  const { t } = useTranslation()
  const { onReadFile, onWriteFile } = usePlatform()
  const { origin, problem: hostProblem } = useDrawioOrigin()

  const spec = React.useMemo(() => parseMarkdownPreviewSpec(code), [code])
  /** The one file this block draws. Without it there is nothing to draw, whatever else the spec says. */
  const src = spec?.src

  const [xml, setXml] = React.useState<string | null>(null)
  const [readProblem, setReadProblem] = React.useState<string | null>(null)
  /**
   * What the viewer said about the document, kept together with the document it said it about.
   *
   * A pair rather than a bare message, so a verdict cannot outlive its subject: once the
   * document changes — by a write from outside — the record no longer matches and the diagram
   * is drawn again, instead of the old failure being shown over a version that may have fixed it.
   */
  const [verdict, setVerdict] = React.useState<{ forXml: string; problem: string } | null>(null)
  /** Which way the overlay was opened, or that it is closed — one state, so it cannot disagree. */
  const [overlay, setOverlay] = React.useState<'closed' | 'view' | 'edit'>('closed')

  const drawProblem = xml !== null && verdict?.forXml === xml ? verdict.problem : null

  /**
   * The document's pages, as the row below the header. Empty for a document that is not an `<mxfile>`
   * of pages, which is also the whole answer for an exported `.svg`: the drawing is one page, and
   * there is no list.
   */
  const pages = React.useMemo(() => (xml !== null ? drawioPages(xml) : []), [xml])

  /**
   * The page the spec names, resolved to the id the viewer addresses — or why there is no such page.
   *
   * A name that matches nothing is *reported*, never drawn: the viewer's own answer to a page it
   * cannot find is to draw the first one and keep quiet, which would put a different diagram on
   * screen than the one the spec asked for. A spec that names no page resolves to nothing, and what
   * the viewer draws without a page is the first one.
   */
  const pageName = spec?.page
  const named = React.useMemo(
    () => (xml !== null && pageName ? findDrawioPage(xml, pageName) : null),
    [xml, pageName],
  )

  /**
   * Which page is showing, as one derivation: the one a person picked, else the one the spec names,
   * else the first.
   *
   * A pick is a page **id**, so it is still the same page after an edit shifts the others around —
   * and it is what outranks the spec: once someone has picked a page, the page the spec named is not
   * what the block is showing any more, so a miss in it stops being reported.
   */
  const [pickedPageId, setPickedPageId] = React.useState<string | null>(null)
  const pickedIndex = pickedPageId === null ? -1 : pages.findIndex((page) => page.id === pickedPageId)
  const namedIndex = named?.ok ? pages.findIndex((page) => page.id === named.page.id) : -1
  const activeIndex = pickedIndex !== -1 ? pickedIndex : namedIndex !== -1 ? namedIndex : 0
  const activePage = pages[activeIndex]
  const pageProblem =
    pickedPageId === null && pageName && named && !named.ok
      ? describeDrawioPageProblem(pageName, named)
      : null

  React.useEffect(() => {
    if (!src || !onReadFile) return
    let cancelled = false
    setXml(null)
    setReadProblem(null)
    setVerdict(null)
    onReadFile(src)
      .then((read) => {
        if (!cancelled) setXml(read)
      })
      .catch((error: unknown) => {
        if (!cancelled) setReadProblem(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [src, onReadFile])

  // The diagram follows the file: when an agent edits it while this conversation is open, the
  // picture changes rather than only the words about it. Most of these events are about
  // something else entirely — the watcher reports the whole tree — so the read is compared
  // before anything is re-rendered.
  const reread = React.useCallback(() => {
    if (!src || !onReadFile) return
    onReadFile(src)
      .then((read) => setXml((current) => (current === read ? current : read)))
      .catch(() => {
        // Unreadable right now keeps whatever is on screen: the first read reported it if it
        // was a problem, and a watcher event is not new information about it.
      })
  }, [src, onReadFile])

  useProjectFilesWatch(reread)

  // What the editor wrote, including the write it makes on its way out: the newest document
  // lives in the pane while it is open, and this is how the block behind it gets it.
  const handleSaved = React.useCallback((document: string) => setXml(document), [])

  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

  if (!spec || !src) return fallback

  // Read once per render: a theme flip while a diagram is open lands on the next render,
  // which is the trade that avoids paying for an observer here.
  const dark = document.documentElement.classList.contains('dark')
  // Two kinds of problem, and they are not the same: without the file or the origin there is
  // nothing to draw at all, while a document that will not draw is a problem with the document.
  const problem = hostProblem ?? readProblem ?? pageProblem ?? drawProblem
  // Editing happens elsewhere, so the pencil is offered only where a write could actually land —
  // the overlay's editor resolves its own platform callbacks, but a host without them would
  // show a canvas with nowhere to save, which is worse than not offering the pencil.
  const canEdit = Boolean(src && origin && onWriteFile)

  // The header says what the file is, and the row below says which page of it is showing — so with
  // pages to switch between, the file's own name is the useful thing here (and the page's name is not
  // said twice). With nothing to switch, the page's name is the more useful of the two. The file's name
  // beats the word "diagram", and none of it goes in the locale files.
  const pageTitle = pages.length > 1 ? undefined : activePage?.name || undefined
  const title = spec.title || pageTitle || src.split(/[\\/]/).pop() || 'Diagram'

  return (
    <DrawioBlockErrorBoundary fallback={fallback}>
      <div className={cn('relative group rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        {/* `relative z-10` because the zoom presets open downwards and the diagram below is a
            positioned box that would otherwise paint over them. */}
        <div className="relative z-10 px-3 py-2 bg-muted/50 border-b flex items-center gap-2">
          <Workflow className="w-3.5 h-3.5 text-muted-foreground/50" />
          <span className="text-[12px] text-muted-foreground font-medium flex-1 truncate">{title}</span>

          <div className="flex items-center gap-1">
            {/* No zoom controls here, as in the mermaid block: in a conversation the picture is
                shown by the rules in `InlineDiagram` — as big as it was drawn, in a box that
                scrolls — and zooming belongs to the window, which has the controls. The pages are not
                here either: they are their own row below, because names need the width. */}

            {/* Editing is not done here: the pencil opens the overlay on the editor, and the
                block stays a picture. Drawing in a message would put a 10 MB application in
                the conversation and take the diagram out of it at the same time. */}
            {canEdit && (
              <button
                type="button"
                onClick={() => setOverlay('edit')}
                title={t('common.edit')}
                aria-label={t('common.edit')}
                className={cn(
                  'p-1 rounded-[6px] transition-all select-none',
                  'bg-background shadow-minimal',
                  'text-muted-foreground/50 hover:text-foreground',
                  'opacity-0 group-hover:opacity-100 focus:opacity-100',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                )}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}

            {/* The same button `MarkdownHtmlBlock` puts in the same corner, with the same reveal:
                it is one of the things this corner offers, and the diagram below is the other. */}
            {origin && xml !== null && (
              <button
                type="button"
                onClick={() => setOverlay('view')}
                className={cn(
                  'p-1 rounded-[6px] transition-all select-none',
                  'bg-background shadow-minimal',
                  'text-muted-foreground/50 hover:text-foreground',
                  'opacity-0 group-hover:opacity-100 focus:opacity-100',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100',
                )}
                title={t('common.viewFullscreen')}
                aria-label={t('common.viewFullscreen')}
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* A row of its own rather than a corner of the header: a page's name is a label, and several
            of them need the width — the header's job is to say which file this is. */}
        <DrawioPages pages={pages} activeIndex={activeIndex} onSelect={(index) => setPickedPageId(pages[index]?.id ?? null)} />

        {problem ? (
          <div className="h-[400px] flex items-center justify-center px-6 text-center">
            <span className="text-destructive/70 text-[13px]">{problem}</span>
          </div>
        ) : origin && xml !== null ? (
          <DrawioViewerShell
            origin={origin}
            xml={xml}
            dark={dark}
            title={title}
            pageId={activePage?.id}
            /* The picture here is the one every diagram in a conversation is shown with: as big as
               it was drawn, in a box that scrolls, with a press that stayed put opening the window
               (a drag is not one — see `pan-gesture.ts`). The window is where it can be read at
               size, so the gesture a picture invites is the one that leads there. */
            onProblem={(problem) => {
              if (xml !== null) setVerdict({ forXml: xml, problem })
            }}
          >
            {(svg) => (
              <InlineDiagram
                svg={svg}
                // The size the viewer states on the markup it hands back — the drawing's bounds plus
                // its margin, and the only place the drawing's size is stated (`parseDrawioSvgSize`).
                size={parseDrawioSvgSize(svg)}
                onActivate={() => setOverlay('view')}
                interactive={interactive}
                activateLabel={t('common.viewFullscreen')}
              />
            )}
          </DrawioViewerShell>
        ) : (
          <div className="h-[400px] flex items-center justify-center text-muted-foreground text-[13px]">
            {t('common.loading')}
          </div>
        )}
      </div>

      {/* A sibling of the block rather than a child, the way `MarkdownHtmlBlock` opens its
          own overlay: the block's overflow and hover styling then cannot clip or trap it.
          One way in is the editor and one is the same drawing at window size, which is why
          the mode is part of the state that opened it. */}
      {src && (
        <DrawioOverlay
          isOpen={overlay !== 'closed'}
          onClose={() => setOverlay('closed')}
          filePath={src}
          initialMode={overlay === 'edit' ? 'edit' : 'view'}
          xml={xml}
          pageId={activePage?.id}
          /* The window's own row of pages: a page picked there is the page this block shows, so closing
             the window does not put a different page behind it than the one that was just on screen. */
          onSelectPage={setPickedPageId}
          title={title}
          onSaved={handleSaved}
        />
      )}
    </DrawioBlockErrorBoundary>
  )
}
