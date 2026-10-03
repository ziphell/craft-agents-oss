/**
 * A diagram, opened full size — from the expand button on a `drawio-preview` block, or from
 * that block's pencil.
 *
 * One overlay rather than two, because the difference between the ways in is which pane it
 * mounts and nothing else — and the window switches between them itself, with a pencil in its
 * own header, the way the page preview does. What it is worth having is what it borrows:
 * `DrawioEditorPane` is the same editor a block opens and `DrawioViewer` the same viewer it draws
 * with, so the debounce, the project-folder write boundary and the "the file changed
 * underneath" question are answered in one place.
 *
 * The chrome is the app's shared one — the same `PreviewOverlay` every other preview uses —
 * which is also what puts the file's own menu (open in draw.io, reveal in the file manager)
 * one click from here.
 */

import * as React from 'react'
import { Eye, Pencil, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { drawioPages } from '@craft-agent/shared/drawio/types'
import { usePlatform } from '../../context/PlatformContext'
import { PreviewOverlay } from '../overlay/PreviewOverlay'
import { CopyButton } from '../overlay/CopyButton'
import { DrawioEditorPane } from './DrawioEditorPane'
import { DrawioViewer } from './frame'
import { DrawioPages } from './Pages'
import { useDrawioOrigin } from './useDrawioOrigin'
import { DrawioViewControls, useDrawioView } from './view'

export interface DrawioOverlayProps {
  isOpen: boolean
  onClose: () => void
  /** Absolute path of the `.drawio` file to show or edit. */
  filePath: string
  /** Which pane to open on. The window switches between them itself; see `headerActions` below. */
  initialMode: 'view' | 'edit'
  /** The document to draw in view mode. The editor reads the file itself. */
  xml?: string | null
  /**
   * Which page of it to draw, by drawio's page id — the page the caller was already showing, so that
   * opening the window does not put a different page of the document on screen than the block had.
   * View mode only, for the same reason `xml` is.
   */
  pageId?: string
  /**
   * A page picked from the window's own row of pages.
   *
   * The window is a view of what the caller is already showing, so it holds no page of its own: it
   * says which page was picked and the caller decides. That is what keeps the block behind it on the
   * same page as the window, and what lets the caller hold a page for a file it opened.
   */
  onSelectPage?: (pageId: string) => void
  /** The file's own name when it has no better title. */
  title?: string
  /** Every document that reached the disk, including the one written on the way out. */
  onSaved?: (document: string) => void
}

export function DrawioOverlay({
  isOpen,
  onClose,
  filePath,
  initialMode,
  xml,
  pageId,
  onSelectPage,
  title,
  onSaved,
}: DrawioOverlayProps) {
  const { t } = useTranslation()
  const { onWriteFile } = usePlatform()
  const { origin, problem: hostProblem } = useDrawioOrigin()
  const dark = document.documentElement.classList.contains('dark')
  const name = title ?? filePath.split(/[\\/]/).pop() ?? filePath

  /**
   * The pane on screen. The caller says which one to *open* on; from then on this owns it, because
   * the header carries the switch and a window that could only be changed from outside would send
   * the person back to the block to do it.
   */
  const [mode, setMode] = React.useState<'view' | 'edit'>(initialMode)
  // Each opening takes the pane it was opened with — this overlay stays mounted while closed.
  React.useEffect(() => {
    if (isOpen) setMode(initialMode)
  }, [isOpen, initialMode])

  /**
   * The newest document this window has seen written, so going back to the drawing shows *that*.
   *
   * The viewer draws what it is handed and the editor reads the file itself, so without this the
   * way back from editing would draw the version the caller read before the window opened.
   */
  const [written, setWritten] = React.useState<string | null>(null)
  React.useEffect(() => {
    setWritten(null)
  }, [xml])

  /**
   * What the viewer said about this document.
   *
   * Reported here rather than left to the viewer to say, because the viewer is not on the
   * screen any more: it draws off to one side and hands the drawing back, so a document it
   * cannot draw would otherwise be a spinner that never ends. The block behind this overlay
   * says it too, but a message has to be wherever the person is looking.
   */
  const [drawProblem, setDrawProblem] = React.useState<string | null>(null)
  const drawn = written ?? xml
  React.useEffect(() => setDrawProblem(null), [drawn, dark])

  const problem = hostProblem ?? drawProblem

  /**
   * The document's own pages, for the row at the top of the window.
   *
   * Read here rather than handed in, because the window is the surface that has the document — and
   * because a caller that only wanted to show a file should not also have to list its pages. View
   * mode only: the editor is drawio's own application, and it has its own way to switch pages.
   */
  const pages = React.useMemo(() => (drawn ? drawioPages(drawn) : []), [drawn])
  const activeIndex = Math.max(0, pages.findIndex((page) => page.id === pageId))

  // The drawing at the size it was authored, in a window that can be panned anywhere — an edge
  // pulled clear across to the other side, a corner read without hugging a border. The wheel is the
  // zoom here, as in every other preview this app opens full size.
  const view = useDrawioView({ isOpen })

  const editing = mode === 'edit'
  /** Editing needs somewhere to write: a host with no write action only ever looks at the drawing. */
  const canEdit = Boolean(origin && onWriteFile)

  const headerActions = (
    <div className="flex items-center gap-2">
      {/* Nothing to size in the editor: drawio's own surface has its own zoom. */}
      {!editing && <DrawioViewControls view={view} />}
      {/* What the image and PDF windows put here: the file's own path, straight after the zoom —
          the same button in the same place in every window that has something to size. */}
      <CopyButton content={filePath} title={t('common.copyPath')} className="bg-background shadow-minimal" />
      {canEdit && (
        <button
          type="button"
          onClick={() => setMode(editing ? 'view' : 'edit')}
          title={editing ? t('preview.backToPreview') : t('common.edit')}
          aria-label={editing ? t('preview.backToPreview') : t('common.edit')}
          aria-pressed={editing}
          className={
            /* Last before the close button, after everything that acts on the drawing: the switch
               between looking and changing is the outermost choice, and it stays in the same place
               in both modes. Same box and colouring as the controls beside it — a toggle a size or
               a shade off its neighbours reads as disabled rather than as the one control that
               changes the pane. */
            'p-1.5 rounded-[8px] transition-all select-none bg-background shadow-minimal ' +
            'text-muted-foreground hover:text-foreground'
          }
        >
          {editing ? <Eye className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
        </button>
      )}
    </div>
  )

  const handleSaved = React.useCallback(
    (document: string) => {
      setWritten(document)
      onSaved?.(document)
    },
    [onSaved],
  )

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={dark ? 'dark' : 'light'}
      typeBadge={{ icon: Workflow, label: t('preview.drawioDiagram'), variant: 'default' }}
      filePath={filePath}
      error={problem ? { label: t('common.error'), message: problem } : undefined}
      headerActions={headerActions}
    >
      {/* The pages, as a row of their own at the top of the window — flush with its edges, the way the
          block's row is, because the gutter below belongs to the drawing. Looking only: see `pages`. */}
      {!editing && (
        <DrawioPages
          pages={pages}
          activeIndex={activeIndex}
          onSelect={(index) => {
            const page = pages[index]
            if (page) onSelectPage?.(page.id)
          }}
        />
      )}

      {/* The same side gutter the page and the document keep, so the three surfaces agree: a drawing
          panned to an edge stops at the gutter rather than under the window's own frame, and nothing
          ends at a different height from its siblings. */}
      <div className="flex-1 min-h-0 flex flex-col px-4">
        {origin && editing ? (
          <DrawioEditorPane src={filePath} origin={origin} dark={dark} title={name} onSaved={handleSaved} />
        ) : origin && drawn ? (
          /* The whole point of this way in: the same drawing, at the size it was authored, with
             the room a window has. Filling the overlay's content box is the viewer's own job. */
          <DrawioViewer
            origin={origin}
            xml={drawn}
            dark={dark}
            title={name}
            pageId={pageId}
            view={view}
            onProblem={setDrawProblem}
          />
        ) : null}
      </div>
    </PreviewOverlay>
  )
}
