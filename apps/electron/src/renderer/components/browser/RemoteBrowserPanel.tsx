/**
 * The browser a remote window sees.
 *
 * A remote window's browser is the workspace's browser on **its server**, like its shell: the
 * hub owns the window and its tabs, and this client only draws the frames and sends pointer and
 * keyboard back (see docs/browser-view-streaming.md). There is nothing to raise on this machine,
 * which is why the top bar opens the full-screen viewer instead of an OS window.
 *
 * The viewer itself is `BrowserStreamViewer` — shared with the web UI, which has the same server
 * browser and no window of its own. This wrapper only answers the question that is local to
 * Electron: is this window remote at all?
 */

import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { closeBrowserViewAtom } from '@/atoms/browser-pane'
import { windowIsRemoteAtom } from '@/atoms/window-mode'
import { useAppShellContext } from '@/context/AppShellContext'
import { isWebUI } from '@/lib/platform'
import { BrowserStreamViewer } from './BrowserStreamViewer'

export function RemoteBrowserPanel() {
  const isRemote = useAtomValue(windowIsRemoteAtom)
  const { activeWorkspaceId } = useAppShellContext()
  const closeBrowserView = useSetAtom(closeBrowserViewAtom)

  // A window that stopped being remote has no server browser left to watch. The webui is never
  // remote in this sense — its own viewer owns the same atom there.
  useEffect(() => {
    if (isRemote || isWebUI) return
    closeBrowserView()
  }, [isRemote, closeBrowserView])

  // A local window's browser is a real window on this machine: there is nothing to stream here.
  if (!isRemote) return null

  return <BrowserStreamViewer workspaceId={activeWorkspaceId ?? undefined} />
}
