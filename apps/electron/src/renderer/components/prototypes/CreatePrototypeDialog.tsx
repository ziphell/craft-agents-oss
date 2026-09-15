/**
 * CreatePrototypeDialog — name + kind (+ target page for overlays).
 *
 * The kind is asked for up front because it is **not** a label: it decides what
 * the prototype's page even is (the live address of someone else's page vs. a
 * document we author), what the deliverable is, and whether there is an external
 * page to keep in sync. It is fixed for the prototype's lifetime, so it cannot be
 * deferred to a later settings screen.
 *
 * That is also why the target page is **required** once the overlay kind is
 * chosen, and why the default is the from-scratch kind: an overlay without an
 * address has no page to open, nothing to export against, and — since the kind
 * cannot be changed afterwards — no way to fill it in later. `createPrototype`
 * refuses the same combination, so the rule holds whichever entry point is used.
 *
 * `createPrototype` rejects when the derived slug is taken or the name yields no
 * usable slug, so the submit handler is awaited and the RPC's own message is
 * shown inline; the buttons are locked while in flight so a double-click cannot
 * race two creates against the same slug.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Layers, PencilRuler } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import { DEFAULT_PROTOTYPE_KIND, type PrototypeKind } from '@craft-agent/shared/prototypes'

export interface CreatePrototypeValues {
  name: string
  kind: PrototypeKind
  /** `overlay` only. */
  targetUrl?: string
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
  // Same default as the data layer (createPrototype.ts): the kind that owns its
  // own page, and so can never be left with nothing to do next.
  const [kind, setKind] = React.useState<PrototypeKind>(DEFAULT_PROTOTYPE_KIND)
  const [targetUrl, setTargetUrl] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Register with modal context so X / Cmd+W closes the dialog first
  useRegisterModal(open, onCancel)

  React.useEffect(() => {
    if (open) {
      setName('')
      setKind(DEFAULT_PROTOTYPE_KIND)
      setTargetUrl('')
      setError(null)
      setSubmitting(false)
    }
  }, [open])

  const trimmed = name.trim()
  const trimmedTarget = targetUrl.trim()
  // An overlay's page *is* the address it was created against, and the kind is
  // fixed for the prototype's lifetime — so an overlay without one would have
  // nothing to open and no way to fill it in later. Required here, for the same
  // reason it is required in createPrototype.
  const needsTarget = kind === 'overlay' && trimmedTarget.length === 0
  const canSubmit = trimmed.length > 0 && !needsTarget && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({
        name: trimmed,
        kind,
        targetUrl: kind === 'overlay' ? trimmedTarget : undefined,
      })
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

  const options: Array<{
    value: PrototypeKind
    icon: React.ReactNode
    title: string
    description: string
  }> = [
    {
      value: 'scratch',
      icon: <PencilRuler className="h-3.5 w-3.5" />,
      title: t('prototypeCreate.kindScratch'),
      description: t('prototypeCreate.kindScratchHint'),
    },
    {
      value: 'overlay',
      icon: <Layers className="h-3.5 w-3.5" />,
      title: t('prototypeCreate.kindOverlay'),
      description: t('prototypeCreate.kindOverlayHint'),
    },
  ]

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

        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t('prototypeCreate.kindLabel')}
          </span>
          <div className="grid gap-1.5">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={submitting}
                onClick={() => setKind(option.value)}
                aria-pressed={kind === option.value}
                className={cn(
                  'flex items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors',
                  'disabled:pointer-events-none disabled:opacity-60',
                  kind === option.value
                    ? 'border-accent/60 bg-accent/[0.08]'
                    : 'border-border/50 hover:bg-foreground/[0.03]',
                )}
              >
                <span className={cn('mt-0.5 shrink-0', kind === option.value ? 'text-accent' : 'text-foreground/40')}>
                  {option.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">{option.title}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {kind === 'overlay' && (
          <div className="space-y-1.5">
            <label htmlFor="create-prototype-target" className="text-xs font-medium text-muted-foreground">
              {t('prototypeCreate.targetUrlLabel')}
            </label>
            <Input
              id="create-prototype-target"
              required
              aria-required="true"
              value={targetUrl}
              disabled={submitting}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder={t('prototypeCreate.targetUrlPlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault()
                  void handleSubmit()
                }
              }}
            />
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t('prototypeCreate.targetUrlHint')}
            </p>
          </div>
        )}

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
