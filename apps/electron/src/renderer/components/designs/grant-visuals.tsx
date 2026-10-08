/**
 * Shared helpers for grant rows (approval dialog + management surfaces):
 * kind icon, human-readable action label, lifecycle status, and the removal
 * hook. Keeping the phrasing in one place means "what was approved" reads
 * identically in the approval prompt, the Approved-actions list, and the
 * Share dialog's publish-blocked notice.
 */

import * as React from 'react'
import { Globe2, ShieldAlert, TerminalSquare, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { DesignActionDescriptor, DesignActionGrant } from '@craft-agent/shared/designs/types'
import { isDesignGrantUsable } from '@craft-agent/shared/designs/types'
import { relativeTime } from './design-visuals'

type Translate = (key: string, opts?: Record<string, unknown>) => string

export function grantKindIcon(kind: DesignActionDescriptor['kind']): LucideIcon {
  if (kind === 'script') return ShieldAlert
  if (kind === 'mcp') return TerminalSquare
  return Globe2
}

/** One phrasing for "what this approval allows", shared by every grant surface. */
export function describeGrantAction(action: DesignActionDescriptor, t: Translate): string {
  if (action.kind === 'mcp') {
    return t('designs.grants.mcpAction', { tool: action.toolName, source: action.sourceSlug })
  }
  if (action.kind === 'script') {
    return t('designs.grants.scriptAction', { script: action.script })
  }
  return t('designs.grants.apiAction', {
    method: action.method,
    path: action.pathPattern,
    source: action.sourceSlug,
  })
}

/** Lifecycle status of a persisted grant relative to the design's current content. */
export function describeGrantStatus(
  grant: Pick<DesignActionGrant, 'contentDigest' | 'expiresAt'>,
  contentDigest: string | undefined,
  t: Translate,
): { label: string; usable: boolean } {
  const now = Date.now()
  if (isDesignGrantUsable(grant, contentDigest, now)) {
    return { label: t('designs.grants.statusExpires', { when: relativeTime(grant.expiresAt) }), usable: true }
  }
  if (grant.expiresAt <= now) {
    return { label: t('designs.grants.statusExpired'), usable: false }
  }
  return { label: t('designs.grants.statusStale'), usable: false }
}

/**
 * Grant removal with per-row busy state. The caller does NOT update any list
 * itself — revocation rewrites design.json, and the designs:changed broadcast
 * refreshes the designs atom, which flows back down as props.
 */
export function useGrantRemoval(workspaceId: string, designSlug: string): {
  busyGrantId: string | null
  removeGrant: (grantId: string) => Promise<void>
} {
  const { t } = useTranslation()
  const [busyGrantId, setBusyGrantId] = React.useState<string | null>(null)

  const removeGrant = React.useCallback(async (grantId: string) => {
    setBusyGrantId(grantId)
    try {
      await window.electronAPI.revokeDesignGrant(workspaceId, designSlug, grantId)
    } catch (err) {
      toast.error(t('toast.designGrantRemoveFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusyGrantId(null)
    }
  }, [workspaceId, designSlug, t])

  return { busyGrantId, removeGrant }
}
