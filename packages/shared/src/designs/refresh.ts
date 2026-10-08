/**
 * Design Refresh Hook
 *
 * Bridges design configs into the automations engine: every design with a
 * `refresh` spec materializes as a synthetic cron matcher carrying a single
 * `script` action. The AutomationSystem merges these into its SchedulerTick
 * matchers, so design refreshes ride the exact same pipeline as user
 * automations (cron matching, script executor, history) — never an agent
 * session (deterministic, no token cost, no session-card spam).
 *
 * Synthetic matchers are rebuilt from disk via
 * AutomationSystem.reloadDesignRefreshMatchers() — the config watcher's designs
 * branch triggers that on any design.json change.
 */

import type { AutomationMatcher } from '../automations/types.ts';
import { loadWorkspaceDesigns } from './storage.ts';

/** Matcher-id prefix marking synthetic design-refresh matchers (also the history key) */
export const DESIGN_REFRESH_MATCHER_PREFIX = 'design:';

/** Stable matcher/history id for a design's refresh automation */
export function designRefreshMatcherId(designSlug: string): string {
  return `${DESIGN_REFRESH_MATCHER_PREFIX}${designSlug}`;
}

/** True when a matcher id belongs to a synthetic design-refresh matcher */
export function isDesignRefreshMatcherId(matcherId: string): boolean {
  return matcherId.startsWith(DESIGN_REFRESH_MATCHER_PREFIX);
}

/**
 * Build the synthetic SchedulerTick matchers for every design with an enabled
 * refresh spec. Pure read — no caching; callers decide when to rebuild.
 */
export function buildDesignRefreshMatchers(workspaceRootPath: string): AutomationMatcher[] {
  const matchers: AutomationMatcher[] = [];

  for (const design of loadWorkspaceDesigns(workspaceRootPath)) {
    const refresh = design.config.refresh;
    if (!refresh || refresh.enabled === false) continue;
    if (!refresh.cron || !refresh.script) continue;

    matchers.push({
      id: designRefreshMatcherId(design.config.slug),
      name: `Design refresh: ${design.config.name}`,
      cron: refresh.cron,
      timezone: refresh.timezone,
      enabled: true,
      actions: [
        {
          type: 'script',
          script: refresh.script,
          args: refresh.args,
          runtime: refresh.runtime,
          timeoutMs: refresh.timeoutMs,
          design: design.config.slug,
        },
      ],
    });
  }

  return matchers;
}
