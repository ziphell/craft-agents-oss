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

interface DeleteDesignDialogProps {
  /** Design name shown in the confirmation copy; null = closed */
  designName: string | null
  /** Published designs get an extra note: the public copy is taken offline too */
  shared?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Destructive confirmation — deleting a design removes its data folder too. */
export function DeleteDesignDialog({ designName, shared, onConfirm, onCancel }: DeleteDesignDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={designName !== null} onOpenChange={open => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('designs.deleteConfirmTitle')}</DialogTitle>
          <DialogDescription>
            {t('designs.deleteConfirmDescription', { name: designName ?? '' })}
            {shared ? ` ${t('designs.deleteSharedNote')}` : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t('designs.deleteDesign')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
