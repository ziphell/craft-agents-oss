import * as React from 'react'
import { Sparkles, Wand2 } from 'lucide-react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { useNavigation } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import { tweaksAtom } from '@/atoms/tweaks'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { cn } from '@/lib/utils'

/**
 * Tweaks library — every tweak in the workspace, as a list.
 *
 * There is deliberately no "New tweak" here: a tweak is written by an agent (it is code
 * for a page this app does not own), and a form that produced an empty tweak would only
 * be a folder with nothing in it. The empty state says that instead of offering a button
 * that cannot work.
 */
export function TweaksHome() {
  const { t } = useTranslation()
  const { navigate } = useNavigation()
  const tweaks = useAtomValue(tweaksAtom)

  const openTweak = React.useCallback(
    (slug: string) => navigate(routes.view.tweaks(slug)),
    [navigate],
  )

  const handleAskAgent = React.useCallback(() => {
    navigate(routes.action.newSession({ input: t('tweaks.askAgentPrompt') }))
  }, [navigate, t])

  // Most recently edited first: a tweak being worked on is the one being looked for.
  const ordered = React.useMemo(
    () => [...tweaks].sort((a, b) => b.updatedAt - a.updatedAt),
    [tweaks],
  )

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="text-sm font-medium">{t('sidebar.tweaks')}</span>
          <span className="text-xs text-foreground/40">{tweaks.length}</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tweaks.length === 0 ? (
          <EntityListEmptyScreen
            icon={<Wand2 />}
            title={t('tweaks.emptyTitle')}
            description={t('tweaks.emptyDescription')}
          >
            <button
              onClick={handleAskAgent}
              className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
            >
              <Sparkles className="h-3.5 w-3.5" /> {t('tweaks.askAgent')}
            </button>
          </EntityListEmptyScreen>
        ) : (
          <div className="mx-auto w-full max-w-[1100px] p-5">
            <div className="overflow-hidden rounded-lg border border-border/60">
              {ordered.map((tweak, index) => (
                <button
                  key={tweak.slug}
                  type="button"
                  onClick={() => openTweak(tweak.slug)}
                  className={cn(
                    'flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.03]',
                    index > 0 && 'border-t border-border/40',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[13px] font-medium">{tweak.name}</span>
                      <TweakChip tone={tweak.enabled ? 'on' : 'muted'}>
                        {tweak.enabled ? t('tweaks.on') : t('tweaks.off')}
                      </TweakChip>
                      <TweakChip tone={tweak.hasCode ? 'muted' : 'warn'}>
                        {tweak.hasCode ? t('tweaks.hasCode') : t('tweaks.noCode')}
                      </TweakChip>
                    </div>
                    {tweak.description && (
                      <p className="mt-1 truncate text-xs text-foreground/50">{tweak.description}</p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      {tweak.matches.map((pattern) => (
                        <code
                          key={pattern}
                          className="rounded bg-foreground/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-foreground/60"
                        >
                          {pattern}
                        </code>
                      ))}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function TweakChip({
  tone,
  children,
}: {
  tone: 'on' | 'muted' | 'warn'
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10.5px] font-medium',
        tone === 'on' && 'bg-success/10 text-success',
        tone === 'muted' && 'bg-foreground/[0.05] text-foreground/50',
        tone === 'warn' && 'bg-destructive/10 text-destructive',
      )}
    >
      {children}
    </span>
  )
}
