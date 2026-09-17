/**
 * BrowserTabStrip
 *
 * Rendered in the TopBar, shows compact badges for all active browser instances.
 * Each badge opens a shared action menu, whose first group is that window's own
 * tabs (plan §22): one window is one badge, and its tabs are listed inside it.
 *
 * A tab row answers two different questions, and they are kept apart. **Clicking**
 * it shows that tab — the switch is the window's own state, and the window comes up
 * with it, so a window behind something else is reached from here (用户报告).
 * **Right-clicking** it hands the tab to a conversation as a chip (plan §12.7),
 * which is about the tab as a thing to look at and leaves the window exactly where
 * it is.
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
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
} from '@/components/ui/styled-context-menu'
import { useAppShellContext } from '@/context/AppShellContext'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { groupTabsByWork, shouldShowGroupHeaders, type TabGroup } from './tab-groups'
import { BrowserTabBadge } from './BrowserTabBadge'
import type { BrowserInstanceInfo } from '../../../shared/types'
import { getHostname, openTargetOfActiveTab, tabRefOf } from './utils'
import { navigate, routes } from '@/lib/navigate'
import type { TabRef } from '@/lib/tab-mention'

const DEFAULT_MAX_VISIBLE_BADGES = 3

/** Whether any tab of this window is the given conversation's — for ordering the badges. */
function hasTabOf(instance: BrowserInstanceInfo, sessionId: string | null): boolean {
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
  /**
   * Hand one of a window's tabs to a conversation, as a reference in its composer.
   *
   * Left out where there is no conversation to put it in (the component playground),
   * which is also what leaves the row without a context menu rather than with one
   * whose only item would do nothing.
   */
  onAddTabToConversation?: (tab: TabRef) => void
}

export function BrowserTabStrip({
  activeSessionId,
  instancesOverride,
  maxVisibleBadges = DEFAULT_MAX_VISIBLE_BADGES,
  onAddTabToConversation,
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
   * Conversation names for the tab list's group headers.
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
    // Optional ordering preference: the window holding this conversation's tabs comes first.
    if (activeSessionId) {
      items.sort((a, b) => {
        const aInActiveSession = hasTabOf(a, activeSessionId) ? 0 : 1
        const bInActiveSession = hasTabOf(b, activeSessionId) ? 0 : 1
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

  const openTabTarget = useCallback((instance: BrowserInstanceInfo) => {
    const target = openTargetOfActiveTab(instance.tabs, sessionMeta)
    if (!target) return
    navigate(routes.view.allSessions(target.sessionId))
  }, [sessionMeta])

  /**
   * Show one of a window's tabs: that tab comes forward **and the window comes up**.
   *
   * Both halves are the same act — switching a tab in a window nobody is looking at
   * is a change the person cannot see — which is also why this is where the strip's
   * own idea of "the window the app is on" is set. Which tab a window shows is the
   * window's state, so the switch is asked of the window rather than assumed here.
   */
  const openTab = useCallback((instance: BrowserInstanceInfo, tabId: string) => {
    if (instancesOverride) return
    const browserPaneApi = window.electronAPI?.browserPane
    if (!browserPaneApi) {
      console.warn('[BrowserTabStrip] browserPane API unavailable for tab switch')
      return
    }

    void browserPaneApi
      .tabAction({ instanceId: instance.id, action: 'activate', tabId })
      .catch((error) => {
        console.warn(`[BrowserTabStrip] Failed to switch tab ${tabId} of ${instance.id}:`, error)
      })
    focusBrowserWindow(instance)
  }, [focusBrowserWindow, instancesOverride])

  /**
   * Give the window one more tab.
   *
   * A tab is added in order to be looked at, so this also brings the window up: a
   * new tab in a window nobody can see is half an action, the same half that
   * switching a tab used to make whole (plan §22). Which tab ends up in front is
   * the window's own answer — the host activates the tab it just added.
   */
  const addTab = useCallback((instance: BrowserInstanceInfo) => {
    if (instancesOverride) return
    const browserPaneApi = window.electronAPI?.browserPane
    if (!browserPaneApi) {
      console.warn('[BrowserTabStrip] browserPane API unavailable for adding a tab')
      return
    }

    void browserPaneApi
      .tabAction({ instanceId: instance.id, action: 'new' })
      .then(() => browserPaneApi.focus(instance.id))
      .catch((error) => {
        console.warn(`[BrowserTabStrip] Failed to add a tab to ${instance.id}:`, error)
      })
  }, [instancesOverride])

  /**
   * The window's own tabs: what it holds, which one is on screen, and what can be
   * done with each.
   *
   * Every entry can be **shown** and can be **given away**, and the two are kept
   * apart because they answer different questions (用户报告):
   *
   * - **the row** shows that tab: the switch is the window's, and the window comes
   *   up with it — a tab switched in a window nobody can see is half an action — so
   *   this is how a window behind something else is reached. The entry that is marked
   *   is where the window is, and that mark follows the window's own state.
   * - **the row's context menu** hands the tab to a conversation as a chip (plan
   *   §12.7) — about the tab as a thing to look at, so it leaves the window alone.
   *
   * It lists the window even when that is one tab (用户报告): this is where you
   * look to see what is open, and leaving it out for a single tab answers the
   * question with a menu that looks like it has nothing to say. The sections are
   * the same rule the rail draws (`groupTabsByWork`), so a person reading the
   * window and a person reading this menu see the same grouping. Headers appear
   * only when there is more than one group — with everything in one group there is
   * nothing to tell apart.
   */
  const renderTabList = useCallback((instance: BrowserInstanceInfo) => {
    const tabs = instance.tabs ?? []
    // No state pushed yet is not "no tabs": the window has not said what it holds,
    // and an empty list would claim it holds nothing.
    if (tabs.length === 0) return null

    const groups = groupTabsByWork(tabs)
    const showHeaders = shouldShowGroupHeaders(groups)
    /**
     * A name, never an id — a conversation with no name yet says so generically, and a task
     * is named by its slug (which IS its name: the board, the folder and its sessions all
     * use it).
     */
    const groupLabel = (group: TabGroup): string => {
      const work = group.work
      if (!work) return t('browser.openedByYou')
      if (work.kind === 'task') return work.taskSlug
      return sessionMeta.get(work.sessionId)?.name || t('browser.openedByConversation')
    }

    // No rule between the tabs and "New tab": adding one is the next thing to do with
    // the list, not another kind of thing.
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
              const label = tab.title.trim() || getHostname(tab.url) || t('browser.untitledTab')
              /**
               * One tab, and the two things it can do.
               *
               * **Click shows it**: the tab comes forward and the window comes up, which
               * is the window's own verb — its rail means the same thing from inside, and
               * this is the way to it from a window that is behind something. **Right-click
               * hands it to a conversation** (plan §12.7), which is about the tab as a
               * thing to look at rather than about what the window is showing, so it leaves
               * the window alone.
               */
              const row = (
                <StyledDropdownMenuItem onSelect={() => openTab(instance, tab.id)}>
                  {tab.active ? (
                    <Icons.Check className="h-3.5 w-3.5 text-accent" />
                  ) : tab.isLoading ? (
                    <Spinner className="text-[10px]" />
                  ) : (
                    <Icons.Globe className="h-3.5 w-3.5 opacity-70" />
                  )}
                  <span className="min-w-0 truncate">{label}</span>
                  {/* The header says whose these are when there is one to say it. */}
                  {!showHeaders && tab.belongsTo !== null && (
                    <Icons.Bot className="h-3 w-3 shrink-0 opacity-50" />
                  )}
                </StyledDropdownMenuItem>
              )

              if (!onAddTabToConversation) return <Fragment key={tab.id}>{row}</Fragment>

              return (
                <ContextMenu key={tab.id}>
                  <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                  <StyledContextMenuContent>
                    <StyledContextMenuItem onSelect={() => onAddTabToConversation(tabRefOf(tab))}>
                      <Icons.MessageSquarePlus className="h-3.5 w-3.5" />
                      {t('browser.addToConversation')}
                    </StyledContextMenuItem>
                  </StyledContextMenuContent>
                </ContextMenu>
              )
            })}
          </Fragment>
        ))}
      </>
    )
  }, [onAddTabToConversation, openTab, sessionMeta, t])

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
    const openTarget = openTargetOfActiveTab(instance.tabs, sessionMeta)
    const canOpenSession = !!openTarget
    // Named after what it actually opens, and after the **tab**: the item reads the tab on
    // screen, because the window is the whole workspace's (plan §22).
    const openSessionLabel = openTarget?.kind === 'task'
      ? t('browser.openTabTask')
      : t('browser.openTabConversation')

    return (
      <>
        {renderTabList(instance)}

        {/*
          One group with the list above, and no rule between them (用户报告): both are
          about this window's tabs — what is open, and the way to open one more — so a
          divider would only split one subject in two. It is an act rather than a
          report, and it is here whatever the window holds: a window with one tab is
          exactly the one somebody wants a second tab in (plan §22, 用户报告).
        */}
        <StyledDropdownMenuItem disabled={!!instancesOverride} onSelect={() => addTab(instance)}>
          <Icons.Plus className="h-3.5 w-3.5" />
          {t('browser.newTab')}
        </StyledDropdownMenuItem>

        <StyledDropdownMenuSeparator />

        <StyledDropdownMenuItem
          disabled={!canUseLiveWindowActions}
          onSelect={() => focusBrowserWindow(instance)}
        >
          <Icons.Monitor className="h-3.5 w-3.5" />
          {t('browser.showWindow')}
        </StyledDropdownMenuItem>

        <StyledDropdownMenuItem
          disabled={!canOpenSession}
          onSelect={() => openTabTarget(instance)}
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
  }, [addTab, instancesOverride, focusBrowserWindow, openTabTarget, renderTabList, sessionMeta, t, terminateBrowserWindow])

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
