/**
 * SkillAvatar - Thin wrapper around EntityIcon for skills.
 *
 * Sets fallbackIcon to the shared skill mark (see @craft-agent/ui → mention-icons), so a skill
 * with no icon of its own looks the same here as it does in a chip. Use `fluid` prop for
 * fill-parent sizing (e.g., Info_Page.Hero).
 */

import { EntityIcon } from '@/components/ui/entity-icon'
import { mentionIconComponent } from '@craft-agent/ui'
import { useEntityIcon } from '@/lib/icon-cache'
import type { IconSize } from '@craft-agent/shared/icons'
import type { LoadedSkill } from '../../../shared/types'

/** Made once, not per render: a new component identity would remount the avatar each time. */
const SKILL_FALLBACK_ICON = mentionIconComponent('skill')

interface SkillAvatarProps {
  /** LoadedSkill object */
  skill: LoadedSkill
  /** Size variant */
  size?: IconSize
  /** Fill parent container (h-full w-full). Overrides size. */
  fluid?: boolean
  /** Additional className overrides */
  className?: string
  /** Workspace ID for loading local icons */
  workspaceId?: string
}

export function SkillAvatar({ skill, size = 'md', fluid, className, workspaceId }: SkillAvatarProps) {
  const icon = useEntityIcon({
    workspaceId: workspaceId ?? '',
    entityType: 'skill',
    identifier: skill.slug,
    iconPath: skill.iconPath,
    iconValue: skill.metadata.icon,
  })

  return (
    <EntityIcon
      icon={icon}
      size={size}
      fallbackIcon={SKILL_FALLBACK_ICON}
      alt={skill.metadata.name}
      className={className}
      containerClassName={fluid ? 'h-full w-full' : undefined}
    />
  )
}
