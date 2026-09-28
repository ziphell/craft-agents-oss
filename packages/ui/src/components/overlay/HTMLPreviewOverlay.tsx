/**
 * HTMLPreviewOverlay - Fullscreen overlay for viewing rendered HTML content.
 *
 * Uses PreviewOverlay as the base for consistent modal/fullscreen behavior.
 * Renders HTML in a sandboxed iframe (no script execution).
 *
 * **A document drawn, not a browsing context.** The frame is handed the text rather than an
 * address, so nothing that needs one works here — a relative reference, a script, a `fetch`.
 * `onOpenInBrowser` (the header button) is the way out: the same file, in a browser, as a tab at
 * an address of its own — the app's browser window or the person's, which their host decides.
 *
 * Links: `injectBaseTarget` hands a click to the top frame, where the app's navigation policy
 * answers. An absolute `http(s)` link therefore ends up in a browser; a relative one resolves
 * against the app's own address (this frame has none of its own), which is the known rough edge
 * of drawing HTML in a frame instead of giving it a window.
 *
 * Supports multiple items with arrow navigation in the header.
 *
 * **The page gets a viewport, not a canvas.** The frame is the size of the box it is
 * given and the page scrolls inside it, both ways, exactly as it would in a browser
 * window — which is also what the in-conversation block already draws (a fixed-height
 * frame), so the two agree. This used to be the other way round: the frame was sized to
 * the content's height so the whole page lay out and the overlay scrolled instead. That
 * cost the horizontal axis — nothing was left to scroll a page wider than the box, and
 * the measurement hid the page's own overflow — so a wide table or a fixed-width layout
 * was simply unreachable. It also made the page's height jump the moment you opened the
 * editor, because the editor needs a viewport it can put its toolbar above.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Eye, Globe, Pencil } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { CopyButton } from './CopyButton'
import { ItemNavigator } from './ItemNavigator'
import { HtmlDesignEditor } from '../html-design/HtmlDesignEditor'
import { usePlatform } from '../../context/PlatformContext'

/**
 * Inject `<base target="_top">` so link clicks navigate the top frame,
 * which Electron's will-navigate handler intercepts → system browser.
 */
function injectBaseTarget(html: string): string {
  if (/<base\s/i.test(html)) return html
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, '$1<base target="_top">')
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/(<html[^>]*>)/i, '$1<head><base target="_top"></head>')
  }
  return `<head><base target="_top"></head>${html}`
}

/**
 * The box, the colouring and the hover of every icon button in this header's row — one
 * constant, so the next button added here cannot drift from the ones beside it.
 */
const HEADER_BUTTON_CLASS =
  'p-1.5 rounded-[8px] transition-all select-none bg-background shadow-minimal ' +
  'text-muted-foreground hover:text-foreground'

interface PreviewItem {
  src: string
  label?: string
}

/**
 * The pixel offset the preview is scrolled to.
 *
 * Readable only because the preview's frame is same-origin; the editor's frame is opaque on
 * purpose, so the number is measured here and carried across rather than asked for on the other
 * side. An offset rather than a fraction: it is the same page in the same box, so the same number
 * is the same place — exactly, and without either side needing to know how tall the other is.
 */
function viewScrollOffset(iframe: HTMLIFrameElement | null): number {
  try {
    const win = iframe?.contentWindow
    if (!win) return 0
    const doc = win.document
    return Math.max(0, Math.round(win.scrollY || doc.documentElement.scrollTop || doc.body?.scrollTop || 0))
  } catch {
    return 0
  }
}

export interface HTMLPreviewOverlayProps {
  /** Whether the overlay is visible */
  isOpen: boolean
  /** Callback when the overlay should close */
  onClose: () => void
  /** Single HTML content (backward compat for link interceptor usage) */
  html?: string
  /** Multiple items for tabbed navigation */
  items?: PreviewItem[]
  /** Pre-loaded content cache (src → html string) */
  contentCache?: Record<string, string>
  /** Callback to load content for uncached items */
  onLoadContent?: (src: string) => Promise<string>
  /** Initial active item index (defaults to 0) */
  initialIndex?: number
  /** Optional title for the overlay header */
  title?: string
  /** Theme mode for dark/light styling */
  theme?: 'light' | 'dark'
  /**
   * Which surface to open on. `'edit'` is how the block's pencil asks for the editor
   * directly; it falls back to the preview when the file cannot be edited.
   */
  initialMode?: 'view' | 'edit'
  /** Called after an edit reached the disk, with the file's newest text. */
  onSaved?: (src: string, html: string) => void
  /**
   * Open this HTML in a browser, as a tab — the way out of a document that has no address of its
   * own.
   *
   * Called with the item **on screen** (`src`, which is the path a host with several items needs;
   * a host given a single document through `html` gets the `__single__` sentinel and should ignore
   * it, since it already knows which file it opened).
   *
   * Optional because not every document has a file to open — HTML drawn from an inline string has
   * none — and because *which* browser is not this component's question: the host that shows the
   * HTML decides, from the person's own setting, between the app's browser window and the browser
   * they use for everything else.
   */
  onOpenInBrowser?: (src: string) => void
}

export function HTMLPreviewOverlay({
  isOpen,
  onClose,
  html,
  items,
  contentCache: externalCache,
  onLoadContent,
  initialIndex = 0,
  title,
  theme,
  initialMode = 'view',
  onSaved,
  onOpenInBrowser,
}: HTMLPreviewOverlayProps) {
  // Normalize: single html prop → single item, or use items array
  const { t } = useTranslation()
  const resolvedItems = React.useMemo<PreviewItem[]>(() => {
    if (items && items.length > 0) return items
    if (html) return [{ src: '__single__' }]
    return []
  }, [items, html])

  const [activeIdx, setActiveIdx] = React.useState(initialIndex)
  const [mode, setMode] = React.useState<'view' | 'edit'>(initialMode)
  /** Where the preview was scrolled, captured as the editor opens — see `viewScrollOffset`. */
  const [editScroll, setEditScroll] = React.useState(0)
  const iframeRef = React.useRef<HTMLIFrameElement>(null)
  const { onWriteFile } = usePlatform()

  // Internal content cache (merges external + locally loaded)
  const [internalCache, setInternalCache] = React.useState<Record<string, string>>({})
  const [loadingItem, setLoadingItem] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  // Merge caches — external takes precedence, plus single html prop
  const mergedCache = React.useMemo(() => {
    const merged: Record<string, string> = { ...internalCache }
    if (externalCache) Object.assign(merged, externalCache)
    if (html) merged['__single__'] = html
    return merged
  }, [internalCache, externalCache, html])

  const activeItem = resolvedItems[activeIdx]
  const activeContent = activeItem ? mergedCache[activeItem.src] : undefined

  // Reset index when overlay opens
  React.useEffect(() => {
    if (isOpen) {
      setActiveIdx(initialIndex)
      setMode(initialMode)
    }
  }, [isOpen, initialIndex, initialMode])

  // Reset the error when active item changes
  React.useEffect(() => {
    setLoadError(null)
  }, [activeIdx])

  // Load content for active item if not cached
  React.useEffect(() => {
    if (!isOpen || !activeItem?.src) return
    if (mergedCache[activeItem.src]) return
    if (!onLoadContent) return

    setLoadingItem(true)
    setLoadError(null)
    onLoadContent(activeItem.src)
      .then((content) => {
        setInternalCache((prev) => ({ ...prev, [activeItem.src]: content }))
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load content')
      })
      .finally(() => setLoadingItem(false))
  }, [isOpen, activeItem?.src, mergedCache, onLoadContent])

  // Preprocess active HTML
  const processedHtml = React.useMemo(
    () => activeContent ? injectBaseTarget(activeContent) : null,
    [activeContent]
  )

  // Editing needs somewhere to write and a real file to write to — a page shown from
  // an inline string has neither, and so does a host with no write action.
  const src = activeItem?.src
  const canEdit = Boolean(src && src !== '__single__' && activeContent && onWriteFile)
  const editing = mode === 'edit' && canEdit

  // Header actions: item navigation + copy button, then the way out to a browser, then the
  // mode switch last.
  const headerActions = (
    <div className="flex items-center gap-2">
      <ItemNavigator items={resolvedItems} activeIndex={activeIdx} onSelect={setActiveIdx} size="md" />
      <CopyButton content={activeContent || ''} label="Copy HTML" className="bg-background shadow-minimal" />
      {/* Beside the copy button, because both act on the HTML rather than on this window — and
          this is the one that opens the same document in a browser: a tab, an address, its
          relative references and its scripts. Which browser, the host decided. */}
      {onOpenInBrowser && src && (
        <button
          type="button"
          onClick={() => onOpenInBrowser(src)}
          title={t('preview.openInBrowser')}
          aria-label={t('preview.openInBrowser')}
          className={HEADER_BUTTON_CLASS}
        >
          <ExternalLink className="w-4 h-4" />
        </button>
      )}
      {/* Last before the close button, after everything that acts on the page — and in the same
          place in both modes, which is what lets the switch be found without reading it. */}
      {canEdit && src && (
        <button
          type="button"
          onClick={() => {
            if (editing) {
              setMode('view')
              return
            }
            // Measured now, on the frame that is still mounted: once the editor is up, the place
            // the person had scrolled to is only knowable from inside a frame nothing can read.
            setEditScroll(viewScrollOffset(iframeRef.current))
            setMode('edit')
          }}
          title={editing ? t('preview.backToPreview') : t('common.edit')}
          aria-label={editing ? t('preview.backToPreview') : t('common.edit')}
          aria-pressed={editing}
          className={HEADER_BUTTON_CLASS}
        >
          {editing ? <Eye className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
        </button>
      )}
    </div>
  )

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: Globe,
        label: 'HTML',
        variant: 'blue',
      }}
      title={title || activeItem?.label || 'HTML Preview'}
      headerActions={headerActions}
    >
      {/* One box for both modes: the card fills what the overlay has, and the page inside
          it is what scrolls. The padding belongs here rather than to either mode, so
          switching between them cannot move the page by a pixel — and the vertical half of
          it is the base's (`CONTENT_GUTTER`), so this box agrees with the diagram and the
          document, which used to end 24–32px higher than it did. */}
      <div className="flex-1 min-h-0 flex flex-col px-4">
        {loadingItem && !activeContent && (
          <div className="py-12 text-center text-muted-foreground text-sm">{t('common.loading')}</div>
        )}
        {loadError && !activeContent && (
          <div className="py-12 text-center text-destructive/70 text-sm">{loadError}</div>
        )}
        {editing && src ? (
          /* Keyed by path: switching tabs mounts a different file, and the editor is
             bound to one file for its whole life. `onSaved` reports the newest text so
             the preview behind this — and the block behind that — is not stale. */
          <HtmlDesignEditor
            key={src}
            src={src}
            initialScrollPx={editScroll}
            onSaved={(next) => onSaved?.(src, next)}
          />
        ) : (
          processedHtml && (
            <div className="relative flex-1 min-h-0 rounded-[12px] overflow-hidden bg-white shadow-minimal">
              {/* Positioned *and* sized: a percentage height would otherwise resolve to `auto`
                  (there is no definite height in this chain to resolve against, so the frame
                  falls back to its intrinsic 150px), and an iframe pinned only by its four edges
                  is not stretched either. See `DrawioEditorFrame` for the measurements. */}
              <iframe
                ref={iframeRef}
                sandbox="allow-same-origin allow-top-navigation-by-user-activation"
                srcDoc={processedHtml}
                title={activeItem?.label || title || 'HTML Preview'}
                className="absolute inset-0 h-full w-full border-0"
              />
            </div>
          )
        )}
      </div>
    </PreviewOverlay>
  )
}
