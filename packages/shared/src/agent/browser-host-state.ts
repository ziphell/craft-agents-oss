/**
 * Whether the server a conversation runs on has a browser of its own.
 *
 * Two consumers, one answer. The prompt prints it when it is `false`, because the agent cannot
 * infer it from its tool list (that list is gated by a setting, not by the host). The tool list
 * itself drops `browser_tool` for the same reason: on a headless hub the call can only refuse, and
 * advertising a tool whose every call fails teaches the wrong lesson.
 *
 * Module-level and keyed by session, like the browser-profile state: the host writes it once when
 * the session is set up, the volatile context reads it per turn, and it never enters the cached
 * system prefix.
 */

const states = new Map<string, boolean>()

export function setBrowserHostState(sessionId: string, hasLocalBrowser: boolean): void {
  states.set(sessionId, hasLocalBrowser)
}

export function getBrowserHostState(sessionId: string): boolean | undefined {
  return states.get(sessionId)
}

export function clearBrowserHostState(sessionId: string): void {
  states.delete(sessionId)
}
