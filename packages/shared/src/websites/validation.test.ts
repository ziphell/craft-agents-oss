/**
 * Refresh-cron validation: the spec is checked on WRITE with the same engine
 * the scheduler matches with (croner), so a stored cron can no longer be
 * unparseable (silently never fires) or run more often than the policy floor
 * (subprocess spawn per run).
 */

import { describe, it, expect } from 'bun:test';
import {
  WEBSITE_REFRESH_MIN_INTERVAL_MS,
  WebsiteRefreshSpecSchema,
  validateWebsiteConfig,
} from './validation.ts';

function refreshSpec(cron: string, timezone?: string) {
  return { cron, script: 'scripts/refresh.ts', ...(timezone ? { timezone } : {}) };
}

describe('WebsiteRefreshSpecSchema cron validation', () => {
  it('accepts real schedules at or above the 5-minute floor', () => {
    expect(WEBSITE_REFRESH_MIN_INTERVAL_MS).toBe(5 * 60 * 1000);
    for (const cron of ['*/5 * * * *', '*/15 * * * *', '0 * * * *', '0 9 * * 1-5', '30 6 1 * *']) {
      expect(WebsiteRefreshSpecSchema.safeParse(refreshSpec(cron)).success).toBe(true);
    }
    expect(WebsiteRefreshSpecSchema.safeParse(refreshSpec('0 9 * * *', 'Europe/Budapest')).success).toBe(true);
  });

  it('rejects unparseable expressions and invalid timezones', () => {
    for (const cron of ['not a cron', '61 * * * *', 'a b c d e']) {
      const result = WebsiteRefreshSpecSchema.safeParse(refreshSpec(cron));
      expect(result.success).toBe(false);
      expect(result.error!.issues[0]!.message).toContain('Invalid cron expression');
    }
    const badTz = WebsiteRefreshSpecSchema.safeParse(refreshSpec('0 9 * * *', 'Mars/Olympus-Mons'));
    expect(badTz.success).toBe(false);
  });

  it('rejects expressions that never fire instead of storing a silent no-op', () => {
    const result = WebsiteRefreshSpecSchema.safeParse(refreshSpec('0 0 30 2 *')); // Feb 30
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toContain('never fires');
  });

  it('rejects schedules below the minimum interval, including bursty and seconds-granularity patterns', () => {
    for (const cron of [
      '* * * * *', // every minute
      '*/2 * * * *', // every 2 minutes
      '0,1 0 * * *', // daily burst: two runs 60s apart
      '*/30 * * * * *', // 6-field: every 30 seconds
    ]) {
      const result = WebsiteRefreshSpecSchema.safeParse(refreshSpec(cron));
      expect(result.success).toBe(false);
      expect(result.error!.issues[0]!.message).toContain('too frequently');
    }
  });

  it('surfaces cron issues through validateWebsiteConfig at refresh.cron', () => {
    const config = {
      schemaVersion: 1,
      id: 'website_1',
      slug: 'dash',
      name: 'Dash',
      kind: 'live',
      createdAt: 1,
      updatedAt: 1,
      refresh: refreshSpec('* * * * *'),
    };
    const result = validateWebsiteConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'refresh.cron')).toBe(true);

    expect(validateWebsiteConfig({ ...config, refresh: refreshSpec('*/10 * * * *') }).valid).toBe(true);
  });
});
