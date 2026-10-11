import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Image as ImageIcon } from 'lucide-react'

export interface ImageSupportWarningBannerProps {
  /** Display name of the active model — interpolated into the message. */
  modelName: string
  /** Click-handler for the inline "Enable image support" action. */
  onEnable: () => void
  /**
   * When set, the pending images will be read by this vision model — the banner
   * becomes an informational note naming it, with no action (nothing to fix).
   * Left unset, it stays the "images will be stripped" warning as before.
   */
  routedToModelName?: string
}

/**
 * Pre-flight banner shown above the chat input when the user has staged image
 * attachments while the active model is configured as text-only.
 *
 * Two states, decided by the parent: with a `routedToModelName` the images will
 * be read by that vision model, so it only informs; without one they will be
 * dropped, so it warns and offers the inline "Enable image support" action
 * (the same `setModelSupportsImages` flow the model picker's row toggle uses).
 */
export function ImageSupportWarningBanner({
  modelName,
  onEnable,
  routedToModelName,
}: ImageSupportWarningBannerProps) {
  const { t } = useTranslation()

  if (routedToModelName) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 mx-2 mt-2 rounded-md bg-foreground/5 text-foreground/70 text-xs">
        <ImageIcon className="h-3.5 w-3.5 shrink-0 text-foreground/50" />
        <span className="flex-1 min-w-0">
          {t('chat.imageWarning.routed', { modelName: routedToModelName })}
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 mx-2 mt-2 rounded-md bg-amber-500/10 text-foreground/70 text-xs">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      <span className="flex-1 min-w-0">
        {t('chat.imageWarning.title', { modelName })}
      </span>
      <button
        type="button"
        onClick={onEnable}
        className="shrink-0 underline underline-offset-2 hover:text-foreground"
      >
        {t('chat.imageWarning.action')}
      </button>
    </div>
  )
}
