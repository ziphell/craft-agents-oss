/**
 * ElementEditorDialog — what happens after the user picks an element in a
 * browser panel's edit mode.
 *
 * Two ways out, matching the two things "edit the page" can mean:
 *
 * - **Save as patch** — writes a real `patches/A-nnn-*.js` file and replays the
 *   prototype, so the change is a durable artifact rather than a live DOM tweak
 *   that a reload would erase. This is the deterministic path: no model involved.
 * - **Change in the conversation** — hands the selector and current text to the
 *   session so the agent can do something that needs reasoning (behaviour, new
 *   structure) instead of a literal substitution.
 *
 * Only text substitution is offered here on purpose. Anything richer is a
 * conversation, and pretending otherwise would produce patches nobody reviewed.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { MessageSquare, Save } from 'lucide-react'
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
import { useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import type { EditElementRequest } from '@/hooks/useBrowserToolbarActions'
import type { PrototypeStatus } from '@craft-agent/shared/prototypes'

interface ElementEditorDialogProps {
  /** The picked element; null keeps the dialog closed. */
  request: EditElementRequest | null
  /** Status of the bound prototype — supplies the patches directory. */
  prototype: PrototypeStatus | null
  workspaceId: string | null | undefined
  onClose: () => void
}

/** Directory that holds a prototype's patches, using the platform's separator. */
function patchesDirFor(prototype: PrototypeStatus): { dir: string; sep: string } {
  const existing = prototype.patches.files[0]
  if (existing) {
    const cut = Math.max(existing.lastIndexOf('/'), existing.lastIndexOf('\\'))
    const sep = existing.includes('\\') ? '\\' : '/'
    if (cut > 0) return { dir: existing.slice(0, cut), sep }
  }
  const sep = prototype.dir.includes('\\') ? '\\' : '/'
  return { dir: `${prototype.dir}${sep}patches`, sep }
}

/**
 * Next free `A-nnn-…` name.
 *
 * Lane A because this is a UI/text change, and the highest existing order + 1 so
 * a patch never overwrites one written by the agent or another lane.
 */
function nextPatchFileName(prototype: PrototypeStatus): string {
  const orders = prototype.patches.files
    .map((file) => /[\\/]([A-Za-z])-(\d+)-/.exec(file))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[2]))

  const next = (orders.length > 0 ? Math.max(...orders) : 0) + 1
  return `A-${String(next).padStart(3, '0')}-text-edit.js`
}

/** A patch body is plain statements — the injector wraps it in its own guard. */
function buildTextPatchBody(selector: string, text: string): string {
  return [
    `const el = document.querySelector(${JSON.stringify(selector)});`,
    `if (el) el.textContent = ${JSON.stringify(text)};`,
    '',
  ].join('\n')
}

export function ElementEditorDialog({
  request,
  prototype,
  workspaceId,
  onClose,
}: ElementEditorDialogProps) {
  const { t } = useTranslation()
  const { onInputChange } = useAppShellContext()
  const open = request !== null

  const [text, setText] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  useRegisterModal(open, onClose)

  // Reset to the element's own text each time a new element arrives.
  React.useEffect(() => {
    setText(request?.element.text ?? '')
    setError(null)
    setSaving(false)
  }, [request])

  const dirty = !!request && text !== request.element.text

  const handleSaveAsPatch = React.useCallback(async () => {
    if (!request || !prototype || saving) return
    setSaving(true)
    setError(null)

    try {
      const { dir, sep } = patchesDirFor(prototype)
      const fileName = nextPatchFileName(prototype)
      const path = `${dir}${sep}${fileName}`

      await window.electronAPI.writeFile(path, buildTextPatchBody(request.element.selector, text))

      // Replay immediately so the change is visible in the panel the user is
      // looking at — writing the file alone would only take effect on reload.
      if (workspaceId) {
        await window.electronAPI.applyPrototype(workspaceId, request.instanceId, request.slug)
      }

      toast.success(t('browserEdit.saved', { name: fileName }))
      onClose()
    } catch (err) {
      console.error('[ElementEditorDialog] Failed to save the patch:', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [request, prototype, saving, text, workspaceId, t, onClose])

  const handleHandOffToChat = React.useCallback(() => {
    if (!request?.sessionId) {
      toast.error(t('browserEdit.noSession'))
      return
    }

    const prompt = t('browserEdit.promptTemplate', {
      selector: request.element.selector,
      text: request.element.text,
    })

    // Write the draft (read on mount) *and* dispatch (applies immediately when the
    // session is already open), then navigate — one of the two always lands.
    onInputChange(request.sessionId, prompt)
    window.dispatchEvent(new CustomEvent('craft:restore-input', {
      detail: { sessionId: request.sessionId, text: prompt },
    }))
    navigate(routes.view.allSessions(request.sessionId))
    onClose()
  }, [request, onInputChange, t, onClose])

  const element = request?.element

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('browserEdit.title')}</DialogTitle>
        </DialogHeader>

        {element && (
          <div className="space-y-3 pt-1">
            <div className="rounded-md bg-foreground/[0.03] px-3 py-2">
              <div className="font-mono text-xs break-all text-foreground/80">{element.selector}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {element.tag}
                {element.text ? ` · ${element.text.slice(0, 80)}` : ''}
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="element-text" className="text-xs font-medium text-muted-foreground">
                {t('browserEdit.textLabel')}
              </label>
              <Input
                id="element-text"
                autoFocus
                value={text}
                disabled={saving}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && dirty) {
                    e.preventDefault()
                    void handleSaveAsPatch()
                  }
                }}
              />
            </div>

            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="outline" disabled={saving || !request?.sessionId} onClick={handleHandOffToChat}>
            <MessageSquare className="h-3.5 w-3.5" />
            {t('browserEdit.changeInChat')}
          </Button>
          <Button disabled={!dirty || saving || !prototype} onClick={() => void handleSaveAsPatch()}>
            <Save className="h-3.5 w-3.5" />
            {saving ? t('common.saving') : t('browserEdit.saveAsPatch')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
