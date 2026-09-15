/**
 * Prototype ↔ live-browser bridge.
 *
 * Shared by the agent tool (`browser_tool prototype-apply`) and the prototype
 * panel's buttons, so both paths produce identical results — a divergence here
 * would mean the UI and the agent disagree about what is on the page.
 *
 * @see docs/prototype-workbench-plan.md §3 (阶段 3 持久注入)
 */

import { buildPatchInitScript, scanPrototypePatches } from '@craft-agent/shared/prototypes'
import type { IBrowserPaneManager } from '../handlers/browser-pane-manager-interface'

export interface PrototypeApplyResult {
  slug: string
  applied: number
  files: string[]
}

export interface PrototypeClearResult {
  slug: string
  removed: string[]
}

/**
 * Replay a prototype's patches into a live browser instance.
 *
 * Each patch is registered as an init script (which is what survives a reload)
 * and then evaluated immediately (so the change is visible without reloading),
 * using the *same* transform so live and reloaded behaviour cannot diverge.
 */
export async function applyPrototypeToBrowser(
  bpm: IBrowserPaneManager,
  instanceId: string,
  workspaceRootPath: string,
  slug: string,
): Promise<PrototypeApplyResult> {
  const patches = scanPrototypePatches(workspaceRootPath, slug)

  // Drop keys left over from patches that no longer exist on disk, so deleting
  // a patch file actually un-applies it.
  await bpm.clearInitScripts(instanceId, `prototype:${slug}:`)

  for (const patch of patches) {
    const script = buildPatchInitScript(patch)
    await bpm.addInitScript(instanceId, patch.key, script)
    await bpm.evaluate(instanceId, script)
  }

  return { slug, applied: patches.length, files: patches.map((patch) => patch.file) }
}

/** Remove a prototype's patches from a live browser instance. */
export async function clearPrototypeFromBrowser(
  bpm: IBrowserPaneManager,
  instanceId: string,
  slug: string,
): Promise<PrototypeClearResult> {
  const removed = await bpm.clearInitScripts(instanceId, `prototype:${slug}:`)
  return { slug, removed }
}

/**
 * Read the *rendered* document out of a live page, for use as a prototype base.
 *
 * This has to go through the browser rather than fetching the URL: a
 * client-rendered app serves an empty shell over HTTP, so a fetch captures
 * nothing, and it would also miss any authenticated state.
 */
export async function captureRenderedDocument(
  bpm: IBrowserPaneManager,
  instanceId: string,
): Promise<string> {
  const markup = await bpm.evaluate(instanceId, 'document.documentElement.outerHTML')
  if (typeof markup !== 'string' || markup.trim().length === 0) {
    throw new Error('Capture failed: the page returned no markup.')
  }
  return markup
}
