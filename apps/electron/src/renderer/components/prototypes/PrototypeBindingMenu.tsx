/**
 * PrototypeBindingMenu — the conversation-side control for a session's prototype.
 *
 * This is the counterpart to the prototype panel's "Open in conversation":
 * the panel starts the binding, this menu changes or clears it. Binding is what
 * lets the agent run `prototype-*` commands without a slug, so the current
 * binding is shown on the session rather than hidden inside the agent's prompt.
 *
 * **One conversation, one binding, or none.** Nothing else decides this: a project can
 * note which prototype *it* is on (§15.1.3) and tells its conversations what exists
 * (`ProjectPromptContext.prototypes`, `<project_prototype>`) — background, like a
 * connected source — but it never binds a conversation. The choice is left to the
 * conversation, which is the only place that knows what it is working on, so this menu
 * has no "inherited" state to display: what it shows is what was bound here.
 *
 * The list is the workspace's prototypes atom, not a fetch on open: the trigger has
 * to answer *before* anyone opens the menu, and once the list is here, fetching a
 * second copy for the picker would be a second answer to the same question.
 * `usePrototypes` (owned by AppShell) keeps the atom current from the workspace
 * watcher.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { Check, FlaskConical } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { navigate, routes } from '@/lib/navigate'
import { prototypesAtom } from '@/atoms/prototypes'

interface PrototypeBindingMenuProps {
  sessionId: string
  /** Prototype this conversation is bound to, when it has one. */
  prototypeSlug?: string
}

export function PrototypeBindingMenu({ sessionId, prototypeSlug }: PrototypeBindingMenuProps) {
  const { t } = useTranslation()
  const prototypes = useAtomValue(prototypesAtom)

  const [saving, setSaving] = React.useState(false)

  const handleBind = React.useCallback(async (slug: string | null) => {
    if (saving) return
    setSaving(true)
    try {
      // The server emits `prototype_slug_changed`, so the bound state in the
      // header (and everywhere else reading the session) updates from the event
      // rather than from local state here.
      await window.electronAPI.sessionCommand(sessionId, { type: 'setPrototypeSlug', prototypeSlug: slug })
      toast.success(slug ? t('prototypeBind.bound', { slug }) : t('prototypeBind.unbound'))
    } catch (err) {
      console.error('[PrototypeBindingMenu] Failed to change the binding:', err)
      toast.error(t('prototypeBind.failed'))
    } finally {
      setSaving(false)
    }
  }, [saving, sessionId, t])

  const triggerLabel = prototypeSlug
    ? t('prototypeBind.current', { slug: prototypeSlug })
    : t('prototypeBind.none')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PanelHeaderCenterButton
          aria-label={triggerLabel}
          tooltip={triggerLabel}
          icon={<FlaskConical className="h-4 w-4" />}
          // A working prototype is visually distinct, so the binding is
          // discoverable without opening the menu.
          className={prototypeSlug ? 'text-accent opacity-100' : undefined}
        />
      </DropdownMenuTrigger>

      <StyledDropdownMenuContent align="end" sideOffset={8}>
        {prototypeSlug && (
          <>
            <StyledDropdownMenuItem onClick={() => navigate(routes.view.prototypes(prototypeSlug))}>
              <FlaskConical className="h-3.5 w-3.5" />
              <span className="flex-1">{t('prototypeBind.openPanel')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
          </>
        )}

        {prototypes.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {t('prototypeBind.empty')}
          </div>
        )}

        {prototypes.map((prototype) => (
          <StyledDropdownMenuItem
            key={prototype.slug}
            onClick={() => void handleBind(prototype.slug)}
          >
            {prototype.slug === prototypeSlug
              ? <Check className="h-3.5 w-3.5" />
              : <FlaskConical className="h-3.5 w-3.5" />}
            <span className="flex-1 font-mono text-xs">{prototype.slug}</span>
          </StyledDropdownMenuItem>
        ))}

        {prototypeSlug && (
          <>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={() => void handleBind(null)}>
              <span className="flex-1">{t('prototypeBind.clear')}</span>
            </StyledDropdownMenuItem>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
