import * as React from 'react'
import { PanelsTopLeft, Plus, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { useAtom, useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { useAppShellContext } from '@/context/AppShellContext'
import { useNavigation } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import { designsAtom, designsProjectFilterAtom, PAGES_UNASSIGNED_PROJECT } from '@/atoms/designs'
import { projectsAtom } from '@/atoms/projects'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import {
  ProjectMultiSelectFilter,
  type ProjectFilterOption,
} from '../app-shell/ProjectMultiSelectFilter'
import { DesignTile, type DesignTileProject } from './DesignTile'
import { DeleteDesignDialog } from './DeleteDesignDialog'
import type { LoadedDesign } from '@craft-agent/shared/designs/types'
import type { DesignKind } from '@craft-agent/shared/designs/types'

/** The kind chips, in the order a person reads them. */
const KIND_FILTERS: ReadonlyArray<DesignKind | 'all'> = ['all', 'prototype', 'dashboard', 'deck', 'motion']

/**
 * Designs library — the full-width home grid (mirrors the Kanban board pane).
 * Header carries the controlled Project filter (with an Unassigned sentinel)
 * and the New Design action; tiles open the embedded design render.
 */
export function DesignsHome() {
  const { activeWorkspaceId, onOpenFile } = useAppShellContext()
  const { t } = useTranslation()
  const { navigate } = useNavigation()
  const designs = useAtomValue(designsAtom)
  const projects = useAtomValue(projectsAtom)
  const [projectFilter, setProjectFilter] = useAtom(designsProjectFilterAtom)
  const [pendingDelete, setPendingDelete] = React.useState<LoadedDesign | null>(null)
  const [kindFilter, setKindFilter] = React.useState<DesignKind | 'all'>('all')

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
    const map = new Map<string, DesignTileProject>()
    for (const project of projects) {
      map.set(project.config.id, { name: project.config.name, color: project.config.color })
    }
    return map
  }, [projects])

  const visibleDesigns = React.useMemo(() => {
    let list = designs
    // The two filters are independent and combine: a kind and a project at once
    // says "the decks in this project".
    if (kindFilter !== 'all') {
      list = list.filter(design => design.config.kind === kindFilter)
    }
    if (projectFilter.length > 0) {
      const allow = new Set(projectFilter)
      list = list.filter(design => {
        const projectId = design.config.projectId
        if (projectId === undefined) return allow.has(PAGES_UNASSIGNED_PROJECT)
        return allow.has(projectId)
      })
    }
    return [...list].sort((a, b) => b.config.updatedAt - a.config.updatedAt)
  }, [designs, kindFilter, projectFilter])

  const openDesign = React.useCallback(
    (slug: string) => navigate(routes.view.designs(slug)),
    [navigate],
  )

  // Blank design, bound to the first selected (real) project so it stays
  // visible under an active filter — mirrors the board's create behavior.
  const handleCreateDesign = React.useCallback(async () => {
    if (!activeWorkspaceId) return
    const boundProjectId = projectFilter.find(id => id !== PAGES_UNASSIGNED_PROJECT)
    try {
      const created = await window.electronAPI.createDesign(activeWorkspaceId, {
        name: t('designs.newDesign'),
        ...(boundProjectId ? { projectId: boundProjectId } : {}),
      })
      navigate(routes.view.designs(created.slug))
    } catch (err) {
      toast.error(t('toast.designCreateFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, projectFilter, t, navigate])

  const handleAskAgent = React.useCallback(() => {
    navigate(routes.action.newSession({ input: t('designs.askAgentPrompt') }))
  }, [navigate, t])

  // The design's folder is the truth and the agent already has get_design/update_design
  // in every conversation — so this hands over a reference (name + slug), not a copy of
  // the markup, and starts a new conversation on it (same as DesignView's own entry).
  const handleContinueInChat = React.useCallback((design: LoadedDesign) => {
    navigate(routes.action.newSession({
      input: t('designs.continueInChatPrompt', {
        name: design.config.name,
        slug: design.config.slug,
      }),
    }))
  }, [navigate, t])

  const handleConfirmDelete = React.useCallback(async () => {
    if (!activeWorkspaceId || !pendingDelete) return
    const { slug, name } = pendingDelete.config
    setPendingDelete(null)
    try {
      const result = await window.electronAPI.deleteDesign(activeWorkspaceId, slug)
      if (result?.publicCopyMayRemain) {
        toast.warning(t('toast.designDeleted', { name }), {
          description: t('toast.designPublicCopyMayRemain'),
        })
      } else {
        toast.success(t('toast.designDeleted', { name }))
      }
    } catch (err) {
      toast.error(t('toast.designDeleteFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, pendingDelete, t])

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Sticky header: title + count, project filter, primary action */}
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="text-sm font-medium">{t('sidebar.designs')}</span>
          <span className="text-xs text-foreground/40">{designs.length}</span>
          {(projectOptions.length > 0 || projectFilter.length > 0) && (
            <ProjectMultiSelectFilter
              projects={projectOptions}
              value={projectFilter}
              onChange={setProjectFilter}
              unassignedId={PAGES_UNASSIGNED_PROJECT}
            />
          )}
          <span className="flex items-center gap-0.5" role="group" aria-label={t('designs.kind.all')}>
            {KIND_FILTERS.map(kind => (
              <button
                key={kind}
                type="button"
                aria-pressed={kindFilter === kind}
                onClick={() => setKindFilter(kind)}
                className={cn(
                  'h-6 rounded-md border px-2 text-[11.5px] transition-colors',
                  kindFilter === kind
                    ? 'border-foreground/20 bg-foreground/[0.06] font-medium text-foreground'
                    : 'border-transparent text-foreground/55 hover:bg-foreground/[0.04]',
                )}
              >
                {t(`designs.kind.${kind}`)}
              </button>
            ))}
          </span>
        </div>
        <button
          type="button"
          onClick={handleCreateDesign}
          disabled={!activeWorkspaceId}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12.5px] font-semibold text-foreground transition-colors hover:bg-foreground/[0.03] disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> {t('designs.newDesign')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {designs.length === 0 ? (
          <EntityListEmptyScreen
            icon={<PanelsTopLeft />}
            title={t('designs.emptyTitle')}
            description={t('designs.emptyDescription')}
          >
            <button
              onClick={handleAskAgent}
              className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
            >
              <Sparkles className="h-3.5 w-3.5" /> {t('designs.askAgent')}
            </button>
            <button
              onClick={handleCreateDesign}
              className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
            >
              <Plus className="h-3.5 w-3.5" /> {t('designs.createBlank')}
            </button>
          </EntityListEmptyScreen>
        ) : visibleDesigns.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-foreground/50">
            {t('designs.noMatches')}
          </div>
        ) : (
          <div className="mx-auto grid w-full max-w-[1440px] grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 p-5">
            {activeWorkspaceId !== null &&
              visibleDesigns.map(design => (
                <DesignTile
                  key={design.config.id}
                  design={design}
                  workspaceId={activeWorkspaceId}
                  project={design.config.projectId ? projectsById.get(design.config.projectId) : undefined}
                  onOpen={() => openDesign(design.config.slug)}
                  onDelete={() => setPendingDelete(design)}
                  onContinueInChat={() => handleContinueInChat(design)}
                  onOpenFolder={() => onOpenFile(design.folderPath)}
                />
              ))}
          </div>
        )}
      </div>

      <DeleteDesignDialog
        designName={pendingDelete?.config.name ?? null}
        shared={Boolean(pendingDelete?.config.share)}
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}
