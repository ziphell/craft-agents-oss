import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Paperclip, Plus } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'

import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { COMPACT_COMMAND, LAYER_COMMANDS, type SlashCommand } from '@/components/ui/slash-command-menu'
import { FreeFormInputContextBadge } from './FreeFormInputContextBadge'
import { buildComposerMenuItems, type ComposerMenuItem } from './composer-menu'
import { cn } from '@/lib/utils'
import type { SessionMode } from '@craft-agent/shared/protocol'

/**
 * ComposerPlusMenu — everything that can be added to a draft or asked of the
 * conversation, behind one `+` next to the input: files, the layer the
 * conversation works on (`goal`/`spec`/`plan`), and compacting the context.
 *
 * Why here and not in the permission menu: the layer is session state, not a
 * permission, and it is invisible while it sits behind a chip that only names
 * the permission mode. This menu is where "what else can I put in this draft"
 * already lives, and it is offered in both composer layouts, so a compact
 * window gets the layer commands too.
 *
 * Labels and icons are the command definitions' own (`slash-command-menu`), and
 * what the menu offers is decided by `buildComposerMenuItems` — this file only
 * draws it. Setting the layer is the caller's business; the menu only sets one
 * (the X on the input's layer chip is still how a layer is cleared).
 *
 * The trigger is a `+` and stays one: choosing a layer must not turn it into a
 * word (the layer is already named on the draft's chip), so the only thing that
 * ever widens it is the file count.
 */
export interface ComposerPlusMenuProps {
  disabled?: boolean
  /** The conversation belongs to a project, so goal/spec/plan have a home. */
  layersEnabled: boolean
  /** The layer the conversation is on, if any. */
  layerMode?: SessionMode
  attachmentCount: number
  isProcessing: boolean
  onAttach: () => void
  onSelectLayer: (layer: SessionMode) => void
  onCompact: () => void
  'data-tutorial'?: string
}

export function ComposerPlusMenu({
  disabled = false,
  layersEnabled,
  layerMode,
  attachmentCount,
  isProcessing,
  onAttach,
  onSelectLayer,
  onCompact,
  'data-tutorial': dataTutorial,
}: ComposerPlusMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  const items = React.useMemo(
    () =>
      buildComposerMenuItems({
        layers: layersEnabled ? LAYER_COMMANDS.map(command => command.id as SessionMode) : [],
        layerMode,
        isProcessing,
      }),
    [layersEnabled, layerMode, isProcessing],
  )

  const layerCommandsById = React.useMemo(
    () => new Map<string, SlashCommand>(LAYER_COMMANDS.map(command => [command.id, command])),
    [],
  )

  // The trigger is a `+` and never a word about the layer: the layer is named
  // on the draft's chip, so choosing one leaves this button a bare icon. What
  // does widen it is the file count, exactly as the attach badge always did.
  const hasAttachments = attachmentCount > 0
  const label = hasAttachments ? t('chat.filesCount', { count: attachmentCount }) : t('chat.attachAndMore')

  // The menu's own items: what to show, and what choosing it does. Both come
  // from the same description, so an item can never be drawn without a meaning
  // or offered while it is disabled.
  const describe = (item: ComposerMenuItem): { label: string; icon: React.ReactNode } => {
    if (item.id === 'attach') {
      return { label: t('chat.attachFiles'), icon: <Paperclip className="h-3.5 w-3.5" /> }
    }
    if (item.id === 'compact') {
      return { label: COMPACT_COMMAND.label, icon: COMPACT_COMMAND.icon }
    }
    const command = layerCommandsById.get(item.id)
    return command
      ? { label: command.label, icon: command.icon }
      : { label: item.id, icon: null }
  }

  const handleSelect = (item: ComposerMenuItem) => {
    if (item.id === 'attach') onAttach()
    else if (item.id === 'compact') onCompact()
    // The menu sets the layer; it never unsets one. Clearing stays where the
    // layer is shown — the X on the input's layer chip.
    else onSelectLayer(item.id)
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <FreeFormInputContextBadge
              // A plus reads smaller than the glyphs beside it (a cross fills
              // less of its box than a paperclip does), so it is drawn at 18px
              // and the padding is tightened to keep the button the same 28px
              // square (5 + 18 + 5) — centred, not widened.
              icon={<Plus className="h-[18px] w-[18px]" />}
              label={label}
              hasSelection={hasAttachments}
              showChevron={false}
              isOpen={open}
              disabled={disabled}
              aria-label={t('chat.attachAndMore')}
              data-tutorial={dataTutorial}
              className={hasAttachments ? undefined : 'px-[5px]'}
            />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{t('chat.attachAndMore')}</TooltipContent>
      </Tooltip>

      <StyledDropdownMenuContent
        side="top"
        align="start"
        sideOffset={4}
        className="min-w-[220px]"
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          // Hand the caret back to the input, like the permission menu does —
          // but never on touch devices, where focusing pulls up the keyboard.
          const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
          if (!isTouchDevice) {
            window.dispatchEvent(new CustomEvent('craft:focus-input'))
          }
        }}
      >
        {items.map(item => {
          const { label: itemLabel, icon } = describe(item)
          return (
            <React.Fragment key={item.id}>
              {item.separatorBefore && <StyledDropdownMenuSeparator />}
              <StyledDropdownMenuItem
                disabled={item.disabled}
                onSelect={() => handleSelect(item)}
                className="justify-between"
                data-active={item.active ? 'true' : undefined}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-muted-foreground">{icon}</span>
                  <span className={cn('truncate', item.active && 'font-medium')}>{itemLabel}</span>
                </span>
                {item.active && <Check className="h-3.5 w-3.5 shrink-0 text-foreground/60" />}
              </StyledDropdownMenuItem>
            </React.Fragment>
          )
        })}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
