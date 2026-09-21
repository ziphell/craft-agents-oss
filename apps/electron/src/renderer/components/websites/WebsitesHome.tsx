import * as React from 'react'
import { PanelsTopLeft, Plus, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { useAtom, useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { useAppShellContext } from '@/context/AppShellContext'
import { useNavigation } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import { websitesAtom, websitesProjectFilterAtom, PAGES_UNASSIGNED_PROJECT } from '@/atoms/websites'
import { projectsAtom } from '@/atoms/projects'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import {
  ProjectMultiSelectFilter,
  type ProjectFilterOption,
} from '../app-shell/ProjectMultiSelectFilter'
import { WebsiteTile, type WebsiteTileProject } from './WebsiteTile'
import { DeleteWebsiteDialog } from './DeleteWebsiteDialog'
import type { LoadedWebsite } from '@craft-agent/shared/websites/types'

/**
 * Websites library — the full-width home grid (mirrors the Kanban board pane).
 * Header carries the controlled Project filter (with an Unassigned sentinel)
 * and the New Website action; tiles open the embedded website render.
 */
export function WebsitesHome() {
  const { activeWorkspaceId } = useAppShellContext()
  const { t } = useTranslation()
  const { navigate } = useNavigation()
  const websites = useAtomValue(websitesAtom)
  const projects = useAtomValue(projectsAtom)
  const [projectFilter, setProjectFilter] = useAtom(websitesProjectFilterAtom)
  const [pendingDelete, setPendingDelete] = React.useState<LoadedWebsite | null>(null)

  // Keep the (module-global) filter scoped to the current workspace + live
  // projects: clear on workspace switch, prune ids whose project no longer
  // exists. The Unassigned sentinel always survives pruning.
  const prevWorkspaceRef = React.useRef(activeWorkspaceId)
  React.useEffect(() => {
    if (prevWorkspaceRef.current !== activeWorkspaceId) {
      prevWorkspaceRef.current = activeWorkspaceId
      setProjectFilter(prev => (prev.length ? [] : prev))
      return
    }
    setProjectFilter(prev => {
      if (prev.length === 0) return prev
      const live = prev.filter(
        id => id === PAGES_UNASSIGNED_PROJECT || projects.some(p => p.config.id === id),
      )
      return live.length === prev.length ? prev : live
    })
  }, [activeWorkspaceId, projects, setProjectFilter])

  const projectOptions = React.useMemo<ProjectFilterOption[]>(
    () => projects.map(p => ({ id: p.config.id, name: p.config.name, color: p.config.color })),
    [projects],
  )

  const projectsById = React.useMemo(() => {
    const map = new Map<string, WebsiteTileProject>()
    for (const project of projects) {
      map.set(project.config.id, { name: project.config.name, color: project.config.color })
    }
    return map
  }, [projects])

  const visibleWebsites = React.useMemo(() => {
    let list = websites
    if (projectFilter.length > 0) {
      const allow = new Set(projectFilter)
      list = websites.filter(website => {
        const projectId = website.config.projectId
        if (projectId === undefined) return allow.has(PAGES_UNASSIGNED_PROJECT)
        return allow.has(projectId)
      })
    }
    return [...list].sort((a, b) => b.config.updatedAt - a.config.updatedAt)
  }, [websites, projectFilter])

  const openWebsite = React.useCallback(
    (slug: string) => navigate(routes.view.websites(slug)),
    [navigate],
  )

  // Blank website, bound to the first selected (real) project so it stays
  // visible under an active filter — mirrors the board's create behavior.
  const handleCreateWebsite = React.useCallback(async () => {
    if (!activeWorkspaceId) return
    const boundProjectId = projectFilter.find(id => id !== PAGES_UNASSIGNED_PROJECT)
    try {
      const created = await window.electronAPI.createWebsite(activeWorkspaceId, {
        name: t('websites.newWebsite'),
        kind: 'interactive',
        ...(boundProjectId ? { projectId: boundProjectId } : {}),
      })
      navigate(routes.view.websites(created.slug))
    } catch (err) {
      toast.error(t('toast.websiteCreateFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, projectFilter, t, navigate])

  const handleAskAgent = React.useCallback(() => {
    navigate(routes.action.newSession({ input: t('websites.askAgentPrompt') }))
  }, [navigate, t])

  const handleConfirmDelete = React.useCallback(async () => {
    if (!activeWorkspaceId || !pendingDelete) return
    const { slug, name } = pendingDelete.config
    setPendingDelete(null)
    try {
      const result = await window.electronAPI.deleteWebsite(activeWorkspaceId, slug)
      if (result?.publicCopyMayRemain) {
        toast.warning(t('toast.websiteDeleted', { name }), {
          description: t('toast.websitePublicCopyMayRemain'),
        })
      } else {
        toast.success(t('toast.websiteDeleted', { name }))
      }
    } catch (err) {
      toast.error(t('toast.websiteDeleteFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, pendingDelete, t])

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Sticky header: title + count, project filter, primary action */}
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="text-sm font-medium">{t('sidebar.websites')}</span>
          <span className="text-xs text-foreground/40">{websites.length}</span>
          {(projectOptions.length > 0 || projectFilter.length > 0) && (
            <ProjectMultiSelectFilter
              projects={projectOptions}
              value={projectFilter}
              onChange={setProjectFilter}
              unassignedId={PAGES_UNASSIGNED_PROJECT}
            />
          )}
        </div>
        <button
          type="button"
          onClick={handleCreateWebsite}
          disabled={!activeWorkspaceId}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12.5px] font-semibold text-foreground transition-colors hover:bg-foreground/[0.03] disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> {t('websites.newWebsite')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {websites.length === 0 ? (
          <EntityListEmptyScreen
            icon={<PanelsTopLeft />}
            title={t('websites.emptyTitle')}
            description={t('websites.emptyDescription')}
          >
            <button
              onClick={handleAskAgent}
              className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
            >
              <Sparkles className="h-3.5 w-3.5" /> {t('websites.askAgent')}
            </button>
            <button
              onClick={handleCreateWebsite}
              className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
            >
              <Plus className="h-3.5 w-3.5" /> {t('websites.createBlank')}
            </button>
          </EntityListEmptyScreen>
        ) : visibleWebsites.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-foreground/50">
            {t('websites.noMatches')}
          </div>
        ) : (
          <div className="mx-auto grid w-full max-w-[1440px] grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 p-5">
            {visibleWebsites.map(website => (
              <WebsiteTile
                key={website.config.id}
                website={website}
                project={website.config.projectId ? projectsById.get(website.config.projectId) : undefined}
                onOpen={() => openWebsite(website.config.slug)}
                onDelete={() => setPendingDelete(website)}
              />
            ))}
          </div>
        )}
      </div>

      <DeleteWebsiteDialog
        websiteName={pendingDelete?.config.name ?? null}
        shared={Boolean(pendingDelete?.config.share)}
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}
