import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { useTransportConnectionState } from './useTransportConnectionState'
import { toast } from 'sonner'

type ServerBrowserMode = 'browse' | 'manual'

interface UseDirectoryPickerOptions {
  /**
   * Pick on this saved server instead of wherever this window is.
   *
   * Workspace creation chooses a host first (this machine or a saved server) and only then a
   * folder. Naming the host here keeps the picker on that host even when this window is local.
   */
  connectionId?: string | null
}

interface DirectoryPickerResult {
  /** Open the picker (native dialog in local mode, ServerDirectoryBrowser in remote mode). */
  pickDirectory: () => void
  /** Whether the ServerDirectoryBrowser modal should be rendered. */
  showServerBrowser: boolean
  /** Which mode the ServerDirectoryBrowser should use. */
  serverBrowserMode: ServerBrowserMode
  /** The chosen host for the browser — `null` keeps it on this window. */
  serverConnectionId: string | null
  /** Close the server browser without selecting. */
  cancelServerBrowser: () => void
  /** Called when a path is selected from the server browser. */
  confirmServerBrowser: (path: string) => void
  /** Whether the picker is not this machine's own file dialog (informational). */
  isRemote: boolean
}

export function useDirectoryPicker(
  onSelect: (path: string) => void,
  options: UseDirectoryPickerOptions = {}
): DirectoryPickerResult {
  const { t } = useTranslation()
  const connectionState = useTransportConnectionState()
  const isRemote = connectionState?.mode === 'remote'
  const connectionId = options.connectionId ?? null
  // A named host is always browsed server-side; the window's hub is browsed when the server
  // says it can list, and falls back to a typed path on older servers.
  const canBrowse = connectionId
    ? true
    : isRemote && window.electronAPI.isChannelAvailable(RPC_CHANNELS.fs.LIST_DIRECTORY)

  const [showServerBrowser, setShowServerBrowser] = useState(false)

  const serverBrowserMode: ServerBrowserMode = canBrowse ? 'browse' : 'manual'

  const pickDirectory = useCallback(async () => {
    if (connectionId || isRemote) {
      // Server-side browsing (this window's hub, or the host picked for a new workspace).
      setShowServerBrowser(true)
      return
    }

    // Local mode — native OS dialog
    try {
      const path = await window.electronAPI.openFolderDialog()
      if (path) onSelect(path)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(t('toast.failedToOpenFolderPicker'), {
        description: message,
      })
    }
  }, [connectionId, isRemote, onSelect, t])

  const cancelServerBrowser = useCallback(() => {
    setShowServerBrowser(false)
  }, [])

  const confirmServerBrowser = useCallback((path: string) => {
    setShowServerBrowser(false)
    onSelect(path)
  }, [onSelect])

  return {
    pickDirectory,
    showServerBrowser,
    serverBrowserMode,
    serverConnectionId: connectionId,
    cancelServerBrowser,
    confirmServerBrowser,
    isRemote: isRemote || !!connectionId,
  }
}
