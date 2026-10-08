/**
 * Pushing a design's fresh snapshot into any tab that is showing it.
 *
 * A tab is a plain page: it renders the snapshot it can fetch, and nothing pushes to it —
 * so a wallboard left open there would sit on the data it loaded. This is the push. When a
 * workspace's designs change (every write stamps `design.json`, which is what the broadcast
 * follows), each tab whose address is one of those designs is handed the new snapshot in the
 * bridge's own message shape — the same message the app's frame receives.
 *
 * Nothing else about such a tab changes: it still has no host, no grants, and no data beyond
 * the snapshot it renders. And it is a push, not a promise: a tab that is not showing a design
 * is never touched, and a design with no snapshot on disk is skipped.
 */

import { existsSync, readFileSync } from 'node:fs'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import {
  designPreviewLabel,
  getDesignSnapshotPath,
  loadWorkspaceDesigns,
} from '@craft-agent/shared/designs'
import type { BrowserPaneManager } from './browser-pane-manager'
import { mainLog } from './logger'

export async function pushDesignSnapshotsToTabs(pane: BrowserPaneManager, workspaceId: string): Promise<void> {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) return

  for (const design of loadWorkspaceDesigns(workspace.rootPath)) {
    const snapshotPath = getDesignSnapshotPath(workspace.rootPath, design.config.slug)
    if (!existsSync(snapshotPath)) continue
    try {
      await pane.pushDesignSnapshot(
        workspaceId,
        // The label is derived the same way the host derived the address it served, so a tab
        // holding that address is recognised by it.
        designPreviewLabel(design.config.slug, design.folderPath),
        readFileSync(snapshotPath, 'utf-8'),
      )
    } catch (error) {
      mainLog.warn(
        `[design-tab-pusher] ${design.config.slug}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
