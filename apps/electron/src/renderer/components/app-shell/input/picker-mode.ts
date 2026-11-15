/**
 * Pure render-mode decision for the chat-input model picker.
 *
 * The picker has four mutually-exclusive UIs. Centralizing the truth table
 * here keeps the chevron on the trigger button and the popover content
 * branch in agreement, and makes the rule trivially unit-testable.
 *
 * Precedence (highest first):
 *   1. switcher        — more than one connection configured, or the session's
 *                        connection is gone but other connections remain:
 *                        hierarchical provider → connection → models list.
 *                        Available at any point in a session, including after
 *                        the first message, because switching model/connection
 *                        mid-conversation is an explicit user action (the
 *                        session's connection pin only blocks *implicit*
 *                        rewrites). It is also how a session whose connection
 *                        was deleted is re-pointed — the pin died with the
 *                        connection, so the user picks the replacement.
 *   2. unavailable     — the session's connection is gone and there is nothing
 *                        left to pick (no connections configured): dead end.
 *   3. locked-single   — `pi_compat` connection with ≤1 model and only one
 *                        connection configured: nothing else to pick, so show
 *                        the single disabled row.
 *   4. flat            — fall-through: list models for the active connection
 *
 * Note: `switcher` deliberately wins over `locked-single`, so a single-model
 * `pi_compat` connection can never be a dead end while other connections exist
 * (regression guard for #727).
 */

export type PickerMode = 'unavailable' | 'switcher' | 'locked-single' | 'flat'

export interface PickerModeInput {
  connectionUnavailable: boolean
  /** Non-null when the active connection is `pi_compat` with ≤1 model. */
  connectionDefaultModel: string | null
  /** Total number of configured connections in the workspace. */
  connectionCount: number
}

export function derivePickerMode(input: PickerModeInput): PickerMode {
  // The session's connection was removed. While another connection exists the
  // picker stays usable: it lists them so the user re-points this session, the
  // same explicit switch as any mid-session connection change. Only with no
  // connections configured at all is there nothing to pick.
  if (input.connectionUnavailable) {
    return input.connectionCount > 0 ? 'switcher' : 'unavailable'
  }
  if (input.connectionCount > 1) return 'switcher'
  if (input.connectionDefaultModel != null) return 'locked-single'
  return 'flat'
}
