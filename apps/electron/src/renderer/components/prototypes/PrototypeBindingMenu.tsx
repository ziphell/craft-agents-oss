/**
 * PrototypeBindingMenu — the conversation-side control for a session's prototype.
 *
 * This is the counterpart to the prototype panel's "Open in conversation":
 * the panel starts the binding, this menu changes or clears it. Binding is what
 * lets the agent run `prototype-*` commands without a slug, so the current
 * binding is shown on the session rather than hidden inside the agent's prompt.
 *
 * What it shows is the *effective* prototype, which is not always one this
 * conversation was bound to: a project whose prototype is unambiguous provides it
 * to every conversation inside (plan §15.1), and that is the whole point of
 * binding one to a project — a session that says "unbound" while it quietly works
 * on a prototype would be worse than no display at all.
 *
 * The list is the workspace's prototypes atom, not a fetch on open. The trigger
 * has to answer *before* anyone opens the menu, so the inheritance can be read
 * before the click; and once the list is here, fetching a second copy for the
 * picker would be a second answer to the same question. `usePrototypes` (owned by
 * AppShell) keeps the atom current from the workspace watcher.
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
import { useActiveWorkspace } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import { prototypesAtom } from '@/atoms/prototypes'
import { projectsAtom } from '@/atoms/projects'

interface PrototypeBindingMenuProps {
  sessionId: string
  /** Prototype this conversation was bound to itself, when it has one. */
  prototypeSlug?: string
  /** Project this conversation belongs to — where an inherited prototype comes from. */
  projectId?: string
}

export function PrototypeBindingMenu({ sessionId, prototypeSlug, projectId }: PrototypeBindingMenuProps) {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id
  const prototypes = useAtomValue(prototypesAtom)
  const projects = useAtomValue(projectsAtom)

  const [saving, setSaving] = React.useState(false)

  /**
   * The prototype the conversation's project provides, if it provides exactly one.
   *
   * Derived here from the same rule the server applies (`resolveProjectPrototype`):
   * with none there is nothing to inherit, and with several the project names no
   * single prototype — so nothing is assumed, and the menu says so instead.
   */
  const project = projectId ? projects.find((item) => item.config.id === projectId) : undefined
  const candidates = project ? prototypes.filter((item) => item.projectSlug === project.config.slug) : []
  const inheritedSlug = candidates.length === 1 ? candidates[0]!.slug : null
  const effectiveSlug = prototypeSlug ?? inheritedSlug
  const ambiguous = !prototypeSlug && candidates.length > 1

  const handleBind = React.useCallback(async (slug: string | null) => {
    if (saving) return
    setSaving(true)
    try {
      // The server emits `prototype_slug_changed`, so the bound state in the
      // header (and everywhere else reading the session) updates from the event
      // rather than from local state here.
      await window.electronAPI.sessionCommand(sessionId, { type: 'setPrototypeSlug', prototypeSlug: slug })
      if (slug) {
        toast.success(t('prototypeBind.bound', { slug }))
      } else if (inheritedSlug) {
        // Clearing this conversation's own binding does not leave it without a
        // prototype — the project's one takes over, and that is worth saying.
        toast.success(t('prototypeBind.clearInherits', { slug: inheritedSlug }))
      } else {
        toast.success(t('prototypeBind.unbound'))
      }
    } catch (err) {
      console.error('[PrototypeBindingMenu] Failed to change the binding:', err)
      toast.error(t('prototypeBind.failed'))
    } finally {
      setSaving(false)
    }
  }, [saving, sessionId, t, inheritedSlug])

  const triggerLabel = prototypeSlug
    ? t('prototypeBind.current', { slug: prototypeSlug })
    : inheritedSlug
      ? t('prototypeBind.inherited', { slug: inheritedSlug })
      : t('prototypeBind.none')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PanelHeaderCenterButton
          aria-label={triggerLabel}
          tooltip={triggerLabel}
          icon={<FlaskConical className="h-4 w-4" />}
          // A working prototype is visually distinct, whether it was bound here or
          // inherited, so the binding is discoverable without opening the menu.
          className={effectiveSlug ? 'text-accent opacity-100' : undefined}
        />
      </DropdownMenuTrigger>

      <StyledDropdownMenuContent align="end" sideOffset={8}>
        {effectiveSlug && (
          <>
            <StyledDropdownMenuItem onClick={() => navigate(routes.view.prototypes(effectiveSlug))}>
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

        {/* Nothing is inherited, and the reason is not "there is none": the project
            has several, so naming one would be a guess. */}
        {ambiguous && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {t('prototypeBind.ambiguous', { count: candidates.length })}
          </div>
        )}

        {prototypes.map((prototype) => (
          <StyledDropdownMenuItem
            key={prototype.slug}
            onClick={() => void handleBind(prototype.slug)}
          >
            {prototype.slug === effectiveSlug
              ? <Check className="h-3.5 w-3.5" />
              : <FlaskConical className="h-3.5 w-3.5" />}
            <span className="flex-1 font-mono text-xs">{prototype.slug}</span>
            {prototype.slug === inheritedSlug && prototypeSlug !== inheritedSlug && (
              <span className="text-[11px] text-muted-foreground">
                {t('prototypeBind.inheritedTag')}
              </span>
            )}
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
