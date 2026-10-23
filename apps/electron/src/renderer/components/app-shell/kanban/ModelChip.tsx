import { Brain } from 'lucide-react'
import { getModelDisplayName, getModelShortName, getModelProvider } from '@config/models'
import { getProviderIcon } from '@/lib/provider-icons'
import { cn } from '@/lib/utils'
import type { KanbanModelConnection } from './types'

interface ModelChipProps {
  /** Model id, e.g. 'claude-opus-4-7'. */
  model: string
  /**
   * Connection that serves this model. Pi and custom endpoints can only be
   * resolved to a real brand through it — the static registry knows Anthropic IDs only.
   */
  connection?: KanbanModelConnection
  /** Show the short name ("Haiku") instead of the full display name ("Haiku 4.5"). */
  short?: boolean
  className?: string
}

/**
 * Read-only chip: provider brand icon + model name. Reuses the centralized
 * model registry (`@config/models`) and provider icon map so it can't drift
 * from the real model metadata.
 */
export function ModelChip({ model, connection, short = false, className }: ModelChipProps) {
  // Prefer the serving connection; fall back to the registry for rows without a
  // connection (synthetic spec nodes, legacy tasks). Unknown providers get a
  // neutral glyph — never assume Anthropic, which painted every unknown model
  // with the Claude logo.
  const iconUrl =
    (connection && getProviderIcon(connection.providerType, connection.baseUrl, connection.piAuthProvider)) ??
    getProviderIcon(getModelProvider(model) ?? '')
  const label = short ? getModelShortName(model) : getModelDisplayName(model)

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
        'bg-foreground/[0.04] text-foreground/70 ring-1 ring-foreground/[0.06]',
        className
      )}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className="h-3 w-3 shrink-0 rounded-[2px]" aria-hidden />
      ) : (
        <Brain className="h-3 w-3 shrink-0 text-foreground/40" strokeWidth={1.75} aria-hidden />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  )
}
