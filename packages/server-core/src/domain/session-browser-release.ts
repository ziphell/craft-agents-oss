/**
 * What letting go of the browser takes: the overlay comes off, and the marks of what this
 * session drove go with it. Nothing is owned to begin with — a window belongs to its
 * workspace, and a conversation only ever drove its tabs for a while.
 */
export type BrowserReleaser = {
  clearVisualsForSession(sessionId: string): Promise<void>
  unbindAllForSession(sessionId: string): void
}

/**
 * Let go of the browser this session was using when the agent is forced to stop
 * (plan submitted, auth interrupt, user stop). Accepts either a direct
 * releaser handle (local Electron path) or a per-session resolver
 * (server path, where the actual BPM may be a `RemoteBrowserPaneManager`).
 *
 * `getBpm` is preferred — it lets the caller bind release to the right
 * session-scoped BPM without leaking session identity into the releaser type.
 */
export async function releaseBrowserOnForcedStop(
  source: BrowserReleaser | ((sessionId: string) => BrowserReleaser | null) | null | undefined,
  sessionId: string,
): Promise<void> {
  if (!source) return
  const releaser = typeof source === 'function' ? source(sessionId) : source
  if (!releaser) return
  await releaser.clearVisualsForSession(sessionId)
  releaser.unbindAllForSession(sessionId)
}
