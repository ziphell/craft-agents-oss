/**
 * The side panel: one panel holding the project's detail page, its asset library and its files, as
 * tabs.
 *
 * The first tab is the project itself (`PROJECT_DETAIL_PATH`) — fixed, always there, and drawn as
 * `ProjectInfoPage`. The library has its own tab (`PROJECT_ASSETS_PATH`): the grid and the board are
 * two views of it, so neither is a document to open. Every other tab is a **path** (see
 * `atoms/side-panel.ts`), and is whatever `classifyFile` says it is. Nothing here guesses a format
 * twice.
 *
 * What it deliberately is not: a second editor. A text file goes to `SourceFilePane`, which is the
 * same pane the overlays use, so the save machinery, the conflict answer and the external-change
 * follow-through are one implementation. A format this panel has no face for says so and offers the
 * overlay instead of pretending to draw it.
 *
 * **Opening is the person's act.** The `+` menu lists what this project has; nothing opens on its
 * own, and nothing expands the panel. When an agent may ask for a tab, it will call
 * `openWorkbenchTab` with this same shape and the question of *who may ask* stays outside.
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useSetAtom } from 'jotai'
import { Code2, Eye, FileAudio, FileText, Film, FolderKanban, Globe, Images, Loader2, Maximize2, Minimize2, PanelRightClose, Pencil, Scissors, PanelsTopLeft, Plus, Search, Trash2, Workflow, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  classifyFile,
  DrawioOverlay,
  HTMLPreviewOverlay,
  MarkdownEditorPane,
  OfficePreviewOverlay,
  PDFPreviewOverlay,
  officeAppFor,
  SourceFilePane,
} from '@craft-agent/ui'
import type { LoadedProject } from '@craft-agent/shared/projects'
import { emptyDocument, isReelPath, REEL_EXTENSION, reelNameOf } from '@craft-agent/shared/reel/document'
import { mediaKindOfFile } from '@craft-agent/shared/media/file-kind'
import type { SessionFile } from '@craft-agent/shared/protocol'
import { requestFileEditorAtom } from '@/atoms/file-editor'
import { PROJECT_ASSETS_PATH, PROJECT_DETAIL_PATH, useSidePanel } from '@/atoms/side-panel'
import { EditSurface } from '@/components/edit/EditSurface'
import { AssetLibrary } from '@/components/library/AssetLibrary'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { mediaUrl } from '@/lib/media-url'
import ProjectInfoPage from '@/pages/ProjectInfoPage'

export interface SidePanelProps {
  workspaceId: string
  project: LoadedProject
  /** The conversation this panel sits beside. The board hands a selection to it. */
  sessionId?: string
  /**
   * Close the panel. When given, the tab strip carries the control at its right end and the host
   * draws no header of its own — the tabs are the title bar, because "side panel" is not a thing
   * anybody needs to be told twice.
   */
  onClose?: () => void
  /** Focus mode: the panel covers the conversation, and the strip carries the way back. */
  focused?: boolean
  onToggleFocus?: () => void
}

const CANVAS_SUFFIX = '.canvas.json'
const EDIT_SUFFIX = REEL_EXTENSION

function isEditPath(path: string): boolean {
  return isReelPath(path)
}

function isCanvasPath(path: string, projectFolder?: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  // The project's one canvas sits at its root. A legacy file under `canvases/` is just a file now:
  // it stays on disk, but it is not a second board this panel can open.
  if (!normalized.endsWith('/canvas.json') || normalized.includes('/canvases/')) return false
  if (!projectFolder) return true
  const root = projectFolder.replace(/\\/g, '/').replace(/[\\/]+$/, '')
  return normalized === `${root}/canvas.json`
}

function nameOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return isReelPath(base) ? reelNameOf(base) : base.replace(CANVAS_SUFFIX, '')
}

/**
 * The media a file plays as, when it is one.
 *
 * `classifyFile` leaves these to the system on purpose: a link to a clip in a conversation should
 * open the person's own player. A **tab** is different — it is asking for a pane, and this panel
 * has one now — so the tab decides from the extension rather than changing what a click means.
 */
function canOpenInTab(path: string): boolean {
  return classifyFile(path).canPreview || mediaKindOfFile(path) !== null
}

export function SidePanel({ workspaceId, project, sessionId, onClose, focused, onToggleFocus }: SidePanelProps) {
  const { t } = useTranslation()
  const projectId = project.config.id
  const { state, open, close, setActive } = useSidePanel(projectId)
  const setFileEditorRequest = useSetAtom(requestFileEditorAtom)

  const [files, setFiles] = React.useState<SessionFile[]>([])
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [menuAt, setMenuAt] = React.useState<{ left: number; top: number } | null>(null)
  const plusRef = React.useRef<HTMLButtonElement | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      const tree = await window.electronAPI.getProjectFiles(workspaceId, project.config.slug)
      setFiles(flatten(tree).map((file) => ({ ...file, path: absolutePath(project.folderPath, file.path) })))
    } catch {
      // A project folder that cannot be read is an empty menu, not an error dialog.
    }
  }, [workspaceId, projectId, project.config.slug, project.folderPath])

  React.useEffect(() => {
    setMenuOpen(false)
    setQuery('')
    void refresh()
  }, [refresh])

  /**
   * The project's cuts — `.reel` files under `reels/`.
   *
   * A cut is a project document, and this folder is its one home: the agent's `reel_tool` and the
   * `+` menu both write there, so the list and the tool cannot disagree about where to look.
   */
  const cutFiles = React.useMemo(() => {
    const root = `${project.folderPath.replace(/[\\/]+$/, '').replace(/\\/g, '/')}/reels/`
    return files.filter(
      (file) => isEditPath(file.path) && file.path.replace(/\\/g, '/').startsWith(root),
    )
  }, [files, project.folderPath])

  /**
   * The menu is drawn in a portal at the button's own coordinates.
   *
   * It used to be an absolutely positioned child of the tab strip, which scrolls horizontally and
   * sits inside a clipped panel — so it opened *outside* the visible area and a click looked like it
   * did nothing. A portal is measured from the button and cannot be clipped by either.
   */
  const placeMenu = React.useCallback(() => {
    const rect = plusRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuAt({ left: Math.round(rect.left), top: Math.round(rect.bottom + 4) })
  }, [])

  React.useEffect(() => {
    if (!menuOpen) return
    placeMenu()
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-side-panel-menu]') || target === plusRef.current) return
      setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', placeMenu)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', placeMenu)
    }
  }, [menuOpen, placeMenu])

  /** A new cut is a file: `reels/<slug>.reel`, named the way the person will say it. */
  const createEdit = React.useCallback(async () => {
    try {
      const name = t('sidePanel.newEditName', { n: cutFiles.length + 1 })
      const path = `${project.folderPath.replace(/[\/]+$/, '')}/reels/${name}${EDIT_SUFFIX}`
      await window.electronAPI.writeFile(
        path,
        JSON.stringify(emptyDocument(name), null, 2),
      )
      await refresh()
      open(path)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setMenuOpen(false)
    }
  }, [cutFiles, open, project.folderPath, refresh, t])

  /**
   * Remove a cut. Closing its tab first matters: the editor flushes one pending save on unmount,
   * and that write must reach the host before the file is removed or it would put the cut back.
   */
  const deleteEdit = React.useCallback(
    async (path: string) => {
      if (!window.confirm(t('sidePanel.deleteEditConfirm', { name: nameOf(path) }))) return
      try {
        close(path)
        await new Promise((resolve) => setTimeout(resolve, 150))
        await window.electronAPI.deleteEdit(path)
        await refresh()
        setMenuOpen(false)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      }
    },
    [close, refresh, t],
  )

  // Closing a tab closes the tab. Deleting a canvas is a different decision and it is not this
  // button's — `canvas.json` stays on disk, exactly as closing an editor never deletes a document.
  const closeTab = React.useCallback((path: string) => close(path), [close])

  const active = state.active
  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    // The project's canvas is opened by its own menu entry; listing its JSON as a file would offer
    // a second, wrong way to edit it.
    const list = files.filter(
      (file) => canOpenInTab(file.path) && !isCanvasPath(file.path, project.folderPath),
    )
    return needle ? list.filter((file) => file.path.toLowerCase().includes(needle)) : list
  }, [files, project.folderPath, query])

  /** Cuts that have been in front once, and so are allowed to keep running. */
  const [mountedCuts, setMountedCuts] = React.useState<string[]>([])
  React.useEffect(() => {
    if (!active || !isEditPath(active)) return
    setMountedCuts((previous) => (previous.includes(active) ? previous : [...previous, active]))
  }, [active])

  /**
   * File tabs mount on their first turn in front, for the same reason cuts do: the tab list is
   * restored from storage at launch, and booting every markdown editor at once is what made a
   * session with a few notes in it crawl. A tab that has been in front stays mounted.
   */
  const [mountedFiles, setMountedFiles] = React.useState<string[]>([])
  React.useEffect(() => {
    if (!active) return
    if (isEditPath(active) || isCanvasPath(active, project.folderPath)) return
    setMountedFiles((previous) => (previous.includes(active) ? previous : [...previous, active]))
  }, [active, project.folderPath])

  return (
<div className="flex h-full min-h-0 flex-col">
      {/* The strip *is* the title bar: the tabs say what is open, and nothing says "side panel".
          Canvas support has been removed; legacy canvas paths are filtered out. */}
      <div className="flex h-[42px] shrink-0 items-center gap-1 border-b border-border/50 pl-2.5 pr-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
          {state.paths.filter((path) => !isCanvasPath(path, project.folderPath)).map((path) => (
            <div
              key={path}
              className={cn(
                'group flex shrink-0 items-center gap-1.5 rounded-md pl-2 py-1 text-[12px] transition-colors',
                // The project tab has no close button, so its label needs the padding the X would take.
                path === PROJECT_DETAIL_PATH ? 'pr-2' : 'pr-1',
                path === active ? 'bg-foreground/[0.07] text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.04]',
              )}
            >
              <button
                type="button"
                className="flex items-center gap-1.5"
                onClick={() => setActive(path)}
                title={
                  path === PROJECT_DETAIL_PATH
                    ? project.config.name
                    : path === PROJECT_ASSETS_PATH
                      ? t('sidePanel.assetsLibrary')
                      : path
                }
              >
                {path === PROJECT_DETAIL_PATH ? (
                  <FolderKanban className="h-3.5 w-3.5 opacity-60" />
                ) : path === PROJECT_ASSETS_PATH ? (
                  <Images className="h-3.5 w-3.5 opacity-60" />
                ) : (
                  <FileText className="h-3.5 w-3.5 opacity-60" />
                )}
                <span className="max-w-[200px] truncate">
                  {path === PROJECT_DETAIL_PATH
                    ? project.config.name
                    : path === PROJECT_ASSETS_PATH
                      ? t('sidePanel.assetsLibrary')
                      : nameOf(path)}
                </span>
              </button>
              {/* The project tab is the panel's floor: it is always there and has nothing to close. */}
              {path !== PROJECT_DETAIL_PATH && (
                <button
                  type="button"
                  className="rounded p-1 opacity-0 transition-opacity group-hover:opacity-70 hover:bg-foreground/[0.08] hover:opacity-100"
                  onClick={() => closeTab(path)}
                  title={t('sidePanel.closeTab')}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}


          <button
            ref={plusRef}
            type="button"
            // Follows the tabs, and stays on screen when they overflow: `sticky right-0` keeps it
            // at the strip's right edge once it would have scrolled past, without pinning it to
            // the far end of the bar when there is room.
            className="sticky right-0 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground shadow-minimal hover:bg-foreground/[0.06] hover:text-foreground"
            onClick={() => {
              setQuery('')
              setMenuOpen((openMenu) => !openMenu)
            }}
            title={t('sidePanel.openSomething')}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        {/* Closing the panel sits beside expanding it, so opening and closing stay one place. */}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title={t('chat.panelClose')}
            aria-label={t('chat.panelClose')}
            className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </button>
        )}
        {onToggleFocus && (
          <button
            type="button"
            onClick={onToggleFocus}
            title={focused ? t('sidePanel.collapse') : t('sidePanel.expand')}
            aria-label={focused ? t('sidePanel.collapse') : t('sidePanel.expand')}
            aria-pressed={focused}
            className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            {focused ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {menuOpen && menuAt &&
        createPortal(
          <div
            data-side-panel-menu
            style={{ position: 'fixed', left: menuAt.left, top: menuAt.top }}
            className="z-[60] w-72 overflow-hidden rounded-lg border border-border/60 bg-popover p-1 shadow-modal-small"
          >
            {/* The library is a destination, not a file: it is the first thing offered, because
                "the project's media" is what a person opens this menu for most often. */}
            <button
              type="button"
              onClick={() => {
                open(PROJECT_ASSETS_PATH)
                setMenuOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-foreground/[0.06]"
            >
              <Images className="h-3.5 w-3.5 text-muted-foreground" />
              {t('sidePanel.assetsLibrary')}
            </button>
            <div className="my-1 border-t border-border/60" />
            {cutFiles.length > 0 ? (
              <>
                <div className="px-2 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground/70">{t('sidePanel.edits')}</div>
                {cutFiles
                  .map((file) => (
                    <div
                      key={file.path}
                      className="group flex items-center gap-1 rounded px-1 hover:bg-foreground/[0.06]"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          open(file.path)
                          setMenuOpen(false)
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1.5 text-left text-xs"
                      >
                        <Film className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{nameOf(file.path)}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteEdit(file.path)}
                        title={t('sidePanel.deleteEdit')}
                        aria-label={t('sidePanel.deleteEdit')}
                        className="rounded p-1 text-muted-foreground opacity-60 transition-opacity hover:bg-foreground/10 hover:text-destructive group-hover:opacity-100"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
              </>
            ) : null}
            <button
              type="button"
              onClick={() => void createEdit()}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-foreground/[0.06]"
            >
              <Scissors className="h-3.5 w-3.5 text-muted-foreground" />
              {t('sidePanel.newEdit')}
            </button>
            <div className="mt-1 flex items-center gap-1 border-t border-border/60 px-2 py-1.5">
              <Search className="h-3 w-3 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('sidePanel.searchFiles')}
                className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
              />
            </div>
            <div className="max-h-64 overflow-y-auto">
              {filtered.slice(0, 60).map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => {
                    open(file.path)
                    setMenuOpen(false)
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-foreground/[0.06]"
                  title={file.path}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{file.path.slice(project.folderPath.length + 1)}</span>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="px-2 py-2 text-[11px] text-muted-foreground/70">{t('sidePanel.noFiles')}</div>
              )}
            </div>
          </div>,
          document.body,
        )}

      {/* Body. Every open tab stays mounted and only the front one is shown: switching tabs must
          not cost the board its viewport or a file its unsaved draft. A tab that is *closed* is
          unmounted, and that is when the board's place is forgotten — which is the rule the whole
          design rests on. */}
      <div className="relative min-h-0 flex-1">
        {state.paths.length === 0 ? null : (
          state.paths.map((path) => {
            // A cut is an editor — a whole application with its own undo history — so switching
            // away from one must not unmount it: the other cut has to still be where it was when
            // it comes back. What it must not do is *start* before it is asked to: the tab list is
            // restored from storage at launch, and booting every cut at once is what made the app
            // crawl. So a cut mounts on its first turn in front and stays mounted after.
            if (isEditPath(path) && path !== active && !mountedCuts.includes(path)) return null
            // A file tab is heavier than a name in the strip — a markdown one is an editor — so it
            // is built when it is first shown, not when the panel is.
            const fileTab = !isEditPath(path) && !isCanvasPath(path, project.folderPath)
            if (fileTab && path !== active && !mountedFiles.includes(path)) return null
            return (
            <div key={path} className={cn('absolute inset-0', path === active ? 'block' : 'hidden')}>
              {path === PROJECT_DETAIL_PATH ? (
                <div className="h-full min-h-0">
                  <ProjectInfoPage projectSlug={project.config.slug} embedded />
                </div>
              ) : path === PROJECT_ASSETS_PATH ? (
                <AssetLibrary
                  workspaceId={workspaceId}
                  projectId={projectId}
                  projectSlug={project.config.slug}
                  folderPath={project.folderPath}
                  active={path === active}
                />
              ) : isEditPath(path) ? (
                <EditSurface
                  workspaceId={workspaceId}
                  projectSlug={project.config.slug}
                  projectFolder={project.folderPath}
                  path={path}
                  active={path === active}
                />
              ) : (
                <FileTab
                  path={path}
                  projectFolder={project.folderPath}
                  onOpenOverlay={() => setFileEditorRequest({ path, origin: 'canvas' })}
                  onCloseTab={() => closeTab(path)}
                />
              )}
            </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/** A file, drawn by the pane its format already has. */
function FileTab({
  path,
  projectFolder,
  onOpenOverlay,
  onCloseTab,
}: {
  path: string
  projectFolder: string
  onOpenOverlay: () => void
  onCloseTab: () => void
}) {
  const { t } = useTranslation()
  const kind = classifyFile(path).type
  const media = mediaKindOfFile(path)
  const language = path.split('.').pop() ?? 'text'

  if (media) {
    return <MediaTab path={path} kind={media} />
  }

  if (kind === 'markdown') {
    // Reading first, like the page and the diagram: the pencil is the way into the editor.
    return <MarkdownTab path={path} onOpenOverlay={onOpenOverlay} />
  }

  if (kind === 'text' || kind === 'code' || kind === 'json') {
    // The pane is a flex column (`flex-1` + an absolutely positioned editor); its parent has to be
    // one too, or the editor resolves against a box with no height and the file looks blank.
    return (
      <div className="flex h-full min-h-0 flex-col">
        <SourceFilePane src={path} language={language} className="h-full" />
      </div>
    )
  }

  if (kind === 'image') {
    return <ImageTab path={path} />
  }

  if (kind === 'drawio') {
    return <DrawioTab path={path} onOpenOverlay={onOpenOverlay} />
  }

  if (kind === 'html') {
    return <HtmlTab path={path} onOpenOverlay={onOpenOverlay} />
  }

  if (kind === 'pdf') {
    return <PdfTab path={path} onOpenOverlay={onOpenOverlay} />
  }

  if (kind === 'office') {
    return <OfficeTab path={path} onOpenOverlay={onOpenOverlay} />
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <FileText className="h-8 w-8 text-muted-foreground/40" />
      <div className="text-sm text-muted-foreground">{t('sidePanel.noPane', { name: nameOf(path) })}</div>
      <Button size="sm" variant="secondary" onClick={onOpenOverlay}>
        {t('sidePanel.openOverlay')}
      </Button>
      <div className="text-[11px] text-muted-foreground/60">
        {path.slice(projectFolder.length + 1)}
      </div>
    </div>
  )
}

/** A document, read in the panel: the same pane the window mounts, on its reading face first. */
function MarkdownTab({ path, onOpenOverlay }: { path: string; onOpenOverlay: () => void }) {
  const { t } = useTranslation()
  const [mode, setMode] = React.useState<'view' | 'source'>('view')
  const sources = mode === 'source'
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelFileBar name={nameOf(path)} icon={<FileText className="h-3.5 w-3.5" />} onFullscreen={onOpenOverlay}>
        <button
          type="button"
          onClick={() => setMode(sources ? 'view' : 'source')}
          title={sources ? t('preview.backToPreview') : t('preview.sourceMode')}
          aria-label={sources ? t('preview.backToPreview') : t('preview.sourceMode')}
          aria-pressed={sources}
          className={panelToggleClass(sources)}
        >
          <Code2 className="h-3.5 w-3.5" />
        </button>
      </PanelFileBar>
      <div className="flex min-h-0 flex-1 flex-col">
        <MarkdownEditorPane src={path} mode={mode} layout="pane" className="px-4" />
      </div>
    </div>
  )
}

/** A page, drawn in the panel under the panel's own chrome — no second title bar. */
function HtmlTab({ path, onOpenOverlay }: { path: string; onOpenOverlay: () => void }) {
  const { t } = useTranslation()
  const dark = document.documentElement.classList.contains('dark')
  const name = nameOf(path)
  const [mode, setMode] = React.useState<'view' | 'edit' | 'source'>('view')
  const sources = mode === 'source'
  const editing = mode === 'edit'
  // Stable: `HTMLPreviewOverlay` re-runs its loader when this identity changes.
  const loadContent = React.useCallback((src: string) => window.electronAPI.readFile(src), [])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelFileBar name={name} icon={<Globe className="h-3.5 w-3.5" />} onFullscreen={onOpenOverlay}>
        <button
          type="button"
          onClick={() => setMode(sources ? 'view' : 'source')}
          title={sources ? t('preview.backToPreview') : t('preview.sourceMode')}
          aria-label={sources ? t('preview.backToPreview') : t('preview.sourceMode')}
          aria-pressed={sources}
          className={panelToggleClass(sources)}
        >
          <Code2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setMode(editing ? 'view' : 'edit')}
          title={editing ? t('preview.backToPreview') : t('common.edit')}
          aria-label={editing ? t('preview.backToPreview') : t('common.edit')}
          aria-pressed={editing}
          className={panelToggleClass(editing)}
        >
          {editing ? <Eye className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
        </button>
      </PanelFileBar>
      <div className="flex min-h-0 flex-1 flex-col">
        <HTMLPreviewOverlay
          isOpen
          embedded
          chrome={false}
          mode={mode}
          onModeChange={setMode}
          onClose={onOpenOverlay}
          items={[{ src: path }]}
          title={name}
          theme={dark ? 'dark' : 'light'}
          onLoadContent={loadContent}
        />
      </div>
    </div>
  )
}

/** A pdf, read in the panel; the page editor is one deliberate step away (as in the window). */
function PdfTab({ path, onOpenOverlay }: { path: string; onOpenOverlay: () => void }) {
  const { t } = useTranslation()
  const dark = document.documentElement.classList.contains('dark')
  const name = nameOf(path)
  const [editing, setEditing] = React.useState(false)
  // Stable: `PDFPreviewOverlay` reloads the bytes when this identity changes.
  const loadPdfData = React.useCallback((target: string) => window.electronAPI.readFileBinary(target), [])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelFileBar name={name} icon={<FileText className="h-3.5 w-3.5" />} onFullscreen={onOpenOverlay}>
        <button
          type="button"
          onClick={() => setEditing((previous) => !previous)}
          title={editing ? t('preview.backToPreview') : t('common.edit')}
          aria-label={editing ? t('preview.backToPreview') : t('common.edit')}
          aria-pressed={editing}
          className={panelToggleClass(editing)}
        >
          {editing ? <Eye className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
        </button>
      </PanelFileBar>
      <div className="flex min-h-0 flex-1 flex-col">
        {editing ? (
          <OfficePreviewOverlay
            isOpen
            embedded
            chrome={false}
            onClose={() => setEditing(false)}
            filePath={path}
            app="pdf"
            theme={dark ? 'dark' : 'light'}
            onBack={() => setEditing(false)}
          />
        ) : (
          <PDFPreviewOverlay
            isOpen
            embedded
            chrome={false}
            onClose={() => setEditing(false)}
            filePath={path}
            loadPdfData={loadPdfData}
            theme={dark ? 'dark' : 'light'}
          />
        )}
      </div>
    </div>
  )
}

/** A Word/Excel/PowerPoint file, edited in the panel by the same office client as the window. */
function OfficeTab({ path, onOpenOverlay }: { path: string; onOpenOverlay: () => void }) {
  const { t } = useTranslation()
  const dark = document.documentElement.classList.contains('dark')
  const name = nameOf(path)
  const app = officeAppFor(path)
  if (!app) return null
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelFileBar name={name} icon={<FileText className="h-3.5 w-3.5" />} onFullscreen={onOpenOverlay} />
      <div className="flex min-h-0 flex-1 flex-col">
        <OfficePreviewOverlay
          isOpen
          embedded
          chrome={false}
          onClose={onOpenOverlay}
          filePath={path}
          app={app}
          theme={dark ? 'dark' : 'light'}
        />
      </div>
    </div>
  )
}

/** The box, colouring and hover of a toggle in a panel's own bar — one constant for all of them. */
function panelToggleClass(pressed = false): string {
  return cn(
    'flex h-6 w-6 items-center justify-center rounded transition-colors',
    pressed ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
  )
}

/**
 * The one row a file tab gets: its name, the controls of the surface it shows, and the way out to
 * the full window. The surface's own switch lives here rather than in a second title bar — this
 * strip is the title bar.
 */
function PanelFileBar({
  name,
  icon,
  onFullscreen,
  children,
}: {
  name: string
  icon: React.ReactNode
  onFullscreen: () => void
  /** The surface's own controls — preview/edit, source — before the way out to the window. */
  children?: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/50 px-2 text-[11px] text-muted-foreground">
      {icon}
      <span className="truncate">{name}</span>
      <div className="ml-auto flex items-center gap-1">
        {children}
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-foreground/[0.06] hover:text-foreground"
          onClick={onFullscreen}
        >
          <Maximize2 className="h-3 w-3" />
          {t('sidePanel.fullscreen')}
        </button>
      </div>
    </div>
  )
}

/**
 * A diagram, in the panel.
 *
 * The window and this tab are the same component (`DrawioOverlay`, embedded): the viewer is the
 * one the full-screen window draws with, and the editor is the one it mounts, so a page picked,
 * an agent patch (`adopt`) or a save is the same path in both. Only the chrome differs — the
 * panel's own bar carries the switch.
 */
function DrawioTab({ path, onOpenOverlay }: { path: string; onOpenOverlay: () => void }) {
  const { t } = useTranslation()
  const name = nameOf(path)
  const [mode, setMode] = React.useState<'view' | 'edit'>('view')
  const [xml, setXml] = React.useState<string | null>(null)

  // The viewer draws what it is handed; the editor reads the file itself.
  React.useEffect(() => {
    if (mode !== 'view') return
    let live = true
    void window.electronAPI
      .readFile(path)
      .then((value) => {
        if (live) setXml(value)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [path, mode])

  const editing = mode === 'edit'
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelFileBar name={name} icon={<Workflow className="h-3.5 w-3.5" />} onFullscreen={onOpenOverlay}>
        <button
          type="button"
          onClick={() => setMode(editing ? 'view' : 'edit')}
          title={editing ? t('preview.backToPreview') : t('common.edit')}
          aria-label={editing ? t('preview.backToPreview') : t('common.edit')}
          aria-pressed={editing}
          className={panelToggleClass(editing)}
        >
          {editing ? <Eye className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
        </button>
      </PanelFileBar>
      <div className="relative min-h-0 flex-1">
        {/* The drawio surfaces size themselves to their box; an absolutely-positioned box is the
            one a scrolling flex child can guarantee. Without it the frame measured 0. */}
        <div className="absolute inset-0 flex flex-col">
          <DrawioOverlay
            isOpen
            embedded
            chrome={false}
            onClose={onOpenOverlay}
            filePath={path}
            initialMode={mode}
            mode={mode}
            onModeChange={setMode}
            xml={xml}
            onSaved={setXml}
          />
        </div>
      </div>
    </div>
  )
}

function ImageTab({ path }: { path: string }) {
  const [url, setUrl] = React.useState<string | null>(null)
  React.useEffect(() => {
    let live = true
    void window.electronAPI
      .readFileDataUrl(path)
      .then((value) => {
        if (live) setUrl(value)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [path])
  if (!url) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  }
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-foreground/[0.02] p-4">
      <img src={url} alt="" className="max-h-full max-w-full object-contain" />
    </div>
  )
}

/**
 * A clip or a recording, played in the panel.
 *
 * The file is served (not inlined as base64) so the player can seek — scrubbing a long recording
 * is the first thing a person does. Chromium decides what it can decode; a container it cannot
 * still shows the player and its error rather than sending the person to another window.
 */
function MediaTab({ path, kind }: { path: string; kind: 'video' | 'audio' }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/50 px-2 text-[11px] text-muted-foreground">
        {kind === 'video' ? <Film className="h-3.5 w-3.5" /> : <FileAudio className="h-3.5 w-3.5" />}
        <span className="truncate">{nameOf(path)}</span>
      </div>
      {kind === 'video' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-black/90 p-2">
          <video key={path} src={mediaUrl(path)} controls className="max-h-full max-w-full rounded-md" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
          <FileAudio className="h-10 w-10 text-muted-foreground/30" />
          <audio key={path} src={mediaUrl(path)} controls className="w-full max-w-md" />
        </div>
      )}
    </div>
  )
}

/** Every file of the project tree, flattened; directories are only structure. */
/**
 * A tab is an absolute path (see `atoms/side-panel.ts`), and the file tree may name its entries
 * relative to the project folder. Normalising here keeps every path in the panel one kind: the
 * tab strip, the file reader and the canvas lookup all address the same file.
 */
function absolutePath(projectFolder: string, path: string): string {
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(path)) return path
  return `${projectFolder.replace(/[\\/]+$/, '')}/${path.replace(/\\/g, '/').replace(/^\/+/, '')}`
}

function flatten(files: SessionFile[]): SessionFile[] {
  const out: SessionFile[] = []
  const walk = (entries: SessionFile[]) => {
    for (const entry of entries) {
      if (entry.children?.length) walk(entry.children)
      else out.push(entry)
    }
  }
  walk(files)
  return out
}
