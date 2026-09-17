/**
 * Pure render-mode decision for the chat-input model picker.
 *
 * The picker has four mutually-exclusive UIs. Centralizing the truth table
 * here keeps the chevron on the trigger button and the popover content
 * branch in agreement, and makes the rule trivially unit-testable.
 *
 * Precedence (highest first):
 *   1. unavailable     — current connection is gone / error state
 *   2. switcher        — more than one connection configured: hierarchical
 *                        provider → connection → models list. Available at any
 *                        point in a session, including after the first message,
 *                        because switching model/connection mid-conversation is
 *                        an explicit user action (the session's connection pin
 *                        only blocks *implicit* rewrites).
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
  if (input.connectionUnavailable) return 'unavailable'
  if (input.connectionCount > 1) return 'switcher'
  if (input.connectionDefaultModel != null) return 'locked-single'
  return 'flat'
}
