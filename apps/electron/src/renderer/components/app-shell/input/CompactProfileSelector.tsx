/**
 * Browser profile picker for the composer.
 *
 * A profile is a window: one workspace holds one browser window per profile, and a conversation
 * works in the window of the profile it picked — its browser commands use that profile unless
 * they name another with `--profile`. Choosing the profile that is also the workspace's
 * default clears the conversation's own pick again — the profile is the same, and "follow the
 * workspace" is a property of that row rather than a separate item to explain (用户报告).
 *
 * Deliberately shaped like the model picker beside it, because it is the same kind of choice.
 * Hidden until a second profile exists: with only the built-in `Default`, there is nothing to
 * pick, and a permanently disabled chip is noise in a toolbar that is already crowded.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { Check, CircleUserRound, Settings2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { FreeFormInputContextBadge } from './FreeFormInputContextBadge'
import { browserProfilesAtom, optimisticSessionProfileAtom, refreshBrowserProfilesAtom } from '@/atoms/browser-profiles'
import { navigate, routes } from '@/lib/navigate'

interface CompactProfileSelectorProps {
  sessionId: string
}

interface ResolvedProfile {
  sessionProfileId: string | null
  projectProfileId: string | null
  workspaceDefaultProfileId: string | null
  effectiveProfileId: string
}

const EMPTY_RESOLVED: ResolvedProfile = {
  sessionProfileId: null,
  projectProfileId: null,
  workspaceDefaultProfileId: null,
  effectiveProfileId: 'default',
}

export function CompactProfileSelector({ sessionId }: CompactProfileSelectorProps) {
  const { t } = useTranslation()
  const profiles = useAtomValue(browserProfilesAtom)
  const refreshProfiles = useSetAtom(refreshBrowserProfilesAtom)
  const setOptimisticProfile = useSetAtom(optimisticSessionProfileAtom)
  const [resolved, setResolved] = useState<ResolvedProfile>(EMPTY_RESOLVED)
  // The tip is shown on hover only (a controlled tooltip), never because the menu returned focus
  // to the badge — that made a tip pop up every time the person picked a profile (用户报告).
  const [tipOpen, setTipOpen] = useState(false)

  const resolve = useCallback(async () => {
    if (!window.electronAPI?.browserProfiles || !sessionId) return
    try {
      setResolved(await window.electronAPI.browserProfiles.resolve(sessionId))
    } catch (error) {
      console.error('Failed to resolve browser profile:', error)
    }
  }, [sessionId])

  useEffect(() => {
    void refreshProfiles()
    void resolve()
    // Re-resolve when the registry changes (a profile was added or deleted): a deleted pick must
    // stop being shown as this conversation's profile.
  }, [refreshProfiles, resolve, profiles.length])

  const selectedProfileMissing =
    !!resolved.sessionProfileId
    && profiles.length > 0
    && !profiles.some((profile) => profile.id === resolved.sessionProfileId)

  const profileName = useMemo(() => {
    if (selectedProfileMissing) {
      return t('composer.browserProfileMissing', 'Deleted profile')
    }
    const match = profiles.find((profile) => profile.id === resolved.effectiveProfileId)
    return match?.name ?? t('composer.browserProfileFallback', 'Default')
  }, [profiles, resolved.effectiveProfileId, selectedProfileMissing, t])

  const choose = useCallback(
    async (profileId: string | null) => {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setBrowserProfile', profileId })
    },
    [sessionId],
  )

  // Nothing to choose between, and nothing chosen: stay out of the toolbar.
  if (profiles.length <= 1 && !resolved.sessionProfileId) return null

  // The profile this conversation inherits when it has no pick of its own — the project's default,
  // else the workspace's. Choosing that row means "follow", rather than pinning the same id: the
  // profile is the same until the default changes, and a pin would quietly stop following it.
  const inheritedProfileId =
    resolved.projectProfileId ?? resolved.workspaceDefaultProfileId ?? EMPTY_RESOLVED.effectiveProfileId
  /**
   * Pick a profile, and show it **now**.
   *
   * The host has to persist the switch before it answers (and a long conversation's session file is
   * not small), so waiting for the round trip made the badge look stuck. The new pick is derivable
   * from what is already on screen — the inherited default or the chosen id — so it is applied
   * optimistically and re-resolved only if the write fails.
   */
  const chooseProfile = (profileId: string) => {
    const next = profileId === inheritedProfileId ? null : profileId
    const nextEffective =
      next ?? resolved.projectProfileId ?? resolved.workspaceDefaultProfileId ?? EMPTY_RESOLVED.effectiveProfileId
    setResolved((prev) => ({
      ...prev,
      sessionProfileId: next,
      effectiveProfileId: nextEffective,
    }))
    // Let the top bar switch with the composer instead of after a persistence round trip.
    setOptimisticProfile((prev) => ({
      ...prev,
      [sessionId]: { profileId: nextEffective, at: Date.now() },
    }))
    void choose(next).catch((error) => {
      console.error('Failed to switch browser profile:', error)
      setOptimisticProfile((prev) => {
        const nextState = { ...prev }
        delete nextState[sessionId]
        return nextState
      })
      void resolve()
    })
  }

  return (
    <DropdownMenu>
      <Tooltip open={tipOpen}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <FreeFormInputContextBadge
              icon={<CircleUserRound className="h-4 w-4" />}
              label={profileName}
              hasSelection
              className={selectedProfileMissing ? '!text-destructive' : undefined}
              onPointerEnter={() => setTipOpen(true)}
              onPointerLeave={() => setTipOpen(false)}
              onPointerDown={() => setTipOpen(false)}
            />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          {selectedProfileMissing
            ? t(
                'composer.browserProfileMissingHint',
                'This profile was deleted. Choose a valid profile before sending.',
              )
            : t('composer.browserProfileSwitchNote', 'The agent uses this browser profile by default.')}
        </TooltipContent>
      </Tooltip>
      <StyledDropdownMenuContent align="start" minWidth="min-w-56">
        {profiles.map((profile) => {
          // What this conversation would use now, whether that is its own pick or the one it
          // follows — a menu that marks nothing while following looks like no profile is chosen.
          const active = resolved.effectiveProfileId === profile.id
          return (
            <StyledDropdownMenuItem key={profile.id} onSelect={() => chooseProfile(profile.id)}>
              <div className="flex items-center gap-2 w-full">
                <Check className={`h-3.5 w-3.5 ${active ? 'opacity-100' : 'opacity-0'}`} />
                <span className="flex-1 truncate">{profile.name}</span>
              </div>
            </StyledDropdownMenuItem>
          )
        })}
        <StyledDropdownMenuSeparator />
        <StyledDropdownMenuItem onSelect={() => navigate(routes.view.settings('browser'))}>
          <div className="flex items-center gap-2 w-full">
            <Settings2 className="h-3.5 w-3.5 opacity-70" />
            <span className="flex-1 truncate">{t('composer.browserProfileManage', 'Manage profiles…')}</span>
          </div>
        </StyledDropdownMenuItem>
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
