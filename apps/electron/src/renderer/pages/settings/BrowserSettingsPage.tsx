/**
 * BrowserSettingsPage
 *
 * The browser profile registry: one row per profile, plus rename and delete.
 *
 * A profile is a Chromium session — its own cookies, `localStorage` and logins — and a browser
 * window is signed into exactly one of them. `Default` is the built-in profile: it owns the session
 * every login lived in before profiles existed, so it is neither renamed nor removed. Deleting a
 * profile leaves its cookies on disk; anything still pointing at it falls back to `Default`.
 *
 * Which profile a *workspace* or a *conversation* works in is chosen elsewhere (workspace settings
 * and the composer's picker); this page only manages what exists.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { SettingsSection, SettingsCard } from '@/components/settings'
import {
  DEFAULT_BROWSER_PROFILE_ID,
  browserProfilesAtom,
  refreshBrowserProfilesAtom,
} from '@/atoms/browser-profiles'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'browser',
}

export default function BrowserSettingsPage() {
  const { t } = useTranslation()
  const profiles = useAtomValue(browserProfilesAtom)
  const refreshProfiles = useSetAtom(refreshBrowserProfilesAtom)

  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void refreshProfiles()
  }, [refreshProfiles])

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setError('')
      try {
        await action()
        await refreshProfiles()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [refreshProfiles],
  )

  const create = useCallback(async () => {
    const name = newName.trim()
    if (!name) return
    await run(async () => {
      await window.electronAPI.browserProfiles.create(name)
      setNewName('')
    })
  }, [newName, run])

  const saveRename = useCallback(async () => {
    if (!renamingId) return
    const name = renameValue.trim()
    if (!name) return
    await run(async () => {
      await window.electronAPI.browserProfiles.rename(renamingId, name)
      setRenamingId(null)
      setRenameValue('')
    })
  }, [renamingId, renameValue, run])

  const remove = useCallback(
    async (id: string) => {
      await run(async () => {
        await window.electronAPI.browserProfiles.delete(id)
        setConfirmingDeleteId(null)
      })
    },
    [run],
  )

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t('settings.browser.title', 'Browser')}
        actions={<HeaderMenu route={routes.view.settings('browser')} />}
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              <SettingsSection
                title={t('settings.browser.profiles', 'Profiles')}
                description={t(
                  'settings.browser.profilesDesc',
                  'Each profile is its own set of cookies and logins. A workspace or a conversation picks which one its browser window is signed into.',
                )}
              >
                <SettingsCard>
                  <div className="divide-y divide-border/50">
                    {profiles.map((profile) => {
                      const isDefault = profile.id === DEFAULT_BROWSER_PROFILE_ID
                      const renaming = renamingId === profile.id
                      return (
                        <div key={profile.id} className="flex items-center gap-2 px-4 py-3">
                          {renaming ? (
                            <>
                              <input
                                autoFocus
                                value={renameValue}
                                onChange={(event) => setRenameValue(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') void saveRename()
                                  if (event.key === 'Escape') setRenamingId(null)
                                }}
                                className="flex-1 min-w-0 h-8 rounded-md border border-border bg-background px-2 text-sm"
                              />
                              <button
                                type="button"
                                onClick={() => void saveRename()}
                                className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-foreground/[0.05]"
                                aria-label={t('settings.browser.save', 'Save')}
                              >
                                <Check className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setRenamingId(null)}
                                className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-foreground/[0.05]"
                                aria-label={t('settings.browser.cancel', 'Cancel')}
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </>
                          ) : (
                            <>
                              <span className="flex-1 min-w-0 truncate text-sm">{profile.name}</span>
                              {isDefault && (
                                <span className="shrink-0 rounded-[4px] bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] text-foreground/60">
                                  {t('settings.browser.builtIn', 'Built-in')}
                                </span>
                              )}
                              {!isDefault && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setRenamingId(profile.id)
                                      setRenameValue(profile.name)
                                    }}
                                    className="h-8 w-8 inline-flex items-center justify-center rounded-md text-foreground/60 hover:bg-foreground/[0.05] hover:text-foreground"
                                    aria-label={t('settings.browser.rename', 'Rename')}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  {confirmingDeleteId === profile.id ? (
                                    <button
                                      type="button"
                                      onClick={() => void remove(profile.id)}
                                      className="h-8 px-2 rounded-md text-[12px] text-destructive bg-destructive/10 hover:bg-destructive/15"
                                    >
                                      {t('settings.browser.confirmDelete', 'Delete?')}
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => setConfirmingDeleteId(profile.id)}
                                      className="h-8 w-8 inline-flex items-center justify-center rounded-md text-foreground/60 hover:bg-foreground/[0.05] hover:text-foreground"
                                      aria-label={t('settings.browser.delete', 'Delete')}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                </>
                              )}
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  <div className="flex items-center gap-2 border-t border-border/50 px-4 py-3">
                    <input
                      value={newName}
                      onChange={(event) => setNewName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void create()
                      }}
                      placeholder={t('settings.browser.namePlaceholder', 'Profile name')}
                      className="flex-1 min-w-0 h-8 rounded-md border border-border bg-background px-2 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => void create()}
                      disabled={!newName.trim()}
                      className="h-8 inline-flex items-center gap-1 rounded-md border border-border px-2.5 text-[13px] disabled:opacity-40 hover:bg-foreground/[0.03]"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t('settings.browser.addProfile', 'New profile')}
                    </button>
                  </div>

                  {error && <p className="px-4 pb-3 text-[12px] text-destructive">{error}</p>}
                  <p className="px-4 pb-3 text-[12px] text-foreground/50">
                    {t(
                      'settings.browser.deleteNote',
                      'Deleting a profile leaves its cookies on disk. Anything still pointing at it falls back to Default.',
                    )}
                  </p>
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
