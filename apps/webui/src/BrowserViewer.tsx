/**
 * Watching the hub's browser from the web UI.
 *
 * The web client has no browser window of its own, so a browser tab that lives on the server is
 * otherwise invisible here. The viewer is shared with the Electron remote window
 * (apps/electron/src/renderer/components/browser/BrowserStreamViewer.tsx) — same stream, same
 * input path, same full-screen pane; only the workspace this page shows is web-specific.
 */

import { useAtomValue } from 'jotai'
import { windowWorkspaceIdAtom } from '@/atoms/sessions'
import { BrowserStreamViewer } from '@/components/browser/BrowserStreamViewer'

export function BrowserViewer() {
  /**
   * The workspace this tab is on, read from the atom the renderer switches — so choosing another
   * workspace moves the viewer with it instead of leaving it scoped to the one the page loaded on.
   */
  const workspaceId = useAtomValue(windowWorkspaceIdAtom) ?? undefined

  return <BrowserStreamViewer workspaceId={workspaceId} />
}
