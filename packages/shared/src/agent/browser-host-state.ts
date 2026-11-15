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
const recordingStates = new Map<string, boolean>()

export function setBrowserHostState(sessionId: string, hasLocalBrowser: boolean): void {
  states.set(sessionId, hasLocalBrowser)
}

export function getBrowserHostState(sessionId: string): boolean | undefined {
  return states.get(sessionId)
}

export function clearBrowserHostState(sessionId: string): void {
  states.delete(sessionId)
}

/**
 * Whether the server a conversation runs on can decode a recording.
 *
 * A desktop answers with its hidden window; a hub answers with the render host it staged. They are
 * two means to the same event, so `recording_tool` asks this one question rather than recognising a
 * particular host — and neither implies the other: a hub may print and draw without a pane, and a
 * desktop may have its browser door turned off and still decode.
 */
export function setRecordingHostState(sessionId: string, hasDecoder: boolean): void {
  recordingStates.set(sessionId, hasDecoder)
}

/** `undefined` is "not told yet", which keeps the tool for callers that do not know. */
export function getRecordingHostState(sessionId: string): boolean | undefined {
  return recordingStates.get(sessionId)
}

export function clearRecordingHostState(sessionId: string): void {
  recordingStates.delete(sessionId)
}
