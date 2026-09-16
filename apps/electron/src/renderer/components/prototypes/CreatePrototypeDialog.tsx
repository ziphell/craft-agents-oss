/**
 * CreatePrototypeDialog — a name, and nothing else.
 *
 * A prototype is a **container for pages**, and a new one has none: the kind and
 * the address are facts about a *page*, not about the flow that holds it (plan
 * §19). So creation asks for a name and writes no page — "this prototype has no
 * pages yet" is a true statement, and a seeded one would assert a screen that is
 * not there. The kind is asked for where a page is added (CreatePageDialog),
 * which is also where it can be honoured: an address for a live page, a document
 * for a page of ours.
 *
 * `createPrototype` rejects when the derived slug is taken or the name yields no
 * usable slug, so the submit handler is awaited and the RPC's own message is
 * shown inline; the buttons are locked while in flight so a double-click cannot
 * race two creates against the same slug.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRegisterModal } from '@/context/ModalContext'

export interface CreatePrototypeValues {
  name: string
}

interface CreatePrototypeDialogProps {
  open: boolean
  onCancel: () => void
  /**
   * Called when the user confirms. Rejections are surfaced in the dialog — the
   * caller must not swallow the RPC error.
   */
  onSubmit: (values: CreatePrototypeValues) => Promise<void>
}

export function CreatePrototypeDialog({ open, onCancel, onSubmit }: CreatePrototypeDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Register with modal context so X / Cmd+W closes the dialog first
  useRegisterModal(open, onCancel)

  React.useEffect(() => {
    if (open) {
      setName('')
      setError(null)
      setSubmitting(false)
    }
  }, [open])

  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({ name: trimmed })
    } catch (err) {
      // The RPC message is already user-facing (duplicate slug / unusable name),
      // so show it verbatim and only fall back to the generic label.
      setError(err instanceof Error && err.message ? err.message : t('prototypeCreate.failed'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = () => {
    if (submitting) return
    onCancel()
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('prototypeCreate.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-1.5 pt-2">
          <label htmlFor="create-prototype-name" className="text-xs font-medium text-muted-foreground">
            {t('prototypeCreate.nameLabel')}
          </label>
          <Input
            id="create-prototype-name"
            autoFocus
            value={name}
            disabled={submitting}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('prototypeCreate.namePlaceholder')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                e.preventDefault()
                void handleSubmit()
              }
            }}
          />
          {/* Says out loud what the new prototype is: a flow with no pages, whose
              pages are added afterwards — one of ours, or a live one. */}
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t('prototypeCreate.noPagesHint')}
          </p>
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
            {submitting ? t('prototypeCreate.creating') : t('prototypeCreate.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
