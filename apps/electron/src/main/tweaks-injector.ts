/**
 * Running a tweak in the app's own browser window.
 *
 * A tweak is a standing edit to a page nobody here owns, and there are two carriers that
 * deliver it (`packages/shared/src/tweaks/index.ts`): the loadable extension, and **this**
 * — the app's own browser window. Until this module existed the second carrier did not
 * exist: switching a tweak on changed a field in `tweak.json` and nothing else.
 *
 * ## The mechanism
 *
 * The pane manager's persistent-injection primitives are the only way a document that has
 * not been created yet can be reached: reads from disk happen on every navigation, and the
 * tab's CDP session is where the registration lands.
 *
 * 1. read the workspace's tweaks from disk **every time** — a few file reads per navigation
 *    is cheaper than an invalidation bug, and re-reading is what makes the folder the truth
 *    rather than whatever this process last saw;
 * 2. `clearInitScripts(instanceId, 'tweak:')` — so a tweak switched off is not delivered to
 *    the next document;
 * 3. `addInitScript(instanceId, 'tweak:all', script)` — registered for **future** documents,
 *    before the page's own scripts. Installing is the whole of it: there is no step 4, and no
 *    `evaluate`, because a document that already exists is never touched (see below).
 *
 * ## Installed rules, and nothing else
 *
 * A tweak is a **rule set**. Installing it decides what each **new** document gets; it says
 * nothing about a document that already exists, and nothing is ever delivered to one — not by
 * a switch, not by an edit, and not by an address moving (a SPA route change makes no new
 * document, so the route it arrives at gets whatever the document was born with).
 *
 * That is not a limitation to work around. Taking a tweak back is only half possible: its CSS
 * could be pulled out again, but its javascript cannot be — what it did to the document is
 * history nobody here has a record of. Removing the style would leave the page in a state its
 * author never wrote, and would separate two files that are one tweak. So they stay together,
 * and a **load** is the reset. `packages/shared/src/tweaks/inject.ts` carries the same rule
 * into the script, which is why that script has no second-pass bookkeeping at all.
 *
 * Two things install: the rules changing (a switch, an agent writing code, a hand edit — see
 * `HandlerDeps.onTweaksChanged` and the config watcher), and an address moving. Neither is
 * about the page in front of the person; both are about the next one.
 *
 * ## What is per tab, not per window
 *
 * Init scripts live on a tab's CDP session, so everything here acts on the window's
 * **active tab**. A background tab that is never brought forward therefore never gets its
 * registration — it gets it the moment it becomes active, which is a state change
 * (`activateTab` emits one), so the window the person is looking at is always covered.
 *
 * ## What `hits.json` knows, and does not
 *
 * The record is written **only** by this carrier. The extension carrier runs in a browser
 * this app is not in, and a content script has no way back to the host's disk, so a
 * `hits.json` says nothing about whether the exported extension ran — its absence is not
 * "this tweak has never run anywhere" (see `packages/shared/src/tweaks/types.ts`).
 *
 * ## Why this does not call `onStateChange` itself
 *
 * `IBrowserPaneManager.onStateChange` holds **one** callback, and the app already spends it
 * (`handlers/browser.ts`, forwarding state to renderers — the address bar depends on it).
 * Registering here would silently replace that one and take the toolbar's live updates with
 * it. So the subscription is composed at the single call site that owns the slot:
 * {@link attachTweaksInjector} hands back a handler, and the existing callback calls it.
 * The payload is enough for the job — `BrowserInstanceInfo` carries the window's `url`,
 * its `workspaceId`, and its `tabs` with `url`/`active` — so navigation is observable and
 * nothing new was added to the pane manager.
 */

import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import type { BrowserInstanceInfo } from '@craft-agent/shared/protocol'
import {
  anyMatchPatternMatches,
  buildSelectorMatchScript,
  buildTweaksInitScript,
  buildTweaksProbeScript,
  getTweakHitsPath,
  loadWorkspaceTweaks,
  readTweakHits,
  readTweakSources,
  recordTweakHits,
  tweakRunAt,
  tweakTargets,
  writeTweakHits,
  type LoadedTweak,
} from '@craft-agent/shared/tweaks'
import type { IBrowserPaneManager } from '@craft-agent/server-core/handlers'
import { mainLog } from './logger'

/**
 * Key prefix for every registration this module owns. The prefix is what makes "switch a
 * tweak off" and "forget everything this feature ever registered" the same operation — no
 * other carrier uses `tweak:` keys.
 */
const INIT_SCRIPT_PREFIX = 'tweak:'
const INIT_SCRIPT_KEY = `${INIT_SCRIPT_PREFIX}all`

/**
 * The pane manager to inject through. Module-level rather than a parameter because the two
 * exported functions have the signatures the feature is specified with; it is set once, by
 * {@link attachTweaksInjector}, and everything is a no-op until it is.
 */
let manager: IBrowserPaneManager | null = null

/** The last `tab|url` seen per window, so a state change that moved nothing is ignored. */
const observedByInstance = new Map<string, string>()
/** Windows with an install in flight, so a navigation storm cannot queue up N installs. */
const applying = new Set<string>()
/** Windows that changed while they were busy: at most one more run is queued. */
const requeued = new Set<string>()

/** What an attached injector offers its host. */
export interface TweaksInjector {
  /**
   * React to a pane-manager state change. Re-installs when the active tab's address moved, and
   * ignores a change that did not (a title, a loading flag, a favicon).
   */
  handleStateChange(info: BrowserInstanceInfo): void
  /** Install the workspace's tweaks on a window now — what opening the browser window calls. */
  request(instanceId: string): void
}

/** The tweaks that are on and have something to inject, in the order the workspace lists them. */
function enabledTweaksWithCode(workspaceRootPath: string): LoadedTweak[] {
  return loadWorkspaceTweaks(workspaceRootPath).filter((tweak) => tweak.config.enabled && !tweak.empty)
}

/** The tab a window is showing, or null when the window is gone. */
function activeTabOf(bpm: IBrowserPaneManager, instanceId: string): { id: string; url: string } | null {
  try {
    const active = bpm.listTabs(instanceId).find((tab) => tab.active)
    return active ? { id: active.id, url: active.url } : null
  } catch {
    return null
  }
}

/**
 * Read a window's tweaks off disk and install them for its active tab.
 *
 * Deliberately uncached: it is called on every address move and on every change to the rules,
 * and the cost of re-reading a few small files is what buys "the folder is the truth" without
 * an invalidation mechanism to get wrong.
 *
 * Installing is the whole of it — a registration for the documents that do not exist yet. The
 * document that is open now is not touched (see the module note).
 */
export async function applyTweaksToInstance(
  instanceId: string,
  workspaceRootPath: string,
): Promise<void> {
  const bpm = manager
  if (!bpm) return

  const tweaks = enabledTweaksWithCode(workspaceRootPath)
  const tab = activeTabOf(bpm, instanceId)
  const tabId = tab?.id

  const cleared = await bpm.clearInitScripts(instanceId, INIT_SCRIPT_PREFIX, tabId)

  if (tweaks.length === 0) {
    // Nothing to register, so the next document gets nothing. The page that is open right now
    // keeps whatever it was born with (see the module note).

    // Quiet unless something was actually cleared: this runs on every address move, and most
    // workspaces have no tweaks at all.
    if (cleared.length > 0) {
      mainLog.info(`[tweaks] nothing enabled in ${workspaceRootPath} — cleared [${cleared.join(', ')}] on ${instanceId}`)
    }
    return
  }

  const script = buildTweaksInitScript(
    tweaks.map((tweak) => {
      const sources = readTweakSources(tweak)
      return {
        slug: tweak.config.slug,
        name: tweak.config.name,
        ...sources,
        runAt: tweakRunAt(sources),
        matches: tweak.config.matches,
      }
    }),
  )

  // The whole of an install: a registration for the documents that do not exist yet.
  await bpm.addInitScript(instanceId, INIT_SCRIPT_KEY, script, tabId)

  const slugs = tweaks.map((tweak) => tweak.config.slug).join(', ')
  mainLog.info(`[tweaks] installed [${slugs}] for ${instanceId}${tab ? ` (${tab.url})` : ''}`)

  await recordTweakHitsForTab(instanceId, workspaceRootPath, tabId, tab?.url)
}

/**
 * Record what each matching tweak's declared `@target` selectors matched on a tab.
 *
 * Only tweaks the **page itself** reports as applied are recorded (the probe), so a hit is
 * attributed to what actually ran rather than to what the host expected to run; and the
 * address recorded is the one observed here, not the one a caller had in hand when the
 * navigation started.
 *
 * The record is merged, never started from empty: the time a target *used* to match is the
 * only thing that makes "this stopped matching" visible (`recordTweakHits`).
 */
export async function recordTweakHitsForTab(
  instanceId: string,
  workspaceRootPath: string,
  tabId?: string,
  url?: string,
): Promise<void> {
  const bpm = manager
  if (!bpm) return

  const observedUrl = url ?? activeTabOf(bpm, instanceId)?.url ?? null
  if (!observedUrl) return

  const matching = enabledTweaksWithCode(workspaceRootPath).filter((tweak) =>
    anyMatchPatternMatches(tweak.config.matches, observedUrl),
  )
  if (matching.length === 0) return

  const appliedRaw = await evaluateSafely(bpm, instanceId, buildTweaksProbeScript(), tabId)
  const applied = new Set(
    Array.isArray(appliedRaw) ? appliedRaw.filter((slug): slug is string => typeof slug === 'string') : [],
  )
  // Nothing reported: the document navigated away, or never ran the script. Either way a
  // record written now would be evidence about a page nobody looked at.
  if (applied.size === 0) return

  const affected = matching
    .filter((tweak) => applied.has(tweak.config.slug))
    .map((tweak) => ({ tweak, targets: tweakTargets(readTweakSources(tweak)) }))
  if (affected.length === 0) return

  const selectors = [...new Set(affected.flatMap((entry) => entry.targets.map((target) => target.selector)))]
  const matchedBySelector = await readSelectorMatches(bpm, instanceId, selectors, tabId)
  // `null` is "could not check" — no selectors at all is `{}`. Only the second may be written
  // down: a failed read must not be recorded as "this stopped matching".
  if (matchedBySelector === null) return

  const now = Date.now()
  for (const entry of affected) {
    const slug = entry.tweak.config.slug
    const matched = new Set(
      entry.targets.filter((target) => matchedBySelector[target.selector] === true).map((target) => target.selector),
    )
    const hitsPath = getTweakHitsPath(workspaceRootPath, slug)
    writeTweakHits(hitsPath, recordTweakHits(readTweakHits(hitsPath), entry.targets, matched, observedUrl, now))
  }

  mainLog.info(
    `[tweaks] recorded hits for [${affected.map((entry) => entry.tweak.config.slug).join(', ')}] at ${observedUrl}`,
  )
}

/**
 * `evaluate`, with a gone tab (or a page that refuses the script) answering `undefined`
 * rather than throwing. Every caller here is an observation, and an observation that could
 * not be made is worth nothing — but it must not take the window's other work down.
 */
async function evaluateSafely(
  bpm: IBrowserPaneManager,
  instanceId: string,
  expression: string,
  tabId?: string,
): Promise<unknown> {
  try {
    return await bpm.evaluate(instanceId, expression, tabId)
  } catch {
    return undefined
  }
}

/**
 * Ask the page which of the declared selectors it has.
 *
 * `{}` when there is nothing to ask; **null** when the answer could not be read, which the
 * caller must treat as "could not check" rather than as "matched nothing" — the second is
 * evidence the page moved, the first is the absence of any.
 */
async function readSelectorMatches(
  bpm: IBrowserPaneManager,
  instanceId: string,
  selectors: string[],
  tabId?: string,
): Promise<Record<string, boolean | null> | null> {
  if (selectors.length === 0) return {}

  const raw = await evaluateSafely(bpm, instanceId, buildSelectorMatchScript(selectors), tabId)
  if (!raw || typeof raw !== 'object') return null

  const out: Record<string, boolean | null> = {}
  for (const selector of selectors) {
    const value = (raw as Record<string, unknown>)[selector]
    out[selector] = value === true ? true : value === false ? false : null
  }
  return out
}

/**
 * One install, with the re-entrancy guard: a window whose rules change while it is being
 * installed is marked, and re-run **once** afterwards rather than queued N times.
 */
async function scheduleApply(instanceId: string): Promise<void> {
  const bpm = manager
  if (!bpm) return

  if (applying.has(instanceId)) {
    requeued.add(instanceId)
    return
  }
  applying.add(instanceId)

  try {
    // Resolved from the window rather than carried from the event: a window belongs to one
    // workspace, and this lookup is the only thing that turns its id into the folder the
    // tweaks live in. An instance with no workspace is not ours to inject into.
    const workspaceId = bpm.listInstances().find((info) => info.id === instanceId)?.workspaceId ?? null
    if (!workspaceId) return

    const workspaceRootPath = getWorkspaceByNameOrId(workspaceId)?.rootPath
    if (!workspaceRootPath) {
      mainLog.warn(`[tweaks] no workspace folder for ${workspaceId}; nothing injected into ${instanceId}`)
      return
    }

    await applyTweaksToInstance(instanceId, workspaceRootPath)
  } catch (err) {
    mainLog.warn(`[tweaks] install failed for ${instanceId}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    applying.delete(instanceId)
    if (requeued.delete(instanceId)) void scheduleApply(instanceId)
  }
}

/**
 * Re-install a workspace's tweaks on every window showing it — what a change to the rules
 * calls (`HandlerDeps.onTweaksChanged`, and the config watcher behind every write).
 *
 * A tweak is a **rule set**, not a page: it decides what each *new* document gets. So this
 * re-registers the init script and stops there — nothing is delivered to the page a person is
 * looking at, in either direction. Reloading is what shows a change, because the reload is a
 * document the new registration applies to.
 *
 * The address has not moved, which is why this cannot ride
 * {@link TweaksInjector.handleStateChange}: that one deliberately ignores a state change that
 * moved nothing.
 */
export function requestTweaksForWorkspace(workspaceId: string): void {
  const bpm = manager
  if (!bpm) return

  try {
    for (const info of bpm.listInstances()) {
      if (info.workspaceId === workspaceId) void scheduleApply(info.id)
    }
  } catch (err) {
    mainLog.warn(`[tweaks] could not reach the windows for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Wire this carrier up. Called once, where the GUI's browser handlers are registered.
 *
 * The returned handler is meant to be called from the pane manager's **existing**
 * `onStateChange` callback: the pane manager holds one callback and the renderers' state
 * push already owns it (see the module note).
 */
export function attachTweaksInjector(bpm: IBrowserPaneManager): TweaksInjector {
  manager = bpm
  observedByInstance.clear()

  // Windows that already exist when this attaches — a late attach, or one opened before
  // this ran. Same request as the navigation path, so the two cannot diverge.
  try {
    for (const info of bpm.listInstances()) {
      if (info.workspaceId) void scheduleApply(info.id)
    }
  } catch (err) {
    mainLog.warn(`[tweaks] startup sweep failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    handleStateChange(info) {
      // A window with no workspace has no tweaks to run; forgetting it also keeps the map
      // from growing for windows that are gone.
      if (!info.workspaceId) {
        observedByInstance.delete(info.id)
        return
      }

      const active = info.tabs?.find((tab) => tab.active) ?? null
      const mark = `${active?.id ?? ''}|${active?.url ?? info.url}`
      if (observedByInstance.get(info.id) === mark) return
      observedByInstance.set(info.id, mark)

      void scheduleApply(info.id)
    },

    request(instanceId) {
      void scheduleApply(instanceId)
    },
  }
}
