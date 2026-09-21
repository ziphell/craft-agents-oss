/**
 * Website Refresh Hook
 *
 * Bridges website configs into the automations engine: every website with a
 * `refresh` spec materializes as a synthetic cron matcher carrying a single
 * `script` action. The AutomationSystem merges these into its SchedulerTick
 * matchers, so website refreshes ride the exact same pipeline as user
 * automations (cron matching, script executor, history) — never an agent
 * session (deterministic, no token cost, no session-card spam).
 *
 * Synthetic matchers are rebuilt from disk via
 * AutomationSystem.reloadWebsiteRefreshMatchers() — the config watcher's
 * websites branch triggers that on any website.json change.
 */

import type { AutomationMatcher } from '../automations/types.ts';
import { loadWorkspaceWebsites } from './storage.ts';

/** Matcher-id prefix marking synthetic website-refresh matchers (also the history key) */
export const WEBSITE_REFRESH_MATCHER_PREFIX = 'website:';

/** Stable matcher/history id for a website's refresh automation */
export function websiteRefreshMatcherId(websiteSlug: string): string {
  return `${WEBSITE_REFRESH_MATCHER_PREFIX}${websiteSlug}`;
}

/** True when a matcher id belongs to a synthetic website-refresh matcher */
export function isWebsiteRefreshMatcherId(matcherId: string): boolean {
  return matcherId.startsWith(WEBSITE_REFRESH_MATCHER_PREFIX);
}

/**
 * Build the synthetic SchedulerTick matchers for every website with an enabled
 * refresh spec. Pure read — no caching; callers decide when to rebuild.
 */
export function buildWebsiteRefreshMatchers(workspaceRootPath: string): AutomationMatcher[] {
  const matchers: AutomationMatcher[] = [];

  for (const website of loadWorkspaceWebsites(workspaceRootPath)) {
    const refresh = website.config.refresh;
    if (!refresh || refresh.enabled === false) continue;
    if (!refresh.cron || !refresh.script) continue;

    matchers.push({
      id: websiteRefreshMatcherId(website.config.slug),
      name: `Website refresh: ${website.config.name}`,
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
          // `page` is the automations `ScriptAction` field (how a refresh run
          // stamps its own completion marker) — it keeps that name.
          page: website.config.slug,
        },
      ],
    });
  }

  return matchers;
}
