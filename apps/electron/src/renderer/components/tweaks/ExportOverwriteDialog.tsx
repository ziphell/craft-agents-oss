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

interface ExportOverwriteDialogProps {
  /** The existing export about to be replaced; null = closed. */
  folderPath: string | null
  onConfirm: () => void
  onCancel: () => void
}

/** Confirmation before replacing an existing export — replacing means deleting that folder. */
export function ExportOverwriteDialog({ folderPath, onConfirm, onCancel }: ExportOverwriteDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={folderPath !== null} onOpenChange={open => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('tweaks.exportOverwriteTitle')}</DialogTitle>
          <DialogDescription>
            {t('tweaks.exportOverwriteDescription', { path: folderPath ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button onClick={onConfirm}>{t('tweaks.exportOverwrite')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
