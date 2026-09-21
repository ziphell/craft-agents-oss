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

interface DeleteWebsiteDialogProps {
  /** Website name shown in the confirmation copy; null = closed */
  websiteName: string | null
  /** Published websites get an extra note: the public copy is taken offline too */
  shared?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Destructive confirmation — deleting a website removes its data folder too. */
export function DeleteWebsiteDialog({ websiteName, shared, onConfirm, onCancel }: DeleteWebsiteDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={websiteName !== null} onOpenChange={open => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('websites.deleteConfirmTitle')}</DialogTitle>
          <DialogDescription>
            {t('websites.deleteConfirmDescription', { name: websiteName ?? '' })}
            {shared ? ` ${t('websites.deleteSharedNote')}` : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t('websites.deleteWebsite')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
