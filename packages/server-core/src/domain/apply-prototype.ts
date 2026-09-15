/**
 * Prototype ↔ live-browser bridge.
 *
 * Shared by the agent tool (`browser_tool prototype-apply`) and the prototype
 * panel's buttons, so both paths produce identical results — a divergence here
 * would mean the UI and the agent disagree about what is on the page.
 *
 * @see docs/prototype-workbench-plan.md §3 (阶段 3 持久注入)
 */

import { buildInlinedPatchProbeScript, buildPatchInitScript, scanPrototypePatches } from '@craft-agent/shared/prototypes'
import type { IBrowserPaneManager } from '../handlers/browser-pane-manager-interface'

export interface PrototypeApplyResult {
  slug: string
  /** Patches injected by this call. */
  applied: number
  /** The files injected by this call, in replay order. */
  files: string[]
  /**
   * Patches left alone because the document already carries them, having arrived
   * with the host's rendering. Empty for a foreign document, and non-empty is the
   * normal case for a page opened from the workbench — say so rather than
   * reporting a smaller number with no explanation.
   */
  skipped: string[]
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
 *
 * **What is already on the page is left alone.** A prototype's own address serves
 * `base.html` rendered with every patch (that is what opening one means), so a
 * page opened from the workbench already carries them; injecting again would run
 * the JS patches a second time in a document that looks identical — the change
 * would be wrong in a way nothing reports. The pages that actually need injecting
 * are the foreign ones: an overlay's real target page, or a raw file. Which is
 * which is read off the document itself (see `buildInlinedPatchProbeScript`), not
 * guessed from the address, so it holds for a document that was saved and
 * reopened elsewhere.
 *
 * The consequence to know about: a patch whose *content* changed is already listed
 * as inlined, so re-applying will not refresh it — reload the page, which re-renders
 * from disk. Patches added since the render are injected normally, which is what
 * keeps editing going on an open page.
 */
export async function applyPrototypeToBrowser(
  bpm: IBrowserPaneManager,
  instanceId: string,
  workspaceRootPath: string,
  slug: string,
): Promise<PrototypeApplyResult> {
  const patches = scanPrototypePatches(workspaceRootPath, slug)

  const inlined = await bpm.evaluate(instanceId, buildInlinedPatchProbeScript())
  const alreadyInlined = new Set(
    Array.isArray(inlined) ? inlined.filter((name): name is string => typeof name === 'string') : [],
  )

  const pending = patches.filter((patch) => !alreadyInlined.has(patch.file))

  // Init scripts are window-level and outlive the document, so the registered set
  // has to match what the page is missing exactly: drop the old registrations
  // (including any left from patches deleted on disk) and re-register only the
  // pending ones. Leaving an inlined patch registered would double it on the next
  // load of the rendered page.
  await bpm.clearInitScripts(instanceId, `prototype:${slug}:`)

  for (const patch of pending) {
    const script = buildPatchInitScript(patch)
    await bpm.addInitScript(instanceId, patch.key, script)
    await bpm.evaluate(instanceId, script)
  }

  return {
    slug,
    applied: pending.length,
    files: pending.map((patch) => patch.file),
    skipped: patches.filter((patch) => alreadyInlined.has(patch.file)).map((patch) => patch.file),
  }
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
