/**
 * Refresh-cron validation: the spec is checked on WRITE with the same engine
 * the scheduler matches with (croner), so a stored cron can no longer be
 * unparseable (silently never fires) or run more often than the policy floor
 * (subprocess spawn per run).
 */

import { describe, it, expect } from 'bun:test';
import {
  DESIGN_REFRESH_MIN_INTERVAL_MS,
  DesignMotionSpecSchema,
  DesignRefreshSpecSchema,
  MOTION_DURATION_MS_MAX,
  MOTION_FPS_MAX,
  validateDesignConfig,
} from './validation.ts';

function refreshSpec(cron: string, timezone?: string) {
  return { cron, script: 'scripts/refresh.ts', ...(timezone ? { timezone } : {}) };
}

describe('DesignRefreshSpecSchema cron validation', () => {
  it('accepts real schedules at or above the 5-minute floor', () => {
    expect(DESIGN_REFRESH_MIN_INTERVAL_MS).toBe(5 * 60 * 1000);
    for (const cron of ['*/5 * * * *', '*/15 * * * *', '0 * * * *', '0 9 * * 1-5', '30 6 1 * *']) {
      expect(DesignRefreshSpecSchema.safeParse(refreshSpec(cron)).success).toBe(true);
    }
    expect(DesignRefreshSpecSchema.safeParse(refreshSpec('0 9 * * *', 'Europe/Budapest')).success).toBe(true);
  });

  it('rejects unparseable expressions and invalid timezones', () => {
    for (const cron of ['not a cron', '61 * * * *', 'a b c d e']) {
      const result = DesignRefreshSpecSchema.safeParse(refreshSpec(cron));
      expect(result.success).toBe(false);
      expect(result.error!.issues[0]!.message).toContain('Invalid cron expression');
    }
    const badTz = DesignRefreshSpecSchema.safeParse(refreshSpec('0 9 * * *', 'Mars/Olympus-Mons'));
    expect(badTz.success).toBe(false);
  });

  it('rejects expressions that never fire instead of storing a silent no-op', () => {
    const result = DesignRefreshSpecSchema.safeParse(refreshSpec('0 0 30 2 *')); // Feb 30
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
      const result = DesignRefreshSpecSchema.safeParse(refreshSpec(cron));
      expect(result.success).toBe(false);
      expect(result.error!.issues[0]!.message).toContain('too frequently');
    }
  });

  it('surfaces cron issues through validateDesignConfig at refresh.cron', () => {
    const config = {
      schemaVersion: 1,
      id: 'design_1',
      slug: 'dash',
      name: 'Dash',
      kind: 'prototype',
      createdAt: 1,
      updatedAt: 1,
      refresh: refreshSpec('* * * * *'),
    };
    const result = validateDesignConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'refresh.cron')).toBe(true);

    expect(validateDesignConfig({ ...config, refresh: refreshSpec('*/10 * * * *') }).valid).toBe(true);
  });
});

describe('DesignMotionSpecSchema', () => {
  it('accepts an empty spec and every aspect ratio', () => {
    expect(DesignMotionSpecSchema.safeParse({}).success).toBe(true);
    for (const aspect of ['16:9', '4:3', '16:10', '9:16']) {
      expect(DesignMotionSpecSchema.safeParse({ fps: 30, durationMs: 5000, aspect }).success).toBe(true);
    }
  });

  it('rejects non-integer and out-of-bounds knobs', () => {
    expect(DesignMotionSpecSchema.safeParse({ fps: 0 }).success).toBe(false);
    expect(DesignMotionSpecSchema.safeParse({ fps: MOTION_FPS_MAX + 1 }).success).toBe(false);
    expect(DesignMotionSpecSchema.safeParse({ fps: 29.5 }).success).toBe(false);
    expect(DesignMotionSpecSchema.safeParse({ durationMs: 1 }).success).toBe(false);
    expect(DesignMotionSpecSchema.safeParse({ durationMs: MOTION_DURATION_MS_MAX + 1 }).success).toBe(false);
    expect(DesignMotionSpecSchema.safeParse({ aspect: '21:9' }).success).toBe(false);
  });

  it('surfaces motion issues through validateDesignConfig at motion.fps', () => {
    const config = {
      schemaVersion: 1,
      id: 'design_1',
      slug: 'anim',
      name: 'Anim',
      kind: 'motion',
      createdAt: 1,
      updatedAt: 1,
      motion: { fps: 999 },
    };
    const result = validateDesignConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'motion.fps')).toBe(true);

    expect(validateDesignConfig({ ...config, motion: { fps: 30, durationMs: 2000 } }).valid).toBe(true);
  });
});
