/**
 * Creations — the works an agent produced, gathered in one place.
 *
 * **What this is not**: a file browser. The app already has a project tree, a session file tree and
 * a browser window; a second directory listing would be a fourth way to look at the same folders.
 * What none of those can answer is the question this screen exists for — *which turn made this, and
 * what else did that turn make* — so every card carries its provenance and links back to the
 * message that produced it.
 *
 * The grid is honest about what it holds: a card is a file, so opening one opens the file in the
 * app's own overlay for its format (markdown, HTML, drawio, the office editors, PDF, images). The
 * library owns no storage, no ids and no lifecycle: a work disappears when its file does.
 *
 * A poster is fetched **when the card is about to be seen**, not with the list: sixty pictures are
 * a few megabytes of base64, and most of them are below the fold.
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import {
  AlertTriangle,
  AppWindow,
  Bot,
  Braces,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileAudio,
  FileVideo,
  Image as ImageIcon,
  ExternalLink,
  FolderOpen,
  MessageSquarePlus,
  MoreHorizontal,
  Presentation,
  Copy,
  Download,
  History,
  RefreshCw,
  Search,
  Workflow,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatDistanceToNowStrict, type Locale } from 'date-fns'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
} from '@/components/ui/styled-context-menu'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { DropdownMenuProvider } from '@/components/ui/menu-context'
import { useAppShellContext } from '@/context/AppShellContext'
import { useNavigation } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import { buildHandoffBrief } from '@/lib/bot-handoff'
import { cn } from '@/lib/utils'
import { projectsAtom } from '@/atoms/projects'
import {
  CREATIONS_UNASSIGNED_PROJECT,
  creationsProjectFilterAtom,
} from '@/atoms/creations'
import {
  ProjectMultiSelectFilter,
  type ProjectFilterOption,
} from '@/components/app-shell/ProjectMultiSelectFilter'
import { useCreations } from '@/hooks/useCreations'
import { useInView } from '@/hooks/useInView'
import { shortTimeLocale } from '@/utils/session'
import type { Creation, CreationFormat } from '@craft-agent/shared/creations/types'
import { exportTargetsFor, type CreationExportTarget } from '@craft-agent/shared/office/creation-export'

/** The badge vocabulary: one icon and one tint per format, so a wall of cards reads by shape. */
const FORMAT_META: Record<CreationFormat, { icon: typeof FileText; tint: string }> = {
  md: { icon: FileText, tint: 'text-sky-600/80 dark:text-sky-400/80' },
  html: { icon: FileCode2, tint: 'text-orange-600/80 dark:text-orange-400/80' },
  drawio: { icon: Workflow, tint: 'text-violet-600/80 dark:text-violet-400/80' },
  docx: { icon: FileText, tint: 'text-blue-700/80 dark:text-blue-400/80' },
  xlsx: { icon: FileSpreadsheet, tint: 'text-emerald-700/80 dark:text-emerald-400/80' },
  pptx: { icon: Presentation, tint: 'text-red-600/80 dark:text-red-400/80' },
  pdf: { icon: FileType2, tint: 'text-rose-600/80 dark:text-rose-400/80' },
  image: { icon: ImageIcon, tint: 'text-amber-600/80 dark:text-amber-400/80' },
  video: { icon: FileVideo, tint: 'text-purple-600/80 dark:text-purple-400/80' },
  audio: { icon: FileAudio, tint: 'text-lime-700/80 dark:text-lime-400/80' },
  csv: { icon: FileSpreadsheet, tint: 'text-teal-700/80 dark:text-teal-400/80' },
  json: { icon: Braces, tint: 'text-yellow-700/80 dark:text-yellow-500/80' },
  text: { icon: FileText, tint: 'text-muted-foreground' },
}

/**
 * The chips, in the order a person looks for them.
 *
 * Two dimensions, and neither is "where the file sits":
 *
 * - **what it is** — documents first, then the three media categories. `json`/`csv`/`text` are data
 *   files and have no chip. Media chips are always offered, even at zero, so the page says what it
 *   can hold before anything has been made; their cards still appear only when a tool named the
 *   file as an output or a `.gen.json` note proves it was generated (see `WORK_FORMATS` /
 *   `MEDIA_FORMATS`), so an uploaded picture is not here.
 * - **which project it was made for** — the fact a person actually looks for. It is not the folder
 *   (`place`), because an agent writes into `sessions/<id>/`: the folder names a project for almost
 *   nothing. `projectSlugs` folds the folder together with the project each origin conversation
 *   belongs to, so this filter is populated for the ordinary case rather than the exceptional one.
 *
 * The second dimension is the board's own control (`ProjectMultiSelectFilter`), not a row of chips:
 * several projects can be on at once, "no project" is a checkbox rather than a chip that pretends
 * to be a sibling of the projects, and the word for it is the one the rest of the app uses.
 */
const FORMAT_ORDER: CreationFormat[] = [
  'md',
  'html',
  'drawio',
  'docx',
  'xlsx',
  'pptx',
  'pdf',
  'image',
  'video',
  'audio',
]

/** The three media categories: shown as chips whether or not the library holds any yet. */
const MEDIA_FORMATS: ReadonlySet<CreationFormat> = new Set<CreationFormat>(['image', 'video', 'audio'])

/** A category reads as a word; a document format keeps its extension, which is what people call it. */
const FORMAT_LABEL_KEY: Partial<Record<CreationFormat, string>> = {
  image: 'library.image',
  video: 'library.video',
  audio: 'library.audio',
}

/** Formats the host can draw. The rest keep their badge — no round trip for a picture that cannot exist. */
const POSTER_FORMATS: ReadonlySet<CreationFormat> = new Set([
  'md',
  'html',
  'drawio',
  'docx',
  'xlsx',
  'pptx',
  'pdf',
  'image',
])

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/**
 * A library is read by recency, so this is the only date a card carries.
 *
 * `date-fns` + `shortTimeLocale` is the app's own localisation of relative time (the cards
 * use it), which is why this is four lines rather than a formatter and a try/catch: the locale the
 * rest of the UI uses is already resolved here.
 */
function relativeTime(at: number, locale: Locale): string {
  return formatDistanceToNowStrict(new Date(at), {
    locale: shortTimeLocale as Locale,
    roundingMethod: 'floor',
    addSuffix: true,
  })
}

/**
 * Posters already in hand, by document version.
 *
 * A card is unmounted by every filter change — and by leaving the library — and its poster state goes
 * with it, so coming back asked the host again for pictures that were already here. That is what
 * "switching a chip looks like it regenerates the posters" was: not a capture (the host answers from
 * disk in about a millisecond) but a round trip per visible card, one after another, right when the
 * grid is busy putting itself back together. Kept by `path|mtime|bytes`, so an edited document is a
 * different key and never shows last week's picture; a couple of hundred entries is a few megabytes,
 * which is what the cards are already holding.
 */
const posterCache = new Map<string, string>()
const POSTER_CACHE_LIMIT = 240

function posterKey(creation: Creation): string {
  return `${creation.path}|${creation.mtimeMs}|${creation.bytes}`
}

function rememberPoster(key: string, dataUrl: string): void {
  if (posterCache.size >= POSTER_CACHE_LIMIT) {
    const oldest = posterCache.keys().next()
    if (!oldest.done) posterCache.delete(oldest.value)
  }
  posterCache.set(key, dataUrl)
}

/**
 * The poster for one card, fetched once it is near the viewport.
 *
 * `useInView` is the app's own observer (the cards use it for the same reason): a grid of
 * forty works opens one window and one request per visible row, not forty of both. A picture already
 * fetched for this version of this document is taken from `posterCache` and costs nothing.
 */
function usePoster(
  workspaceId: string | null | undefined,
  creation: Creation,
): { posterUrl: string | null; ref: React.RefObject<HTMLDivElement> } {
  const [ref, inView] = useInView<HTMLDivElement>({ rootMargin: '200px' })
  const [posterUrl, setPosterUrl] = React.useState<string | null>(
    () => posterCache.get(posterKey(creation)) ?? null,
  )

  React.useEffect(() => {
    if (!inView || !workspaceId) return
    if (!POSTER_FORMATS.has(creation.format) || !creation.exists) return
    const key = posterKey(creation)
    const cached = posterCache.get(key)
    if (cached) {
      setPosterUrl(cached)
      return
    }
    let cancelled = false
    window.electronAPI
      .getCreationThumbnail(workspaceId, creation.path)
      .then((result) => {
        if (cancelled || !result?.dataUrl) return
        rememberPoster(key, result.dataUrl)
        setPosterUrl(result.dataUrl)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // The version is in the key, so an edit is a different request.
  }, [inView, workspaceId, creation.path, creation.format, creation.exists, creation.mtimeMs, creation.bytes])

  return { posterUrl, ref }
}

/** One action in a card's menu — the same object feeds both menus. */
interface CreationAction {
  id: string
  icon: React.ComponentType<{ className?: string }>
  label: string
  onSelect: () => void
}

/**
 * The items, rendered into whichever menu family is asking.
 *
 * `Item` is `StyledContextMenuItem` or `StyledDropdownMenuItem`; both take the same props, which is
 * why the list above can be written once. A third menu in the future is a third `Item`.
 */
function ActionItems({ actions, Item }: { actions: CreationAction[]; Item: React.ElementType }) {
  return (
    <>
      {actions.map((action) => (
        <Item key={action.id} onClick={action.onSelect}>
          <action.icon aria-hidden />
          {action.label}
        </Item>
      ))}
    </>
  )
}

/**
 * One work, as the library draws it.
 *
 * Exported because a work looks the same wherever it is listed: the project detail page shows the
 * same card, filtered to its own folder and conversations, rather than a second, simpler row that
 * would drift from this one — the poster, the versions menu and the export targets are all here.
 *
 * **Memoised**, and that is a rule for its callers rather than a detail of this component: the
 * list's answer arrives as fresh objects every time a transcript grows (once a second or two while
 * a turn runs), and `useCreations` keeps the old instance for a work that did not change precisely
 * so this comparison can mean something. A card that re-rendered regardless would rebuild ten menu
 * items and eleven translated labels per push for a picture that is already on screen.
 *
 * The two callbacks take the work they are for, so a caller can pass one function for the whole
 * grid instead of a new closure per card per render — a fresh closure would defeat the memo by
 * itself.
 */
export const CreationCard = React.memo(function CreationCard({
  workspaceId,
  creation,
  onOpen,
  onOpenSource,
  onHandOff,
}: {
  workspaceId: string | null | undefined
  creation: Creation
  onOpen: (creation: Creation) => void
  onOpenSource: (creation: Creation) => void
  /** Offer the work to Craft Bot. Omitted where no assistant can be handed anything. */
  onHandOff?: (creation: Creation) => void
}) {
  const { t } = useTranslation()
  const meta = FORMAT_META[creation.format]
  const Icon = meta.icon
  const origin = creation.last
  const gone = !creation.exists
  const { posterUrl, ref } = usePoster(workspaceId, creation)
  const [menuOpen, setMenuOpen] = React.useState(false)

  const [versionsOpen, setVersionsOpen] = React.useState(false)
  const [versions, setVersions] = React.useState<Array<{ id: string; at: number; bytes: number }>>([])
  const [versionsLoading, setVersionsLoading] = React.useState(false)

  /**
   * What this work looked like before.
   *
   * A version is a **copy**: saving one writes the old bytes beside the file, and nothing here
   * overwrites the current one — a write under an open editor is the one this app refuses to make
   * on a person's behalf.
   */
  const openVersions = React.useCallback(async () => {
    if (!workspaceId || gone) return
    setVersionsOpen(true)
    setVersionsLoading(true)
    setVersions([])
    try {
      setVersions(await window.electronAPI.getCreationVersions(workspaceId, creation.path))
    } catch {
      setVersions([])
    } finally {
      setVersionsLoading(false)
    }
  }, [creation.path, gone, workspaceId])

  const saveVersion = React.useCallback(
    async (id: string) => {
      if (!workspaceId) return
      const result = await window.electronAPI.saveCreationVersion(workspaceId, creation.path, id)
      if (result.canceled) return
      if (result.error) toast.error(result.error)
      else if (result.path) toast.success(t('creations.versionSaved', { path: result.path }))
    },
    [creation.path, t, workspaceId],
  )


  const openInWindow = () => {
    if (!workspaceId) return
    void window.electronAPI.openFileWindow(workspaceId, creation.path).catch((err: unknown) => {
      toast.error(t('common.failed'), { description: err instanceof Error ? err.message : String(err) })
    })
  }

  const copyPath = () => {
    void navigator.clipboard.writeText(creation.path).then(
      () => toast.success(t('common.copied')),
      () => undefined,
    )
  }

  /**
   * Export, where the person says — the dialog belongs to the RPC, so this only reports the
   * outcome. Which targets exist comes from the same table the handler validates against.
   */
  const runExport = (target: CreationExportTarget) => {
    if (!workspaceId) return
    void window.electronAPI
      .exportCreation(workspaceId, creation.path, target)
      .then((result) => {
        if (result.canceled) return
        if (result.error) toast.error(t('common.failed'), { description: result.error })
        else toast.success(t('creations.exported'), { description: result.path })
      })
      .catch((err: unknown) => {
        toast.error(t('common.failed'), { description: err instanceof Error ? err.message : String(err) })
      })
  }

  /**
   * One list of actions, two doors onto it.
   *
   * The card answers a right click with a context menu (what the cards do) and the corner
   * with a "more" menu (what every row in settings does). Both are fed from this array, so an
   * action added once appears in both — the alternative is two lists that drift.
   */
  const actions: CreationAction[] = [
    { id: 'open', icon: FolderOpen, label: t('common.open'), onSelect: () => onOpen(creation) },    { id: 'window', icon: AppWindow, label: t('creations.openInWindow'), onSelect: openInWindow },
    {
      id: 'external',
      icon: ExternalLink,
      label: t('creations.openExternal'),
      onSelect: () => void window.electronAPI.openFile(creation.path),
    },
    {
      id: 'folder',
      icon: FolderOpen,
      label: t('creations.showInFolder'),
      onSelect: () => void window.electronAPI.showInFolder(creation.path),
    },
    { id: 'copy', icon: Copy, label: t('creations.copyPath'), onSelect: copyPath },
    // A file found on disk belongs to the folder it sits in; only one with a conversation behind
    // it has somewhere to jump to.
    ...(origin?.sessionId
      ? [{ id: 'source', icon: MessageSquarePlus, label: t('creations.openSource'), onSelect: () => onOpenSource(creation) }]
      : []),
    ...(gone
      ? []
      : [{ id: 'versions', icon: History, label: t('creations.versions'), onSelect: () => void openVersions() }]),
    ...exportTargetsFor(creation.path).map<CreationAction>((target) => ({
      id: `export-${target}`,
      icon: Download,
      label:
        target === 'pdf'
          ? t('creations.exportPdf')
          : target === 'docx'
            ? t('creations.exportDocx')
            : target === 'html'
              ? t('creations.exportHtml')
              : t('creations.exportMd'),
      onSelect: () => runExport(target),
    })),
    ...(onHandOff && !gone
      ? [{ id: 'bot', icon: Bot, label: t('bot.handOff'), onSelect: () => onHandOff(creation) }]
      : []),
  ]

  return (
    <>
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <div
      className="group relative flex flex-col overflow-hidden rounded-[10px] border border-border/60 bg-card text-left shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-all duration-150 hover:border-border hover:shadow-[0_2px_10px_rgba(0,0,0,0.06)]"
    >
      {/* The picture is one way in; the title is the other. Two buttons rather than one wrapping
          both, because the menu belongs *beside the title* and a button cannot contain one. The
          picture is not a tab stop: it does exactly what the title already does. */}
      <button
        type="button"
        onClick={() => onOpen(creation)}
        tabIndex={-1}
        aria-label={creation.title}
        className="block w-full text-left"
      >
        {/* Poster. Its absence is a badge, never a hole: not every format has a picture.
            16:9 is the poster's own shape, so a deck's card is exactly its page — and a document's
            card is the top of its page at full width, not a page shrunk into a letterbox. */}
        <div
          ref={ref}
          className="relative aspect-video w-full overflow-hidden border-b border-border/50 bg-muted/40"
        >
          {posterUrl ? (
            <img
              src={posterUrl}
              alt=""
              aria-hidden
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover object-top"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <Icon className={cn('h-7 w-7 opacity-40', meta.tint)} aria-hidden />
            </div>
          )}
          {/* Format reads like a label at the bottom of the picture. */}
          <span className="absolute bottom-1.5 left-2 rounded-[4px] bg-background/85 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
            {creation.format}
          </span>
          {gone && (
            <span className="absolute inset-0 flex items-center justify-center bg-background/70 text-[11px] font-medium text-muted-foreground">
              {t('creations.gone')}
            </span>
          )}
        </div>
      </button>

      <div className="flex min-w-0 items-start gap-1.5 pr-2">
        <button
          type="button"
          onClick={() => onOpen(creation)}
          className="flex min-w-0 flex-1 flex-col gap-1 py-2.5 pl-3.5 text-left"
        >
          <span className="truncate text-[12.5px] font-medium leading-snug text-foreground" title={creation.path}>
            {creation.title}
          </span>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {/* The project, when the work belongs to one — the same fact the chips filter on, so the
                card and the row above it cannot disagree. Only a work that belongs to no project
                falls back to saying where it came from. */}
            <span className="truncate">
              {creation.projectSlugs[0] ??
                (creation.place === 'session' ? t('creations.placeSession') : t('creations.placeOther'))}
            </span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{gone ? '—' : formatBytes(creation.bytes)}</span>
            <span className="ml-auto shrink-0">
              {relativeTime(creation.mtimeMs || 0, shortTimeLocale as Locale)}
            </span>
          </div>
        </button>

        {/* The menu sits at the title's right edge — on hover, while it is open, and always where
            hover does not exist. */}
        <div
          data-touch-reveal="true"
          className={cn(
            'shrink-0 pt-2 transition-opacity',
            menuOpen ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
          )}
        >
          <DropdownMenu modal onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                aria-label={t('creations.more')}
                title={t('creations.more')}
                className="cursor-pointer rounded-[6px] p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground data-[state=open]:bg-foreground/[0.06]"
              >
                <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
              </div>
            </DropdownMenuTrigger>
            <StyledDropdownMenuContent align="end">
              <DropdownMenuProvider>
                <ActionItems actions={actions} Item={StyledDropdownMenuItem} />
              </DropdownMenuProvider>
            </StyledDropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* A file found on disk belongs to the folder it sits in; only one with a session behind it
          has a conversation to open. */}
      {origin?.sessionId && (
        <button
          type="button"
          onClick={() => onOpenSource(creation)}
          title={t('creations.openSource')}
          className="flex items-center gap-1.5 border-t border-border/50 px-3.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <MessageSquarePlus className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{origin.sessionName ?? origin.sessionId}</span>
        </button>
      )}

    </div>
      </ContextMenuTrigger>
      <StyledContextMenuContent>
        <ActionItems actions={actions} Item={StyledContextMenuItem} />
      </StyledContextMenuContent>
    </ContextMenu>
      <Dialog open={versionsOpen} onOpenChange={setVersionsOpen}>
        <DialogContent className="max-w-[460px]">
          <DialogHeader>
            <DialogTitle>{t('creations.versions')}</DialogTitle>
            <DialogDescription className="truncate">{creation.title}</DialogDescription>
          </DialogHeader>
          {versionsLoading ? (
            <p className="py-4 text-[12.5px] text-muted-foreground">{t('common.loading')}</p>
          ) : versions.length === 0 ? (
            <p className="py-4 text-[12.5px] text-muted-foreground">{t('creations.versionsEmpty')}</p>
          ) : (
            <ul className="max-h-[320px] space-y-1 overflow-y-auto py-1">
              {versions.map((version) => (
                <li
                  key={version.id}
                  className="flex items-center justify-between gap-3 rounded-[7px] px-2 py-1.5 hover:bg-muted/50"
                >
                  <span className="min-w-0">
                    <span className="block text-[12.5px]">
                      {new Date(version.at).toLocaleString(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {formatBytes(version.bytes)}
                    </span>
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void saveVersion(version.id)}>
                    {t('creations.saveVersion')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
})

export function CreationsHome() {
  const { t } = useTranslation()
  const { activeWorkspaceId, onOpenFile, onHandOffToBot } = useAppShellContext()
  const { navigate } = useNavigation()
  const { snapshot, loading, error, refresh } = useCreations(activeWorkspaceId)

  const [formatFilter, setFormatFilter] = React.useState<CreationFormat | 'all'>('all')
  const [projectFilter, setProjectFilter] = useAtom(creationsProjectFilterAtom)
  const [search, setSearch] = React.useState('')

  const projects = useAtomValue(projectsAtom)

  /**
   * How long the first screen took — mount → a painted frame with works in it.
   *
   * Written to the main log because the answer to "opening the library feels slow" is a number
   * nobody can read off the screen: it is this one when it is large and the poster queue when this
   * one is small. It fires once per mount, and a mount with no works yet (a first scan) reports
   * when they arrive.
   */
  const mountedAt = React.useRef(performance.now())
  const reported = React.useRef(false)
  React.useEffect(() => {
    if (reported.current || !snapshot) return
    reported.current = true
    const frame = requestAnimationFrame(() => {
      const ms = performance.now() - mountedAt.current
      void window.electronAPI.debugLog(
        `[creations] first screen ${ms.toFixed(0)} ms · ${snapshot.creations.length} works`,
      )
    })
    return () => cancelAnimationFrame(frame)
  }, [snapshot])
  // Stable across renders: every memo below is keyed on it, and a fresh `[]` each time would
  // recompute all of them on every keystroke in the search box.
  const all = React.useMemo(() => snapshot?.creations ?? [], [snapshot])

  const counts = React.useMemo(() => {
    const map = new Map<CreationFormat, number>()
    for (const creation of all) map.set(creation.format, (map.get(creation.format) ?? 0) + 1)
    return map
  }, [all])

  /**
   * The projects worth offering: those that actually hold works, in the workspace's own order.
   *
   * A project with nothing in it would be a dead end — pick it and the grid empties — so it is left
   * out rather than listed. Selected ones stay whatever happens, so a filter can always be undone
   * from the control itself.
   */
  const projectOptions = React.useMemo<ProjectFilterOption[]>(() => {
    const holders = new Set<string>()
    for (const creation of all) {
      for (const slug of creation.projectSlugs) holders.add(slug)
    }
    return projects
      .filter(
        (project) =>
          holders.has(project.config.slug) || projectFilter.includes(project.config.id)
      )
      .map((project) => ({
        id: project.config.id,
        name: project.config.name,
        color: project.config.color,
      }))
  }, [all, projects, projectFilter])

  // The filter speaks project **ids** (what the board selects); a work knows its projects by
  // **slug** (what a folder and a route are called). This is the one place the two meet.
  const selectedProjectSlugs = React.useMemo(
    () =>
      new Set(
        projects
          .filter((project) => projectFilter.includes(project.config.id))
          .map((project) => project.config.slug)
      ),
    [projects, projectFilter]
  )
  const wantsUnassigned = projectFilter.includes(CREATIONS_UNASSIGNED_PROJECT)

  // A selection made in one workspace means nothing in another, and a deleted project leaves an id
  // that would filter the grid down to nothing. Same pruning the board does, for the same
  // two reasons.
  const previousWorkspaceRef = React.useRef<string | null | undefined>(undefined)
  React.useEffect(() => {
    if (previousWorkspaceRef.current !== activeWorkspaceId) {
      previousWorkspaceRef.current = activeWorkspaceId
      setProjectFilter((previous) => (previous.length > 0 ? [] : previous))
      return
    }
    setProjectFilter((previous) => {
      if (previous.length === 0) return previous
      const live = previous.filter(
        (id) => id === CREATIONS_UNASSIGNED_PROJECT || projects.some((p) => p.config.id === id)
      )
      return live.length === previous.length ? previous : live
    })
  }, [activeWorkspaceId, projects, setProjectFilter])

  const visible = React.useMemo(() => {
    const needle = search.trim().toLowerCase()
    return all.filter((creation) => {
      if (formatFilter !== 'all' && creation.format !== formatFilter) return false
      if (projectFilter.length > 0) {
        const belongs = creation.projectSlugs.some((slug) => selectedProjectSlugs.has(slug))
        const inNoProject = creation.projectSlugs.length === 0
        if (!belongs && !(inNoProject && wantsUnassigned)) return false
      }
      if (needle && !creation.path.toLowerCase().includes(needle)) return false
      return true
    })
  }, [all, formatFilter, projectFilter, selectedProjectSlugs, wantsUnassigned, search])

  const sessionCount = React.useMemo(
    () =>
      new Set(
        all.flatMap((creation) => creation.origins.map((origin) => origin.sessionId)).filter(Boolean),
      ).size,
    [all],
  )

  /**
   * One function per action for the whole grid, not one closure per card per render.
   *
   * `CreationCard` is memoised on its props, and a new closure is a changed prop — the card would
   * re-render on every push even though the work it draws did not change. So the card receives the
   * work and these stay identical for as long as the grid is mounted.
   */
  const openCreation = React.useCallback(
    (creation: Creation) => onOpenFile(creation.path),
    [onOpenFile],
  )
  const openSource = React.useCallback(
    (creation: Creation) => navigate(routes.view.allSessions(creation.last.sessionId)),
    [navigate],
  )

  /**
   * Offer the work to Craft Bot — the path, its title and the conversation that wrote it.
   *
   * The person is looking at the thing they want help with; making them describe it in another
   * panel is the step this removes. Nothing is sent: the brief lands in the Bot's composer.
   */
  const handOffToBot = React.useCallback(
    (creation: Creation) => {
      void onHandOffToBot?.(buildHandoffBrief({
        kind: 'file',
        path: creation.path,
        title: creation.title,
        format: creation.format,
        sessionId: creation.last?.sessionId,
        sessionName: creation.last?.sessionName,
      }))
    },
    [onHandOffToBot],
  )

  const chip = (active: boolean) =>
    cn(
      'rounded-full border px-2.5 py-1 text-[11.5px] transition-colors',
      active
        ? 'border-foreground/20 bg-foreground/[0.06] font-medium text-foreground'
        : 'border-transparent text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-baseline gap-3 px-6 pt-6">
        <h1 className="text-[15px] font-semibold text-foreground">{t('creations.title')}</h1>
        <span className="text-[11.5px] text-muted-foreground">
          {t('creations.subtitle', { works: all.length, sessions: sessionCount })}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          title={t('creations.refresh')}
          className="ml-auto inline-flex items-center gap-1.5 rounded-[7px] px-2 py-1 text-[11.5px] text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
          {t('creations.refresh')}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-6 pb-4 pt-3">
        <button type="button" className={chip(formatFilter === 'all')} onClick={() => setFormatFilter('all')}>
          {t('creations.allFormats')}
        </button>
        {FORMAT_ORDER.filter((format) => counts.has(format) || MEDIA_FORMATS.has(format)).map((format) => (
          <button
            key={format}
            type="button"
            className={chip(formatFilter === format)}
            onClick={() => setFormatFilter(format)}
          >
            {FORMAT_LABEL_KEY[format] ? t(FORMAT_LABEL_KEY[format]!) : format}{' '}
            <span className="opacity-50">{counts.get(format) ?? 0}</span>
          </button>
        ))}

        <span className="mx-1 h-3.5 w-px bg-border" aria-hidden />

        <ProjectMultiSelectFilter
          projects={projectOptions}
          value={projectFilter}
          onChange={setProjectFilter}
          unassignedId={CREATIONS_UNASSIGNED_PROJECT}
        />

        <label className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('creations.search')}
            className="h-7 w-44 rounded-[7px] border border-border/60 bg-background pl-7 pr-2 text-[12px] text-foreground placeholder:text-muted-foreground/70 focus:border-border focus:outline-none"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-[8px] border border-destructive/30 bg-destructive/5 p-3 text-[12px] text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{error}</span>
          </div>
        )}

        {!loading && visible.length === 0 ? (
          <div className="mx-auto mt-16 max-w-md text-center">
            <p className="text-[13px] font-medium text-foreground">{t('creations.emptyTitle')}</p>
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">{t('creations.emptyBody')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
            {visible.map((creation) => (
              <CreationCard
                key={creation.id}
                workspaceId={activeWorkspaceId}
                creation={creation}
                onOpen={openCreation}
                onOpenSource={openSource}
                onHandOff={onHandOffToBot ? handOffToBot : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
