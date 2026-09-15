/**
 * PrototypeSourceEditorDialog — edit one prototype artifact in place.
 *
 * The artifacts are ordinary files (`base.html`, `patches/*.css|js`), so this
 * dialog is a thin read → edit → write wrapper: it reads through `file:read`,
 * writes through `file:write`, and lets the caller re-read the status report.
 * Nothing is buffered on the main side, which is what makes an external editor
 * and this dialog interchangeable.
 *
 * Saving is deliberately not followed by an apply: re-injecting is a separate,
 * explicit action (`Apply`), so a half-finished edit cannot silently land on the
 * page the user is presenting.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useRegisterModal } from '@/context/ModalContext'
import { ShikiCodeEditor } from '@/components/shiki/ShikiCodeEditor'

interface PrototypeSourceEditorDialogProps {
  /** Absolute path of the artifact to edit; null keeps the dialog closed. */
  path: string | null
  /** Display name of the artifact (its file name). */
  name: string
  onClose: () => void
  /** Called after a successful write so the caller can re-read the status. */
  onSaved?: () => void
}

/** Highlighting language for an artifact, by extension. */
function languageForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'js') return 'javascript'
  if (ext === 'css') return 'css'
  if (ext === 'html' || ext === 'htm') return 'html'
  return 'text'
}

export function PrototypeSourceEditorDialog({
  path,
  name,
  onClose,
  onSaved,
}: PrototypeSourceEditorDialogProps) {
  const { t } = useTranslation()
  const open = path !== null

  const [content, setContent] = React.useState('')
  /** Content as last read from / written to disk — the dirty comparison base. */
  const [savedContent, setSavedContent] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  useRegisterModal(open, onClose)

  // Read the file whenever a new path is opened. A stale response for a path the
  // user already navigated away from is dropped.
  React.useEffect(() => {
    if (!path) return
    let cancelled = false

    setLoading(true)
    setError(null)
    window.electronAPI
      .readFile(path)
      .then((text: string) => {
        if (cancelled) return
        setContent(text)
        setSavedContent(text)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [path])

  const dirty = content !== savedContent

  const handleSave = React.useCallback(async () => {
    if (!path || saving || !dirty) return
    setSaving(true)
    setError(null)
    try {
      await window.electronAPI.writeFile(path, content)
      setSavedContent(content)
      toast.success(t('prototypeEdit.saved', { name }))
      onSaved?.()
    } catch (err) {
      console.error('[PrototypeSourceEditorDialog] Failed to save:', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [path, saving, dirty, content, name, t, onSaved])

  const handleClose = React.useCallback(() => {
    if (saving) return
    // An edit that was never written is unrecoverable once the dialog closes.
    if (dirty && !window.confirm(t('prototypeEdit.discardConfirm'))) return
    onClose()
  }, [saving, dirty, t, onClose])

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContent
        className="sm:max-w-4xl"
        // Cmd/Ctrl+S is the reflex for "save this file" — trap it on the dialog so
        // it cannot reach the window-level handler.
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            void handleSave()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            {name}
            {dirty && <span className="ml-2 text-xs text-muted-foreground">{t('prototypeEdit.unsaved')}</span>}
          </DialogTitle>
        </DialogHeader>

        <div className="h-[60vh] overflow-hidden rounded-md border border-border/50">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('common.loading')}
            </div>
          ) : (
            <ShikiCodeEditor
              value={content}
              language={path ? languageForPath(path) : 'text'}
              onChange={setContent}
            />
          )}
        </div>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" disabled={saving} onClick={handleClose}>
            {t('common.close')}
          </Button>
          <Button disabled={!dirty || saving || loading} onClick={() => void handleSave()}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
