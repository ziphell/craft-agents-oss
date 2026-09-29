/**
 * SessionWebsitesMenu — the websites this conversation produced, one click away.
 *
 * The reverse index is the single weak reference a website carries
 * (`WebsiteConfig.originSessionId`), so this menu is the way back to it — no
 * library, no second navigator.
 *
 * Nothing produced, nothing rendered.
 *
 * The list comes from the workspace atom, not a fetch on open: `useWebsites`
 * (owned by AppShell) keeps it current from the watcher, so opening the menu
 * cannot show a staler answer than the header.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { PanelsTopLeft } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { useAppShellContext } from '@/context/AppShellContext'
import { openWebsiteInWindow } from '../websites/open-website'
import { websitesAtom } from '@/atoms/websites'

interface SessionWebsitesMenuProps {
  sessionId: string
}

export function SessionWebsitesMenu({ sessionId }: SessionWebsitesMenuProps) {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const websites = useAtomValue(websitesAtom)

  const produced = React.useMemo(
    () => websites.filter(website => website.config.originSessionId === sessionId),
    [websites, sessionId],
  )

  // A website is a page at its own origin, so picking one opens it in the
  // workspace's browser window rather than a page inside the app.
  const handleOpen = React.useCallback((slug: string) => {
    if (!activeWorkspaceId) return
    void openWebsiteInWindow(activeWorkspaceId, slug).catch(err => {
      toast.error(t('toast.failedToCreateBrowser'), {
        description: err instanceof Error ? err.message : String(err),
      })
    })
  }, [activeWorkspaceId, t])

  if (produced.length === 0) return null

  const label = t('chat.websites', { count: produced.length })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PanelHeaderCenterButton
          aria-label={label}
          tooltip={label}
          icon={<PanelsTopLeft className="h-4 w-4" />}
        />
      </DropdownMenuTrigger>

      <StyledDropdownMenuContent align="end" sideOffset={8}>
        {produced.map(website => (
          <StyledDropdownMenuItem
            key={website.config.slug}
            onClick={() => handleOpen(website.config.slug)}
          >
            <PanelsTopLeft className="h-3.5 w-3.5" />
            <span className="flex-1 truncate">{website.config.name}</span>
          </StyledDropdownMenuItem>
        ))}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
