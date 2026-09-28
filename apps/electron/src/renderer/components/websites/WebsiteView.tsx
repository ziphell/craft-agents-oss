import * as React from 'react'
import { AlertTriangle, ArrowLeft, Check, Download, ExternalLink, FolderKanban, FolderOpen, MessageSquare, MoreHorizontal, Pencil, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { useAppShellContext } from '@/context/AppShellContext'
import { useNavigation } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import { websitesAtom } from '@/atoms/websites'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { LoadingIndicator } from '@craft-agent/ui'
import { Info_Alert } from '@/components/info'
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
import { useProjects } from '@/hooks/useProjects'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import type { LoadedWebsite } from '@craft-agent/shared/websites/types'
import { WebsiteFreshness } from './website-visuals'
import { DeleteWebsiteDialog } from './DeleteWebsiteDialog'

interface WebsiteViewProps {
  websiteSlug: string
}

/**
 * One website: its header and actions, and a plain note that the site itself lives
 * in the browser window rather than in this page.
 *
 * A website is a real page at an **origin of its own** (`http://<label>.localhost/`,
 * answered from disk by the app), so the app opens it where a page belongs — a tab of
 * the browser window — and this screen keeps everything that is *about* the website:
 * its name, freshness, and the actions on its folder. Entering it opens the tab once
 * (see the effect below); the header carries a button to bring it up again.
 */
export function WebsiteView({ websiteSlug }: WebsiteViewProps) {
  const { activeWorkspaceId, onOpenFile } = useAppShellContext()
  const { t } = useTranslation()
  const { navigate } = useNavigation()
  const websites = useAtomValue(websitesAtom)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  // Prefer the live atom copy; fall back to a direct fetch for deep links
  // that land before the initial websites load.
  const websiteFromAtom = React.useMemo(
    () => websites.find(p => p.config.slug === websiteSlug) ?? null,
    [websites, websiteSlug],
  )
  const [fallback, setFallback] = React.useState<{ slug: string; website: LoadedWebsite | null } | null>(null)
  const website = websiteFromAtom ?? (fallback?.slug === websiteSlug ? fallback.website : null)
  const fallbackResolved = fallback?.slug === websiteSlug

  React.useEffect(() => {
    if (websiteFromAtom || !activeWorkspaceId) return
    let stale = false
    window.electronAPI
      .getWebsite(activeWorkspaceId, websiteSlug)
      .then(loaded => { if (!stale) setFallback({ slug: websiteSlug, website: loaded }) })
      .catch(() => { if (!stale) setFallback({ slug: websiteSlug, website: null }) })
    return () => { stale = true }
  }, [activeWorkspaceId, websiteSlug, websiteFromAtom])

  // ------------------------------------------------------------------
  // Open in the browser window
  //
  // A website is a page at its own origin, so it is shown in a tab of the browser
  // window rather than framed inside this one: register (and read) the origin, ask
  // for a tab, then point it there and bring it up. `newTab` is the one addition —
  // a window that is already up gets a real new tab, while one that is not yet up
  // opens *into* the blank tab it already holds, so nothing is opened beside a
  // blank tab and what someone is reading is never replaced.
  // ------------------------------------------------------------------
  const openInWindow = React.useCallback(async () => {
    if (!activeWorkspaceId || !website) return
    try {
      const origin = await window.electronAPI.getWebsiteOrigin(activeWorkspaceId, website.config.slug)
      const instanceId = await window.electronAPI.browserPane.create({ show: true, newTab: true })
      await window.electronAPI.browserPane.navigate(instanceId, origin)
      await window.electronAPI.browserPane.focus(instanceId)
    } catch (err) {
      toast.error(t('toast.failedToCreateBrowser'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, website, t])

  // Entering the detail view opens the site, once per website.
  //
  // The ref, not the dependency array, is what makes it once: `openInWindow` changes
  // identity on every render (it closes over the website atom), so an effect keyed on
  // it would fire again on each re-render — after a rename, a refresh stamp, any atom
  // update — and open a tab every time. The ref records the website already opened
  // (workspace + slug, so the same slug in another workspace still opens), so a
  // re-render is a no-op while a different website (a fresh mount, or moving from one
  // detail to another) opens again. A website with no content yet is left alone: it
  // has no page to open, and the empty state offers to have one written.
  const openedRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!activeWorkspaceId || !website || !website.config.contentDigest) return
    const key = `${activeWorkspaceId}::${websiteSlug}`
    if (openedRef.current === key) return
    openedRef.current = key
    void openInWindow()
  }, [activeWorkspaceId, website, websiteSlug, openInWindow])

  // ------------------------------------------------------------------
  // Export — hand a copy of the folder to someone else
  //
  // A website is a directory, so this copies it out rather than compiling it: the
  // person picking a folder is the whole of the decision, and where it lands is on the
  // host that holds the website (which in remote mode is not this machine).
  // ------------------------------------------------------------------
  const exportTo = React.useCallback(
    async (destParent: string) => {
      if (!activeWorkspaceId || !website) return
      try {
        const result = await window.electronAPI.exportWebsite(
          activeWorkspaceId,
          website.config.slug,
          destParent,
        )
        toast.success(t('toast.websiteExported', { files: result.files }), { description: result.dir })
      } catch (err) {
        toast.error(t('toast.websiteExportFailed'), {
          description: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [activeWorkspaceId, website, t],
  )

  const onExportFolderPicked = React.useCallback(
    (destParent: string) => void exportTo(destParent),
    [exportTo],
  )

  const {
    pickDirectory: pickExportFolder,
    showServerBrowser,
    serverBrowserMode,
    cancelServerBrowser,
    confirmServerBrowser,
  } = useDirectoryPicker(onExportFolderPicked)

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------
  const [confirmingDelete, setConfirmingDelete] = React.useState(false)
  const { projects } = useProjects(activeWorkspaceId)

  // Inline rename: null = display mode, string = the draft being edited.
  const [nameDraft, setNameDraft] = React.useState<string | null>(null)

  const commitRename = React.useCallback(async () => {
    const next = (nameDraft ?? '').trim()
    setNameDraft(null)
    if (!activeWorkspaceId || !website || !next || next === website.config.name) return
    try {
      await window.electronAPI.updateWebsite(activeWorkspaceId, website.config.slug, { name: next })
    } catch (err) {
      toast.error(t('toast.websiteUpdateFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [nameDraft, activeWorkspaceId, website, t])

  const moveToProject = React.useCallback(async (projectId: string | null) => {
    if (!activeWorkspaceId || !website) return
    if ((website.config.projectId ?? null) === projectId) return
    try {
      // Explicit null clears the binding (updateWebsite normalizes null → absent).
      await window.electronAPI.updateWebsite(activeWorkspaceId, website.config.slug, { projectId })
    } catch (err) {
      toast.error(t('toast.websiteUpdateFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, website, t])

  const handleDesignWithAgent = React.useCallback(() => {
    if (!website) return
    navigate(routes.action.newSession({
      input: t('websites.designWithAgentPrompt', { name: website.config.name, slug: website.config.slug }),
    }))
  }, [website, navigate, t])

  const handleBack = React.useCallback(() => navigate(routes.view.websites()), [navigate])

  const handleOpenFolder = React.useCallback(() => {
    if (website) onOpenFile(website.folderPath)
  }, [website, onOpenFile])

  const handleRefreshPreview = React.useCallback(() => {
    if (!activeWorkspaceId || !website) return
    void window.electronAPI
      .regenerateWebsiteThumbnail(activeWorkspaceId, website.config.slug)
      .then((queued) => {
        if (queued) toast.success(t('toast.websitePreviewQueued'))
        else toast.error(t('toast.websitePreviewFailed'))
      })
      .catch(() => toast.error(t('toast.websitePreviewFailed')))
  }, [activeWorkspaceId, website, t])

  const handleConfirmDelete = React.useCallback(async () => {
    if (!activeWorkspaceId || !website) return
    setConfirmingDelete(false)
    try {
      await window.electronAPI.deleteWebsite(activeWorkspaceId, website.config.slug)
      toast.success(t('toast.websiteDeleted', { name: website.config.name }))
      navigate(routes.view.websites())
    } catch (err) {
      toast.error(t('toast.websiteDeleteFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, website, t, navigate])

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  if (!website) {
    return (
      <div className="flex h-full items-center justify-center">
        {fallbackResolved ? (
          <div className="flex flex-col items-center gap-3 text-sm text-foreground/50">
            <span>{t('websites.notFound')}</span>
            <button
              onClick={handleBack}
              className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> {t('websites.backToWebsites')}
            </button>
          </div>
        ) : (
          <LoadingIndicator label={t('common.loading')} />
        )}
      </div>
    )
  }

  const { config } = website
  const refreshFailed = config.lastRefresh && !config.lastRefresh.ok
  const hasContent = Boolean(config.contentDigest)
  // Why this website exists: the conversation that asked for it. A weak reference —
  // the row appears only while that conversation is still around.
  const originSession = config.originSessionId ? sessionMetaMap.get(config.originSessionId) : undefined

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header: back, title, freshness, open, overflow */}
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <button
          type="button"
          onClick={handleBack}
          aria-label={t('websites.backToWebsites')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        {nameDraft !== null ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={e => {
              if (e.key === 'Enter') void commitRename()
              else if (e.key === 'Escape') setNameDraft(null)
            }}
            aria-label={t('websites.renameWebsite')}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm font-medium outline-none focus:border-ring"
          />
        ) : (
          <span
            className="min-w-0 truncate text-sm font-medium"
            title={t('websites.renameWebsite')}
            onDoubleClick={() => setNameDraft(config.name)}
          >
            {config.name}
          </span>
        )}
        <WebsiteFreshness config={config} className="hidden @[28rem]/panel:inline-flex" />
        {originSession && (
          <button
            type="button"
            onClick={() => navigate(routes.view.allSessions(config.originSessionId!))}
            aria-label={t('websites.originChipOpen')}
            title={t('websites.originChipOpen')}
            className="hidden h-7 max-w-[12rem] shrink-0 items-center gap-1.5 rounded-md px-2 text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground @[28rem]/panel:inline-flex"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span className="truncate text-xs">
              {originSession.name ?? originSession.preview ?? t('websites.originChip')}
            </span>
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => void openInWindow()}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('websites.openInWindow')}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('common.more')}
                className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground data-[state=open]:bg-foreground/5"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <StyledDropdownMenuContent align="end">
              <StyledDropdownMenuItem onClick={() => setNameDraft(config.name)}>
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
                      const isBound = config.projectId === p.config.id
                      return (
                        <StyledDropdownMenuItem key={p.config.id} onClick={() => void moveToProject(p.config.id)}>
                          {isBound && <Check className="h-3.5 w-3.5" />}
                          <span className={isBound ? 'flex-1' : 'flex-1 ml-[18px]'}>{p.config.name}</span>
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
              <StyledDropdownMenuItem onClick={() => pickExportFolder()}>
                <Download />
                {t('websites.exportCopy')}
              </StyledDropdownMenuItem>
              <StyledDropdownMenuItem onClick={handleRefreshPreview}>
                <RefreshCw />
                {t('websites.refreshPreview')}
              </StyledDropdownMenuItem>
              <StyledDropdownMenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
                <Trash2 />
                {t('websites.deleteWebsite')}
              </StyledDropdownMenuItem>
            </StyledDropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Last-refresh failure surfaces above the body */}
      {refreshFailed && (
        <Info_Alert
          variant="error"
          inline
          icon={<AlertTriangle className="h-4 w-4" />}
          className="mx-3 mt-2"
        >
          <Info_Alert.Title>{t('websites.refreshFailed')}</Info_Alert.Title>
          {config.lastRefresh?.error && (
            <Info_Alert.Description className="break-all">
              {config.lastRefresh.error}
            </Info_Alert.Description>
          )}
        </Info_Alert>
      )}

      {/* Body: the site is a tab in the browser window, not a frame in here */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        {hasContent ? (
          <>
            <ExternalLink className="h-5 w-5 text-foreground/40" aria-hidden />
            <span className="max-w-md text-xs text-foreground/50">
              {t('websites.openInWindowDescription')}
            </span>
            <button
              type="button"
              onClick={() => void openInWindow()}
              className="mt-1 inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('websites.openInWindow')}
            </button>
          </>
        ) : (
          <>
            <span className="text-sm font-medium text-foreground/70">{t('websites.noContentTitle')}</span>
            <span className="max-w-md text-xs text-foreground/50">{t('websites.noContentDescription')}</span>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={handleDesignWithAgent}
                className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {t('websites.designWithAgent')}
              </button>
              <button
                type="button"
                onClick={handleOpenFolder}
                className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {t('websites.openFolder')}
              </button>
            </div>
          </>
        )}
      </div>

      <DeleteWebsiteDialog
        websiteName={confirmingDelete ? config.name : null}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
      {activeWorkspaceId && (
        <ServerDirectoryBrowser
          open={showServerBrowser}
          mode={serverBrowserMode}
          onSelect={confirmServerBrowser}
          onCancel={cancelServerBrowser}
        />
      )}
    </div>
  )
}
