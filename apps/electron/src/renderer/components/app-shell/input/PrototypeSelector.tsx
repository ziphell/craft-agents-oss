/**
 * PrototypeSelector — the prototype this conversation is on, as its own badge with its
 * own picker, sitting next to the working-directory badge.
 *
 * The two are neighbours, not one control: the folder says **where** the conversation
 * works, the prototype says **which body of work** it is on, and binding a prototype
 * leaves the working directory alone (`SessionManager.setSessionPrototypeSlug`). Keeping
 * them as two badges is what stops either from reading as an answer to the other.
 *
 * The list is the prototypes, and unbinding is the footer action rather than a row of its
 * own — the same shape as the folder picker beside it, where "reset" is a button below the
 * list and not one of the folders.
 *
 * Both surfaces — the desktop popover and the compact drawer — read the same two facts
 * (the workspace's prototypes, this conversation's binding) and write through the same
 * session command, so no copy of the choice is kept anywhere.
 *
 * Nothing renders for a conversation with no id, or a workspace with no prototypes: a
 * badge that could only ever say "none" is noise.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { Check, FlaskConical, X } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import { prototypesAtom } from '@/atoms/prototypes'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import type { PrototypeStatus } from '@craft-agent/shared/prototypes'
import { FreeFormInputContextBadge } from './FreeFormInputContextBadge'

export interface PrototypeSelectorProps {
  /** The conversation whose binding this is. */
  sessionId?: string
  /** Render the label even with nothing bound (the chat input does this on an empty session). */
  isEmptySession?: boolean
}

/**
 * The prototypes on offer, this conversation's binding, and the one writer both surfaces
 * use. Reading the binding from session meta rather than holding it locally is deliberate:
 * the change comes back as an event, so there is never a second value to reconcile.
 */
function usePrototypeBinding(sessionId?: string) {
  const prototypes = useAtomValue(prototypesAtom)
  const sessionMeta = useAtomValue(sessionMetaMapAtom)
  const boundSlug = sessionId ? sessionMeta.get(sessionId)?.prototypeSlug : undefined

  const select = React.useCallback((slug: string | null) => {
    if (!sessionId) return
    window.electronAPI.sessionCommand(sessionId, { type: 'setPrototypeSlug', prototypeSlug: slug })
  }, [sessionId])

  return { prototypes, boundSlug, select }
}

/**
 * The badge itself, shared by both surfaces. `showChevron` is always on — this opens
 * something — and an unbound conversation shows the icon alone once the composer is no
 * longer empty, exactly like the folder badge next to it.
 *
 * Forwards its ref to the underlying button so the desktop popover can anchor to it.
 */
const PrototypeBadgeFace = React.forwardRef<HTMLButtonElement, {
  open: boolean
  isEmptySession: boolean
  boundSlug: string | undefined
  onClick?: () => void
}>(function PrototypeBadgeFace({ open, isEmptySession, boundSlug, onClick }, ref) {
  const { t } = useTranslation()
  return (
    <FreeFormInputContextBadge
      ref={ref}
      icon={<FlaskConical className="h-4 w-4" />}
      label={boundSlug ?? t('sessionMenu.prototype')}
      isExpanded={isEmptySession}
      hasSelection={!!boundSlug}
      showChevron={true}
      isOpen={open}
      onClick={onClick}
      tooltip={
        boundSlug ? (
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{t('sessionMenu.prototype')}</span>
            <span className="text-xs opacity-70 font-mono">{boundSlug}</span>
          </span>
        ) : t('sessionMenu.noPrototype')
      }
    />
  )
})

/** One prototype in the list — the bound one carries the check. */
function PrototypeRow({
  prototype,
  selected,
  onSelect,
}: {
  prototype: PrototypeStatus
  selected: boolean
  onSelect: (slug: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(prototype.slug)}
      className="w-full flex items-center gap-2 rounded-[6px] px-3 py-1.5 text-[13px] text-left hover:bg-foreground/5"
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 min-w-0 truncate font-mono">{prototype.slug}</span>
      {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
    </button>
  )
}

/** Desktop: a popover off the badge, like every other composer badge. */
export function PrototypeBadge({ sessionId, isEmptySession = false }: PrototypeSelectorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const { prototypes, boundSlug, select } = usePrototypeBinding(sessionId)

  if (!sessionId || prototypes.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PrototypeBadgeFace open={open} isEmptySession={isEmptySession} boundSlug={boundSlug} />
      </PopoverTrigger>
      <PopoverContent
        className="min-w-[200px] max-w-[400px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small p-0"
        side="top"
        align="start"
        sideOffset={4}
      >
        <div className="max-h-[200px] overflow-y-auto p-1 space-y-px">
          {prototypes.map((prototype) => (
            <PrototypeRow
              key={prototype.slug}
              prototype={prototype}
              selected={boundSlug === prototype.slug}
              onSelect={(slug) => {
                setOpen(false)
                select(slug)
              }}
            />
          ))}
        </div>

        {/* Unbinding, below the list — an action, not one of the choices. */}
        {boundSlug && (
          <div className="border-t border-border/50 p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                select(null)
              }}
              className="w-full flex items-center gap-2 rounded-[6px] px-3 py-1.5 text-[13px] text-left hover:bg-foreground/5"
            >
              {t('common.reset')}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Compact / touch: the same badge, opening a bottom sheet instead of a popover. */
export function CompactPrototypeSelector({ sessionId, isEmptySession = false }: PrototypeSelectorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const { prototypes, boundSlug, select } = usePrototypeBinding(sessionId)

  if (!sessionId || prototypes.length === 0) return null

  return (
    <>
      <PrototypeBadgeFace
        open={open}
        isEmptySession={isEmptySession}
        boundSlug={boundSlug}
        onClick={() => setOpen((prev) => !prev)}
      />

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{t('sessionMenu.prototype')}</DrawerTitle>
          </DrawerHeader>

          <div className="px-2 pb-2 flex flex-col gap-0.5 max-h-[50vh] overflow-y-auto">
            {prototypes.map((prototype) => (
              <DrawerClose asChild key={prototype.slug}>
                <button
                  type="button"
                  onClick={() => select(prototype.slug)}
                  className="flex items-center gap-3 px-3 py-3 rounded-[10px] text-left transition-colors hover:bg-foreground/5"
                >
                  <FlaskConical className="h-5 w-5 shrink-0 text-foreground/60" />
                  <div className="flex-1 min-w-0 text-sm font-medium truncate font-mono">
                    {prototype.slug}
                  </div>
                  {boundSlug === prototype.slug && (
                    <Check className="h-4 w-4 shrink-0 text-foreground/60" />
                  )}
                </button>
              </DrawerClose>
            ))}
          </div>

          {/* Unbinding, below the list — an action, not one of the choices. */}
          {boundSlug && (
            <div className="px-2 pt-2 pb-4 border-t border-border/30">
              <DrawerClose asChild>
                <button
                  type="button"
                  onClick={() => select(null)}
                  className="w-full h-12 px-3 rounded-[10px] flex items-center gap-3 text-sm font-medium text-foreground/70 hover:bg-foreground/5 transition-colors"
                >
                  <X className="h-5 w-5 shrink-0 text-foreground/60" />
                  <span>{t('common.reset')}</span>
                </button>
              </DrawerClose>
            </div>
          )}
        </DrawerContent>
      </Drawer>
    </>
  )
}
