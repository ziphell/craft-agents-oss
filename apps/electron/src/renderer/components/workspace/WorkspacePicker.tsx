/**
 * WorkspacePicker — shown when a remote window connects without a workspace ID.
 * Lists remote server workspaces and allows selection or creation.
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { Spinner } from '@craft-agent/ui'
import type { WorkspaceInfo } from '../../../shared/types'
import {
  AddWorkspaceContainer,
  AddWorkspaceStepHeader,
  AddWorkspaceSecondaryButton,
  AddWorkspacePrimaryButton,
} from './primitives'
import { AddWorkspace_RadioOption } from './AddWorkspace_RadioOption'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'

type LocationOption = 'default' | 'folder'

interface WorkspacePickerProps {
  onSelectWorkspace: (workspaceId: string) => void
}

export function WorkspacePicker({ onSelectWorkspace }: WorkspacePickerProps) {
  const { t } = useTranslation()
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  // The host is already settled here (this window's server), so only the workspace level is
  // chosen: the server's default folder, or a folder picked on that same server.
  const [location, setLocation] = useState<LocationOption>('default')
  const [folderPath, setFolderPath] = useState<string | null>(null)

  // Load workspaces from server
  useEffect(() => {
    window.electronAPI.getServerWorkspaces()
      .then(ws => {
        setWorkspaces(ws)
        setLoading(false)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to load workspaces')
        setLoading(false)
      })
  }, [])

  const handleFolderSelected = useCallback((path: string) => {
    setFolderPath(path)
    setLocation('folder')
    // The folder's own name is the natural workspace name; keep a name already typed.
    if (!newName.trim()) {
      setNewName(path.split(/[\\/]/).pop() || path)
    }
  }, [newName])

  const {
    pickDirectory,
    showServerBrowser,
    serverBrowserMode,
    cancelServerBrowser,
    confirmServerBrowser,
  } = useDirectoryPicker(handleFolderSelected)

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return
    if (location === 'folder' && !folderPath) return
    setCreating(true)
    setError(null)
    try {
      // Both calls run on this window's server: the default-location one there, and the folder
      // one through workspace creation, which is registered on that server as well.
      const ws = location === 'folder' && folderPath
        ? await window.electronAPI.createWorkspace(folderPath, newName.trim())
        : await window.electronAPI.createServerWorkspace(newName.trim())
      onSelectWorkspace(ws.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
      setCreating(false)
    }
  }, [newName, location, folderPath, onSelectWorkspace])

  const canCreate = !!newName.trim() && (location === 'default' || !!folderPath) && !creating

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-sidebar px-4">
        {/* The window is frameless where the app draws its own title bar, so this
            screen needs a draggable strip of its own. */}
        <div className="titlebar-drag-region fixed top-0 left-0 right-0 h-[50px] z-titlebar" />
        <AddWorkspaceContainer>
          <Spinner className="h-6 w-6" />
          <p className="mt-3 text-sm text-muted-foreground">{t("workspace.loadingWorkspaces")}</p>
        </AddWorkspaceContainer>
      </div>
    )
  }

  return (
    <div className="flex h-screen items-center justify-center bg-sidebar px-4">
      {/* The window is frameless where the app draws its own title bar, so this
          screen needs a draggable strip of its own. */}
      <div className="titlebar-drag-region fixed top-0 left-0 right-0 h-[50px] z-titlebar" />
      <AddWorkspaceContainer>
        <AddWorkspaceStepHeader
          title={t("workspace.selectWorkspace")}
          description={t("workspace.selectWorkspaceDesc")}
        />

        {error && (
          <p className="mt-3 w-full text-center text-sm text-destructive">{error}</p>
        )}

        {/* Workspace list */}
        {workspaces.length > 0 && (
          <div className="mt-5 w-full space-y-1.5">
            {workspaces.map(ws => (
              <button
                key={ws.id}
                onClick={() => onSelectWorkspace(ws.id)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-foreground/5"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent text-xs font-semibold uppercase">
                  {ws.name.charAt(0)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{ws.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{ws.slug}</div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Divider */}
        <div className="mt-5 mb-4 w-full border-t" />

        {/* Create new */}
        <div className="w-full space-y-2">
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            placeholder={t("workspace.newWorkspaceName")}
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          />

          {/* Where on this server: its default folder, or any folder picked there. */}
          <AddWorkspace_RadioOption
            name="remote-location"
            checked={location === 'default'}
            onChange={() => setLocation('default')}
            disabled={creating}
            title={t("workspace.defaultLocation")}
            subtitle={t("workspace.underDefaultFolder")}
          />
          <AddWorkspace_RadioOption
            name="remote-location"
            checked={location === 'folder'}
            onChange={() => setLocation('folder')}
            disabled={creating}
            title={t("workspace.chooseLocation")}
            subtitle={folderPath || t("workspace.pickLocation")}
            action={location === 'folder' ? (
              <AddWorkspaceSecondaryButton
                onClick={(e) => {
                  e.preventDefault()
                  pickDirectory()
                }}
                disabled={creating}
              >
                {t("common.browse")}
              </AddWorkspaceSecondaryButton>
            ) : undefined}
          />

          <AddWorkspacePrimaryButton
            onClick={handleCreate}
            disabled={!canCreate}
            loading={creating}
            loadingText={t("workspace.creating")}
            className="bg-accent hover:bg-accent/90 text-white"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t("workspace.createWorkspace")}
          </AddWorkspacePrimaryButton>
        </div>
      </AddWorkspaceContainer>

      <ServerDirectoryBrowser
        open={showServerBrowser}
        mode={serverBrowserMode}
        onSelect={confirmServerBrowser}
        onCancel={cancelServerBrowser}
      />
    </div>
  )
}
