/**
 * PrototypeBindingMenu — the conversation-side control for a session's prototype.
 *
 * This is the counterpart to the prototype panel's "Open in conversation":
 * the panel starts the binding, this menu changes or clears it. Binding is what
 * lets the agent run `prototype-*` commands without a slug, so the current
 * binding is shown on the session rather than hidden inside the agent's prompt.
 *
 * The list is read when the menu opens (not on mount): it is only needed at the
 * moment of choosing, and a list cached from page load would go stale.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
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
import type { PrototypeStatus } from '@craft-agent/shared/prototypes'

interface PrototypeBindingMenuProps {
  sessionId: string
  /** Bound prototype slug, when this session has one. */
  prototypeSlug?: string
}

export function PrototypeBindingMenu({ sessionId, prototypeSlug }: PrototypeBindingMenuProps) {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id

  const [prototypes, setPrototypes] = React.useState<PrototypeStatus[]>([])
  const [loaded, setLoaded] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  const refresh = React.useCallback(async () => {
    if (!workspaceId) return
    try {
      const result = await window.electronAPI.listPrototypes(workspaceId)
      setPrototypes(Array.isArray(result) ? (result as PrototypeStatus[]) : [])
      setLoaded(true)
    } catch (err) {
      console.error('[PrototypeBindingMenu] Failed to load prototypes:', err)
    }
  }, [workspaceId])

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

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) void refresh() }}>
      <DropdownMenuTrigger asChild>
        <PanelHeaderCenterButton
          aria-label={prototypeSlug
            ? t('prototypeBind.current', { slug: prototypeSlug })
            : t('prototypeBind.none')}
          tooltip={prototypeSlug
            ? t('prototypeBind.current', { slug: prototypeSlug })
            : t('prototypeBind.none')}
          icon={<FlaskConical className="h-4 w-4" />}
          // A bound session is visually distinct, so the binding is discoverable
          // without opening the menu.
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

        {loaded && prototypes.length === 0 && (
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
