/**
 * EditTargetPageDialog — change which page an overlay points at.
 *
 * The address is a fact about where the page is, not a rule of the kind: the same
 * page usually exists in a dev, a staging and a production environment, and the
 * same patches are meant to be looked at in each (plan §13.2.1). So this is an
 * ordinary field — the point is to keep the address visible and changeable, not
 * to put it behind a warning wall.
 *
 * The warning is there because two things go stale **silently** when it changes:
 * a window already open on the old page keeps showing it, and the selectors were
 * written against the old DOM — a patch that matches nothing looks exactly like a
 * patch that did nothing. Both happen just as much when a site changes and the
 * address does not, which is why this informs rather than blocks.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRegisterModal } from '@/context/ModalContext'

interface EditTargetPageDialogProps {
  open: boolean
  /** Shown in the title, so the dialog says which prototype it will change. */
  slug: string
  currentUrl: string
  onCancel: () => void
  /** Rejections are surfaced in the dialog — the caller must not swallow the RPC error. */
  onSubmit: (targetUrl: string) => Promise<void>
}

export function EditTargetPageDialog({
  open,
  slug,
  currentUrl,
  onCancel,
  onSubmit,
}: EditTargetPageDialogProps) {
  const { t } = useTranslation()
  const [url, setUrl] = React.useState(currentUrl)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  useRegisterModal(open, onCancel)

  React.useEffect(() => {
    if (open) {
      setUrl(currentUrl)
      setError(null)
      setSubmitting(false)
    }
  }, [open, currentUrl])

  const trimmed = url.trim()
  // Saving an unchanged value would write the config and say nothing changed; the
  // interesting action is repointing, so an identical address is not one.
  const canSubmit = trimmed.length > 0 && trimmed !== currentUrl && !submitting

  const handleCancel = () => {
    if (submitting) return
    onCancel()
  }

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(trimmed)
    } catch (err) {
      // The RPC message names what to fix (a from-scratch prototype, a scheme-less
      // address), so show it verbatim and only fall back to the generic label.
      setError(err instanceof Error && err.message ? err.message : t('prototypeTarget.failed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('prototypeTarget.title')}</DialogTitle>
          <DialogDescription className="font-mono text-xs">{slug}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5 pt-2">
          <label htmlFor="edit-prototype-target" className="text-xs font-medium text-muted-foreground">
            {t('prototypeTarget.addressLabel')}
          </label>
          <Input
            id="edit-prototype-target"
            autoFocus
            value={url}
            disabled={submitting}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('prototypeCreate.targetUrlPlaceholder')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                e.preventDefault()
                void handleSubmit()
              }
            }}
          />
        </div>

        {/* The cost of repointing, said once and in the place where it is incurred. */}
        <div className="flex items-start gap-2 rounded-md border border-border/50 bg-foreground/[0.02] px-2.5 py-2">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/40" />
          <p className="text-[11px] leading-snug text-muted-foreground">{t('prototypeTarget.warning')}</p>
        </div>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" disabled={submitting} onClick={handleCancel}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {submitting ? t('common.saving') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
