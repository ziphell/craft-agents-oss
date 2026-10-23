/**
 * RemoteHostBadge — which server this window is on, and whether it is reachable.
 *
 * Local windows render nothing. A remote window shows the saved server's name next to the
 * workspace pill (the same place VS Code's status bar names the remote host), plus a dot for
 * the live connection state. Clicking it goes to Settings → Server, which explains the
 * connection and can edit it.
 */

import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { Server } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { windowRemoteTargetAtom } from '@/atoms/window-mode'
import { useTransportConnectionState } from '@/hooks/useTransportConnectionState'

interface RemoteHostBadgeProps {
  onOpenSettings?: () => void
  /** Compact top bar: the name is dropped, the icon and dot still say "remote". */
  compact?: boolean
}

export function RemoteHostBadge({ onOpenSettings, compact = false }: RemoteHostBadgeProps) {
  const { t } = useTranslation()
  const target = useAtomValue(windowRemoteTargetAtom)
  const connection = useTransportConnectionState()
  if (!target) return null

  const hostName = target.name || target.url
  const status = connection?.status ?? 'connecting'
  const connected = status === 'connected'
  const pending = status === 'connecting' || status === 'reconnecting' || status === 'idle'

  const label = connected
    ? t('remote.connectedTo', { name: hostName })
    : pending
      ? t('remote.connectingTo', { name: hostName })
      : t('remote.disconnectedFrom', { name: hostName })

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onOpenSettings}
          className={cn(
            'titlebar-no-drag shrink-0 flex items-center gap-1.5 h-[30px] rounded-[8px] px-2',
            'text-[12px] text-foreground/55 hover:text-foreground hover:bg-foreground/5 transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
          aria-label={label}
        >
          <Server className="h-3.5 w-3.5 shrink-0" />
          {!compact && <span className="truncate max-w-[160px]">{hostName}</span>}
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full shrink-0',
              connected ? 'bg-success' : pending ? 'bg-warning animate-pulse' : 'bg-destructive',
            )}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
