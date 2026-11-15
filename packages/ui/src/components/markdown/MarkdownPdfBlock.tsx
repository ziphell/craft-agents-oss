/**
 * MarkdownPdfBlock - Renders ```pdf-preview code blocks as inline PDF previews.
 *
 * Loads PDF(s) from file(s) (via `src` or `items` field) and renders the first page
 * using react-pdf. Supports multiple items with a tab bar for switching between them.
 *
 * Expected JSON shapes:
 * Single item:
 * {
 *   "src": "/absolute/path/to/file.pdf",
 *   "title": "Optional title"
 * }
 *
 * Multiple items:
 * {
 *   "title": "Quarterly Reports",
 *   "items": [
 *     { "src": "/path/to/q1.pdf", "label": "Q1 Report" },
 *     { "src": "/path/to/q2.pdf", "label": "Q2 Report" }
 *   ]
 * }
 *
 * Only one Document is mounted at a time. The content area uses a fixed height
 * container to prevent layout shift when switching between items.
 *
 * Inline: Shows first page in a fixed 400px container with bottom fade + expand button.
 * Fullscreen: Opens PDFPreviewOverlay with full page-by-page navigation.
 */

import * as React from 'react'
import { FileText, Maximize2 } from 'lucide-react'
import { Document, Page, pdfjs } from 'react-pdf'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { PDFPreviewOverlay } from '../overlay/PDFPreviewOverlay'
import { ItemNavigator } from '../overlay/ItemNavigator'
import { useInView } from '../../hooks/useInView'
import {
  getPdfBytes,
  pinPdfBytes,
  retainPdfBytes,
  subscribePdfBytes,
  touchPdfBytes,
  unpinPdfBytes,
} from '../../lib/pdf-bytes'

/**
 * How long a block has to stay on screen before its file is read.
 *
 * Someone skipping to the bottom of a long conversation drives every block on the way through the
 * observer's margin: without this, each one starts a round trip and a copy of its whole document,
 * and none of them is looked at. A block that leaves before the dwell is up is never read at all;
 * one a person stops on pays this once, and it reads “loading” in the meantime.
 */
const READ_AFTER_DWELL_MS = 120
import { OfficePreviewOverlay } from '../office/OfficePreviewOverlay'
import { usePlatform } from '../../context/PlatformContext'
import { useTranslation } from 'react-i18next'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// Configure pdf.js worker using Vite's ?url import for cross-platform dev/prod compatibility
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker

// ── Types ────────────────────────────────────────────────────────────────────

interface PreviewItem {
  src: string
  label?: string
}

interface PdfPreviewSpec {
  src?: string
  title?: string
  items?: PreviewItem[]
}

// ── Error boundary ───────────────────────────────────────────────────────────

class PdfBlockErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) {
    console.warn('[MarkdownPdfBlock] Render failed, falling back to CodeBlock:', error)
  }
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

// ── Main component ───────────────────────────────────────────────────────────

export interface MarkdownPdfBlockProps {
  code: string
  className?: string
  onCreateRegionAnnotation?: (region: { page?: number; x: number; y: number; w: number; h: number; unit: 'pixel' | 'percent' }) => void
}

export function MarkdownPdfBlock({ code, className, onCreateRegionAnnotation: _onCreateRegionAnnotation }: MarkdownPdfBlockProps) {
  const { t } = useTranslation()
  const { onReadFileBinary } = usePlatform()

  // Parse the JSON spec — supports single src or items array
  const spec = React.useMemo<PdfPreviewSpec | null>(() => {
    try {
      const raw = JSON.parse(code)
      if (raw.items && Array.isArray(raw.items) && raw.items.length > 0) {
        return raw as PdfPreviewSpec
      }
      if (raw.src && typeof raw.src === 'string') {
        return raw as PdfPreviewSpec
      }
      return null
    } catch {
      return null
    }
  }, [code])

  // Normalize to items array (backward compat)
  const items = React.useMemo<PreviewItem[]>(() => {
    if (!spec) return []
    if (spec.items && spec.items.length > 0) return spec.items
    if (spec.src) return [{ src: spec.src }]
    return []
  }, [spec])

  const [activeIndex, setActiveIndex] = React.useState(0)
  const [isFullscreen, setIsFullscreen] = React.useState(false)
  /** The editor, opened from the reader in the overlay. A deliberate step, never the small preview:
   *  the block draws page 1 and takes no edits (`renderAnnotationLayer={false}`). */
  const [editing, setEditing] = React.useState(false)

  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const activeItem = items[activeIndex]
  const src = activeItem?.src

  /**
   * The bytes come from a **shared, budgeted** cache rather than this component's state.
   *
   * A block cannot decide on its own how much memory is reasonable — the bound belongs to the view,
   * where any number of these blocks can be showing any number of files. So the cache keeps the
   * least recently used ones under `PDF_CACHE_BUDGET`, and a file it lets go is a file this block
   * must stop drawing: the subscription below is what turns an eviction into an unmounted
   * `<Document>` (and the copy react-pdf took with it).
   *
   * `useSyncExternalStore` is the shape that fits: an external store, read synchronously, with the
   * re-render driven by the store's own notification instead of by a copy in state.
   */
  const pdfBytes = React.useSyncExternalStore(
    React.useCallback((onChange: () => void) => (src ? subscribePdfBytes(src, onChange) : () => {}), [src]),
    React.useCallback(() => (src ? getPdfBytes(src) : undefined), [src]),
  )
  const activePdfData = pdfBytes

  /**
   * Read and parse only once the block is near the viewport.
   *
   * A history renders every turn, so a dozen `pdf-preview` blocks used to mean a dozen file reads
   * and a dozen pdf.js parses before anything was scrolled to — each one tens of milliseconds and
   * a canvas. Paired with the release effect below it is also what keeps the memory bounded: read
   * when it comes into view, drop when it leaves.
   */
  const [viewportRef, inView] = useInView<HTMLDivElement>()

  /**
   * While it is on screen this file is **pinned**: the cache may not take it back to make room.
   *
   * Not a courtesy — without it, an eviction can pick the file a person is reading, this block
   * re-reads it, and that eviction can take the other visible block's file. Two documents larger than
   * the budget would then chase each other for as long as the view stayed open.
   */
  React.useEffect(() => {
    if (!inView || !src) return
    pinPdfBytes(src)
    return () => unpinPdfBytes(src)
  }, [inView, src])

  // Load the active file once the block is near the viewport, and keep it warm while it is.
  React.useEffect(() => {
    if (!inView || !src) return
    const held = getPdfBytes(src)
    if (held) {
      touchPdfBytes(src)
      setError(null)
      return
    }
    if (!onReadFileBinary) return
    let cancelled = false
    setLoading(true)
    setError(null)
    // Reading is what a scroll that is only *passing through* must not pay for — see the constant.
    const timer = setTimeout(() => {
      onReadFileBinary(src)
        .then((data) => {
          // `retain` takes its own copy: react-pdf transfers the buffer it is handed, and the cache
          // must keep bytes that stay readable.
          if (!cancelled) retainPdfBytes(src, new Uint8Array(data))
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to read PDF file')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, READ_AFTER_DWELL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // `pdfBytes` is a dependency because an entry can disappear from under this block (it was not
    // pinned yet when the budget ran out); that is a reason to read again, not to go blank.
  }, [inView, src, onReadFileBinary, pdfBytes])

  /**
   * The `<Document>`'s own file object, kept across re-renders so react-pdf does not remount (and
   * re-parse) because a parent rendered again. `data` is a copy, because react-pdf transfers it.
   */
  const fileObjRef = React.useRef<{ src: string; obj: { data: Uint8Array } } | null>(null)
  const activeFileObj = React.useMemo(() => {
    if (!src || !pdfBytes) return undefined
    if (fileObjRef.current?.src === src && fileObjRef.current.obj.data.byteLength > 0) {
      return fileObjRef.current.obj
    }
    const obj = { data: new Uint8Array(pdfBytes) }
    fileObjRef.current = { src, obj }
    return obj
  }, [src, pdfBytes])



  // Fullscreen overlay: always a fresh copy (the overlay's Document transfers it), from the cache
  // when it is still there and from disk when it is not.
  const loadPdfData = React.useCallback(async (path: string) => {
    const held = getPdfBytes(path)
    if (held) return new Uint8Array(held)
    if (!onReadFileBinary) throw new Error('Cannot load PDF')
    return onReadFileBinary(path)
  }, [onReadFileBinary])

  const hasMultiple = items.length > 1

  // Invalid spec → fall back to code block
  if (!spec || items.length === 0) {
    return <CodeBlock code={code} language="json" mode="full" className={className} />
  }

  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

  return (
    <PdfBlockErrorBoundary fallback={fallback}>
      <div className={cn('relative group rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        {/* Header */}
        <div className="px-3 py-2 bg-muted/50 border-b flex items-center gap-2">
          <FileText className="w-3.5 h-3.5 text-muted-foreground/50" />
          <span className="text-[12px] text-muted-foreground font-medium flex-1">
            {spec.title || t('preview.pdfPreview')}
          </span>
          <div className="flex items-center gap-1">
            <ItemNavigator items={items} activeIndex={activeIndex} onSelect={setActiveIndex} />
            <button
              onClick={() => setIsFullscreen(true)}
              className={cn(
                "p-1 rounded-[6px] transition-all select-none",
                "bg-background shadow-minimal",
                "text-muted-foreground/50 hover:text-foreground",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100",
                hasMultiple ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
              title={t('common.viewFullscreen')}
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Content area: fixed height prevents layout shift on item switch (and on going out of
            view, which unmounts nothing but the parse) */}
        <div ref={viewportRef} className="relative h-[400px] overflow-hidden">
          {/* Active Document (only one mounted at a time) */}
          {activeFileObj && (
            <div className="flex items-start justify-center bg-white p-4">
              <Document
                file={activeFileObj}
                loading={<div className="py-8 text-center text-muted-foreground text-[13px]">{t('common.rendering')}</div>}
                error={<div className="py-6 text-center text-destructive/70 text-[13px]">{t('preview.failedToRenderPdf')}</div>}
              >
                <Page
                  pageNumber={1}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  width={500}
                />
              </Document>
            </div>
          )}

          {/* Loading state for uncached active item */}
          {!activePdfData && loading && (
            <div className="py-8 text-center text-muted-foreground text-[13px]">{t('common.loading')}</div>
          )}

          {/* Error state for uncached active item */}
          {!activePdfData && !loading && error && (
            <div className="py-6 text-center text-destructive/70 text-[13px]">{error}</div>
          )}

          {/* Bottom fade gradient */}
          {activePdfData && (
            <div
              className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none"
              style={{
                background: 'linear-gradient(to bottom, transparent, var(--muted))',
                zIndex: 'var(--z-local, 10)',
              }}
            />
          )}
        </div>
      </div>

      {/* Fullscreen overlay — passes items for multi-item navigation.

          The pen belongs to this overlay, not to the block above it: the small preview draws one
          page and takes no edits, so a click that changes the file always goes through a surface
          the person opened on purpose. */}
      {/* One window, two states (see the file window's pdf case): the editor replaces the pages
          instead of opening over them, and the header's arrow comes back. Closing closes the
          file — `editing` is reset on the way, so the next open starts at the pages again. */}
      {editing && activeItem ? (
        <OfficePreviewOverlay
          isOpen
          onClose={() => {
            setEditing(false)
            setIsFullscreen(false)
          }}
          filePath={activeItem.src}
          app="pdf"
          onBack={() => setEditing(false)}
        />
      ) : (
        <PDFPreviewOverlay
          isOpen={isFullscreen}
          onClose={() => {
            setEditing(false)
            setIsFullscreen(false)
          }}
          filePath={activeItem!.src}
          items={items}
          initialIndex={activeIndex}
          loadPdfData={loadPdfData}
          onEdit={() => setEditing(true)}
        />
      )}
    </PdfBlockErrorBoundary>
  )
}

