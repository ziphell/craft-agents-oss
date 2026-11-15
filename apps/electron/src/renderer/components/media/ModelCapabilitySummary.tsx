/**
 * One line of model facts: what the catalogue knows that the model name does not.
 *
 * Shared by the settings pane and the canvas model picker so the two cannot disagree about why a
 * model refuses a duration or a reference count. Everything shown is declared data; a model with
 * no catalogue entry simply renders nothing.
 */

import { useTranslation } from 'react-i18next'
import type { MediaModelInfo } from '@craft-agent/shared/media/model-catalog'
import { cn } from '@/lib/utils'

export function ModelCapabilitySummary({
  info,
  showCatalogId = false,
  className,
}: {
  info?: MediaModelInfo | null
  /** Settings shows the canonical id; a picker row is too narrow for it. */
  showCatalogId?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  if (!info) return null

  const caps = info.capabilities
  const parts: string[] = []
  if (showCatalogId && info.catalogId) {
    parts.push(t('mediaCapability.catalogId', { id: info.catalogId }))
  }

  const images = caps?.references?.image?.maxCount
  const videos = caps?.references?.video?.maxCount
  const audios = caps?.references?.audio?.maxCount
  if (caps?.maxReferences !== undefined) {
    parts.push(t('mediaCapability.references', { count: caps.maxReferences }))
  }
  if (images) parts.push(t('mediaCapability.imageCount', { count: images }))
  if (videos) parts.push(t('mediaCapability.videoCount', { count: videos }))
  if (audios) parts.push(t('mediaCapability.audioCount', { count: audios }))

  if (caps?.frameRoles?.length) {
    const first = caps.frameRoles.includes('first_frame')
    const last = caps.frameRoles.includes('last_frame')
    parts.push(
      first && last
        ? t('mediaCapability.framesBoth')
        : first
          ? t('mediaCapability.firstFrame')
          : t('mediaCapability.lastFrame'),
    )
  }
  if (caps?.allowsReferenceMode) parts.push(t('mediaCapability.referenceMode'))
  if (caps?.maxPromptCharacters) {
    parts.push(t('mediaCapability.prompt', { count: caps.maxPromptCharacters }))
  }

  if (parts.length === 0) return null
  return (
    <p className={cn('truncate text-[10px] leading-4 text-muted-foreground', className)}>
      {parts.join(' · ')}
    </p>
  )
}
