/**
 * Prototype ↔ live-browser bridge.
 *
 * Shared by the agent tool (`browser_tool prototype-apply`) and the prototype
 * panel's buttons, so both paths produce identical results — a divergence here
 * would mean the UI and the agent disagree about what is on the page.
 *
 * @see docs/prototype-workbench-plan.md §3 (阶段 3 持久注入), §19.4 (按页归属)
 */

import {
  buildInlinedPatchProbeScript,
  buildPatchInitScript,
  findEntryPage,
  listPrototypePages,
  matchPrototypePage,
  scanPrototypePatches,
  scanPrototypePatchesForPage,
  type PrototypePage,
} from '@craft-agent/shared/prototypes'
import type { IBrowserPaneManager } from '../handlers/browser-pane-manager-interface'

export interface PrototypeApplyResult {
  slug: string
  /**
   * Whose patches were replayed: the page this window is actually on, or the
   * entry page when the window is on none of them.
   *
   * `null` means "the shared patches only" (`patches/*`, which apply to every
   * page) — the window is on no page of this prototype and no page of ours claims
   * the address it is on. It is part of the answer rather than a detail, because
   * without it "this prototype has no patch for what you are looking at" and "the
   * patch you wrote belongs to another page" read identically from `files`.
   */
  page: string | null
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
 * **What is already on the page is left alone.** A page of ours served on the
 * prototype's own address is rendered with that page's patches already in it (that
 * is what opening one means), so a window on it already carries them; injecting
 * again would run the JS patches a second time in a document that looks identical —
 * the change would be wrong in a way nothing reports. The pages that actually need
 * injecting are the foreign ones: an overlay's live page, or a raw file. Which is
 * which is read off the document itself (see `buildInlinedPatchProbeScript`), not
 * guessed from the address, so it holds for a document that was saved and
 * reopened elsewhere.
 *
 * The consequence to know about: a patch whose *content* changed is already listed
 * as inlined, so re-applying will not refresh it — reload the page, which re-renders
 * from disk. Patches added since the render are injected normally, which is what
 * keeps editing going on an open page.
 *
 * **Which patches** is decided by the window (plan §19.4): the page it is on brings
 * its own (`patches/<page>/…`) plus the shared ones (`patches/*`), and a patch of
 * another page is left out — it was written against a different DOM. See
 * {@link resolveReplayPage} for what happens when the window is on no page of ours;
 * the answer is named in {@link PrototypeApplyResult.page} so a patch that did
 * nothing can be told from a patch belonging to a page that is not on screen.
 */
export async function applyPrototypeToBrowser(
  bpm: IBrowserPaneManager,
  instanceId: string,
  workspaceRootPath: string,
  slug: string,
): Promise<PrototypeApplyResult> {
  const page = await resolveReplayPage(bpm, instanceId, listPrototypePages(workspaceRootPath, slug))
  const patches = page
    ? scanPrototypePatchesForPage(workspaceRootPath, slug, page)
    : scanPrototypePatches(workspaceRootPath, slug).filter((patch) => patch.page === null)

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
    page,
    applied: pending.length,
    files: pending.map((patch) => patch.file),
    skipped: patches.filter((patch) => alreadyInlined.has(patch.file)).map((patch) => patch.file),
  }
}

/**
 * Which page's patches this window should be given — or null for the shared ones.
 *
 * The window's own URL answers it, because that is what is on screen: the page
 * table is read against it (`matchPrototypePage`), so "/cart.html matches cart"
 * needs no second registry and stays true for a page reached by its own link.
 *
 * Two fallbacks, and both say what they are rather than guessing:
 *
 * - the window is on no described page **and the entry page is one of ours** — the
 *   host renders that document for the prototype's address, so it is the page a
 *   bare "apply" means. A caller that cannot say (no instance, no URL) lands here
 *   too.
 * - otherwise **null**, which stands for "the shared patches only". A page we
 *   cannot name must not be handed another page's patches: they were written
 *   against a DOM that is not on screen, and the result (a patch matching nothing)
 *   would look exactly like a patch that did nothing.
 */
async function resolveReplayPage(
  bpm: IBrowserPaneManager,
  instanceId: string,
  pages: PrototypePage[],
): Promise<string | null> {
  const url = (await bpm.getInstanceAsync(instanceId))?.currentUrl ?? null
  const matched = matchPrototypePage(pages, url)
  if (matched) return matched

  const entry = findEntryPage(pages)
  return entry && entry.kind === 'scratch' && entry.file ? entry.name : null
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
