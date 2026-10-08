import type { SessionMode } from '@craft-agent/shared/protocol'

/**
 * The composer's `+` menu, as data.
 *
 * One description of what that menu offers, so the surface that draws it keeps
 * no rules of its own: whether the layer commands are offered at all (a
 * conversation that belongs to no project has nowhere to keep those files),
 * which one the conversation is on, and that `compact` is the single command
 * that cannot run while a turn is being generated.
 *
 * Items carry ids only. Labels and icons come from the command definitions
 * themselves (`components/ui/slash-command-menu`), so no command is described
 * twice — and the layer ids are the session's own `mode` values, not a second
 * list of the same three words.
 */

/** Everything the menu can offer: attaching a file, the layer, or compacting. */
export type ComposerMenuItemId = 'attach' | SessionMode | 'compact'

export interface ComposerMenuItem {
  id: ComposerMenuItemId
  /** Draw a separator above this item (groups are only drawn where they exist). */
  separatorBefore: boolean
  /** This item is the layer the conversation is on (the menu never unsets one). */
  active: boolean
  /** This item cannot be chosen right now. */
  disabled: boolean
}

export interface ComposerMenuState {
  /**
   * The layer commands to offer, in the order to offer them. Empty when the
   * conversation belongs to no project.
   */
  layers: readonly SessionMode[]
  /** The layer the conversation is on, if any. */
  layerMode?: SessionMode | null
  /** A turn is being generated. */
  isProcessing: boolean
}

export function buildComposerMenuItems({
  layers,
  layerMode,
  isProcessing,
}: ComposerMenuState): ComposerMenuItem[] {
  // "Attach files" is always first: it is the one item here that is not a
  // command, and the one people most often came for. Opening the menu with the
  // keyboard puts focus on it, so Enter Enter is still a single action.
  const items: ComposerMenuItem[] = [
    { id: 'attach', separatorBefore: false, active: false, disabled: false },
  ]

  for (const layer of layers) {
    items.push({
      id: layer,
      separatorBefore: items.length === 1,
      active: layer === layerMode,
      disabled: false,
    })
  }

  items.push({
    id: 'compact',
    separatorBefore: items.length > 1,
    active: false,
    // A turn's model and context are fixed when it is sent, so summarizing the
    // context is the one command that makes no sense mid-turn.
    disabled: isProcessing,
  })

  return items
}
