import * as React from "react"
import { useTranslation } from "react-i18next"
import { useState, useCallback } from "react"
import { Check, FolderPlus, ExternalLink, ChevronDown, Trash2, Server, Laptop } from "lucide-react"
import { AnimatePresence } from "motion/react"
import { useSetAtom } from "jotai"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { fullscreenOverlayOpenAtom } from "@/atoms/overlay"
import type { RemoteConnection } from '@craft-agent/shared/config/client-config'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from "@/components/ui/styled-dropdown"
import { WorkspaceAvatar } from "@/components/ui/workspace-avatar"
import { FadingText } from "@/components/ui/fading-text"
import { WorkspaceCreationScreen } from "@/components/workspace"
import { useWorkspaceIcons } from "@/hooks/useWorkspaceIcon"
import { useRemoteWorkspaceGroups } from "@/hooks/useRemoteWorkspaceGroups"
import type { Workspace } from "../../../shared/types"

interface WorkspaceSwitcherProps {
  variant?: 'sidebar' | 'topbar'
  isCollapsed?: boolean
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  onSelect: (workspaceId: string, openInNewWindow?: boolean) => void | Promise<void>
  onWorkspaceCreated?: (workspace: Workspace) => void
  onWorkspaceRemoved?: () => void
  /** workspaceId -> has unread */
  workspaceUnreadMap?: Record<string, boolean>
}

/**
 * WorkspaceSwitcher - Dropdown to select active workspace.
 *
 * Supports two trigger variants:
 * - sidebar: bottom-left selector trigger
 * - topbar: center top-bar selector trigger
 */
export function WorkspaceSwitcher({
  variant = 'sidebar',
  isCollapsed = false,
  workspaces,
  activeWorkspaceId,
  onSelect,
  onWorkspaceCreated,
  onWorkspaceRemoved,
  workspaceUnreadMap,
}: WorkspaceSwitcherProps) {
  const { t } = useTranslation()
  const [showCreationScreen, setShowCreationScreen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const setFullscreenOverlayOpen = useSetAtom(fullscreenOverlayOpenAtom)
  const selectedWorkspace = workspaces.find(w => w.id === activeWorkspaceId)
  const workspaceIconMap = useWorkspaceIcons(workspaces)
  // Servers with no window open are reached here: server, then workspace. A remote window also
  // gets one group for this machine, which is how it comes back.
  const { groups: remoteGroups } = useRemoteWorkspaceGroups(menuOpen)
  const hasUnreadInOtherWorkspaces = React.useMemo(() => {
    if (!activeWorkspaceId || !workspaceUnreadMap) return false
    return workspaces.some((workspace) => workspace.id !== activeWorkspaceId && workspaceUnreadMap[workspace.id])
  }, [workspaces, activeWorkspaceId, workspaceUnreadMap])

  /** Open a second window on that server, leaving this one where it is. */
  const openRemoteWorkspace = useCallback(async (connectionId: string, workspaceId: string) => {
    try {
      await window.electronAPI.connectToRemoteConnection(connectionId, workspaceId)
    } catch (error) {
      toast.error(t('toast.failedToOpenRemoteWindow'), {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }, [t])

  /**
   * What a pick in the remote section does.
   *
   * Both kinds of window move themselves: a local one builds the hub connection, a remote one
   * swaps server (or workspace) — the way VS Code reconnects a window to another host, renderer
   * intact. ⌘/Ctrl asks for a second window instead. `connection === null` is "this machine",
   * which only appears in a remote window and is how it gets back.
   */
  const chooseRemoteWorkspace = useCallback(async (
    connection: RemoteConnection | null,
    workspaceId: string,
    openInNewWindow: boolean,
  ) => {
    if (openInNewWindow) {
      if (connection) await openRemoteWorkspace(connection.id, workspaceId)
      else void window.electronAPI.openWorkspace(workspaceId)
      return
    }
    // A switch waits for the new server to answer, so there is a real gap to fill: until it
    // does, this window stays exactly where it is.
    const pending = connection ? toast.loading(t('remote.connectingTo', { name: connection.name })) : null
    try {
      if (connection) await window.electronAPI.switchRemoteServer(connection.id, workspaceId)
      else await window.electronAPI.switchLocalWorkspace(workspaceId)
      if (pending) toast.dismiss(pending)
      // The window is already there: selecting the workspace now only clears the state that
      // belonged to the previous one, which App does at the end of `onSelect`.
      await onSelect(workspaceId)
    } catch (error) {
      if (pending) toast.dismiss(pending)
      toast.error(t('toast.failedToSwitchServer'), {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }, [onSelect, openRemoteWorkspace, t])

  const handleNewWorkspace = () => {
    setShowCreationScreen(true)
    setFullscreenOverlayOpen(true)
  }

  const handleWorkspaceCreated = (workspace: Workspace) => {
    setShowCreationScreen(false)
    setFullscreenOverlayOpen(false)
    toast.success(t('toast.createdWorkspace', { name: workspace.name }))
    onWorkspaceCreated?.(workspace)
    onSelect(workspace.id)
  }

  const handleRemoveWorkspace = useCallback(async (workspace: Workspace) => {
    if (workspace.id === activeWorkspaceId) {
      toast.error(t('toast.cannotRemoveActiveWorkspace'))
      return
    }
    const removed = await window.electronAPI.removeWorkspace(workspace.id)
    if (removed) {
      toast.success(t('toast.removedWorkspace', { name: workspace.name }))
      onWorkspaceRemoved?.()
    }
  }, [activeWorkspaceId, onWorkspaceRemoved])

  const handleCloseCreationScreen = useCallback(() => {
    setShowCreationScreen(false)
    setFullscreenOverlayOpen(false)
  }, [setFullscreenOverlayOpen])

  return (
    <>
      {/* Full-screen workspace creation overlay */}
      <AnimatePresence>
        {showCreationScreen && (
          <WorkspaceCreationScreen
            onWorkspaceCreated={handleWorkspaceCreated}
            onClose={handleCloseCreationScreen}
          />
        )}
      </AnimatePresence>

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          {variant === 'topbar' ? (
            <button
              type="button"
              data-workspace-switcher="topbar"
              className="header-icon-btn titlebar-no-drag ml-1 flex-1 min-w-0 flex items-center justify-start gap-0.5 h-[30px] px-3 rounded-[8px] border border-foreground/6 text-[13px] text-foreground/50 hover:bg-foreground/5 hover:text-foreground transition-colors cursor-pointer data-[state=open]:bg-foreground/5 data-[state=open]:text-foreground"
              aria-label={t('workspace.selectWorkspace')}
            >
              <WorkspaceAvatar
                workspaceId={selectedWorkspace?.id}
                workspaceName={selectedWorkspace?.name}
                src={selectedWorkspace ? workspaceIconMap.get(selectedWorkspace.id) : undefined}
                className="h-4 w-4 mr-1.5 rounded-full ring-1 ring-border/50"
                fallbackClassName="rounded-full"
              />
              <span className="truncate min-w-0 flex-1 text-left">{selectedWorkspace?.name || 'Workspace'}</span>
              <ChevronDown data-slot="chevron" className="h-3 w-3 opacity-60 shrink-0" />
              {hasUnreadInOtherWorkspaces && <span className="h-2 w-2 rounded-full bg-accent shrink-0" />}
            </button>
          ) : (
            <button
              className={cn(
                "flex items-center gap-1 w-full min-w-0 justify-start px-2 py-1.5 rounded-md",
                "text-foreground hover:bg-foreground/5 data-[state=open]:bg-foreground/5 transition-colors duration-150",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                isCollapsed && "h-9 w-9 shrink-0 justify-center p-0"
              )}
              aria-label={t('workspace.selectWorkspace')}
            >
              <WorkspaceAvatar
                workspaceId={selectedWorkspace?.id}
                workspaceName={selectedWorkspace?.name}
                src={selectedWorkspace ? workspaceIconMap.get(selectedWorkspace.id) : undefined}
                className="h-4 w-4 rounded-full ring-1 ring-border/50"
                fallbackClassName="rounded-full"
              />
              {!isCollapsed && (
                <>
                  <FadingText className="ml-1 font-sans min-w-0 text-sm" fadeWidth={36}>
                    {selectedWorkspace?.name || 'Select workspace'}
                  </FadingText>
                  <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
                </>
              )}
            </button>
          )}
        </DropdownMenuTrigger>

        <StyledDropdownMenuContent
          align={variant === 'topbar' ? 'center' : 'start'}
          sideOffset={variant === 'topbar' ? 6 : 4}
          minWidth={variant === 'topbar' ? 'min-w-64' : undefined}
        >
          {workspaces.map((workspace) => {
            return (
              <StyledDropdownMenuItem
                key={workspace.id}
                onClick={(e) => {
                  const openInNewWindow = e.metaKey || e.ctrlKey
                  onSelect(workspace.id, openInNewWindow)
                }}
                className={cn(
                  "justify-between group",
                  activeWorkspaceId === workspace.id && "bg-foreground/10",
                )}
              >
                <div className="flex items-center gap-3 font-sans min-w-0 flex-1">
                  <WorkspaceAvatar
                    workspaceId={workspace.id}
                    workspaceName={workspace.name}
                    src={workspaceIconMap.get(workspace.id)}
                    className="h-5 w-5 rounded-full ring-1 ring-border/50"
                    fallbackClassName="rounded-full text-xs"
                  />
                  <span className="truncate">{workspace.name}</span>
                  {workspaceUnreadMap?.[workspace.id] && <span className="h-2 w-2 rounded-full bg-accent shrink-0" />}
                </div>
                <div className="flex items-center gap-1">
                  {/* Action buttons - only visible on hover for non-active workspaces */}
                  {activeWorkspaceId !== workspace.id && (
                    <button
                      data-touch-reveal="true"
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/20 hover:text-destructive transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRemoveWorkspace(workspace)
                      }}
                      title={t("workspace.removeWorkspace")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {activeWorkspaceId !== workspace.id && (
                    <button
                      data-touch-reveal="true"
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-foreground/10 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelect(workspace.id, true)
                      }}
                      title={t("sidebarMenu.openInNewWindow")}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {activeWorkspaceId === workspace.id && (
                    <Check className="h-3.5 w-3.5" />
                  )}
                </div>
              </StyledDropdownMenuItem>
            )
          })}

          {/* Remote servers, one submenu each — the second level is that server's workspaces.
              This window moves itself to the pick (a local window builds the hub connection, a
              remote one swaps it); ⌘/Ctrl asks for a second window. In a remote window the first
              group is "this machine", which is how the window comes back. */}
          {remoteGroups.length > 0 && (
            <>
              <StyledDropdownMenuSeparator />
              <div className="px-2 py-1 font-sans text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {t('workspace.remoteServers')}
              </div>
              {remoteGroups.map((group) => {
                const isLocal = group.connection === null
                return (
                  <DropdownMenuSub key={group.connection?.id ?? 'local'}>
                    <StyledDropdownMenuSubTrigger className="font-sans">
                      <span className="flex min-w-0 items-center gap-2">
                        {isLocal
                          ? <Laptop className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          : <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                        <span className="truncate">{group.connection?.name ?? t('workspace.thisComputer')}</span>
                      </span>
                    </StyledDropdownMenuSubTrigger>
                    <StyledDropdownMenuSubContent>
                      {group.workspaces.map((workspace) => (
                        <StyledDropdownMenuItem
                          key={workspace.id}
                          className="font-sans group justify-between"
                          onClick={(e) => void chooseRemoteWorkspace(
                            group.connection,
                            workspace.id,
                            e.metaKey || e.ctrlKey,
                          )}
                        >
                          <span className="truncate">{workspace.name}</span>
                          <button
                            data-touch-reveal="true"
                            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-foreground/10 transition-opacity"
                            onClick={(e) => {
                              e.stopPropagation()
                              void chooseRemoteWorkspace(group.connection, workspace.id, true)
                            }}
                            title={t("sidebarMenu.openInNewWindow")}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </button>
                        </StyledDropdownMenuItem>
                      ))}
                      {group.workspaces.length === 0 && (
                        <StyledDropdownMenuItem disabled className="font-sans text-muted-foreground">
                          {isLocal
                            ? t('workspace.noLocalWorkspaces')
                            : group.unavailable
                              ? t('workspace.remoteUnavailable')
                              : t('workspace.noRemoteWorkspaces')}
                        </StyledDropdownMenuItem>
                      )}
                    </StyledDropdownMenuSubContent>
                  </DropdownMenuSub>
                )
              })}
            </>
          )}

          {/* Separator and New Workspace option */}
          <StyledDropdownMenuSeparator />
          <StyledDropdownMenuItem
            onClick={handleNewWorkspace}
            className="font-sans"
          >
            <FolderPlus className="h-4 w-4" />
            {t("workspace.addWorkspace")}
          </StyledDropdownMenuItem>
        </StyledDropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
