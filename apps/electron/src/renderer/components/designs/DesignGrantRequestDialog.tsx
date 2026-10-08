import * as React from 'react'
import { KeyRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { DesignGrantRequestEntry } from '../../../shared/design-bridge'
import { describeGrantAction, grantKindIcon } from './grant-visuals'

/**
 * Approval dialog for design-initiated grant requests (`grant-request` bridge
 * message). The dialog itself IS the user consent: approving calls
 * `designs:issueGrant` per entry, which binds each grant to the design's current
 * content digest. All-or-nothing per request batch — a design that wants
 * separable capabilities should send separate requests.
 */

interface DesignGrantRequestDialogProps {
  designName: string
  /** Pending request entries, or null when no dialog should show */
  requests: DesignGrantRequestEntry[] | null
  busy: boolean
  onApprove: () => void
  onDeny: () => void
}

export function DesignGrantRequestDialog({ designName, requests, busy, onApprove, onDeny }: DesignGrantRequestDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={requests !== null} onOpenChange={(open) => { if (!open && !busy) onDeny() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-amber-600 dark:text-amber-500" />
            {t('designs.grants.title')}
          </DialogTitle>
          <DialogDescription>{t('designs.grants.description', { name: designName })}</DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-2">
          {(requests ?? []).map((entry) => {
            const isScript = entry.action.kind === 'script'
            const Icon = grantKindIcon(entry.action.kind)
            return (
              <li
                key={entry.key}
                className={
                  isScript
                    ? 'flex items-start gap-2.5 rounded-lg border border-red-500/40 bg-red-500/[0.06] px-3 py-2.5'
                    : 'flex items-start gap-2.5 rounded-lg border border-border/60 bg-foreground/[0.02] px-3 py-2.5'
                }
              >
                <Icon
                  className={
                    isScript
                      ? 'mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-500'
                      : 'mt-0.5 h-4 w-4 shrink-0 text-foreground/50'
                  }
                />
                <div className="min-w-0 text-sm">
                  <div className="break-words font-medium">{describeGrantAction(entry.action, t)}</div>
                  {isScript && (
                    <div className="mt-0.5 break-words text-xs font-medium text-red-600 dark:text-red-500">
                      {t('designs.grants.scriptWarning')}
                    </div>
                  )}
                  {entry.description && (
                    <div className="mt-0.5 break-words text-xs text-foreground/60">{entry.description}</div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>

        <p className="text-xs text-foreground/50">{t('designs.grants.expiryNote')}</p>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onDeny}>
            {t('designs.grants.deny')}
          </Button>
          <Button disabled={busy} onClick={onApprove}>
            {busy ? t('designs.grants.approving') : t('designs.grants.approve')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
