/**
 * Prototype ↔ live-browser bridge.
 *
 * Shared by the agent tool (`browser_tool prototype-apply`), the prototype
 * panel's buttons and the auto-replay that follows a file change, so every path
 * produces identical results — a divergence here would mean the UI and the agent
 * disagree about what is on the page.
 *
 * The second half of the job is the answer the replay alone cannot give: **did
 * the patches do anything?** Each patch reports what it observed about itself
 * (`patch-script.ts`), and this module turns that into three facts the caller can
 * act on (plan §21.1/§21.2):
 *
 * - a declared `@target` that matched nothing and was never recorded is a
 *   selector that is wrong;
 * - a recorded `@target` that matched before and does not now means the page
 *   moved — and a fingerprint of what it looked like is kept, so a replacement
 *   selector can be proposed rather than only complained about;
 * - a patch with no `@target` cannot be checked at all, which is said out loud
 *   instead of being reported as a clean run.
 *
 * @see docs/prototype-workbench-plan.md §3 (阶段 3 持久注入), §19.4 (按页归属), §21
 */

import {
  buildAnchorCandidateScript,
  buildAnchorProbeScript,
  buildInlinedPatchProbeScript,
  buildPatchInitScript,
  buildPatchStateProbeScript,
  findEntryPage,
  listPrototypePages,
  matchPrototypePage,
  readPrototypeAnchors,
  recordPrototypeAnchors,
  resolveAnchorDrift,
  scanPrototypePatches,
  scanPrototypePatchesForPage,
  type PrototypeAnchorFingerprint,
  type PrototypeAnchorObservation,
  type PrototypePage,
} from '@craft-agent/shared/prototypes'
import type { IBrowserPaneManager } from '../handlers/browser-pane-manager-interface'

/** What one declared target matched, and whether it had matched before. */
export interface PrototypeApplyTargetReport {
  /** The patch that declares it, as `patches/…`. */
  file: string
  target: string
  /** Elements matched at apply time, or null when nothing measured this target. */
  matched: number | null
  /** True when this target was recorded by an earlier apply. */
  recorded: boolean
}

export interface PrototypeDriftReport {
  target: string
  /** When it last matched — the date the page is known to have been good. */
  lastMatchedAt: string
  /** Selectors that resolve to exactly one element now, best first. */
  suggestions: string[]
}

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
  /** Every declared target and what it matched (`@target`). */
  targets: PrototypeApplyTargetReport[]
  /** Declared targets that matched nothing and had never matched — a wrong selector. */
  unmatched: string[]
  /** Targets that matched before and do not now — the page moved. */
  drifted: PrototypeDriftReport[]
  /** Patches that declare no `@target`, so nothing about them could be checked. */
  untargeted: string[]
}

export interface PrototypeClearResult {
  slug: string
  removed: string[]
}

/** What an automatic replay did — a reload, or an injection into a foreign page. */
export interface PrototypeReplayResult {
  slug: string
  page: string | null
  action: 'reloaded' | 'applied'
  /** Patches injected; always 0 for a reload, which re-renders from disk. */
  applied: number
}

/** `{ [file]: { matches: { [target]: number | null }, error } }`, as the page reports it. */
type PatchState = Record<string, { matches: Record<string, number | null>; error: string | null }>

function readPatchState(raw: unknown): PatchState {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: PatchState = {}
  for (const [file, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as { matches?: unknown; error?: unknown }
    const matches: Record<string, number | null> = {}
    if (typeof entry.matches === 'object' && entry.matches !== null) {
      for (const [target, count] of Object.entries(entry.matches as Record<string, unknown>)) {
        matches[target] = typeof count === 'number' ? count : null
      }
    }
    out[file] = { matches, error: typeof entry.error === 'string' ? entry.error : null }
  }
  return out
}

function readFingerprints(raw: unknown): Record<string, PrototypeAnchorFingerprint | null> {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Record<string, PrototypeAnchorFingerprint | null> = {}
  for (const [target, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      out[target] = null
      continue
    }
    const entry = value as Record<string, unknown>
    out[target] = {
      tag: typeof entry.tag === 'string' ? entry.tag : '',
      text: typeof entry.text === 'string' ? entry.text : '',
      path: typeof entry.path === 'string' ? entry.path : '',
      attrs: Array.isArray(entry.attrs)
        ? entry.attrs.filter((item): item is string => typeof item === 'string')
        : [],
    }
  }
  return out
}

function readSuggestions(raw: unknown): Record<string, string[]> {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Record<string, string[]> = {}
  for (const [target, value] of Object.entries(raw as Record<string, unknown>)) {
    out[target] = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  }
  return out
}

/**
 * Replay a prototype's patches into a live browser instance, and report what
 * each declared target made of it.
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
 * as inlined, so re-applying will not refresh it — a reload re-renders from disk,
 * which is why a file change is followed by a reload rather than a second apply
 * ({@link replayPrototypeInBrowser}).
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

  const inspection = await inspectTargets(bpm, instanceId, workspaceRootPath, slug, page, patches)

  return {
    slug,
    page,
    applied: pending.length,
    files: pending.map((patch) => patch.file),
    skipped: patches.filter((patch) => alreadyInlined.has(patch.file)).map((patch) => patch.file),
    ...inspection,
  }
}

/**
 * What every declared target matched, what that means, and the record of it.
 *
 * Split out of the apply so the reading order is visible: measure, compare with
 * the record that already exists (that comparison *is* the drift check), then
 * write the new record. Doing it in the other order would erase the evidence on
 * every run.
 */
async function inspectTargets(
  bpm: IBrowserPaneManager,
  instanceId: string,
  workspaceRootPath: string,
  slug: string,
  page: string | null,
  patches: Array<{ file: string; targets: string[] }>,
): Promise<Pick<PrototypeApplyResult, 'targets' | 'unmatched' | 'drifted' | 'untargeted'>> {
  const untargeted = patches.filter((patch) => patch.targets.length === 0).map((patch) => patch.file)
  const declared = patches.flatMap((patch) => patch.targets.map((target) => ({ file: patch.file, target })))

  if (declared.length === 0) return { targets: [], unmatched: [], drifted: [], untargeted }

  const state = readPatchState(await bpm.evaluate(instanceId, buildPatchStateProbeScript()))

  // Only what the page actually measured counts. A js patch may declare a
  // selector without there being a count for it, and "nothing measured this" must
  // not be reported as "matched nothing" — the second is evidence, the first is
  // the absence of any.
  const measured = declared.map(({ file, target }) => ({
    file,
    target,
    matched: state[file]?.matches?.[target] ?? null,
  }))

  const existing = readPrototypeAnchors(workspaceRootPath, slug, page)

  const observations: PrototypeAnchorObservation[] = measured.map(({ file, target, matched }) => ({
    target,
    matched: matched ?? 0,
    patches: [...new Set(measured.filter((entry) => entry.target === target).map((entry) => entry.file))],
    fingerprint: null,
  }))

  const drift = resolveAnchorDrift(existing, observations)
  const recorded = new Set(existing?.anchors.filter((anchor) => anchor.lastMatchedAt !== '').map((anchor) => anchor.target) ?? [])

  const unmatched = [
    ...new Set(
      measured
        .filter((entry) => entry.matched === 0 && !recorded.has(entry.target))
        .map((entry) => entry.target),
    ),
  ]
  const driftedTargets = [...new Set(drift.map((anchor) => anchor.target))]

  // Fingerprints for what did match, so the record describes the page that was
  // patched rather than the one that was expected.
  const toFingerprint = [...new Set(measured.filter((entry) => (entry.matched ?? 0) > 0).map((entry) => entry.target))]
  const fingerprints =
    toFingerprint.length > 0 ? readFingerprints(await bpm.evaluate(instanceId, buildAnchorProbeScript(toFingerprint))) : {}

  const url = (await bpm.getInstanceAsync(instanceId))?.currentUrl ?? null
  // Only what is worth remembering is written: a target that just matched (so the
  // fingerprint is real), and one that already had a record (so "it stopped
  // matching" stays visible). A target nobody has ever seen match is reported as
  // `unmatched` and left out of the record — an anchor with no date beside it
  // would read as evidence of something, and there is none.
  const known = new Set(existing?.anchors.map((anchor) => anchor.target) ?? [])
  recordPrototypeAnchors(workspaceRootPath, slug, page, {
    url,
    observed: observations
      .filter((observation) => fingerprints[observation.target] != null || known.has(observation.target))
      .map((observation) => ({
        ...observation,
        fingerprint: fingerprints[observation.target] ?? null,
      })),
  })

  // Suggestions are asked for last and only for the targets that need them: the
  // probe is a page-wide scan, and running it on a healthy page would be work
  // nobody reads.
  const suggestionEntries = drift
    .filter((anchor) => anchor.fingerprint.tag !== '' || anchor.fingerprint.text !== '')
    .map((anchor) => ({ target: anchor.target, fingerprint: anchor.fingerprint }))
  const suggestions =
    suggestionEntries.length > 0
      ? readSuggestions(await bpm.evaluate(instanceId, buildAnchorCandidateScript(suggestionEntries)))
      : {}

  return {
    targets: measured.map((entry) => ({
      ...entry,
      recorded: recorded.has(entry.target),
    })),
    unmatched,
    drifted: driftedTargets.map((target) => ({
      target,
      lastMatchedAt: drift.find((anchor) => anchor.target === target)?.lastMatchedAt ?? '',
      suggestions: suggestions[target] ?? [],
    })),
    untargeted,
  }
}

/**
 * Replay a prototype into a window after its files changed (plan §21.4).
 *
 * Two cases, and which one applies is read off the document rather than assumed:
 *
 * - **a page of ours** arrives from the host with its patches inlined, so a
 *   reload is the whole answer — the host renders from disk on every request.
 *   Registering anything here would double the js patches on the next render.
 * - **someone else's page** has no such machinery, so it is re-applied: the
 *   patches are registered and evaluated into the document that is on screen.
 *
 * Deliberately *not* "apply, then reload": evaluating a patch that the document
 * already carries runs its js a second time, which is exactly the double-apply
 * the inlined marker exists to prevent.
 */
export async function replayPrototypeInBrowser(
  bpm: IBrowserPaneManager,
  instanceId: string,
  workspaceRootPath: string,
  slug: string,
): Promise<PrototypeReplayResult> {
  const inlined = await bpm.evaluate(instanceId, buildInlinedPatchProbeScript())
  const carriesPatches = Array.isArray(inlined) && inlined.length > 0

  if (carriesPatches) {
    const url = (await bpm.getInstanceAsync(instanceId))?.currentUrl ?? null
    const page = matchPrototypePage(listPrototypePages(workspaceRootPath, slug), url)
    bpm.reload(instanceId)
    return { slug, page, action: 'reloaded', applied: 0 }
  }

  const result = await applyPrototypeToBrowser(bpm, instanceId, workspaceRootPath, slug)
  return { slug, page: result.page, action: 'applied', applied: result.applied }
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
