/**
 * MarkdownDocBlock - Renders ```markdown-preview code blocks as the file they name.
 *
 * Loads markdown from file(s) (via `src` or `items` field) and shows each one **as the document it
 * is** — drawn by the app's own markdown renderer, so a `.md` that quotes a diagram shows the
 * diagram. The block itself is a look at the document and nothing more: it never changes one. That
 * happens in the window, which opens on the file's source with the pencil and on the rendered
 * document with the four corners. Supports multiple items with a tab bar for switching between them.
 *
 * Expected JSON shapes:
 * Single item:
 * {
 *   "src": "/absolute/path/to/file.md",
 *   "title": "Optional title"
 * }
 *
 * Multiple items:
 * {
 *   "title": "Spec drafts",
 *   "items": [
 *     { "src": "/path/to/v1.md", "label": "v1" },
 *     { "src": "/path/to/v2.md", "label": "v2" }
 *   ]
 * }
 *
 * The block is chrome: the title, the tab bar, the fixed box it may not grow past, and the two
 * buttons in its corner. The pane behind it reads the file and follows it when an agent writes to
 * it — none of which is this block's to answer a second time.
 */

import * as React from 'react'
import { FileText, Maximize2, Pencil } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { ItemNavigator } from '../overlay/ItemNavigator'
import { MarkdownFileOverlay } from '../overlay/MarkdownFileOverlay'
import { useTranslation } from 'react-i18next'
import { usePlatform } from '../../context/PlatformContext'
import { MarkdownEditorPane } from './MarkdownEditorPane'
import {
  parseMarkdownPreviewSpec,
  normalizePreviewItems,
  type MarkdownPreviewItem,
} from './markdown-preview-helpers'

class MarkdownDocBlockErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) {
    console.warn('[MarkdownDocBlock] Render failed, falling back to CodeBlock:', error)
  }
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

export interface MarkdownDocBlockProps {
  code: string
  className?: string
  onUrlClick?: (url: string) => void
  onFileClick?: (path: string) => void
}

/** The corner buttons' chrome, which both of them share — they differ only in what they do. */
const CORNER_BUTTON = cn(
  'p-1 rounded-[6px] transition-all select-none',
  'bg-background shadow-minimal',
  'text-muted-foreground/50 hover:text-foreground',
  'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100',
)

export function MarkdownDocBlock({ code, className, onUrlClick, onFileClick }: MarkdownDocBlockProps) {
  const { t } = useTranslation()
  const { onWriteFile } = usePlatform()

  const spec = React.useMemo(() => parseMarkdownPreviewSpec(code), [code])
  const items = React.useMemo<MarkdownPreviewItem[]>(() => normalizePreviewItems(spec), [spec])

  const [activeIndex, setActiveIndex] = React.useState(0)
  /** Which way the window was opened, or that it is closed — one state, so it cannot disagree. */
  const [overlay, setOverlay] = React.useState<'closed' | 'view' | 'edit'>('closed')
  /**
   * Whether the window wrote anything while it was open, and a counter that re-reads when it did.
   *
   * The block and the window are **two readers of the same file**: the window saves to the disk, and
   * nothing here hears about it — the watcher only reports the prototypes tree, so a document
   * anywhere else would keep showing the version from before the edit. Rather than copy the text
   * across, the block reads the file again, which is the authority it was built on and also picks up
   * whatever else changed meanwhile.
   */
  const wroteRef = React.useRef(false)
  const [revision, setRevision] = React.useState(0)

  const closeOverlay = React.useCallback(() => {
    setOverlay('closed')
    // On closing, not on every save: the block is behind the window and cannot be seen, and a save
    // lands about a second after each pause in typing.
    if (!wroteRef.current) return
    wroteRef.current = false
    setRevision((count) => count + 1)
  }, [])

  const activeItem = items[activeIndex]

  React.useEffect(() => {
    if (!activeItem) {
      setActiveIndex(0)
      return
    }
    if (activeIndex > items.length - 1) {
      setActiveIndex(0)
    }
  }, [activeIndex, activeItem, items.length])

  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

  if (!spec || items.length === 0) {
    return fallback
  }

  const hasMultiple = items.length > 1
  const headerTitle = spec.title || t('preview.markdownPreview')
  /** Always in front when there is more than one document to step through up here. */
  const reveal = hasMultiple ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'

  return (
    <MarkdownDocBlockErrorBoundary fallback={fallback}>
      <div className={cn('relative group rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        <div className="px-3 py-2 bg-muted/50 border-b flex items-center gap-2">
          <FileText className="w-3.5 h-3.5 text-muted-foreground/50" />
          <span className="text-[12px] text-muted-foreground font-medium flex-1">{headerTitle}</span>
          <div className="flex items-center gap-1">
            <ItemNavigator items={items} activeIndex={activeIndex} onSelect={setActiveIndex} />

            {/* The pencil: the window opened to be *typed in* — the caret goes into the document,
                which is the only difference there can be, because this overlay has no read-only
                face to switch to. Offered only where a write could land: a host with nothing to
                save shows a document nothing can change. */}
            {onWriteFile && (
              <button
                type="button"
                onClick={() => setOverlay('edit')}
                className={cn(CORNER_BUTTON, reveal)}
                title={t('common.edit')}
                aria-label={t('common.edit')}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}

            {/* And the window, to read in: the same button in the same corner the diagram, page
                and mermaid blocks carry, opening the document the way a `.md` link does. */}
            <button
              type="button"
              onClick={() => setOverlay('view')}
              className={cn(CORNER_BUTTON, reveal)}
              title={t('common.viewFullscreen')}
              aria-label={t('common.viewFullscreen')}
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* The block is a fixed height and scrolls: it is a look at a document inside a message, and
            the window is where one is actually read. Keyed by path *and* by the re-reads, because a
            pane is bound to one file for its whole life: switching tabs is switching files, and a
            session in the window that wrote to this one gets it read again from the start. */}
        <div className="overflow-auto max-h-[400px]">
          {activeItem?.src && (
            <MarkdownEditorPane
              key={`${activeItem.src}:${revision}`}
              src={activeItem.src}
              layout="inline"
              className="px-3 py-2"
              onUrlClick={onUrlClick}
              onFileClick={onFileClick}
            />
          )}
        </div>
      </div>

      {/* A sibling of the block rather than a child, the way `MarkdownDrawioBlock` opens its own
          overlay: the block's overflow and hover styling then cannot clip or trap it. No title
          when the spec has none, so the overlay names the file itself. */}
      {activeItem?.src && (
        <MarkdownFileOverlay
          isOpen={overlay !== 'closed'}
          onClose={closeOverlay}
          filePath={activeItem.src}
          title={spec.title}
          initialMode={overlay === 'edit' ? 'edit' : 'view'}
          onSaved={() => {
            wroteRef.current = true
          }}
          onOpenUrl={onUrlClick}
          onOpenFile={onFileClick}
        />
      )}
    </MarkdownDocBlockErrorBoundary>
  )
}
