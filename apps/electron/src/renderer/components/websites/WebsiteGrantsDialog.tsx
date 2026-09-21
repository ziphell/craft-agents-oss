import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@craft-agent/ui'
import type { LoadedWebsite } from '@craft-agent/shared/websites/types'
import { describeGrantAction, describeGrantStatus, grantKindIcon, useGrantRemoval } from './grant-visuals'

/**
 * "Approved actions" — everything the website is allowed to do, with removal.
 * Lists ALL persisted grants (including stale/expired ones: they still block
 * publishing when they are script grants, so they must be visible and
 * removable). Removal is instant — pure privilege reduction, the website can
 * simply re-request — and the list refreshes via websites:changed → atom → props.
 */

interface WebsiteGrantsDialogProps {
  workspaceId: string
  website: LoadedWebsite
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function WebsiteGrantsDialog({ workspaceId, website, open, onOpenChange }: WebsiteGrantsDialogProps) {
  const { t } = useTranslation()
  const { config } = website
  const grants = config.grants ?? []
  const { busyGrantId, removeGrant } = useGrantRemoval(workspaceId, config.slug)

  return (
    <Dialog open={open} onOpenChange={next => { if (busyGrantId === null) onOpenChange(next) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('websites.grants.manage')}</DialogTitle>
          <DialogDescription>{t('websites.grants.manageDescription', { name: config.name })}</DialogDescription>
        </DialogHeader>

        {grants.length === 0 ? (
          <p className="text-sm text-foreground/50">{t('websites.grants.none')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {grants.map(grant => {
              const isScript = grant.action.kind === 'script'
              const Icon = grantKindIcon(grant.action.kind)
              const status = describeGrantStatus(grant, config.contentDigest, t)
              return (
                <li
                  key={grant.id}
                  className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-foreground/[0.02] px-3 py-2.5"
                >
                  <Icon
                    className={
                      isScript
                        ? 'mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-500'
                        : 'mt-0.5 h-4 w-4 shrink-0 text-foreground/50'
                    }
                  />
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="break-words font-medium">{describeGrantAction(grant.action, t)}</div>
                    {grant.description && (
                      <div className="mt-0.5 break-words text-xs text-foreground/60">{grant.description}</div>
                    )}
                    <div
                      className={
                        status.usable
                          ? 'mt-0.5 text-xs text-foreground/50'
                          : 'mt-0.5 text-xs text-amber-600 dark:text-amber-500'
                      }
                    >
                      {status.label}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={busyGrantId !== null}
                    onClick={() => void removeGrant(grant.id)}
                  >
                    {busyGrantId === grant.id && <Spinner className="text-xs" />}
                    {t('websites.grants.remove')}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
