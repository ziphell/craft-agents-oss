/**
 * HTMLPreviewOverlay - Fullscreen overlay for viewing rendered HTML content.
 *
 * Uses PreviewOverlay as the base for consistent modal/fullscreen behavior.
 *
 * **Two frames, and which one you get is the host's answer.** Where the host serves pages
 * (`onGetHtmlOrigin` — the desktop app serves the page's own folder at a `craft-local://` label),
 * the frame is loaded by `src` from an opaque origin with its scripts allowed: a real page, whose
 * relative images and stylesheets resolve, and which still cannot reach the app. Where it cannot
 * (the Web UI, a window whose files are on another machine), the file's text goes into a `srcDoc`
 * frame — the document *drawn*, with no address, so neither a script nor a relative reference has
 * anywhere to go. `onOpenInBrowser` (the header button) remains the way to the same file in a
 * browser, as a tab at an address of its own.
 *
 * Links: `injectBaseTarget` sets `target="_top"` in the drawn frame, and the served document is
 * sent with a `<base target="_top">` already in it (`packages/shared/src/html-preview.ts`), so a
 * click reaches the top frame, where the app's navigation policy answers it. In the drawn frame a
 * relative link still resolves against the app's own address — the known rough edge of drawing
 * HTML instead of serving it, and one the served frame does not have.
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
import { Code2, Eye, Globe, Pencil } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { CopyButton } from './CopyButton'
import { ItemNavigator } from './ItemNavigator'
import { HtmlDesignEditor } from '../html-design/HtmlDesignEditor'
import { SourceFilePane } from '../editors/SourceFilePane'
import { usePlatform } from '../../context/PlatformContext'
import { DRAWN_PAGE_SANDBOX } from '@craft-agent/shared/html-preview'

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
  /** Draw in place (a panel column) instead of in a window of its own. */
  embedded?: boolean
  /** Draw the header or leave the chrome to the caller. Embedded only. */
  chrome?: boolean
  /**
   * Which surface to open on. `'edit'` is how the block's pencil asks for the editor
   * directly; it falls back to the preview when the file cannot be edited.
   */
  initialMode?: 'view' | 'edit' | 'source'
  /**
   * The surface on screen, when the host owns the switch — a panel whose own bar carries it.
   * Absent, this window owns it (`initialMode` and the header's buttons).
   */
  mode?: 'view' | 'edit' | 'source'
  onModeChange?: (mode: 'view' | 'edit' | 'source') => void
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
  embedded = false,
  chrome = true,
  initialMode = 'view',
  mode: controlledMode,
  onModeChange,
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
  const [ownMode, setOwnMode] = React.useState<'view' | 'edit' | 'source'>(initialMode)
  // A host that owns the switch passes `mode`; otherwise this window holds it, as it always has.
  const mode = controlledMode ?? ownMode
  const setMode = React.useCallback(
    (next: 'view' | 'edit' | 'source') => {
      if (controlledMode === undefined) setOwnMode(next)
      onModeChange?.(next)
    },
    [controlledMode, onModeChange],
  )
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
      if (controlledMode === undefined) setOwnMode(initialMode)
    }
  }, [isOpen, initialIndex, initialMode, controlledMode])

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
  const canEdit = Boolean(src && src !== '__single__' && onWriteFile)
  const editing = mode === 'edit' && canEdit
  const sources = mode === 'source' && canEdit

  // Header actions: item navigation + copy button, then the mode switch last. "Open in browser"
  // is not here any more: it belongs to the *file*, so it sits in the badge's menu beside "Open"
  // and "Reveal" (`FullscreenOverlayBaseHeader`), where the same three answers already are.
  const headerActions = (
    <div className="flex items-center gap-2">
      <ItemNavigator items={resolvedItems} activeIndex={activeIdx} onSelect={setActiveIdx} size="md" />
      <CopyButton content={activeContent || ''} label="Copy HTML" className="bg-background shadow-minimal" />
      {/* The text of the page, beside the picture of it. A page editor can move a heading and
          cannot correct a `<style>` block, an attribute or a comment — which is what the source is
          for — and it is the same file either way (see `SourceFilePane`). Pressed means "this is
          source", and pressing it again reads the page. */}
      {canEdit && src && (
        <button
          type="button"
          onClick={() => setMode(sources ? 'view' : 'source')}
          title={sources ? t('preview.backToPreview') : t('preview.sourceMode')}
          aria-label={sources ? t('preview.backToPreview') : t('preview.sourceMode')}
          aria-pressed={sources}
          className={HEADER_BUTTON_CLASS}
        >
          <Code2 className="w-4 h-4" />
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
            // Where the person had scrolled to is asked of the frame by the editor itself, which
            // owns it — the two modes are the same document, so the page does not move.
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
      embedded={embedded}
      chrome={chrome}
      typeBadge={{
        icon: Globe,
        label: 'HTML',
        variant: 'blue',
      }}
      title={title || activeItem?.label || 'HTML Preview'}
      headerActions={headerActions}
      /* The badge's menu, not a header button: a page is the one format with a third place to go,
         and it is a property of the file rather than of this window. Wrapped so the menu item
         answers about the item on screen — the overlay switches between them. */
      onOpenInBrowser={onOpenInBrowser && src ? () => onOpenInBrowser(src) : undefined}
      filePath={src && src !== '__single__' ? src : undefined}
    >
      {/* One box for both modes: the card fills what the overlay has, and the page inside
          it is what scrolls. The padding belongs here rather than to either mode, so
          switching between them cannot move the page by a pixel — and the vertical half of
          it is the base's (`CONTENT_GUTTER`), so this box agrees with the diagram and the
          document, which used to end 24–32px higher than it did. */}
      <div className="flex-1 min-h-0 flex flex-col px-4">
        {/* A served page needs no text to draw: the loading line belongs to the fallback only. */}
        {loadingItem && !activeContent && !src && (
          <div className="py-12 text-center text-muted-foreground text-sm">{t('common.loading')}</div>
        )}
        {loadError && !activeContent && (
          <div className="py-12 text-center text-destructive/70 text-sm">{loadError}</div>
        )}
        {sources && src ? (
          /* The same file as text. Keyed by path for the same reason the editor is: a tab switch is
             a different file, and this pane is bound to one file for its whole life. */
          <SourceFilePane
            key={src}
            src={src}
            language="html"
            className="px-2 py-2"
            onSaved={(next) => onSaved?.(src, next)}
          />
        ) : src ? (
          /**
           * **One frame, two modes.** The page is drawn by the editor's own document
           * (`design-document.ts`) either way — read-only first, and the pencil turns the probe on
           * — so the reader sees the real page (its scripts, its links) and the person who then
           * presses edit is looking at the same document, in the same box, at the same scroll
           * position. There is no second kind of frame that could disagree with the first.
           *
           * Keyed by path: switching tabs mounts a different file, and this frame is bound to one
           * file for its whole life. `onSaved` reports the newest text so whatever drew the page
           * behind this is not stale.
           */
          <HtmlDesignEditor
            key={src}
            src={src}
            mode={editing ? 'inspect' : 'browse'}
            onSaved={(next) => onSaved?.(src, next)}
          />
        ) : processedHtml ? (
          /* Nothing but the text (an `html` string with no file behind it): the same drawn frame the
             block uses, and the one case with no editor to hand the document to. */
          <div className="relative flex-1 min-h-0 rounded-[12px] overflow-hidden bg-white shadow-minimal">
            <iframe
              sandbox={DRAWN_PAGE_SANDBOX}
              srcDoc={processedHtml}
              title={activeItem?.label || title || 'HTML Preview'}
              className="absolute inset-0 h-full w-full border-0"
            />
          </div>
        ) : null}
      </div>
    </PreviewOverlay>
  )
}
