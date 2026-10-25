/**
 * RemoteUnreachableScreen — shown when a window pointed at a remote server cannot reach it.
 *
 * A remote window's setup state and workspaces live on its hub, so when the hub is down there is
 * nothing to show yet nothing is misconfigured. This screen names the target, explains the
 * failure, and offers two ways forward: retry the connection, or work on this machine instead.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Monitor, ServerOff } from 'lucide-react'
import { Spinner } from '@craft-agent/ui'
import type { RemoteWindowTarget, TransportConnectionState, Workspace } from '../../../shared/types'
import { getFailureReason } from '@/components/app-shell/TransportConnectionBanner'
import {
  AddWorkspaceContainer,
  AddWorkspaceStepHeader,
  AddWorkspacePrimaryButton,
} from '@/components/workspace/primitives'

interface RemoteUnreachableScreenProps {
  target: RemoteWindowTarget | null
  connectionState: TransportConnectionState | null
  onRetry: () => void
  onSwitchToLocal: (workspaceId: string) => Promise<void>
}

export function RemoteUnreachableScreen({
  target,
  connectionState,
  onRetry,
  onSwitchToLocal,
}: RemoteUnreachableScreenProps) {
  const { t } = useTranslation()
  // This machine's workspaces, not the hub's: the whole point is that the hub cannot answer.
  const [localWorkspaces, setLocalWorkspaces] = useState<Workspace[] | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.getLocalWorkspaces()
      .then((list) => {
        if (!cancelled) setLocalWorkspaces(list)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLocalWorkspaces([])
        setLocalError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSwitch = useCallback(async (workspaceId: string) => {
    setSwitchingId(workspaceId)
    setSwitchError(null)
    try {
      await onSwitchToLocal(workspaceId)
    } catch (error) {
      setSwitchError(error instanceof Error ? error.message : String(error))
      setSwitchingId(null)
    }
  }, [onSwitchToLocal])

  const retrying =
    connectionState?.status === 'connecting' || connectionState?.status === 'reconnecting'
  const host = target?.name || target?.url || ''
  const detail = connectionState
    ? getFailureReason(connectionState)
    : t('transport.waitingForConnection')

  return (
    <div className="flex h-screen items-center justify-center bg-sidebar px-4">
      {/* The window is frameless where the app draws its own title bar, so this
          screen needs a draggable strip of its own. */}
      <div className="titlebar-drag-region fixed top-0 left-0 right-0 h-[50px] z-titlebar" />
      <AddWorkspaceContainer>
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <ServerOff className="h-6 w-6" />
        </div>

        <AddWorkspaceStepHeader
          title={t('remote.unreachable.title')}
          description={host ? t('remote.unreachable.description', { name: host }) : undefined}
          className="mt-4"
        />

        <p className="mt-3 w-full break-words text-center text-xs text-muted-foreground">
          {detail}
        </p>

        <AddWorkspacePrimaryButton
          onClick={onRetry}
          loading={retrying}
          loadingText={t('common.retrying')}
          className="mt-5"
        >
          {t('common.retry')}
        </AddWorkspacePrimaryButton>

        <div className="mt-6 mb-4 w-full border-t" />

        <div className="w-full">
          <div className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">{t('remote.unreachable.switchToLocal')}</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('remote.unreachable.switchToLocalDesc')}
          </p>

          {localWorkspaces === null && (
            <div className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Spinner className="h-4 w-4" />
              {t('workspace.loadingWorkspaces')}
            </div>
          )}

          {localError && <p className="mt-3 text-xs text-destructive">{localError}</p>}

          {localWorkspaces?.length === 0 && !localError && (
            <p className="mt-3 text-xs text-muted-foreground">
              {t('remote.unreachable.noLocalWorkspaces')}
            </p>
          )}

          {!!localWorkspaces?.length && (
            <div className="mt-3 max-h-48 w-full space-y-1.5 overflow-y-auto">
              {localWorkspaces.map((ws) => (
                <button
                  key={ws.id}
                  onClick={() => void handleSwitch(ws.id)}
                  disabled={switchingId !== null}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-foreground/5 disabled:opacity-50"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent text-xs font-semibold uppercase">
                    {ws.name.charAt(0)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{ws.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{ws.rootPath}</div>
                  </div>
                  {switchingId === ws.id && <Spinner className="h-4 w-4 shrink-0" />}
                </button>
              ))}
            </div>
          )}

          {switchError && <p className="mt-3 text-xs text-destructive">{switchError}</p>}
        </div>
      </AddWorkspaceContainer>
    </div>
  )
}
