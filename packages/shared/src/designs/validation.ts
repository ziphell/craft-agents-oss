/**
 * Design Config Validation
 *
 * Zod schemas mirroring the design types in @craft-agent/core, applied on every
 * design.json write (validate-on-write, like sources) so malformed configs never
 * reach disk. Read paths stay lenient (parse errors → null) like projects.
 */

import { z } from 'zod';
import { Cron } from 'croner';
import type { ValidationIssue, ValidationResult } from '../config/validators.ts';

// ============================================================================
// Schemas
// ============================================================================

export const DESIGN_SLUG_REGEX = /^[a-z0-9-]+$/;

const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;

/** Thrown when a design slug fails the on-disk safety check. */
export class InvalidDesignSlugError extends Error {
  constructor(slug: unknown) {
    const shown = typeof slug === 'string' ? slug.slice(0, 100) : String(slug);
    super(`Invalid design slug: ${JSON.stringify(shown)}`);
    this.name = 'InvalidDesignSlugError';
  }
}

/**
 * A design slug is a single on-disk directory name — `[a-z0-9-]+`. The regex
 * alone is the full safety guarantee: it rejects empty strings, `.`/`..`,
 * path separators (`/`, `\`), and absolute/drive prefixes, so a validated
 * slug can never escape `{workspaceRoot}/designs/`. Non-throwing; use it on
 * lenient read/enumeration paths that treat a bad slug as "not found".
 */
export function isValidDesignSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && DESIGN_SLUG_REGEX.test(slug);
}

/**
 * Assert a slug is safe to turn into a filesystem path. This is the single
 * chokepoint called by getDesignPath, so no design path is ever derived from an
 * unsafe slug — closing traversal on delete/read/write (`designs:delete(ws, "..")`
 * → rmSync of the workspace root, cross-workspace read/overwrite via `../..`).
 *
 * @throws InvalidDesignSlugError
 */
export function assertValidDesignSlug(slug: unknown): asserts slug is string {
  if (!isValidDesignSlug(slug)) throw new InvalidDesignSlugError(slug);
}

export const DesignScriptRuntimeSchema = z.enum(['bun', 'node', 'python3']);

/**
 * A workspace-relative script path: no absolute paths, no ".." escape. The
 * executor re-validates with symlink resolution at run time; this is the
 * static gate shared by refresh specs and script-action grants.
 */
export const WorkspaceRelativeScriptPathSchema = z
  .string()
  .min(1, 'Script path cannot be empty')
  .superRefine((script, ctx) => {
    if (script.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(script)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Script path must be relative to the workspace root' });
    }
    if (script.split(/[\\/]/).includes('..')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Script path must not contain ".." segments' });
    }
  });

/**
 * Policy floor for scheduled refreshes. The scheduler ticks once a minute and
 * every matching run spawns a script subprocess — an every-minute design refresh
 * is 1,440 spawns/day per design. Five minutes is the documented minimum
 * (resources/docs/designs.md); loosen deliberately, not by accident.
 */
export const DESIGN_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Consecutive runs sampled for the interval floor — enough to catch bursty patterns like "0,1 0 * * *". */
const CRON_SAMPLE_RUNS = 10;

/**
 * Validate a refresh cron with the SAME engine the scheduler matches with
 * (croner, via automations/cron-matcher.ts) so "valid on write" and "fires at
 * runtime" cannot disagree. Rejects unparseable expressions and timezones,
 * expressions that never fire (e.g. "0 0 30 2 *"), and anything that can run
 * more often than the minimum interval.
 */
function validateRefreshCron(spec: { cron: string; timezone?: string }, ctx: z.RefinementCtx): void {
  let runs: Date[];
  // The whole evaluation stays inside the try: croner validates the EXPRESSION
  // in the constructor but the TIMEZONE lazily, on the first date computation
  // (nextRuns) — both must land as a validation issue, never an exception.
  try {
    const job = new Cron(spec.cron, spec.timezone ? { timezone: spec.timezone } : {});
    runs = job.nextRuns(CRON_SAMPLE_RUNS);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cron'],
      message: `Invalid cron expression or timezone: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  if (runs.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cron'],
      message: 'Cron expression never fires (no upcoming run exists — check day-of-month/month combination)',
    });
    return;
  }

  for (let i = 1; i < runs.length; i++) {
    const gapMs = runs[i]!.getTime() - runs[i - 1]!.getTime();
    if (gapMs < DESIGN_REFRESH_MIN_INTERVAL_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cron'],
        message: `Cron runs too frequently (consecutive runs ${Math.round(gapMs / 1000)}s apart); the minimum refresh interval is ${DESIGN_REFRESH_MIN_INTERVAL_MS / 60_000} minutes`,
      });
      return;
    }
  }
}

export const DesignRefreshSpecSchema = z
  .object({
    cron: z.string().min(1, 'Cron expression cannot be empty'),
    timezone: z.string().min(1).optional(),
    script: WorkspaceRelativeScriptPathSchema,
    args: z.array(z.string()).optional(),
    runtime: DesignScriptRuntimeSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine(validateRefreshCron);

export const DesignRefreshStatusSchema = z.object({
  at: z.number(),
  ok: z.boolean(),
  durationMs: z.number(),
  error: z.string().optional(),
});

export const DesignActionHttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const DesignActionDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('api'),
    sourceSlug: z.string().min(1),
    method: DesignActionHttpMethodSchema,
    pathPattern: z.string().min(1, 'Path pattern cannot be empty'),
  }),
  z.object({
    kind: z.literal('mcp'),
    sourceSlug: z.string().min(1),
    toolName: z.string().min(1),
  }),
  z.object({
    kind: z.literal('script'),
    script: WorkspaceRelativeScriptPathSchema,
    runtime: DesignScriptRuntimeSchema.optional(),
    args: z.array(z.string()).optional(),
  }),
]);

export const DesignActionGrantSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  action: DesignActionDescriptorSchema,
  contentDigest: z.string().regex(SHA256_HEX_REGEX, 'Must be a sha256 hex digest'),
  createdAt: z.number(),
  expiresAt: z.number(),
});

export const DesignKindSchema = z.enum(['webpage', 'prototype', 'deck', 'motion']);

export const DesignDeckAspectSchema = z.enum(['16:9', '4:3', '16:10', '9:16']);

/**
 * Deck presentation hint. Absent = a plain document. The slide count is not
 * here on purpose: the deck reports it over the bridge, so this stays a hint
 * rather than a second description of the HTML.
 */
export const DesignDeckSpecSchema = z.object({
  aspect: DesignDeckAspectSchema.optional(),
  theme: z.string().max(200).optional(),
});

/**
 * Motion capture policy floor/ceiling. The numbers are the single source of
 * truth: the same bounds gate what reaches design.json here and what the
 * renderer clamps to (export.ts), so "valid on write" and "what gets rendered"
 * cannot disagree. Realtime capture is wall-clock bound, so 60fps is the
 * ceiling (a higher hint buys nothing) and 10 minutes is the longest piece one
 * hidden window will record.
 */
export const MOTION_FPS_MIN = 1;
export const MOTION_FPS_MAX = 60;
export const MOTION_DURATION_MS_MIN = 100;
export const MOTION_DURATION_MS_MAX = 10 * 60 * 1000;

/**
 * Motion composition hint. Absent = a plain document. The timeline itself
 * lives in the HTML — only the render knobs are stored here (see
 * DesignMotionSpec in @craft-agent/core).
 */
export const DesignMotionSpecSchema = z.object({
  fps: z.number().int().min(MOTION_FPS_MIN).max(MOTION_FPS_MAX).optional(),
  durationMs: z.number().int().min(MOTION_DURATION_MS_MIN).max(MOTION_DURATION_MS_MAX).optional(),
  aspect: DesignDeckAspectSchema.optional(),
});

export const DesignShareInfoSchema = z.object({
  publicationId: z.string().min(1),
  url: z.string().url(),
  publishedRevision: z.string().min(1),
  publishedContentDigest: z.string().regex(SHA256_HEX_REGEX, 'Must be a sha256 hex digest'),
  includesData: z.boolean(),
  publishedAt: z.number(),
  updatedAt: z.number(),
  passwordProtected: z.boolean(),
  lastPublishError: z.string().max(2000).optional(),
});

export const DesignThumbnailInfoSchema = z.object({
  digest: z.string().regex(SHA256_HEX_REGEX, 'Must be a sha256 hex digest'),
  capturedAt: z.number(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const DesignConfigSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  slug: z.string().regex(DESIGN_SLUG_REGEX, 'Slug must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1, 'Name cannot be empty'),
  description: z.string().optional(),
  kind: DesignKindSchema,
  projectId: z.string().min(1).optional(),
  pinnedToTrayAt: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  refresh: DesignRefreshSpecSchema.optional(),
  lastRefresh: DesignRefreshStatusSchema.optional(),
  contentDigest: z.string().regex(SHA256_HEX_REGEX, 'Must be a sha256 hex digest').optional(),
  grants: z.array(DesignActionGrantSchema).optional(),
  share: DesignShareInfoSchema.optional(),
  thumbnail: DesignThumbnailInfoSchema.optional(),
  deck: DesignDeckSpecSchema.optional(),
  motion: DesignMotionSpecSchema.optional(),
}).superRefine((config, ctx) => {
  // The kind is the only statement of what a design is; its settings belong to
  // it and to nothing else (see designs/kind.ts). A hand-edited design.json is
  // held to the same rule as the write path.
  if (config.deck !== undefined && config.kind !== 'deck') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deck'],
      message: `Deck settings belong to a deck, but the kind is "${config.kind}".`,
    });
  }
  if (config.motion !== undefined && config.kind !== 'motion') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['motion'],
      message: `Motion settings belong to a motion composition, but the kind is "${config.kind}".`,
    });
  }
});

// ============================================================================
// Validation
// ============================================================================

/** Convert Zod error to ValidationIssues (matches validators.ts pattern) */
function zodErrorToIssues(error: z.ZodError, file: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    file,
    path: issue.path.join('.') || 'root',
    message: issue.message,
    severity: 'error' as const,
  }));
}

/**
 * Validate a design config object (schema-level).
 * Used on every save; invalid configs are rejected before touching disk.
 */
export function validateDesignConfig(config: unknown): ValidationResult {
  const result = DesignConfigSchema.safeParse(config);
  if (result.success) {
    return { valid: true, errors: [], warnings: [] };
  }
  return {
    valid: false,
    errors: zodErrorToIssues(result.error, 'design.json'),
    warnings: [],
  };
}
