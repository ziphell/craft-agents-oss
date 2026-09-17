/**
 * BrowserTabStrip
 *
 * Rendered in the TopBar, shows compact badges for all active browser instances.
 * Each badge opens a shared action menu, whose first group is that window's own
 * pages (plan §22): one window is one badge, and its pages are listed inside it.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import { Spinner } from '@craft-agent/ui'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import {
  activeBrowserInstanceIdAtom,
  browserInstancesAtom,
  filterInstancesForWorkspace,
  setBrowserInstancesAtom,
  updateBrowserInstanceAtom,
  removeBrowserInstanceAtom,
} from '@/atoms/browser-pane'
import { useAppShellContext } from '@/context/AppShellContext'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { groupTabsByWork, shouldShowGroupHeaders, type PageGroup } from './page-groups'
import { BrowserTabBadge } from './BrowserTabBadge'
import type { BrowserInstanceInfo } from '../../../shared/types'
import { getHostname, openTargetOfActivePage } from './utils'
import { navigate, routes } from '@/lib/navigate'

const DEFAULT_MAX_VISIBLE_BADGES = 3

/** Whether any page of this window is the given conversation's — for ordering the badges. */
function hasPageOf(instance: BrowserInstanceInfo, sessionId: string | null): boolean {
  if (!sessionId) return false
  return !!instance.tabs?.some(
    (tab) =>
      tab.belongsTo?.sessionId === sessionId
      || tab.cursorOf === sessionId
      || tab.lockedBy === sessionId,
  )
}

interface BrowserTabStripProps {
  activeSessionId?: string | null
  instancesOverride?: BrowserInstanceInfo[]
  maxVisibleBadges?: number
}

export function BrowserTabStrip({
  activeSessionId,
  instancesOverride,
  maxVisibleBadges = DEFAULT_MAX_VISIBLE_BADGES,
}: BrowserTabStripProps) {
  // Filter the badge strip to the workspace currently in focus. Remote-connected
  // workspaces have a different `remoteWorkspaceId` (what the remote agent
  // stamps onto its tabs) than the local `activeWorkspaceId` (what locally-
  // opened manual tabs use), so we accept either.
  const { t } = useTranslation()
  const { activeWorkspaceId, workspaces } = useAppShellContext()
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const remoteWorkspaceId = activeWorkspace?.remoteServer?.remoteWorkspaceId ?? null
  const allInstances = useAtomValue(browserInstancesAtom)
  /**
   * Conversation names for the page list's group headers.
   *
   * The badge sits in the app shell, which already holds every conversation's
   * metadata — the rail, a separate document with its own preload, gets the same
   * names pushed with the window's state instead.
   */
  const sessionMeta = useAtomValue(sessionMetaMapAtom)
  const instances = useMemo(
    () => filterInstancesForWorkspace(allInstances, activeWorkspaceId, remoteWorkspaceId),
    [allInstances, activeWorkspaceId, remoteWorkspaceId],
  )
  const setInstances = useSetAtom(setBrowserInstancesAtom)
  const updateInstance = useSetAtom(updateBrowserInstanceAtom)
  const removeInstance = useSetAtom(removeBrowserInstanceAtom)
  const [activeInstanceId, setActiveInstanceId] = useAtom(activeBrowserInstanceIdAtom)
  const effectiveInstances = instancesOverride ?? instances
  const instancesRef = useRef(effectiveInstances)
  const removeReconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const orderedInstances = useMemo(() => {
    const items = [...effectiveInstances]

    // Global list: keep all browser windows visible.
    // Optional ordering preference: the window holding this conversation's pages comes first.
    if (activeSessionId) {
      items.sort((a, b) => {
        const aInActiveSession = hasPageOf(a, activeSessionId) ? 0 : 1
        const bInActiveSession = hasPageOf(b, activeSessionId) ? 0 : 1
        if (aInActiveSession !== bInActiveSession) return aInActiveSession - bInActiveSession
        return a.id.localeCompare(b.id)
      })
    } else {
      items.sort((a, b) => a.id.localeCompare(b.id))
    }

    return items
  }, [effectiveInstances, activeSessionId])

  useEffect(() => {
    instancesRef.current = effectiveInstances
  }, [effectiveInstances])

  useEffect(() => {
    if (instancesOverride) return

    const browserPaneApi = window.electronAPI?.browserPane
    if (!browserPaneApi || !window.electronAPI.isChannelAvailable('browser-pane:list')) {
      setInstances([])
      setActiveInstanceId(null)
      return
    }

    browserPaneApi.list()
      .then((items) => {
        setInstances(items)
        if (items.length === 0) {
          setActiveInstanceId(null)
          return
        }
        setActiveInstanceId((prev) => prev ?? items[0].id)
      })
      .catch((error) => {
        console.warn('[BrowserTabStrip] Failed to list browser panes:', error)
        setInstances([])
        setActiveInstanceId(null)
      })
  }, [instancesOverride, setInstances, setActiveInstanceId])

  useEffect(() => {
    if (instancesOverride) return

    const browserPaneApi = window.electronAPI?.browserPane
    if (!browserPaneApi || !window.electronAPI.isChannelAvailable('browser-pane:list')) return

    const cleanupState = browserPaneApi.onStateChanged((info: BrowserInstanceInfo) => {
      updateInstance(info)
    })

    const cleanupRemoved = browserPaneApi.onRemoved((id: string) => {
      removeInstance(id)
      setActiveInstanceId((prev) => {
        if (prev !== id) return prev
        const remaining = instancesRef.current.filter((item) => item.id !== id)
        return remaining[0]?.id ?? null
      })

      if (removeReconcileTimerRef.current) {
        clearTimeout(removeReconcileTimerRef.current)
      }

      removeReconcileTimerRef.current = setTimeout(() => {
        removeReconcileTimerRef.current = null
        void browserPaneApi.list()
          .then((items) => {
            setInstances(items)
            setActiveInstanceId((prev) => {
              if (!prev) return items[0]?.id ?? null
              return items.some((item) => item.id === prev) ? prev : (items[0]?.id ?? null)
            })
          })
          .catch((error) => {
            console.warn('[BrowserTabStrip] Reconcile list failed after remove:', error)
          })
      }, 75)
    })

    const cleanupInteracted = browserPaneApi.onInteracted((id: string) => {
      setActiveInstanceId(id)
    })

    return () => {
      cleanupState()
      cleanupRemoved()
      cleanupInteracted()
      if (removeReconcileTimerRef.current) {
        clearTimeout(removeReconcileTimerRef.current)
        removeReconcileTimerRef.current = null
      }
    }
  }, [instancesOverride, updateInstance, removeInstance, setActiveInstanceId, setInstances])

  useEffect(() => {
    if (orderedInstances.length === 0) {
      setActiveInstanceId(null)
      return
    }
    if (!activeInstanceId || !orderedInstances.some((item) => item.id === activeInstanceId)) {
      setActiveInstanceId(orderedInstances[0].id)
    }
  }, [orderedInstances, activeInstanceId, setActiveInstanceId])

  const focusBrowserWindow = useCallback((instance: BrowserInstanceInfo) => {
    setActiveInstanceId(instance.id)
    if (instancesOverride) return

    const browserPaneApi = window.electronAPI?.browserPane
    if (!browserPaneApi) {
      console.warn('[BrowserTabStrip] browserPane API unavailable for focus action')
      return
    }

    void browserPaneApi.focus(instance.id).catch((error) => {
      console.warn(`[BrowserTabStrip] Failed to focus browser window ${instance.id}:`, error)
    })
  }, [instancesOverride, setActiveInstanceId])

  const openPageTarget = useCallback((instance: BrowserInstanceInfo) => {
    const target = openTargetOfActivePage(instance.tabs, sessionMeta)
    if (!target) return
    navigate(routes.view.allSessions(target.sessionId))
  }, [sessionMeta])

  /**
   * Show one of a window's pages.
   *
   * Switching is done through the window (which page is on screen is the
   * window's own state), so the badge's list is a list of pages *of one window*
   * rather than a flat list of everything open — which is what "grouped by
   * window" means here.
   */
  const selectPage = useCallback((instance: BrowserInstanceInfo, tabId: string) => {
    if (instancesOverride) return
    const browserPaneApi = window.electronAPI?.browserPane
    if (!browserPaneApi) {
      console.warn('[BrowserTabStrip] browserPane API unavailable for page switch')
      return
    }

    void browserPaneApi.tabAction({ instanceId: instance.id, action: 'activate', tabId }).catch((error) => {
      console.warn(`[BrowserTabStrip] Failed to switch page ${tabId} of ${instance.id}:`, error)
    })
    // Switching a page in a window nobody can see is half an action.
    void browserPaneApi.focus(instance.id).catch(() => {})
  }, [instancesOverride])

  const addPage = useCallback((instance: BrowserInstanceInfo) => {
    if (instancesOverride) return
    void window.electronAPI?.browserPane
      .tabAction({ instanceId: instance.id, action: 'new' })
      .catch((error) => {
        console.warn(`[BrowserTabStrip] Failed to add a page to ${instance.id}:`, error)
      })
  }, [instancesOverride])

  /**
   * The window's own pages, above its actions, sectioned by whose work they are.
   *
   * One entry per page, the one on screen marked. A single-page window shows
   * nothing here — that page is what the badge already says, and a group of one
   * is noise. Closing a page is deliberately *not* here: it lives on the rail in
   * the window, where the page being closed is the one in front of you.
   *
   * The sections are the same rule the rail draws (`groupTabsByWork`), so a person
   * reading the window and a person reading this menu see the same grouping. Headers
   * appear only when there is more than one group: with one group, the header would be
   * a row saying "all of these are yours" over all of them.
   */
  const renderPageList = useCallback((instance: BrowserInstanceInfo) => {
    const tabs = instance.tabs ?? []
    if (tabs.length < 2) return null

    const groups = groupTabsByWork(tabs)
    const showHeaders = shouldShowGroupHeaders(groups)
    /**
     * A name, never an id — a conversation with no name yet says so generically, and a task
     * is named by its slug (which IS its name: the board, the folder and its sessions all
     * use it).
     */
    const groupLabel = (group: PageGroup): string => {
      const work = group.work
      if (!work) return t('browser.openedByYou')
      if (work.kind === 'task') return work.taskSlug
      return sessionMeta.get(work.sessionId)?.name || t('browser.openedByConversation')
    }

    return (
      <>
        {groups.map((group) => (
          <Fragment key={group.key}>
            {showHeaders && (
              <div className="flex items-center gap-1 px-2 pb-0.5 pt-1.5 text-[10px] font-medium text-foreground/40">
                {group.work !== null && <Icons.Bot className="h-3 w-3 shrink-0" />}
                <span className="truncate">{groupLabel(group)}</span>
              </div>
            )}

            {group.tabs.map((tab) => {
              const label = tab.title.trim() || getHostname(tab.url) || t('browser.untitledPage')
              return (
                <StyledDropdownMenuItem key={tab.id} onSelect={() => selectPage(instance, tab.id)}>
                  {tab.active ? (
                    <Icons.Check className="h-3.5 w-3.5 text-accent" />
                  ) : tab.isLoading ? (
                    <Spinner className="text-[10px]" />
                  ) : (
                    <Icons.Globe className="h-3.5 w-3.5 opacity-70" />
                  )}
                  <span className="truncate">{label}</span>
                  {/* The header says whose these are when there is one to say it. */}
                  {!showHeaders && tab.belongsTo !== null && (
                    <Icons.Bot className="h-3 w-3 shrink-0 opacity-50" />
                  )}
                </StyledDropdownMenuItem>
              )
            })}
          </Fragment>
        ))}

        <StyledDropdownMenuItem disabled={!!instancesOverride} onSelect={() => addPage(instance)}>
          <Icons.Plus className="h-3.5 w-3.5" />
          {t('browser.newPage')}
        </StyledDropdownMenuItem>

        <StyledDropdownMenuSeparator />
      </>
    )
  }, [addPage, instancesOverride, selectPage, sessionMeta, t])

  const terminateBrowserWindow = useCallback((instance: BrowserInstanceInfo) => {
    if (!instancesOverride) {
      const browserPaneApi = window.electronAPI?.browserPane
      if (!browserPaneApi) {
        console.warn('[BrowserTabStrip] browserPane API unavailable for terminate action')
      } else {
        void browserPaneApi.destroy(instance.id).catch((error) => {
          console.warn(`[BrowserTabStrip] Failed to terminate browser window ${instance.id}:`, error)
        })
      }
      removeInstance(instance.id)
    }

    setActiveInstanceId((prev) => {
      if (prev !== instance.id) return prev
      const remaining = instancesRef.current.filter((item) => item.id !== instance.id)
      return remaining[0]?.id ?? null
    })
  }, [instancesOverride, removeInstance, setActiveInstanceId])

  const renderBrowserActions = useCallback((instance: BrowserInstanceInfo) => {
    const canUseLiveWindowActions = !instancesOverride
    const openTarget = openTargetOfActivePage(instance.tabs, sessionMeta)
    const canOpenSession = !!openTarget
    // Named after what it actually opens, and after the **page**: the item reads the page on
    // screen, because the window is the whole workspace's (plan §22).
    const openSessionLabel = openTarget?.kind === 'task'
      ? t('browser.openPageTask')
      : t('browser.openPageConversation')

    return (
      <>
        {renderPageList(instance)}

        <StyledDropdownMenuItem
          disabled={!canUseLiveWindowActions}
          onSelect={() => focusBrowserWindow(instance)}
        >
          <Icons.Monitor className="h-3.5 w-3.5" />
          {t('browser.showWindow')}
        </StyledDropdownMenuItem>

        <StyledDropdownMenuItem
          disabled={!canOpenSession}
          onSelect={() => openPageTarget(instance)}
        >
          <Icons.PanelRightOpen className="h-3.5 w-3.5" />
          {openSessionLabel}
        </StyledDropdownMenuItem>

        <StyledDropdownMenuSeparator />

        <StyledDropdownMenuItem
          variant="destructive"
          disabled={!canUseLiveWindowActions}
          onSelect={() => terminateBrowserWindow(instance)}
        >
          <Icons.XCircle className="h-3.5 w-3.5" />
          {t('browser.terminateBrowser')}
        </StyledDropdownMenuItem>
      </>
    )
  }, [instancesOverride, focusBrowserWindow, openPageTarget, renderPageList, sessionMeta, t, terminateBrowserWindow])

  if (orderedInstances.length === 0) return null

  const visibleBadgeCount = Math.max(1, maxVisibleBadges)
  const visible = orderedInstances.slice(0, visibleBadgeCount)
  const overflow = orderedInstances.slice(visibleBadgeCount)

  return (
    <div className="flex items-center gap-1.5">
      {visible.map((instance) => (
        <DropdownMenu key={instance.id}>
          <DropdownMenuTrigger asChild>
            <BrowserTabBadge
              instance={instance}
              isActive={instance.id === activeInstanceId}
            />
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align="end" minWidth="min-w-56">
            {renderBrowserActions(instance)}
          </StyledDropdownMenuContent>
        </DropdownMenu>
      ))}

      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="h-[26px] px-1.5 rounded-lg text-[11px] text-foreground/50 bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors cursor-pointer titlebar-no-drag"
            >
              +{overflow.length}
            </button>
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align="end" minWidth="min-w-64">
            {overflow.map((instance) => {
              const hostname = getHostname(instance.url)
              const displayLabel = instance.title.trim() || hostname || 'Local File'
              return (
                <DropdownMenuSub key={instance.id}>
                  <StyledDropdownMenuSubTrigger>
                    {instance.isLoading ? (
                      <Spinner className="text-[10px]" />
                    ) : (
                      <Icons.Globe className="h-3.5 w-3.5" />
                    )}
                    <span className="truncate">{displayLabel}</span>
                  </StyledDropdownMenuSubTrigger>
                  <StyledDropdownMenuSubContent minWidth="min-w-56">
                    {renderBrowserActions(instance)}
                  </StyledDropdownMenuSubContent>
                </DropdownMenuSub>
              )
            })}
          </StyledDropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
