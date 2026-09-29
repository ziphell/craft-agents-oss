import * as React from 'react'
import {
  Check,
  Download,
  ExternalLink,
  FolderKanban,
  FolderOpen,
  MoreHorizontal,
  PanelsTopLeft,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useAppShellContext } from '@/context/AppShellContext'
import { useNavigation } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import {
  DropdownMenu,
  DropdownMenuSub,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubContent,
  StyledDropdownMenuSubTrigger,
} from '@/components/ui/styled-dropdown'
import type { LoadedWebsite } from '@craft-agent/shared/websites/types'
import { WebsiteFreshness } from './website-visuals'
import { RenameWebsiteDialog } from './RenameWebsiteDialog'
import { useInView } from '@/hooks/useInView'

export interface WebsiteTileProject {
  name: string
  color?: string
}

interface WebsiteTileProjectOption extends WebsiteTileProject {
  id: string
}

interface WebsiteTileProps {
  website: LoadedWebsite
  /** Resolved owning project (undefined when the website is unassigned) */
  project?: WebsiteTileProject
  /** Every project, for the card's "Move to project" submenu */
  projects: WebsiteTileProjectOption[]
  onOpen: () => void
  onExport: () => void
  onDelete: () => void
}

/**
 * One tile in the Websites library grid. Shows the cached preview poster when one
 * is fresh (lazily fetched once the tile scrolls into view); otherwise falls
 * back to a quiet glyph placeholder. "Fresh" = the poster's digest matches the
 * current content digest, mirroring `isThumbnailFresh` server-side (inlined
 * here — the renderer must not import Node-backed `@craft-agent/shared` code).
 *
 * The card is the website's only surface: clicking it opens the site in the
 * browser window, where a page belongs, and the whole action menu (a website has
 * no second-level page) sits at its bottom-right with the status/time indicator
 * at the bottom-left. A website with no content yet has nothing to open, so its
 * card is not a click target at all — the one action it has (have an agent design
 * it) sits in the middle of it. Once it has content, that same action is in the
 * menu instead, with a prompt that continues what exists rather than writing from
 * nothing.
 */
export function WebsiteTile({ website, project, projects, onOpen, onExport, onDelete }: WebsiteTileProps) {
  const { t } = useTranslation()
  const { activeWorkspaceId, onOpenFile } = useAppShellContext()
  const { navigate } = useNavigation()
  const { config } = website
  const accent = project?.color
  const hasContent = Boolean(config.contentDigest)

  const posterDigest =
    config.thumbnail && config.contentDigest && config.thumbnail.digest === config.contentDigest
      ? config.contentDigest
      : null
  // A re-shoot keeps the same digest (the content did not change), so the capture
  // time is what tells this card the poster is a new picture and must be re-read.
  const posterCapturedAt = config.thumbnail?.capturedAt

  const [thumbRef, inView] = useInView<HTMLDivElement>()
  const [posterUrl, setPosterUrl] = React.useState<string | null>(null)

  React.useEffect(() => {
    // Reset when the website has no fresh poster (e.g. content just changed).
    if (!posterDigest) {
      setPosterUrl(null)
      return
    }
    // `activeWorkspaceId` (the workspace's own id), not `website.workspaceId`:
    // the latter is the website folder's parent name (its basename), which the
    // RPCs do not resolve.
    if (!activeWorkspaceId || !inView) return
    let cancelled = false
    void window.electronAPI
      .getWebsiteThumbnail(activeWorkspaceId, config.slug)
      .then((result) => {
        // Guard against a stale response after another content change.
        if (!cancelled && result && result.digest === posterDigest) setPosterUrl(result.dataUrl)
      })
      .catch(() => { /* posterless → placeholder stays */ })
    return () => { cancelled = true }
  }, [activeWorkspaceId, config.slug, posterDigest, posterCapturedAt, inView])

  const handleRefreshPreview = React.useCallback(() => {
    if (!activeWorkspaceId) return
    void window.electronAPI
      .regenerateWebsiteThumbnail(activeWorkspaceId, config.slug)
      .then((queued) => {
        if (queued) toast.success(t('toast.websitePreviewQueued'))
        else toast.error(t('toast.websitePreviewFailed'))
      })
      .catch(() => toast.error(t('toast.websitePreviewFailed')))
  }, [activeWorkspaceId, config.slug, t])

  const handleOpenFolder = React.useCallback(() => {
    onOpenFile(website.folderPath)
  }, [onOpenFile, website.folderPath])

  const moveToProject = React.useCallback(async (projectId: string | null) => {
    if (!activeWorkspaceId) return
    if ((config.projectId ?? null) === projectId) return
    try {
      // Explicit null clears the binding (updateWebsite normalizes null → absent).
      await window.electronAPI.updateWebsite(activeWorkspaceId, config.slug, { projectId })
    } catch (err) {
      toast.error(t('toast.websiteUpdateFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, config.slug, config.projectId, t])

  const [renameOpen, setRenameOpen] = React.useState(false)

  const handleRename = React.useCallback(async (name: string) => {
    setRenameOpen(false)
    if (!activeWorkspaceId || name === config.name) return
    try {
      await window.electronAPI.updateWebsite(activeWorkspaceId, config.slug, { name })
    } catch (err) {
      toast.error(t('toast.websiteUpdateFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, config.slug, config.name, t])

  // One action, two prompts: a website with no content is asking to be written,
  // one that already has content is asking to be taken further.
  const handleDesignWithAgent = React.useCallback(() => {
    const input = hasContent
      ? t('websites.continueWithAgentPrompt', { name: config.name, slug: config.slug })
      : t('websites.designWithAgentPrompt', { name: config.name, slug: config.slug })
    navigate(routes.action.newSession({ input }))
  }, [hasContent, config.name, config.slug, navigate, t])

  const cardClass = cn(
    'relative flex h-full w-full flex-col overflow-hidden rounded-xl border border-foreground/[0.08] bg-card text-left shadow-minimal',
    hasContent && 'transition-colors duration-150 hover:border-foreground/20 hover:bg-foreground/[0.02]',
  )

  return (
    <div className={cn('group', cardClass)}>
      {/* The card is the click target; the menu in the footer sits above it
          (z-10 vs z-1) so both can be real buttons rather than nested ones. */}
      {hasContent && (
        <button
          type="button"
          onClick={onOpen}
          aria-label={config.name}
          className="absolute inset-0 z-[1] cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        />
      )}

      {/* Project accent: hairline + dot, never a full-card tint */}
      {accent && (
        <span
          className="absolute inset-x-0 top-0 h-[2px]"
          style={{ backgroundColor: accent }}
          aria-hidden
        />
      )}

      {/* Preview poster when fresh, else the deterministic placeholder (16:10, visual inset) */}
      <div className="p-3 pb-0">
        <div
          ref={thumbRef}
          className="relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded-lg bg-foreground/[0.03]"
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
          ) : hasContent ? (
            <>
              <PanelsTopLeft className="absolute h-6 w-6 text-foreground/25" strokeWidth={1.75} aria-hidden />
              <span
                className="absolute -right-4 -top-4 h-16 w-16 rounded-full border border-foreground/[0.05]"
                aria-hidden
              />
              <span
                className="absolute -bottom-6 -left-2 h-14 w-24 rounded-full border border-foreground/[0.04]"
                aria-hidden
              />
            </>
          ) : (
            /* Nothing to open yet, so the card's one action sits in the middle of it */
            <button
              type="button"
              onClick={handleDesignWithAgent}
              className="absolute z-10 inline-flex h-7 items-center gap-1.5 rounded-[8px] border border-primary-foreground/25 bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t('websites.designWithAgent')}
            </button>
          )}
        </div>
      </div>

      {/* Footer: title, then status/time at the left and the actions at the right */}
      <div className="flex min-w-0 flex-col gap-1 px-3.5 py-3">
        <span className="truncate text-[13px] font-semibold text-foreground">{config.name}</span>
        <div className="flex min-w-0 items-center gap-2">
          {project && (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-foreground/50">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: project.color ?? 'var(--muted-foreground)' }}
                aria-hidden
              />
              <span className="truncate">{project.name}</span>
            </span>
          )}
          <WebsiteFreshness config={config} />

          {/* The card's whole action menu — a website has no second-level page.
              Everything that needs content (open, design, export, refresh) waits
              until there is some, so nothing in here is a dead click. */}
          <div className="relative z-10 ml-auto flex shrink-0 items-center">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('common.more')}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground data-[state=open]:bg-foreground/5"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <StyledDropdownMenuContent align="end">
                {hasContent && (
                  <StyledDropdownMenuItem onClick={onOpen}>
                    <ExternalLink />
                    {t('websites.openInWindow')}
                  </StyledDropdownMenuItem>
                )}
                <StyledDropdownMenuItem onClick={() => setRenameOpen(true)}>
                  <Pencil />
                  {t('websites.renameWebsite')}
                </StyledDropdownMenuItem>
                {projects.length > 0 && (
                  <DropdownMenuSub>
                    <StyledDropdownMenuSubTrigger>
                      <FolderKanban className="h-3.5 w-3.5" />
                      <span className="flex-1">{t('websites.moveToProject')}</span>
                    </StyledDropdownMenuSubTrigger>
                    <StyledDropdownMenuSubContent>
                      <StyledDropdownMenuItem onClick={() => void moveToProject(null)}>
                        {!config.projectId && <Check className="h-3.5 w-3.5" />}
                        <span className={config.projectId ? 'flex-1 ml-[18px]' : 'flex-1'}>
                          {t('sessionMenu.noProject')}
                        </span>
                      </StyledDropdownMenuItem>
                      <StyledDropdownMenuSeparator />
                      {projects.map(p => {
                        const isBound = config.projectId === p.id
                        return (
                          <StyledDropdownMenuItem key={p.id} onClick={() => void moveToProject(p.id)}>
                            {isBound && <Check className="h-3.5 w-3.5" />}
                            <span className={isBound ? 'flex-1' : 'flex-1 ml-[18px]'}>{p.name}</span>
                          </StyledDropdownMenuItem>
                        )
                      })}
                    </StyledDropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <StyledDropdownMenuItem onClick={handleOpenFolder}>
                  <FolderOpen />
                  {t('websites.openFolder')}
                </StyledDropdownMenuItem>
                {hasContent && (
                  <>
                    <StyledDropdownMenuItem onClick={handleDesignWithAgent}>
                      <Sparkles />
                      {t('websites.designWithAgent')}
                    </StyledDropdownMenuItem>
                    <StyledDropdownMenuItem onClick={onExport}>
                      <Download />
                      {t('websites.exportCopy')}
                    </StyledDropdownMenuItem>
                    <StyledDropdownMenuItem onClick={handleRefreshPreview}>
                      <RefreshCw />
                      {t('websites.refreshPreview')}
                    </StyledDropdownMenuItem>
                  </>
                )}
                <StyledDropdownMenuItem variant="destructive" onClick={onDelete}>
                  <Trash2 />
                  {t('websites.deleteWebsite')}
                </StyledDropdownMenuItem>
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <RenameWebsiteDialog
        websiteName={renameOpen ? config.name : null}
        onSubmit={name => void handleRename(name)}
        onCancel={() => setRenameOpen(false)}
      />
    </div>
  )
}
