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
  Drawer,
  DrawerTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerClose,
} from "@/components/ui/drawer"
import { WorkspaceAvatar } from "@/components/ui/workspace-avatar"
import { WorkspaceCreationScreen } from "@/components/workspace"
import { useWorkspaceIcons } from "@/hooks/useWorkspaceIcon"
import { useRemoteWorkspaceGroups } from "@/hooks/useRemoteWorkspaceGroups"
import type { Workspace } from "../../../shared/types"

interface CompactWorkspaceSwitcherProps {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  onSelect: (workspaceId: string, openInNewWindow?: boolean) => void | Promise<void>
  onWorkspaceCreated?: (workspace: Workspace) => void
  onWorkspaceRemoved?: () => void
  workspaceUnreadMap?: Record<string, boolean>
}

/**
 * CompactWorkspaceSwitcher — bottom-sheet workspace picker for compact/touch mode.
 *
 * Mirrors the topbar trigger from `WorkspaceSwitcher` (avatar pill with chevron)
 * but opens a Drawer instead of a Radix DropdownMenu so the picker is
 * touch-friendly and avoids the awkward popover anchoring on narrow viewports.
 */
export function CompactWorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  onSelect,
  onWorkspaceCreated,
  onWorkspaceRemoved,
  workspaceUnreadMap,
}: CompactWorkspaceSwitcherProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [showCreationScreen, setShowCreationScreen] = useState(false)
  const [reconnectTarget, setReconnectTarget] = useState<Workspace | null>(null)
  const setFullscreenOverlayOpen = useSetAtom(fullscreenOverlayOpenAtom)
  const selectedWorkspace = workspaces.find(w => w.id === activeWorkspaceId)
  const workspaceIconMap = useWorkspaceIcons(workspaces)
  // Servers without a window are reached from here: server, then its workspaces. On another
  // machine a first group is this machine, which is how the window comes back.
  const { groups: remoteGroups } = useRemoteWorkspaceGroups(open)

  /**
   * A pick moves this window: it builds a hub connection, swaps one, or releases it for this
   * machine. There is no modifier on a touch sheet, so "open a second window" is a button on
   * each row.
   */
  const chooseRemoteWorkspace = useCallback(async (connection: RemoteConnection | null, workspaceId: string) => {
    setOpen(false)
    // A switch waits for the new server to answer; until it does, this window stays where it is.
    const pending = connection ? toast.loading(t('remote.connectingTo', { name: connection.name })) : null
    try {
      if (connection) await window.electronAPI.switchRemoteServer(connection.id, workspaceId)
      else await window.electronAPI.switchLocalWorkspace(workspaceId)
      if (pending) toast.dismiss(pending)
      // Already there: selecting the workspace now only clears what the previous one owned.
      await onSelect(workspaceId)
    } catch (error) {
      if (pending) toast.dismiss(pending)
      toast.error(t('toast.failedToSwitchServer'), {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }, [onSelect, t])

  /** Open a second window on that server (or this machine), leaving this one where it is. */
  const openRemoteWorkspaceInNewWindow = useCallback(async (
    connection: RemoteConnection | null,
    workspaceId: string,
  ) => {
    setOpen(false)
    if (!connection) {
      void window.electronAPI.openWorkspace(workspaceId)
      return
    }
    try {
      await window.electronAPI.connectToRemoteConnection(connection.id, workspaceId)
    } catch (error) {
      toast.error(t('toast.failedToOpenRemoteWindow'), {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }, [t])

  const hasUnreadInOtherWorkspaces = React.useMemo(() => {
    if (!activeWorkspaceId || !workspaceUnreadMap) return false
    return workspaces.some((workspace) => workspace.id !== activeWorkspaceId && workspaceUnreadMap[workspace.id])
  }, [workspaces, activeWorkspaceId, workspaceUnreadMap])

  const handleNewWorkspace = () => {
    setShowCreationScreen(true)
    setFullscreenOverlayOpen(true)
    setOpen(false)
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
  }, [activeWorkspaceId, onWorkspaceRemoved, t])

  const handleCloseCreationScreen = useCallback(() => {
    setShowCreationScreen(false)
    setFullscreenOverlayOpen(false)
  }, [setFullscreenOverlayOpen])

  return (
    <>
      <AnimatePresence>
        {showCreationScreen && (
          <WorkspaceCreationScreen
            onWorkspaceCreated={handleWorkspaceCreated}
            onClose={handleCloseCreationScreen}
          />
        )}
      </AnimatePresence>

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>
          <button
            type="button"
            data-workspace-switcher="topbar"
            className="titlebar-no-drag ml-1 h-[30px] flex-1 min-w-0 flex items-center justify-start gap-1 px-3 rounded-[8px] border border-foreground/6 text-[13px] text-foreground/55 hover:bg-foreground/5 hover:text-foreground transition-colors cursor-pointer data-[state=open]:bg-foreground/5 data-[state=open]:text-foreground"
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
        </DrawerTrigger>

        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{t('workspace.selectWorkspace')}</DrawerTitle>
          </DrawerHeader>

          <div className="px-2 pb-2 flex flex-col gap-0.5 max-h-[60vh] overflow-y-auto">
            {workspaces.map((workspace) => {
              const isActive = activeWorkspaceId === workspace.id
              const handleSelect = () => {
                onSelect(workspace.id)
                setOpen(false)
              }
              return (
                <div
                  key={workspace.id}
                  className={cn(
                    "flex items-center gap-3 px-3 py-3 rounded-[10px] transition-colors",
                    isActive ? "bg-foreground/5" : "hover:bg-foreground/5",
                  )}
                >
                  <button
                    type="button"
                    onClick={handleSelect}
                    className="flex-1 min-w-0 flex items-center gap-3 text-left outline-none"
                  >
                    <WorkspaceAvatar
                      workspaceId={workspace.id}
                      workspaceName={workspace.name}
                      src={workspaceIconMap.get(workspace.id)}
                      className="h-7 w-7 rounded-full ring-1 ring-border/50 shrink-0"
                      fallbackClassName="rounded-full text-sm"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="truncate text-sm font-medium">{workspace.name}</span>
                        {workspaceUnreadMap?.[workspace.id] && <span className="h-2 w-2 rounded-full bg-accent shrink-0" />}
                      </div>
                    </div>
                  </button>
                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => handleRemoveWorkspace(workspace)}
                      className="shrink-0 h-9 w-9 rounded-[8px] flex items-center justify-center text-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors"
                      aria-label={t("workspace.removeWorkspace")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => { onSelect(workspace.id, true); setOpen(false) }}
                      className="shrink-0 h-9 w-9 rounded-[8px] flex items-center justify-center text-foreground/50 hover:text-foreground hover:bg-foreground/10 transition-colors"
                      aria-label={t("sidebarMenu.openInNewWindow")}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </button>
                  )}
                  {isActive && (
                    <Check className="h-4 w-4 shrink-0 text-foreground/60 mr-2" />
                  )}
                </div>
              )
            })}

            {/* Servers and their workspaces. A pick moves this window there — and on another
                machine the first group is "this machine", which is how it comes back. */}
            {remoteGroups.length > 0 && (
              <div className="mt-2">
                <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('workspace.remoteServers')}
                </div>
                {remoteGroups.map((group) => {
                  const isLocal = group.connection === null
                  return (
                    <div key={group.connection?.id ?? 'local'} className="mt-1">
                      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
                        {isLocal
                          ? <Laptop className="h-3.5 w-3.5 shrink-0" />
                          : <Server className="h-3.5 w-3.5 shrink-0" />}
                        <span className="truncate">{group.connection?.name ?? t('workspace.thisComputer')}</span>
                      </div>
                      {group.workspaces.map((workspace) => (
                        <div
                          key={workspace.id}
                          className="flex items-center gap-1 px-1 rounded-[10px] hover:bg-foreground/5 transition-colors"
                        >
                          <button
                            type="button"
                            onClick={() => void chooseRemoteWorkspace(group.connection, workspace.id)}
                            className="flex-1 min-w-0 flex items-center gap-3 px-2 py-2.5 text-left"
                          >
                            <span className="truncate text-sm">{workspace.name}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void openRemoteWorkspaceInNewWindow(group.connection, workspace.id)}
                            className="shrink-0 h-9 w-9 rounded-[8px] flex items-center justify-center text-foreground/50 hover:text-foreground hover:bg-foreground/10 transition-colors"
                            aria-label={t("sidebarMenu.openInNewWindow")}
                            title={t("sidebarMenu.openInNewWindow")}
                          >
                            <ExternalLink className="h-4 w-4" />
                          </button>
                        </div>
                      ))}
                      {group.workspaces.length === 0 && (
                        <div className="px-3 py-2 text-xs text-muted-foreground/70">
                          {isLocal
                            ? t('workspace.noLocalWorkspaces')
                            : group.denied
                              ? t('workspace.remoteControlDenied')
                              : group.unavailable
                                ? t('workspace.remoteUnavailable')
                                : t('workspace.noRemoteWorkspaces')}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            <DrawerClose asChild>
              <button
                type="button"
                onClick={handleNewWorkspace}
                className="mt-1 flex items-center gap-3 px-3 py-3 rounded-[10px] hover:bg-foreground/5 transition-colors text-left"
              >
                <div className="h-7 w-7 rounded-full bg-foreground/5 flex items-center justify-center shrink-0">
                  <FolderPlus className="h-4 w-4 text-foreground/60" />
                </div>
                <span className="text-sm font-medium">{t("workspace.addWorkspace")}</span>
              </button>
            </DrawerClose>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  )
}
