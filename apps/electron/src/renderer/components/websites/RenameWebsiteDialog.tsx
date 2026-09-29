import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

interface RenameWebsiteDialogProps {
  /** Current website name; null = closed */
  websiteName: string | null
  onSubmit: (name: string) => void
  onCancel: () => void
}

/** Rename a website from its card's menu. Enter submits, Escape cancels. */
export function RenameWebsiteDialog({ websiteName, onSubmit, onCancel }: RenameWebsiteDialogProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = React.useState('')

  React.useEffect(() => {
    if (websiteName !== null) setDraft(websiteName)
  }, [websiteName])

  const submit = React.useCallback(() => {
    const next = draft.trim()
    if (next) onSubmit(next)
    else onCancel()
  }, [draft, onSubmit, onCancel])

  return (
    <Dialog open={websiteName !== null} onOpenChange={open => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('websites.renameWebsite')}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={draft}
          aria-label={t('common.name')}
          placeholder={t('common.name')}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') submit()
            else if (e.key === 'Escape') onCancel()
          }}
        />
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={!draft.trim()}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
