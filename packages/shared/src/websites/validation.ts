/**
 * Website Config Validation
 *
 * Zod schemas mirroring the website types in @craft-agent/core, applied on every
 * website.json write (validate-on-write, like sources) so malformed configs never
 * reach disk. Read paths stay lenient (parse errors → null) like projects.
 */

import { z } from 'zod';
import { Cron } from 'croner';
import type { ValidationIssue, ValidationResult } from '../config/validators.ts';

// ============================================================================
// Schemas
// ============================================================================

export const WEBSITE_SLUG_REGEX = /^[a-z0-9-]+$/;

const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;

/** Thrown when a website slug fails the on-disk safety check. */
export class InvalidWebsiteSlugError extends Error {
  constructor(slug: unknown) {
    const shown = typeof slug === 'string' ? slug.slice(0, 100) : String(slug);
    super(`Invalid website slug: ${JSON.stringify(shown)}`);
    this.name = 'InvalidWebsiteSlugError';
  }
}

/**
 * A website slug is a single on-disk directory name — `[a-z0-9-]+`. The regex
 * alone is the full safety guarantee: it rejects empty strings, `.`/`..`,
 * path separators (`/`, `\`), and absolute/drive prefixes, so a validated
 * slug can never escape `{workspaceRoot}/websites/`. Non-throwing; use it on
 * lenient read/enumeration paths that treat a bad slug as "not found".
 */
export function isValidWebsiteSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && WEBSITE_SLUG_REGEX.test(slug);
}

/**
 * Assert a slug is safe to turn into a filesystem path. This is the single
 * chokepoint called by getWebsitePath, so no website path is ever derived from an
 * unsafe slug — closing traversal on delete/read/write (`websites:delete(ws, "..")`
 * → rmSync of the workspace root, cross-workspace read/overwrite via `../..`).
 *
 * @throws InvalidWebsiteSlugError
 */
export function assertValidWebsiteSlug(slug: unknown): asserts slug is string {
  if (!isValidWebsiteSlug(slug)) throw new InvalidWebsiteSlugError(slug);
}

export const WebsiteScriptRuntimeSchema = z.enum(['bun', 'node', 'python3']);

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
 * every matching run spawns a script subprocess — an every-minute website refresh
 * is 1,440 spawns/day per website. Five minutes is the documented minimum
 * (resources/docs/websites.md); loosen deliberately, not by accident.
 */
export const WEBSITE_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;

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
    if (gapMs < WEBSITE_REFRESH_MIN_INTERVAL_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cron'],
        message: `Cron runs too frequently (consecutive runs ${Math.round(gapMs / 1000)}s apart); the minimum refresh interval is ${WEBSITE_REFRESH_MIN_INTERVAL_MS / 60_000} minutes`,
      });
      return;
    }
  }
}

export const WebsiteRefreshSpecSchema = z
  .object({
    cron: z.string().min(1, 'Cron expression cannot be empty'),
    timezone: z.string().min(1).optional(),
    script: WorkspaceRelativeScriptPathSchema,
    args: z.array(z.string()).optional(),
    runtime: WebsiteScriptRuntimeSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine(validateRefreshCron);

export const WebsiteRefreshStatusSchema = z.object({
  at: z.number(),
  ok: z.boolean(),
  durationMs: z.number(),
  error: z.string().optional(),
});

export const WebsiteActionHttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const WebsiteActionDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('api'),
    sourceSlug: z.string().min(1),
    method: WebsiteActionHttpMethodSchema,
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
    runtime: WebsiteScriptRuntimeSchema.optional(),
    args: z.array(z.string()).optional(),
  }),
]);

export const WebsiteActionGrantSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  action: WebsiteActionDescriptorSchema,
  contentDigest: z.string().regex(SHA256_HEX_REGEX, 'Must be a sha256 hex digest'),
  createdAt: z.number(),
  expiresAt: z.number(),
});

export const WebsiteKindSchema = z.enum(['static', 'interactive', 'live']);

export const WebsiteShareInfoSchema = z.object({
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

export const WebsiteThumbnailInfoSchema = z.object({
  digest: z.string().regex(SHA256_HEX_REGEX, 'Must be a sha256 hex digest'),
  capturedAt: z.number(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const WebsiteConfigSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  slug: z.string().regex(WEBSITE_SLUG_REGEX, 'Slug must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1, 'Name cannot be empty'),
  description: z.string().optional(),
  kind: WebsiteKindSchema,
  projectId: z.string().min(1).optional(),
  originSessionId: z.string().min(1).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  refresh: WebsiteRefreshSpecSchema.optional(),
  lastRefresh: WebsiteRefreshStatusSchema.optional(),
  contentDigest: z.string().regex(SHA256_HEX_REGEX, 'Must be a sha256 hex digest').optional(),
  grants: z.array(WebsiteActionGrantSchema).optional(),
  share: WebsiteShareInfoSchema.optional(),
  thumbnail: WebsiteThumbnailInfoSchema.optional(),
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
 * Validate a website config object (schema-level).
 * Used on every save; invalid configs are rejected before touching disk.
 */
export function validateWebsiteConfig(config: unknown): ValidationResult {
  const result = WebsiteConfigSchema.safeParse(config);
  if (result.success) {
    return { valid: true, errors: [], warnings: [] };
  }
  return {
    valid: false,
    errors: zodErrorToIssues(result.error, 'website.json'),
    warnings: [],
  };
}
