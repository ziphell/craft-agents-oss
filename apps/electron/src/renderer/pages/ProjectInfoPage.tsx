/**
 * ProjectInfoPage
 *
 * Workspace-project detail page with three tabs: Sessions, Creations, Settings.
 *
 * The asset library is not one of them: it is the project's media, which a person browses beside a
 * conversation, so it opens as its own tab of the side panel (`PROJECT_ASSETS_PATH`) rather than a
 * second-level tab inside this page.
 *
 * The **Creations** tab lists the works the agent produced for this project. Creations are
 * derived, never registered (`@craft-agent/shared/creations`): a file is listed because a
 * transcript named it and it is still on disk. "This project's" is therefore two existing facts
 * rather than a field — the file sits in the project's own folder, or one of the project's own
 * conversations wrote it — so nothing is bound here and nothing can go stale.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FolderKanban, FolderOpen, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useActiveWorkspace, useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { browserProfilesAtom, refreshBrowserProfilesAtom } from '@/atoms/browser-profiles'
import { windowIsRemoteAtom } from '@/atoms/window-mode'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { SettingsMenuSelect } from '@/components/settings'
import { CreationCard } from '@/components/creations/CreationsHome'
import { useCreations } from '@/hooks/useCreations'
import type { Creation } from '@craft-agent/shared/creations/types'
import {
  Info_Page,
  Info_Section,
  Info_Table,
} from '@/components/info'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { PROJECT_COLOR_PALETTE } from '@/utils/project-colors'
import { InlineColorPickerRow } from '@/components/ui/inline-color-picker-row'
import type { LoadedProject } from '@craft-agent/shared/projects/types'

interface ProjectInfoPageProps {
  projectSlug: string
  /**
   * Drawn inside a panel whose own tab strip is the title bar (the side panel): the page header
   * would be a second title saying the same name, so it is left to the host.
   */
  embedded?: boolean
}

type TabKey = 'sessions' | 'creations' | 'settings'

export default function ProjectInfoPage({ projectSlug, embedded = false }: ProjectInfoPageProps) {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const { onCreateSession } = useAppShellContext()

  const browserProfiles = useAtomValue(browserProfilesAtom)
  const refreshBrowserProfiles = useSetAtom(refreshBrowserProfilesAtom)
  // A remote window's project folder is on the hub: browsing and opening must happen there.
  const isRemoteWindow = useAtomValue(windowIsRemoteAtom)

  useEffect(() => {
    void refreshBrowserProfiles()
  }, [refreshBrowserProfiles])

  const [project, setProject] = useState<LoadedProject | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('sessions')
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editWorkingDir, setEditWorkingDir] = useState('')
  const [editBrowserProfile, setEditBrowserProfile] = useState('')
  const [editDetails, setEditDetails] = useState('')
  const [editColor, setEditColor] = useState<string>('')
  const [saving, setSaving] = useState(false)

  // A saved pick may name a profile that has since been deleted. The picker only lists what exists,
  // so show the inherited (empty) choice rather than a value with no matching option.
  useEffect(() => {
    if (!editBrowserProfile || browserProfiles.length === 0) return
    if (!browserProfiles.some((profile) => profile.id === editBrowserProfile)) {
      setEditBrowserProfile('')
    }
  }, [browserProfiles, editBrowserProfile])

  // Load project (and re-load on broadcast)
  const loadProject = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.getProject(workspaceId, projectSlug)
      if (!result) {
        setError(t('projectInfo.notFound'))
        setProject(null)
        return
      }
      const loaded = result as LoadedProject
      setProject(loaded)
      setEditName(loaded.config.name)
      setEditDescription(loaded.config.description ?? '')
      setEditWorkingDir(loaded.config.workingDirectory ?? '')
      setEditBrowserProfile(loaded.config.browserProfile ?? '')
      setEditDetails(loaded.config.details ?? '')
      setEditColor(loaded.config.color ?? '')
    } catch (err) {
      console.error('[ProjectInfoPage] Failed to load project:', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workspaceId, projectSlug, t])

  useEffect(() => {
    loadProject()
  }, [loadProject])

  useEffect(() => {
    if (!workspaceId) return
    const off = window.electronAPI.onProjectsChanged((wsId: string) => {
      if (wsId === workspaceId) loadProject()
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [workspaceId, loadProject])

  const projectSessions = useMemo(() => {
    if (!project) return []
    const result: { id: string; name: string }[] = []
    for (const meta of sessionMetaMap.values()) {
      if ((meta as { projectId?: string }).projectId === project.config.id) {
        result.push({ id: meta.id, name: meta.name ?? meta.id })
      }
    }
    return result
  }, [project, sessionMetaMap])

  const handleStartSession = useCallback(async () => {
    if (!workspaceId || !project) return
    try {
      const session = await onCreateSession(workspaceId, { projectId: project.config.id })
      if (session?.id) {
        navigate(routes.view.allSessions(session.id))
      }
    } catch (err) {
      console.error('[ProjectInfoPage] Failed to create session:', err)
      toast.error(t('projectInfo.newSessionFailed'))
    }
  }, [workspaceId, project, onCreateSession, t])

  // The picker is the server's in a remote window (its folders are there) and the native dialog
  // locally — the same helper the new-workspace flow uses.
  const {
    pickDirectory: pickWorkingDirectory,
    showServerBrowser,
    serverBrowserMode,
    cancelServerBrowser,
    confirmServerBrowser,
  } = useDirectoryPicker(useCallback((path: string) => setEditWorkingDir(path), []))

  const handlePickWorkingDirectory = useCallback(() => {
    pickWorkingDirectory()
  }, [pickWorkingDirectory])

  const handleSaveSettings = useCallback(async () => {
    if (!workspaceId || !project) return
    setSaving(true)
    try {
      await window.electronAPI.updateProject(workspaceId, project.config.slug, {
        name: editName.trim() || project.config.name,
        // Optional text goes as the trimmed value, so an emptied field arrives as '' — which
        // the writer reads as "clear". Sending `undefined` would say nothing: the transport is
        // JSON, which drops undefined keys, and the old value would come straight back.
        description: editDescription.trim(),
        workingDirectory: editWorkingDir.trim(),
        browserProfile: editBrowserProfile.trim(),
        details: editDetails.trim(),
        color: editColor.trim(),
      })
      toast.success(t('projectInfo.saved'))
    } catch (err) {
      console.error('[ProjectInfoPage] Save failed:', err)
      toast.error(t('projectInfo.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [workspaceId, project, editName, editDescription, editWorkingDir, editBrowserProfile, editDetails, editColor, t])

  const handleDeleteProject = useCallback(async () => {
    if (!workspaceId || !project) return
    if (!window.confirm(t('projectInfo.deleteConfirm', { name: project.config.name }))) return
    try {
      await window.electronAPI.deleteProject(workspaceId, project.config.slug)
      navigate(routes.view.projects())
    } catch (err) {
      console.error('[ProjectInfoPage] Delete failed:', err)
      toast.error(t('projectInfo.deleteFailed'))
    }
  }, [workspaceId, project, t])

  return (
    <Info_Page
      loading={loading}
      error={error ?? undefined}
      empty={!project && !loading && !error ? t('projectInfo.notFound') : undefined}
    >
      {!embedded && <Info_Page.Header title={project?.config.name ?? ''} />}
      {project && (
        <Info_Page.Content>
          <Info_Page.Hero
            avatar={<FolderKanban className="h-6 w-6 text-foreground/60" />}
            title={project.config.name}
            tagline={project.config.description ?? t('projectInfo.taglineFallback')}
          />

          {/* Tab bar */}
          <div className="flex items-center gap-1 border-b border-border/50 px-2 mb-4">
            <TabButton active={tab === 'sessions'} onClick={() => setTab('sessions')}>
              {t('projectInfo.tabSessions')}
            </TabButton>
            <TabButton active={tab === 'creations'} onClick={() => setTab('creations')}>
              {t('projectInfo.tabCreations')}
            </TabButton>
            <TabButton active={tab === 'settings'} onClick={() => setTab('settings')}>
              {t('projectInfo.tabSettings')}
            </TabButton>
          </div>

          {/* Sessions tab */}
          {tab === 'sessions' && (
            <Info_Section
              title={t('projectInfo.tabSessions')}
              actions={
                <Button size="sm" variant="ghost" onClick={handleStartSession}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  {t('projectInfo.newSessionButton', { name: project.config.name })}
                </Button>
              }
            >
              {projectSessions.length === 0 ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  {t('projectInfo.noSessions')}
                </div>
              ) : (
                <ul className="divide-y divide-border/50">
                  {projectSessions.map((s) => (
                    <li key={s.id} className="px-4 py-2">
                      <button
                        type="button"
                        className="text-sm text-foreground hover:underline text-left"
                        onClick={() => navigate(routes.view.allSessions(s.id))}
                      >
                        {s.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Info_Section>
          )}

          {/* Creations tab — what the agent made for this project, in the library's own card.
              Nothing here writes anything: the filter is two facts that already exist (the
              project's folder, the project's conversations), so there is no binding to keep in
              step and a work that is deleted simply stops being listed. */}
          {tab === 'creations' && (
            <Info_Section title={t('projectInfo.tabCreations')}>
              <ProjectCreationsGrid workspaceId={workspaceId} projectSlug={projectSlug} />
            </Info_Section>
          )}

          {/* Settings tab */}
          {tab === 'settings' && (
            <Info_Section title={t('projectInfo.tabSettings')}>
              <div className="space-y-4 px-4 py-3">
                <Field label={t('projectInfo.title')}>
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder={project.config.name}
                  />
                </Field>
                <Field label={t('projectInfo.description')}>
                  <Input
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder={t('projectInfo.descriptionPlaceholder')}
                  />
                </Field>
                <Field label={t('projectInfo.workingDirectory')}>
                  <div className="flex gap-2">
                    <Input
                      value={editWorkingDir}
                      onChange={(e) => setEditWorkingDir(e.target.value)}
                      // Left empty, a session in this project works in the project's own
                      // folder — so the folder is what the field falls back to, shown as
                      // the placeholder rather than written in, which would pin it.
                      placeholder={project.folderPath}
                      className="flex-1"
                    />
                    <Button size="sm" variant="outline" onClick={handlePickWorkingDirectory}>
                      <FolderOpen className="h-3.5 w-3.5 mr-1" />
                      {t('projectInfo.workingDirectoryPicker')}
                    </Button>
                  </div>
                </Field>
                <Field
                  label={t('projectInfo.browserProfile')}
                  hint={t('projectInfo.browserProfileHint')}
                >
                  <SettingsMenuSelect
                    value={editBrowserProfile}
                    onValueChange={setEditBrowserProfile}
                    options={[
                      { value: '', label: t('projectInfo.browserProfileInherit') },
                      ...browserProfiles.map((profile) => ({ value: profile.id, label: profile.name })),
                    ]}
                    className="w-full justify-between"
                    menuWidth={240}
                  />
                </Field>
                <Field
                  label={t('projectInfo.color')}
                  hint={t('projectInfo.colorHint')}
                >
                  <InlineColorPickerRow
                    value={editColor}
                    onChange={setEditColor}
                    presets={PROJECT_COLOR_PALETTE}
                    onClear={() => setEditColor('')}
                    clearLabel={t('projectInfo.colorClear')}
                    customAriaLabel={t('projectInfo.colorCustom')}
                  />
                </Field>
                <Field
                  label={t('projectInfo.details')}
                  hint={t('projectInfo.detailsHelpText')}
                >
                  <Textarea
                    value={editDetails}
                    onChange={(e) => setEditDetails(e.target.value)}
                    rows={6}
                    placeholder={t('projectInfo.detailsPlaceholder')}
                  />
                </Field>
                <div className="flex justify-between pt-2">
                  <Button
                    variant="ghost"
                    onClick={handleDeleteProject}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    {t('projectInfo.deleteProject')}
                  </Button>
                  <Button onClick={handleSaveSettings} disabled={saving}>
                    {saving ? t('common.saving') : t('common.save')}
                  </Button>
                </div>
              </div>
            </Info_Section>
          )}

          {/* Metadata read-out for quick reference */}
          <Info_Section title={t('projectInfo.metadata')}>
            <Info_Table>
              <Info_Table.Row label={t('common.slug')} value={project.config.slug} />
              <Info_Table.Row label={t('common.location')}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="flex-1 min-w-0 truncate font-mono text-xs">{project.folderPath}</span>
                  {!isRemoteWindow && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => window.electronAPI.openFile(project.folderPath)}
                          className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded text-foreground/50 hover:text-foreground hover:bg-foreground/5 transition-colors"
                          aria-label={t('projectInfo.openLocation')}
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{t('projectInfo.openLocation')}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </Info_Table.Row>
            </Info_Table>
          </Info_Section>
        </Info_Page.Content>
      )}
      <ServerDirectoryBrowser
        open={showServerBrowser}
        mode={serverBrowserMode}
        onSelect={confirmServerBrowser}
        onCancel={cancelServerBrowser}
      />
    </Info_Page>
  )
}

/**
 * The works this project produced.
 *
 * Mounted only while its tab is open, because `useCreations` keeps the library current — a push
 * whenever a transcript grows, a warm poll while the document is visible. A page that is on
 * another tab should not be re-scanning for work nobody is looking at.
 *
 * "This project's" is one fact the index already folded (`projectSlugs`): the project whose folder
 * holds the file, and the project each conversation that wrote it belongs to. Nothing is computed
 * here — the filter the library offers and this tab are the same answer, read the same way, so the
 * two can never disagree about which project a work is in.
 */
function ProjectCreationsGrid({
  workspaceId,
  projectSlug,
}: {
  workspaceId: string | undefined
  projectSlug: string
}) {
  const { t } = useTranslation()
  const { onOpenFile } = useAppShellContext()
  const { snapshot, error } = useCreations(workspaceId)

  const visible = useMemo(() => {
    const all = snapshot?.creations ?? []
    return all
      .filter((creation) => creation.projectSlugs.includes(projectSlug))
      .sort((a, b) => b.last.at - a.last.at)
  }, [snapshot, projectSlug])

  // Stable, so the memoised card is not re-rendered by a fresh closure (see `CreationCard`).
  const openCreation = useCallback((creation: Creation) => onOpenFile(creation.path), [onOpenFile])
  const openSource = useCallback(
    (creation: Creation) => navigate(routes.view.allSessions(creation.last.sessionId)),
    [navigate],
  )

  if (error) {
    return <div className="px-4 py-6 text-sm text-destructive">{error}</div>
  }
  if (!snapshot) return null
  if (visible.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground">
        {t('projectInfo.noCreations')}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 p-4">
      {visible.map((creation) => (
        <CreationCard
          key={creation.id}
          workspaceId={workspaceId}
          creation={creation}
          onOpen={openCreation}
          onOpenSource={openSource}
        />
      ))}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 text-sm rounded-t-md border-b-2',
        active
          ? 'border-foreground/80 text-foreground'
          : 'border-transparent text-foreground/60 hover:text-foreground/80'
      )}
    >
      {children}
    </button>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-foreground/70 mb-1">{label}</div>
      {children}
      {hint && <div className="mt-1 text-xs text-foreground/50">{hint}</div>}
    </label>
  )
}
