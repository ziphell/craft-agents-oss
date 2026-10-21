/**
 * BrowserTabStrip
 *
 * The top bar's one browser control.
 *
 * There is no strip of badges: a workspace holds a window per profile, and a row of them ran out
 * of room — the ones that did not fit disappeared behind a "+N" menu (用户报告). This is one
 * trigger showing **the browser window for the conversation's profile** (its tab in use) when it is open, and
 * the globe when no window is; one menu holds everything: that window laid out flat with its
 * tabs, every other window as a submenu, and the profiles that have no window yet (a click
 * opens one).
 *
 * A tab row answers two different questions, and they are kept apart. **Clicking**
 * it shows that tab — the switch is the window's own state, and the window comes up
 * with it, so a window behind something else is reached from here (用户报告).
 * **Right-clicking** it hands the tab to a conversation as a chip,
 * which is about the tab as a thing to look at and leaves the window exactly where
 * it is.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import { Spinner, Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui'
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
import {
  browserProfilesAtom,
  DEFAULT_BROWSER_PROFILE_ID,
  optimisticSessionProfileAtom,
  refreshBrowserProfilesAtom,
} from '@/atoms/browser-profiles'
import { useAppShellContext } from '@/context/AppShellContext'
import { sessionAtomFamily, sessionMetaMapAtom } from '@/atoms/sessions'
import { groupTabsByWork, shouldShowGroupHeaders, type TabGroup } from './tab-groups'
import { BrowserTabBadge } from './BrowserTabBadge'
import { TopBarButton } from '../ui/TopBarButton'
import type { BrowserInstanceInfo } from '../../../shared/types'
import { getHostname, openTargetOfActiveTab, tabRefOf } from './utils'
import { navigate, routes } from '@/lib/navigate'
import type { TabRef } from '@craft-agent/shared/mentions'

/** Whether any tab of this window is the given conversation's — for ordering the windows. */
function hasTabOf(instance: BrowserInstanceInfo, sessionId: string | null): boolean {
  if (!sessionId) return false
  return !!instance.tabs?.some(
    (tab) =>
      tab.belongsTo?.sessionId === sessionId
      || tab.cursorOf.includes(sessionId)
      || tab.lockedBy === sessionId,
  )
}

/**
 * The page's own icon, where the list would otherwise draw a globe.
 *
 * Only the globe is replaced: what is happening to a tab is said by its own mark —
 * the check on the tab on screen, the spinner on one still loading — and this never
 * stands in for those. A page with no icon (or one that will not load) is the globe.
 */
function TabFavicon({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [src])
  if (!src || failed) return <Icons.Globe className="h-3.5 w-3.5 opacity-70" />
  return (
    <img
      src={src}
      alt=""
      className="h-3.5 w-3.5 rounded-[3px] object-cover opacity-70"
      onError={() => setFailed(true)}
    />
  )
}

interface BrowserTabStripProps {
  activeSessionId?: string | null
  instancesOverride?: BrowserInstanceInfo[]
  /**
   * Hand one of a window's tabs to a conversation, as a reference in its composer.
   *
   * Left out where there is no conversation to put it in (the component playground),
   * which is also what leaves the row without a context menu rather than with one
   * whose only item would do nothing.
   */
  onAddTabToConversation?: (tab: TabRef) => void
  /**
   * Open — or bring up — the workspace's browser, or the window of the profile named.
   *
   * The host owns the call so a failure is reported where every other browser action's
   * is; left out (the playground) the menu still lists windows but opens nothing.
   */
  onOpenBrowser?: (profileId?: string) => void
}

export function BrowserTabStrip({
  activeSessionId,
  instancesOverride,
  onAddTabToConversation,
  onOpenBrowser,
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
  // Hover-only hint for the no-window globe. The dropdown itself stays uncontrolled: making it
  // controlled re-rendered this whole strip (every tab, every profile) before the menu could open,
  // which made the click feel one beat late (用户报告).
  const [globeTipOpen, setGlobeTipOpen] = useState(false)
  const effectiveInstances = instancesOverride ?? instances
  const browserProfiles = useAtomValue(browserProfilesAtom)
  const refreshBrowserProfiles = useSetAtom(refreshBrowserProfilesAtom)
  /**
   * The profile's name, shown whenever more than one profile exists.
   *
   * A window belongs to one profile, and two profiles of the same site draw the same favicon and title —
   * so once the app has profiles to choose from, every window says which one it is. Waiting for a
   * second window would leave the only window anonymous exactly when the person is deciding
   * which profile they just opened (用户报告).
   */
  const profileNameOf = useCallback(
    (instance: BrowserInstanceInfo): string | undefined => {
      const profileId = instance.profileId ?? DEFAULT_BROWSER_PROFILE_ID
      const match = browserProfiles.find((profile) => profile.id === profileId)
      // A window can outlive a deleted profile. It stays usable (its tabs and cookies are still
      // there), so it is named as a deleted profile rather than by an opaque id.
      if (!match) {
        return instance.profileId ? t('composer.browserProfileMissing', 'Deleted profile') : undefined
      }
      return browserProfiles.length > 1 ? match.name : undefined
    },
    [browserProfiles, t],
  )

  // Names for the badges; a profile can be created or renamed while the app is open.
  useEffect(() => {
    void refreshBrowserProfiles()
  }, [refreshBrowserProfiles])

  /**
   * The profile this conversation works in — the same answer the composer and the agent's
   * unnamed commands use: the conversation's own pick, then the workspace default, then Default.
   *
   * The badge deliberately does **not** follow the window the person last focused. That is
   * attention, not a profile choice, and making the badge follow it left the badge, the
   * composer and the agent disagreeing about which profile was "current" (用户报告).
   *
   * Resolved over RPC because only the server sees the conversation's pick and the workspace
   * default together. `activeSession.browserProfile` is the raw pick, and watching it re-resolves
   * after a switch (the event processor writes it onto the session).
   */
  const activeSession = useAtomValue(sessionAtomFamily(activeSessionId ?? ''))
  const [conversationProfileId, setConversationProfileId] = useState<string | null>(null)
  useEffect(() => {
    if (!activeSessionId || instancesOverride) {
      setConversationProfileId(null)
      return
    }
    const api = window.electronAPI?.browserProfiles
    if (!api) {
      setConversationProfileId(null)
      return
    }
    let cancelled = false
    void api
      .resolve(activeSessionId)
      .then((resolved) => {
        if (!cancelled) setConversationProfileId(resolved.effectiveProfileId)
      })
      .catch(() => {
        if (!cancelled) setConversationProfileId(null)
      })
    return () => {
      cancelled = true
    }
  }, [activeSessionId, activeSession?.browserProfile, browserProfiles.length, instancesOverride])

  /**
   * The profile the composer just picked, read before this side's own resolution catches up.
   *
   * The pick is persisted and announced before `browserProfiles.resolve` can report it, so without
   * this the badge switched one beat after the composer did. The entry is dropped once the resolved
   * value agrees, and ignored after a few seconds if it never does.
   */
  const optimisticProfiles = useAtomValue(optimisticSessionProfileAtom)
  const setOptimisticProfiles = useSetAtom(optimisticSessionProfileAtom)
  const pendingProfile = activeSessionId ? optimisticProfiles[activeSessionId] : undefined
  const pendingProfileId =
    pendingProfile && Date.now() - pendingProfile.at < 5_000 ? pendingProfile.profileId : undefined
  const effectiveConversationProfileId = pendingProfileId ?? conversationProfileId

  useEffect(() => {
    if (!activeSessionId || !pendingProfileId || pendingProfileId !== conversationProfileId) return
    setOptimisticProfiles((prev) => {
      if (prev[activeSessionId]?.profileId !== pendingProfileId) return prev
      const nextState = { ...prev }
      delete nextState[activeSessionId]
      return nextState
    })
  }, [activeSessionId, pendingProfileId, conversationProfileId, setOptimisticProfiles])

  const instancesRef = useRef(effectiveInstances)
  const removeReconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * The profiles in the order the rest of the app lists them — Default first, then as they were
   * created. A badge keeps the place its profile has, whatever order the windows were opened in.
   */
  const profileOrder = useMemo(
    () => new Map(browserProfiles.map((profile, index) => [profile.id, index])),
    [browserProfiles],
  )

  const orderedInstances = useMemo(() => {
    const items = [...effectiveInstances]
    const rank = (instance: BrowserInstanceInfo) =>
      profileOrder.get(instance.profileId ?? 'default') ?? Number.MAX_SAFE_INTEGER

    /**
     * The window the person is working in leads.
     *
     * The strip is a view of what is active, not a record of what was opened first: ordering by
     * creation left the first profile's badge in the one visible slot for as long as that window
     * existed, so opening a second profile appeared to change nothing (用户报告). What is active
     * is the window focused last — its own active tab is the one its badge shows.
     *
     * After it, the window holding this conversation's tabs, then profile order — the same order
     * the settings page and the top bar's profile menu use, so a badge's place does not depend on
     * which window happened to be opened first.
     */
    items.sort((a, b) => {
      const aActive = a.id === activeInstanceId ? 0 : 1
      const bActive = b.id === activeInstanceId ? 0 : 1
      if (aActive !== bActive) return aActive - bActive

      if (activeSessionId) {
        const aInActiveSession = hasTabOf(a, activeSessionId) ? 0 : 1
        const bInActiveSession = hasTabOf(b, activeSessionId) ? 0 : 1
        if (aInActiveSession !== bInActiveSession) return aInActiveSession - bInActiveSession
      }

      const aRank = rank(a)
      const bRank = rank(b)
      if (aRank !== bRank) return aRank - bRank
      return a.id.localeCompare(b.id)
    })

    return items
  }, [effectiveInstances, activeSessionId, activeInstanceId, profileOrder])

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
   * switching a tab used to make whole. Which tab ends up in front is
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
   * - **the row's context menu** hands the tab to a conversation as a chip —
   *   about the tab as a thing to look at, so it leaves the window alone.
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
                {/* The same mark the rail draws for a section: a message, because a section is
                    a conversation's work (see `TabRail`). */}
                {group.work !== null && <Icons.MessageSquare className="h-3 w-3 shrink-0" />}
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
               * hands it to a conversation**, which is about the tab as a
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
                    <TabFavicon src={tab.favicon} />
                  )}
                  <span className="min-w-0 truncate">{label}</span>
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
    // screen, because the window is the whole workspace's.
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
          exactly the one somebody wants a second tab in.
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

        {/*
          Terminating the window is one of the things you can do **to** it, so it sits with the
          other two rather than on a line of its own behind a rule (用户报告): a divider is for a
          different subject, and this is the same subject with a different outcome.
        */}
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

  /**
   * The window the trigger is about: the browser window for the conversation's profile, when it is open.
   *
   * With no resolved profile — no conversation, or the registry has not answered — it falls back
   * to the window in use, so the control still has something to show. With no window at all the
   * trigger is just the globe: which profile a click opens is the menu's job, and repeating the
   * conversation's profile on the button said nothing the menu did not (用户报告).
   */
  const focusInstance = effectiveConversationProfileId
    ? orderedInstances.find(
        (instance) => (instance.profileId ?? DEFAULT_BROWSER_PROFILE_ID) === effectiveConversationProfileId,
      )
    : orderedInstances.find((instance) => instance.id === activeInstanceId) ?? orderedInstances[0]

  /**
   * The globe's hint belongs to the globe, and the globe is not always the trigger.
   *
   * Hover state is not unmounted with the control: opening the browser from the globe leaves
   * `globeTipOpen` true (the pointer was on it when it went away), and closing the last window
   * later mounts the globe again — with that stale `true`, the hint popped up by itself
   * (用户报告). A window on screen means the trigger is a badge, so drop the hint here.
   */
  useEffect(() => {
    if (focusInstance) setGlobeTipOpen(false)
  }, [focusInstance])

  /** Every window except the one the menu lays out flat. */
  const otherInstances = orderedInstances.filter((instance) => instance.id !== focusInstance?.id)

  /** Profiles with no window in this workspace — the way to open one before a turn asks for it. */
  const openProfileIds = new Set(orderedInstances.map((instance) => instance.profileId ?? 'default'))
  const unopenedProfiles = browserProfiles.filter((profile) => !openProfileIds.has(profile.id))

  const openProfileWindow = (profileId: string) => {
    if (instancesOverride) return
    onOpenBrowser?.(profileId)
  }

  /**
   * With only the built-in Default profile and no window at all there is nothing to choose: the
   * globe opens the browser directly instead of opening a one-item menu (用户报告). A window that
   * outlived a deleted profile still keeps the menu, so it stays reachable and can be closed.
   */
  if (!focusInstance && browserProfiles.length === 1 && orderedInstances.length === 0) {
    return (
      <Tooltip open={globeTipOpen}>
        <TooltipTrigger asChild>
          <TopBarButton
            aria-label={t('browser.openBrowser')}
            className="h-7 w-7 rounded-lg"
            disabled={!!instancesOverride || !onOpenBrowser}
            onPointerEnter={() => setGlobeTipOpen(true)}
            onPointerLeave={() => setGlobeTipOpen(false)}
            onPointerDown={() => setGlobeTipOpen(false)}
            onClick={() => {
              setGlobeTipOpen(false)
              onOpenBrowser?.()
            }}
          >
            <Icons.Globe className="h-4 w-4 text-foreground/70" strokeWidth={1.5} />
          </TopBarButton>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('browser.openBrowser')}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <DropdownMenu>
      {/*
        The tooltip is only for the case with nothing to read: a globe says nothing about what it
        does. A badge already says which tab and which profile it is, so naming "open browser"
        over it would describe the wrong thing (用户报告).
      */}
      {focusInstance ? (
        <DropdownMenuTrigger asChild>
          <BrowserTabBadge
            instance={focusInstance}
            isActive
          />
        </DropdownMenuTrigger>
      ) : (
        /*
          The globe with no window. The hint is hover-only (a controlled tooltip): the menu closing
          returns focus to this button, and an uncontrolled tooltip treated that as a reason to
          show the hint — after the last tab closed, "open browser" popped up by itself (用户报告).
        */
        <Tooltip open={globeTipOpen}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <TopBarButton
                aria-label={t('browser.openBrowser')}
                className="h-7 w-7 rounded-lg"
                onPointerEnter={() => setGlobeTipOpen(true)}
                onPointerLeave={() => setGlobeTipOpen(false)}
                onPointerDown={() => setGlobeTipOpen(false)}
              >
                <Icons.Globe className="h-4 w-4 text-foreground/70" strokeWidth={1.5} />
              </TopBarButton>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('browser.openBrowser')}</TooltipContent>
        </Tooltip>
      )}

      <StyledDropdownMenuContent align="end" minWidth="min-w-64">
        {/*
          The browser window for the conversation's profile is laid out flat: its profile (when there is a
          choice of profiles), its tabs, then its own actions. That is the window this
          conversation is set to, so switching one of its tabs is one click rather than
          a hover into a submenu. The person's last-focused window does not choose it — the
          profile is the conversation's (用户报告).
        */}
        {focusInstance && (
          <>
            {profileNameOf(focusInstance) && (
              <div className="px-2 py-1 text-[11px] leading-none text-foreground/45">
                {profileNameOf(focusInstance)}
              </div>
            )}
            {renderBrowserActions(focusInstance)}
          </>
        )}

        {/*
          Every other window is one row, with its tabs in a submenu. They are not where the
          person is, so they stay one level away instead of pushing the current window's tabs
          down the menu.
        */}
        {otherInstances.length > 0 && (
          <>
            {focusInstance && <StyledDropdownMenuSeparator />}
            {otherInstances.map((instance) => {
              const displayLabel =
                instance.title.trim() || getHostname(instance.url) || t('browser.untitledTab')
              const tabCount = instance.tabs?.length ?? 0
              return (
                <DropdownMenuSub key={instance.id}>
                  <StyledDropdownMenuSubTrigger>
                    {instance.isLoading ? (
                      <Spinner className="text-[10px]" />
                    ) : (
                      <TabFavicon src={instance.favicon} />
                    )}
                    <span className="min-w-0 max-w-[200px] truncate">{displayLabel}</span>
                    {profileNameOf(instance) && (
                      <span className="shrink-0 max-w-[80px] truncate rounded-[3px] px-1 text-[9px] leading-[12px] bg-foreground/[0.08] opacity-70">
                        {profileNameOf(instance)}
                      </span>
                    )}
                    {tabCount > 1 && (
                      <span className="shrink-0 rounded-[3px] px-1 text-[9px] leading-[12px] bg-foreground/[0.08] opacity-70">
                        {tabCount}
                      </span>
                    )}
                  </StyledDropdownMenuSubTrigger>
                  <StyledDropdownMenuSubContent minWidth="min-w-56">
                    {renderBrowserActions(instance)}
                  </StyledDropdownMenuSubContent>
                </DropdownMenuSub>
              )
            })}
          </>
        )}

        {/*
          The profiles with no window are listed flat, each with the globe that already means
          "open a browser": one click opens the browser window for that profile. Burying them in a submenu made
          the same choice cost a hover (用户报告).
        */}
        {unopenedProfiles.length > 0 && orderedInstances.length > 0 && (
          <StyledDropdownMenuSeparator />
        )}
        {unopenedProfiles.map((profile) => (
          <StyledDropdownMenuItem
            key={profile.id}
            disabled={!!instancesOverride || !onOpenBrowser}
            onSelect={() => openProfileWindow(profile.id)}
          >
            <Icons.CircleUserRound className="h-3.5 w-3.5" />
            <span className="min-w-0 flex-1 truncate">{profile.name}</span>
          </StyledDropdownMenuItem>
        ))}

        {/*
          With no window and no profile list (the registry has not answered yet) there is still
          one thing this menu can do: open the workspace's browser.
        */}
        {orderedInstances.length === 0 && unopenedProfiles.length === 0 && (
          <StyledDropdownMenuItem
            disabled={!!instancesOverride || !onOpenBrowser}
            onSelect={() => onOpenBrowser?.()}
          >
            <Icons.Globe className="h-3.5 w-3.5" />
            <span className="flex-1">{t('browser.openBrowser')}</span>
          </StyledDropdownMenuItem>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
