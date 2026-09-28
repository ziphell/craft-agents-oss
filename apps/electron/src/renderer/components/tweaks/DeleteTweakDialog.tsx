import * as React from 'react'
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

interface DeleteTweakDialogProps {
  /** Tweak name shown in the confirmation copy; null = closed */
  tweakName: string | null
  onConfirm: () => void
  onCancel: () => void
}

/** Destructive confirmation — deleting a tweak removes its code folder too. */
export function DeleteTweakDialog({ tweakName, onConfirm, onCancel }: DeleteTweakDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={tweakName !== null} onOpenChange={open => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('tweaks.deleteConfirmTitle')}</DialogTitle>
          <DialogDescription>
            {t('tweaks.deleteConfirmDescription', { name: tweakName ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t('tweaks.deleteTweak')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
