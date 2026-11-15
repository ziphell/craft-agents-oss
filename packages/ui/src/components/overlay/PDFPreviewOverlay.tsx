/**
 * PDFPreviewOverlay - In-app PDF preview using Mozilla's pdf.js via react-pdf.
 *
 * Renders PDFs using the react-pdf library, which wraps pdfjs-dist.
 * Supports multiple items with arrow navigation in the header.
 *
 * The PDF is loaded from a Uint8Array (via IPC) and rendered to canvas.
 * The pdf.js worker handles decoding and rendering in a background thread.
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Document, Page, pdfjs } from 'react-pdf'
import { FileText, PenLine } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { CopyButton } from './CopyButton'
import { ItemNavigator } from './ItemNavigator'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// Configure pdf.js worker using Vite's ?url import for cross-platform dev/prod compatibility
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker

interface PreviewItem {
  src: string
  label?: string
}

export interface PDFPreviewOverlayProps {
  isOpen: boolean
  onClose: () => void
  /** Absolute file path for the PDF (single item / backward compat) */
  filePath: string
  /** Multiple items for arrow navigation */
  items?: PreviewItem[]
  /** Initial active item index (defaults to 0) */
  initialIndex?: number
  /** Async loader that returns PDF data as Uint8Array */
  loadPdfData: (path: string) => Promise<Uint8Array>
  theme?: 'light' | 'dark'
  /** Draw in place (a panel column) instead of in a window of its own. */
  embedded?: boolean
  /** Draw the header or leave the chrome to the caller. Embedded only. */
  chrome?: boolean
  /**
   * Open the pdf in the editing surface, when this host has one.
   *
   * This window is a **reader** — it draws pages, and that is the common case: someone clicks a
   * `.pdf` to read it, and an 8 MB editor would be a poor answer to that. Filling a form, marking up
   * a clause, splitting or cropping pages is the rarer, deliberate act, so it gets a button here
   * rather than becoming the default. Absent (a host with no editor) the button is not drawn.
   *
   * "Edit" and not "annotate": the vendored editor applies its own changes with pdf-lib and asks
   * the host only for bytes and a save path, so what it can do is far wider than markup — form
   * fields, page extraction/crop/n-up and image export all write back. The tooltip names the two
   * things it cannot: in-place text surgery and permanent redaction (both were stubbed out of the
   * bundle that provides `savePdfToPath`).
   */
  onEdit?: (path: string) => void
}

export function PDFPreviewOverlay({
  isOpen,
  onClose,
  filePath,
  items,
  initialIndex = 0,
  loadPdfData,
  theme = 'light',
  embedded = false,
  chrome = true,
  onEdit,
}: PDFPreviewOverlayProps) {
  const { t } = useTranslation()

  // Normalize: items array or single filePath
  const resolvedItems = useMemo<PreviewItem[]>(() => {
    if (items && items.length > 0) return items
    return [{ src: filePath }]
  }, [items, filePath])

  const [activeIdx, setActiveIdx] = useState(initialIndex)
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null)
  const [numPages, setNumPages] = useState<number>(0)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const activeItem = resolvedItems[activeIdx]

  // Reset index when overlay opens
  useEffect(() => {
    if (isOpen) {
      setActiveIdx(initialIndex)
    }
  }, [isOpen, initialIndex])

  // Load PDF data when overlay opens or active item changes
  useEffect(() => {
    if (!isOpen || !activeItem?.src) return

    let cancelled = false
    setIsLoading(true)
    setError(null)
    setPdfData(null)
    setNumPages(0)

    loadPdfData(activeItem.src)
      .then((data) => {
        if (!cancelled) {
          setPdfData(data)
          setIsLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PDF')
          setIsLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [isOpen, activeItem?.src, loadPdfData])

  const onDocumentLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages)
  }, [])

  const onDocumentLoadError = useCallback((error: Error) => {
    setError(`Failed to load PDF: ${error.message}`)
  }, [])

  // Memoize file object to prevent unnecessary re-renders (react-pdf uses === equality)
  const fileObj = useMemo(() =>
    pdfData ? { data: pdfData } : null,
    [pdfData]
  )

  // Header actions: item navigation + copy button
  const headerActions = (
    <div className="flex items-center gap-2">
      <ItemNavigator items={resolvedItems} activeIndex={activeIdx} onSelect={setActiveIdx} size="md" />
      {/* Editing is deliberate, so it is offered and not imposed — see `onEdit`.

          An icon with no label beside it, like the copy and expand buttons next to it: the header
          of a reader is a row of controls, and one of them spelling out a word makes the row look
          broken. The words live where they can be as long as they need to be — the accessible name
          says what it is, the tooltip says what it does and does not do ("edit" alone would promise
          text surgery this editor does not have). */}
      {onEdit && (
        <button
          type="button"
          onClick={() => onEdit(activeItem?.src || filePath)}
          aria-label={t('preview.editPdf')}
          title={t('preview.editPdfHint')}
          /* The row's other buttons are `w-7 h-7` with a 16px icon (the header's copy is `p-1.5`
             around `w-4 h-4`); this one was `p-1` around `h-3.5 w-3.5` — 22px in a row of 28px
             boxes, and no centring, so it read as a smaller, lesser control than copy beside it.
             Same box, same icon size, same place in the row. */
          className="flex h-7 w-7 items-center justify-center rounded-[6px] bg-background text-muted-foreground shadow-minimal transition-colors hover:text-foreground"
        >
          <PenLine className="h-4 w-4" />
        </button>
      )}
      <CopyButton content={activeItem?.src || filePath} title={t('common.copyPath')} className="bg-background shadow-minimal" />
    </div>
  )

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      embedded={embedded}
      chrome={chrome}
      typeBadge={{
        icon: FileText,
        label: 'PDF',
        variant: 'orange',
      }}
      filePath={activeItem?.src || filePath}
      error={error ? { label: 'Load Failed', message: error } : undefined}
      headerActions={headerActions}
    >
      <div className="h-full flex flex-col items-center overflow-auto">
        {isLoading && (
          <div className="text-muted-foreground text-sm">{t('preview.loadingPdf')}</div>
        )}
        {fileObj && (
          <Document
            file={fileObj}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={<div className="text-muted-foreground text-sm">{t('common.rendering')}</div>}
          >
            {Array.from({ length: numPages }, (_, i) => (
              <Page
                key={i + 1}
                pageNumber={i + 1}
                renderTextLayer={true}
                renderAnnotationLayer={true}
                className="pdf-page"
              />
            ))}
          </Document>
        )}
      </div>
    </PreviewOverlay>
  )
}
