/**
 * A tweak as something to look at: the storage model plus what is derived.
 *
 * A tweak lives in files (`./storage.ts`), and there are two readers that want the same
 * two shapes: the agent's tools (`packages/server-core/src/tweaks/tool-callbacks.ts`) and
 * the app's own pages. The mapping lives here once so the tool contract and the UI cannot
 * drift — the view a person sees and the view an agent gets are the same object.
 *
 * These are structurally the shapes `@craft-agent/session-tools-core` declares
 * (`TweakToolSummary` / `TweakToolDetails` / `TweakToolTarget`). That package cannot
 * import them from here: it is deliberately free of `@craft-agent/shared`.
 */

import { getTweakCssPath, getTweakHitsPath, getTweakJsPath, readTweakSources } from './storage.ts'
import { readTweakHits, tweakTargets } from './targets.ts'
import { tweakRunAt, type TweakRunAt } from './run-at.ts'
import type { LoadedTweak, TweakHits } from './types.ts'

/** One tweak as it appears in a list. */
export interface TweakSummary {
  slug: string
  name: string
  description?: string
  /** Chrome match patterns: the pages this tweak runs on. */
  matches: string[]
  /** Off means it does nothing anywhere. */
  enabled: boolean
  /** False when the folder has neither tweak.css nor tweak.js, so there is nothing to inject. */
  hasCode: boolean
  /** Absolute path to the tweak's folder. */
  folderPath: string
  createdAt: number
  updatedAt: number
}

/**
 * One selector a tweak declares with `@target`, and what it has matched.
 *
 * `stale` is the point of keeping the record: the tweak has been applied since the last
 * time this selector matched, and it did not — the page moved. Absent `lastMatchedAt`
 * means it never matched at all, which is a different fact.
 */
export interface TweakTargetInfo {
  selector: string
  /** Which of the tweak's files declares it. */
  file: string
  /** When it last matched something, epoch ms. Absent means it never has. */
  lastMatchedAt?: number
  /** It matched before, and the most recent apply did not see it. */
  stale: boolean
}

/** One tweak in full: the list row plus its files, its record and its targets. */
export interface TweakDetails extends TweakSummary {
  /** Absolute path to tweak.css (whether or not it exists). */
  cssPath: string;
  /** Absolute path to tweak.js (whether or not it exists). */
  jsPath: string;
  /** Which of the two code files are actually there — a path does not say that. */
  hasCss: boolean;
  hasJs: boolean;
  /** Absolute path to hits.json — written by whatever applies the tweak, never by hand. */
  hitsPath: string;
  /**
   * When its javascript runs: what the tweak declares with `@run-at`, or the default
   * (`document_end`). Derived from the code, because that is where it is declared.
   */
  runAt: TweakRunAt;
  targets: TweakTargetInfo[];
  /** When the hit record was last written, or null when nothing has applied it yet. */
  appliedAt: number | null;
}

export function toTweakSummary(tweak: LoadedTweak): TweakSummary {
  const config = tweak.config
  return {
    slug: config.slug,
    name: config.name,
    description: config.description,
    matches: config.matches,
    enabled: config.enabled,
    hasCode: !tweak.empty,
    folderPath: tweak.folderPath,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  }
}

/**
 * The selectors a tweak declares, with what the record says about each.
 *
 * `stale` is derived rather than stored: the record was written **after** the last time
 * this selector matched, and the match time did not move with it.
 */
export function toTweakTargets(tweak: LoadedTweak, hits: TweakHits | null): TweakTargetInfo[] {
  const recorded = new Map((hits?.targets ?? []).map((hit) => [hit.selector, hit]))
  const appliedAt = hits?.updatedAt ?? null

  return tweakTargets(readTweakSources(tweak)).map((target) => {
    const lastMatchedAt = recorded.get(target.selector)?.lastMatchedAt
    return {
      selector: target.selector,
      file: target.file,
      ...(lastMatchedAt === undefined ? {} : { lastMatchedAt }),
      stale: lastMatchedAt !== undefined && appliedAt !== null && appliedAt > lastMatchedAt,
    }
  })
}

export function toTweakDetails(workspaceRootPath: string, tweak: LoadedTweak): TweakDetails {
  const hits = readTweakHits(getTweakHitsPath(workspaceRootPath, tweak.config.slug))
  return {
    ...toTweakSummary(tweak),
    cssPath: getTweakCssPath(workspaceRootPath, tweak.config.slug),
    jsPath: getTweakJsPath(workspaceRootPath, tweak.config.slug),
    hasCss: tweak.hasCss,
    hasJs: tweak.hasJs,
    hitsPath: getTweakHitsPath(workspaceRootPath, tweak.config.slug),
    runAt: tweakRunAt(readTweakSources(tweak)),
    targets: toTweakTargets(tweak, hits),
    appliedAt: hits?.updatedAt ?? null,
  }
}
