/**
 * CreatePageDialog — add one page to a prototype: the two kinds, and what each
 * one needs.
 *
 * The kind cards moved here from the create-prototype dialog (plan §19.8): the
 * kind describes a **document**, not the container, and a flow may mix both —
 * three screens of ours plus the one real page we cannot rebuild. So the choice
 * is made where a page is added, which is also where it can be honoured.
 *
 * - **A live page** *is* its address, so the address is required: nothing else
 *   could say where it is, and the kind cannot be changed afterwards.
 * - **A page of ours** *is* a file. The renderer can only *declare* it — the row
 *   is the flow order and the entry, never creation (`pages.ts`) — so the dialog
 *   writes the document first (`window.electronAPI.writeFile`, which the host
 *   confines to the workspace prototypes folder) and then declares it. Declaring
 *   a page nobody wrote is refused by the control plane, so writing a minimal
 *   document is the one way this dialog can honestly offer a page of ours.
 *
 * The minimal document mentions `_layout.html` when the prototype has one, so the
 * first thing written is already consistent with how it will be rendered.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Layers, PencilRuler } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRegisterModal } from '@/context/ModalContext'
import { cn } from '@/lib/utils'
import { DEFAULT_PAGE_KIND, PROTOTYPE_LAYOUT_FILENAME, type PageKind } from '@craft-agent/shared/prototypes/types'

export interface CreatePageValues {
  name: string
  kind: PageKind
  /** `overlay` only: the live address. */
  url?: string
}

interface CreatePageDialogProps {
  open: boolean
  /** The prototype the page is added to — shown in the dialog. */
  slug: string
  /** Absolute path of the prototype's directory, where a document is written. */
  dir: string
  /** Names already in the flow (declared rows and undeclared documents alike). */
  existingNames: string[]
  onCancel: () => void
  /** Rejections are surfaced in the dialog — the caller must not swallow the RPC error. */
  onSubmit: (values: CreatePageValues) => Promise<void>
}

/**
 * A page name becomes a file name and an address segment, so it has to be usable
 * as both. The same rule the control plane enforces (`requirePageName` in
 * `pages.ts`), checked here because a page of ours is **written** before it is
 * declared: a name that cannot be a file must be refused before the write.
 */
function pageNameProblem(value: string): 'empty' | 'path' | 'reserved' | null {
  if (!value) return 'empty'
  if (/[\\/]/.test(value) || value === '.' || value === '..') return 'path'
  if (value.startsWith('_')) return 'reserved'
  return null
}

/**
 * The document a page of ours is written to.
 *
 * Joined by hand: a page of ours is `<name>.html` in the prototype's directory
 * (`pageFileName` in the data layer), and the renderer has no path module. A
 * forward slash addresses the same file on every platform Node runs on.
 */
export function pageDocumentPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${name}.html`
}

/**
 * The document a page of ours starts as — a **complete** HTML document, because
 * a fragment is not a page (`writePrototypePage` refuses one, and patches could
 * not be applied to it).
 *
 * With a layout present the document is left bare on purpose: `_layout.html` is
 * applied by the host around the page's own document, and it is the layout that
 * carries the slot — a page that repeated it would render it twice.
 */
export function buildNewPageDocument(name: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `    <title>${name}</title>`,
    '  </head>',
    '  <body>',
    `    <!-- ${name}: the screen goes here. -->`,
    '  </body>',
    '</html>',
    '',
  ].join('\n')
}

export function CreatePageDialog({
  open,
  slug,
  dir,
  existingNames,
  onCancel,
  onSubmit,
}: CreatePageDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = React.useState('')
  // The same default as the data layer: the kind that owns its own document, and
  // so can never be left with nothing to open.
  const [kind, setKind] = React.useState<PageKind>(DEFAULT_PAGE_KIND)
  const [url, setUrl] = React.useState('')
  const [hasLayout, setHasLayout] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  useRegisterModal(open, onCancel)

  React.useEffect(() => {
    if (!open) return
    setName('')
    setKind(DEFAULT_PAGE_KIND)
    setUrl('')
    setError(null)
    setSubmitting(false)
  }, [open])

  // Whether the prototype has a shared layout. Read once per open: it changes the
  // wording (and what the first document will look like), and it is cheap.
  React.useEffect(() => {
    if (!open || !dir) return
    let cancelled = false
    setHasLayout(false)
    const layoutPath = `${dir.replace(/[\\/]+$/, '')}/${PROTOTYPE_LAYOUT_FILENAME}`
    window.electronAPI
      .readFile(layoutPath)
      .then(() => {
        if (!cancelled) setHasLayout(true)
      })
      .catch(() => {
        // No layout is the ordinary case, not an error worth reporting.
        if (!cancelled) setHasLayout(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, dir])

  const trimmedName = name.trim()
  const trimmedUrl = url.trim()
  const nameProblem = pageNameProblem(trimmedName)
  const nameTaken = nameProblem === null && existingNames.includes(trimmedName)
  const needsUrl = kind === 'overlay' && trimmedUrl.length === 0
  const canSubmit = !nameProblem && !nameTaken && !needsUrl && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({
        name: trimmedName,
        kind,
        url: kind === 'overlay' ? trimmedUrl : undefined,
      })
    } catch (err) {
      // The RPC message is already user-facing (a file that has to exist, an
      // address that is already another page's), so show it verbatim.
      setError(err instanceof Error && err.message ? err.message : t('prototypePage.failed'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = () => {
    if (submitting) return
    onCancel()
  }

  const options: Array<{
    value: PageKind
    icon: React.ReactNode
    title: string
    description: string
  }> = [
    {
      value: 'scratch',
      icon: <PencilRuler className="h-3.5 w-3.5" />,
      title: t('prototypePage.kindScratch'),
      description: t('prototypePage.kindScratchHint'),
    },
    {
      value: 'overlay',
      icon: <Layers className="h-3.5 w-3.5" />,
      title: t('prototypePage.kindOverlay'),
      description: t('prototypePage.kindOverlayHint'),
    },
  ]

  const fileName = `${trimmedName || '<name>'}.html`

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('prototypePage.title')}</DialogTitle>
          {/* Which prototype the page lands in — the dialog is opened from its row. */}
          <DialogDescription className="font-mono text-xs">{slug}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5 pt-2">
          <label htmlFor="create-page-name" className="text-xs font-medium text-muted-foreground">
            {t('prototypePage.nameLabel')}
          </label>
          <Input
            id="create-page-name"
            autoFocus
            value={name}
            disabled={submitting}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('prototypePage.namePlaceholder')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                e.preventDefault()
                void handleSubmit()
              }
            }}
          />
          {nameProblem === 'path' || nameProblem === 'reserved' ? (
            <p role="alert" className="text-[11px] leading-snug text-destructive">
              {t('prototypePage.nameInvalid')}
            </p>
          ) : nameTaken ? (
            <p role="alert" className="text-[11px] leading-snug text-destructive">
              {t('prototypePage.nameTaken', { name: trimmedName })}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t('prototypePage.kindLabel')}
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

        {kind === 'overlay' ? (
          <div className="space-y-1.5">
            <label htmlFor="create-page-url" className="text-xs font-medium text-muted-foreground">
              {t('prototypePage.urlLabel')}
            </label>
            <Input
              id="create-page-url"
              required
              aria-required="true"
              value={url}
              disabled={submitting}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('prototypePage.urlPlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault()
                  void handleSubmit()
                }
              }}
            />
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t('prototypePage.urlHint')}
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {/* Which file gets written, said before it happens: a page of ours is
                a document, and the name is what the file is called. */}
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t('prototypePage.scratchFileHint', { file: fileName })}
            </p>
            {hasLayout && (
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t('prototypePage.layoutNote', { layout: PROTOTYPE_LAYOUT_FILENAME })}
              </p>
            )}
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
            {submitting ? t('prototypePage.creating') : t('prototypePage.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
