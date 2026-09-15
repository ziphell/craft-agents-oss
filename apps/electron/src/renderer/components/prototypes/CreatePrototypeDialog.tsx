/**
 * CreatePrototypeDialog — Prompts the user for a prototype name before creating it.
 *
 * Mirrors CreateProjectDialog, with two differences the prototype RPC forces:
 * `createPrototype` rejects when the derived slug is already taken or the name
 * yields no usable slug, so the submit handler is awaited and the RPC's own
 * message is shown inline; and the buttons are locked while the request is in
 * flight so a double-click cannot race two creates against the same slug.
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

interface CreatePrototypeDialogProps {
  open: boolean
  onCancel: () => void
  /**
   * Called with the trimmed name when the user confirms. Rejections are
   * surfaced in the dialog — the caller must not swallow the RPC error.
   */
  onSubmit: (name: string) => Promise<void>
}

export function CreatePrototypeDialog({ open, onCancel, onSubmit }: CreatePrototypeDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Register with modal context so X / Cmd+W closes the dialog first
  useRegisterModal(open, onCancel)

  // Reset name / error whenever the dialog opens
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
      await onSubmit(trimmed)
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
        </div>

        {error && (
          <p role="alert" className="pt-2 text-xs text-destructive">
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
