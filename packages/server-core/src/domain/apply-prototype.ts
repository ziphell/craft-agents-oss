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

import { existsSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import {
  buildAnchorCandidateScript,
  buildAnchorProbeScript,
  buildInlinedPatchProbeScript,
  buildPatchInitScript,
  buildPatchStateProbeScript,
  findEntryPage,
  getPrototypeDirPath,
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
  type PrototypePatch,
} from '@craft-agent/shared/prototypes'
import type { BrowserTabSummary } from '@craft-agent/shared/protocol'
import type { IBrowserPaneManager } from '../handlers/browser-pane-manager-interface'

/**
 * The tab a prototype command is about, as the browser side describes it.
 *
 * Both halves are needed and only the caller can say them: `id` is what every browser call is
 * addressed to, and `url` is what decides *which page of the prototype* this is
 * (`matchPrototypePage`). Read off the window they would be the tab **on screen** — the
 * person's, who is free to be reading something else while this runs (plan §22, 第十二轮) —
 * and an apply that lands its patches on the strength of that is patching the wrong page.
 *
 * Shared by the apply, the replay and the verification, because all three ask the same
 * question of the same tab.
 */
export type PrototypeTargetPage = Pick<BrowserTabSummary, 'id' | 'url'>

/**
 * What an apply was narrowed to, when the caller asked for less than everything the page brings.
 */
export interface PrototypeApplyOptions {
  /**
   * One patch file, by absolute path, applied on its own.
   *
   * The path is resolved by the caller (the browser tool resolves `--file` against the
   * workspace root, so every command has one base for it) and has to name a file inside this
   * prototype's `patches/`. The command exists so a patch that was just written can be put on
   * the page without replaying — and without un-registering — every other patch it is built on.
   */
  file?: string
}

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
  /**
   * The one file this apply was narrowed to, when the command named it (`--file`),
   * with the page that brings it (`null` = every page). Null means the whole set the
   * page carries was replayed.
   *
   * The page here is the patch's own scope, which is not the same question as `page`
   * above: that one answers "which page did this command act on", this one "where does
   * the file belong". They disagree only when a patch for one page is named while
   * another is open — where every declared target matching nothing would otherwise read
   * as a wrong selector rather than as a file that belongs somewhere else.
   */
  file: { name: string; page: string | null } | null
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
 *
 * `options.file` narrows that set to one file the caller named — the patch that was
 * just written, applied without replaying everything else the page carries. Nothing
 * here is cleared in that case: the other registrations are not this command's to
 * touch, and re-registering this one under its own key is how an edited patch is
 * re-applied idempotently.
 */
export async function applyPrototypeToBrowser(
  bpm: IBrowserPaneManager,
  instanceId: string,
  workspaceRootPath: string,
  slug: string,
  /** The tab this apply is about — the conversation's, not the one on screen. */
  page?: PrototypeTargetPage | null,
  options?: PrototypeApplyOptions,
): Promise<PrototypeApplyResult> {
  const replayPage = resolveReplayPage(listPrototypePages(workspaceRootPath, slug), page?.url ?? null)

  // One named file, or everything the page brings. `named` is what the command asked
  // for, resolved against the prototype's own directory so a file of another prototype
  // (or of no prototype) is refused by name rather than silently applying nothing.
  let patches: PrototypePatch[]
  let named: PrototypeApplyResult['file'] = null
  if (options?.file) {
    const relativePath = namedPatchPath(workspaceRootPath, slug, options.file)
    const patch = scanPrototypePatches(workspaceRootPath, slug).find((entry) => entry.file === relativePath)
    if (!patch) {
      throw new Error(
        `"${relativePath}" is not a patch of prototype "${slug}": the injector reads a file named ` +
        `{writer}-{nnn}-{name}.{css|js} (optionally under patches/<page>/), and it ignores anything else — ` +
        `so this file is not replayed under any name.`,
      )
    }
    patches = [patch]
    named = { name: patch.file, page: patch.page }
  } else {
    patches = replayPage
      ? scanPrototypePatchesForPage(workspaceRootPath, slug, replayPage)
      : scanPrototypePatches(workspaceRootPath, slug).filter((patch) => patch.page === null)
  }

  const inlined = await bpm.evaluate(instanceId, buildInlinedPatchProbeScript(), page?.id)
  const alreadyInlined = new Set(
    Array.isArray(inlined) ? inlined.filter((name): name is string => typeof name === 'string') : [],
  )

  const pending = patches.filter((patch) => !alreadyInlined.has(patch.file))

  // Init scripts are window-level and outlive the document, so the registered set
  // has to match what the page is missing exactly: drop the old registrations
  // (including any left from patches deleted on disk) and re-register only the
  // pending ones. Leaving an inlined patch registered would double it on the next
  // load of the rendered page.
  //
  // Only when the whole set is being replayed: a single named file says nothing about
  // the others, and dropping their registrations would un-apply them on the next load.
  if (!named) await bpm.clearInitScripts(instanceId, `prototype:${slug}:`, page?.id)

  for (const patch of pending) {
    const script = buildPatchInitScript(patch)
    await bpm.addInitScript(instanceId, patch.key, script, page?.id)
    await bpm.evaluate(instanceId, script, page?.id)
  }

  const inspection = await inspectTargets(
    bpm,
    instanceId,
    workspaceRootPath,
    slug,
    replayPage,
    patches,
    page?.id,
    page?.url ?? null,
  )

  return {
    slug,
    page: replayPage,
    file: named,
    applied: pending.length,
    files: pending.map((patch) => patch.file),
    skipped: patches.filter((patch) => alreadyInlined.has(patch.file)).map((patch) => patch.file),
    ...inspection,
  }
}

/**
 * The `patches/`-relative name of the file a caller named, or a refusal that says which
 * of the three things went wrong.
 *
 * The scanner ignores files that are not named `{writer}-{nnn}-{name}.{css|js}` — right for
 * a replay of the whole set, wrong for a file named on purpose: "there is no such file",
 * "that is not a patch of this prototype" and "this prototype does not exist" all end the
 * same way here (nothing applied), and the caller has to be able to tell them apart.
 *
 * The path is taken as absolute (the tool resolves it, so a relative one has one base
 * everywhere), and it has to land inside the prototype's own directory.
 */
function namedPatchPath(workspaceRootPath: string, slug: string, absolutePath: string): string {
  if (!existsSync(absolutePath)) {
    throw new Error(`No such file: ${absolutePath}`)
  }

  const dir = getPrototypeDirPath(workspaceRootPath, slug)
  const inside = relative(dir, absolutePath).split(sep).join('/')
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(
      `${absolutePath} is not inside prototype "${slug}" (${dir}). A patch of this prototype is what ` +
      `"prototype-apply --file" can apply; name one of its own files.`,
    )
  }

  const prefix = 'patches/'
  if (!inside.startsWith(prefix)) {
    throw new Error(
      `${absolutePath} is not a patch: this prototype's patches live under ${dir}/patches/ ` +
      `(patches/{writer}-{nnn}-{name}.{css|js}, or patches/<page>/… for one page's own).`,
    )
  }

  return inside.slice(prefix.length)
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
  /** The tab these observations were made on — the conversation's, not the one on screen. */
  tabId: string | undefined,
  /** …and where it is, which is what the record keeps as "the page that was patched". */
  pageUrl: string | null,
): Promise<Pick<PrototypeApplyResult, 'targets' | 'unmatched' | 'drifted' | 'untargeted'>> {
  const untargeted = patches.filter((patch) => patch.targets.length === 0).map((patch) => patch.file)
  const declared = patches.flatMap((patch) => patch.targets.map((target) => ({ file: patch.file, target })))

  if (declared.length === 0) return { targets: [], unmatched: [], drifted: [], untargeted }

  const state = readPatchState(await bpm.evaluate(instanceId, buildPatchStateProbeScript(), tabId))

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
    toFingerprint.length > 0 ? readFingerprints(await bpm.evaluate(instanceId, buildAnchorProbeScript(toFingerprint), tabId)) : {}

  // Only what is worth remembering is written: a target that just matched (so the
  // fingerprint is real), and one that already had a record (so "it stopped
  // matching" stays visible). A target nobody has ever seen match is reported as
  // `unmatched` and left out of the record — an anchor with no date beside it
  // would read as evidence of something, and there is none.
  const known = new Set(existing?.anchors.map((anchor) => anchor.target) ?? [])
  recordPrototypeAnchors(workspaceRootPath, slug, page, {
    url: pageUrl,
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
      ? readSuggestions(await bpm.evaluate(instanceId, buildAnchorCandidateScript(suggestionEntries), tabId))
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
 * Replay a prototype into one tab of a window after its files changed (plan §21.4).
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
  /** The tab showing this prototype — a window may hold more than one. */
  page?: PrototypeTargetPage | null,
): Promise<PrototypeReplayResult> {
  const inlined = await bpm.evaluate(instanceId, buildInlinedPatchProbeScript(), page?.id)
  const carriesPatches = Array.isArray(inlined) && inlined.length > 0

  if (carriesPatches) {
    const matched = matchPrototypePage(listPrototypePages(workspaceRootPath, slug), page?.url ?? null)
    bpm.reload(instanceId, page?.id)
    return { slug, page: matched, action: 'reloaded', applied: 0 }
  }

  const result = await applyPrototypeToBrowser(bpm, instanceId, workspaceRootPath, slug, page)
  return { slug, page: result.page, action: 'applied', applied: result.applied }
}

/**
 * Which page's patches this page should be given — or null for the shared ones.
 *
 * The caller's page URL answers it, and the caller is the one that read it off that page: the
 * page table is read against it (`matchPrototypePage`), so "/cart.html matches cart" needs no
 * second registry and stays true for a page reached by its own link. Reading it off the window
 * instead would answer with the tab **on screen**, which is the person's — and the person
 * reading another tab of the window must not decide which patches this one gets
 * (plan §22, 第十二轮).
 *
 * Two fallbacks, and both say what they are rather than guessing:
 *
 * - the page is on no described page **and the entry page is one of ours** — the
 *   host renders that document for the prototype's address, so it is the page a
 *   bare "apply" means. A caller that cannot say (no instance, no URL) lands here
 *   too.
 * - otherwise **null**, which stands for "the shared patches only". A page we
 *   cannot name must not be handed another page's patches: they were written
 *   against a DOM that is not on screen, and the result (a patch matching nothing)
 *   would look exactly like a patch that did nothing.
 */
function resolveReplayPage(pages: PrototypePage[], url: string | null): string | null {
  const matched = matchPrototypePage(pages, url)
  if (matched) return matched

  const entry = findEntryPage(pages)
  return entry && entry.kind === 'scratch' && entry.file ? entry.name : null
}

/** Remove a prototype's patches from one tab of a live browser instance. */
export async function clearPrototypeFromBrowser(
  bpm: IBrowserPaneManager,
  instanceId: string,
  slug: string,
  /** The tab to clear — the conversation's, not the one on screen. */
  tabId?: string,
): Promise<PrototypeClearResult> {
  const removed = await bpm.clearInitScripts(instanceId, `prototype:${slug}:`, tabId)
  return { slug, removed }
}
