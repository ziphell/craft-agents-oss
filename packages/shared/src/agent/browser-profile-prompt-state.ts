/**
 * The browser profile each conversation works in, as the prompt needs it.
 *
 * A module-level map keyed by session, like the permission-mode diagnostics: the volatile context
 * builder reads it once per turn, and the host writes it whenever the session's profile or the
 * workspace default changes. It deliberately does **not** live in the system prompt — the profile
 * can change between turns, and re-stamping the cached prefix is what issue #862 is about.
 *
 * It is also where a switch becomes something the model can read: `previousName` is the profile an
 * as-yet-unannounced switch came from, consumed by the next turn's context. That is how a user
 * switching the profile stops being invisible to the agent.
 */

export interface BrowserProfilePromptState {
  /** The display name `--profile` accepts, or the id when the registry has no name for it. */
  name: string
  /** The profile a user switched away from, until a turn announces it. */
  previousName?: string
}

const states = new Map<string, BrowserProfilePromptState>()

/**
 * Record the profile a session works in.
 *
 * A change keeps the **first** profile of an unannounced switch, so two switches before a turn
 * read as "Default → Work" rather than losing the original in the second hop.
 */
export function setBrowserProfilePromptState(
  sessionId: string,
  name: string,
  options?: { announceFrom?: string },
): void {
  const current = states.get(sessionId)
  if (current?.name === name) {
    // Same profile: keep any pending announcement it already carries.
    if (current.previousName === undefined && options?.announceFrom) {
      states.set(sessionId, { name, previousName: options.announceFrom })
    }
    return
  }

  states.set(sessionId, {
    name,
    ...(options?.announceFrom
      ? { previousName: options.announceFrom }
      : current?.previousName
        ? { previousName: current.previousName }
        : {}),
  })
}

export function getBrowserProfilePromptState(sessionId: string): BrowserProfilePromptState | undefined {
  return states.get(sessionId)
}

/**
 * The switch this session has not announced yet, if there is one.
 *
 * Consuming rather than reading: the note belongs to the first turn after the switch, and a turn
 * that repeats it would claim the user switched again.
 */
export function consumeBrowserProfileChange(
  sessionId: string,
): { from: string; to: string } | null {
  const current = states.get(sessionId)
  if (!current?.previousName) return null
  const from = current.previousName
  states.set(sessionId, { name: current.name })
  return { from, to: current.name }
}

/** The conversation is gone — so is what it was working in. */
export function clearBrowserProfilePromptState(sessionId: string): void {
  states.delete(sessionId)
}
