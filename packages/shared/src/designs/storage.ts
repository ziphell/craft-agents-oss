/**
 * Design Storage
 *
 * CRUD operations for workspace-scoped designs.
 * Designs are stored at {workspaceRootPath}/designs/{designSlug}/
 *
 * Note: All functions take `workspaceRootPath` (absolute path to workspace
 * folder), NOT a workspace slug — same contract as projects/storage.ts.
 *
 * Cross-process contract: refresh scripts own data/store.sqlite (never read
 * it from here); the host only reads data/snapshot.json, and design.json is
 * always the last file touched (the watcher's completion marker).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'fs';
import { basename, join } from 'path';
import { createHash, randomUUID } from 'crypto';
import type {
  DesignActionDescriptor,
  DesignActionGrant,
  DesignConfig,
  DesignDataSnapshot,
  DesignRefreshStatus,
  DesignShareInfo,
  DesignThumbnailInfo,
} from '@craft-agent/core';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { generateUniqueSlug } from '../utils/slug.ts';
import { debug } from '../utils/debug.ts';
import { validateDesignConfig, assertValidDesignSlug, isValidDesignSlug } from './validation.ts';
import { migrateDesignKind, resolveDesignKindState } from './kind.ts';
import type { CreateDesignInput, LoadedDesign } from './types.ts';

/** Filename of a design's config (also the watcher's completion marker) */
export const DESIGN_CONFIG_FILENAME = 'design.json';
/** Filename of a design's self-contained HTML content */
export const DESIGN_CONTENT_FILENAME = 'index.html';
/** Filename of the atomically-written cross-process data snapshot */
export const DESIGN_SNAPSHOT_FILENAME = 'snapshot.json';
/** Filename of the script-private SQLite working store */
export const DESIGN_STORE_FILENAME = 'store.sqlite';
/**
 * Filename of the cached preview poster. JPEG, not WebP: Electron's
 * `nativeImage` can encode JPEG/PNG natively but not WebP, and adding a WebP
 * encoder dependency isn't worth it for a tile poster.
 */
export const DESIGN_THUMBNAIL_FILENAME = 'thumbnail.jpg';

/** Default grant lifetime: 30 days (grants are re-approved, never auto-renewed) */
export const DEFAULT_DESIGN_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Max stored length for lastRefresh.error */
const REFRESH_ERROR_MAX_LENGTH = 2000;

// ============================================================
// Directory Utilities
// ============================================================

/**
 * Get path to workspace designs directory.
 */
export function getWorkspaceDesignsPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'designs');
}

/**
 * Get path to a design folder within a workspace.
 */
export function getDesignPath(workspaceRootPath: string, designSlug: string): string {
  // Single chokepoint: every design path (config/content/data/snapshot/store/
  // thumbnail, and thus delete/read/write) derives from here, so validating the
  // slug once guarantees no on-disk path can escape {workspaceRoot}/designs/.
  assertValidDesignSlug(designSlug);
  return join(getWorkspaceDesignsPath(workspaceRootPath), designSlug);
}

/**
 * Get path to a design's design.json.
 */
export function getDesignConfigPath(workspaceRootPath: string, designSlug: string): string {
  return join(getDesignPath(workspaceRootPath, designSlug), DESIGN_CONFIG_FILENAME);
}

/**
 * Get a design's design.json as a workspace-relative path with forward slashes
 * (`designs/{slug}/design.json`) — the form the config watcher keys on (see
 * watcher.ts: only `designs/.../design.json` is a designs trigger).
 */
export function getDesignConfigRelativePath(designSlug: string): string {
  assertValidDesignSlug(designSlug);
  return ['designs', designSlug, DESIGN_CONFIG_FILENAME].join('/');
}

/**
 * Get path to a design's index.html content.
 */
export function getDesignContentPath(workspaceRootPath: string, designSlug: string): string {
  return join(getDesignPath(workspaceRootPath, designSlug), DESIGN_CONTENT_FILENAME);
}

/**
 * Get path to a design's data directory.
 */
export function getDesignDataPath(workspaceRootPath: string, designSlug: string): string {
  return join(getDesignPath(workspaceRootPath, designSlug), 'data');
}

/**
 * Get path to a design's data/snapshot.json (cross-process data contract).
 */
export function getDesignSnapshotPath(workspaceRootPath: string, designSlug: string): string {
  return join(getDesignDataPath(workspaceRootPath, designSlug), DESIGN_SNAPSHOT_FILENAME);
}

/**
 * Get path to a design's data/store.sqlite (script-private; see designs/data-store.ts).
 */
export function getDesignStorePath(workspaceRootPath: string, designSlug: string): string {
  return join(getDesignDataPath(workspaceRootPath, designSlug), DESIGN_STORE_FILENAME);
}

/**
 * Get path to a design's cached preview poster (designs/{slug}/thumbnail.jpg).
 */
export function getDesignThumbnailPath(workspaceRootPath: string, designSlug: string): string {
  return join(getDesignPath(workspaceRootPath, designSlug), DESIGN_THUMBNAIL_FILENAME);
}

/**
 * Ensure designs directory exists for a workspace.
 */
export function ensureDesignsDir(workspaceRootPath: string): void {
  const dir = getWorkspaceDesignsPath(workspaceRootPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Ensure a design's data directory exists.
 */
export function ensureDesignDataDir(workspaceRootPath: string, designSlug: string): void {
  const dir = getDesignDataPath(workspaceRootPath, designSlug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================
// Config Operations
// ============================================================

/**
 * Load design.json.
 * Returns null if the config does not exist or fails to parse.
 */
export function loadDesignConfig(
  workspaceRootPath: string,
  designSlug: string,
): DesignConfig | null {
  // Lenient read: an unsafe slug is simply "not found" (never a thrown path
  // traversal). This also keeps loadDesign/GET_ONE's id-or-slug fallback working
  // — an id like `design_ab12` isn't a valid slug, so it falls through to loadDesignById.
  if (!isValidDesignSlug(designSlug)) return null;
  const configPath = getDesignConfigPath(workspaceRootPath, designSlug);
  if (!existsSync(configPath)) return null;

  try {
    const raw = readJsonFileSync<Record<string, unknown>>(configPath);
    // Kinds are stored now (prototype / deck / motion). A file written before
    // that says which one it is by which settings it carries — and one written
    // with the retired runtime kinds (`static`/`interactive`/`live`) said
    // nothing about what it is, so it is inferred the same way. Whatever is
    // settled here is written back on the next save.
    const migrated = migrateDesignKind(raw);
    for (const note of migrated.notes) {
      debug('[loadDesignConfig]', designSlug, note);
    }
    return migrated.config as unknown as DesignConfig;
  } catch (error) {
    debug('[loadDesignConfig] Failed to read design config:', designSlug, error);
    return null;
  }
}

/**
 * Save design.json (validated, atomic write, bumps updatedAt).
 *
 * @throws Error if the config fails schema validation
 */
export function saveDesignConfig(workspaceRootPath: string, config: DesignConfig): void {
  const storageConfig: DesignConfig = {
    ...config,
    updatedAt: Date.now(),
  };

  const validation = validateDesignConfig(storageConfig);
  if (!validation.valid) {
    const errorMessages = validation.errors.map((e) => `${e.path}: ${e.message}`).join(', ');
    debug('[saveDesignConfig] Validation failed:', errorMessages);
    throw new Error(`Invalid design config: ${errorMessages}`);
  }

  const dir = getDesignPath(workspaceRootPath, config.slug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  atomicWriteFileSync(join(dir, DESIGN_CONFIG_FILENAME), JSON.stringify(storageConfig, null, 2));
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Load a single design by slug.
 */
export function loadDesign(
  workspaceRootPath: string,
  designSlug: string,
): LoadedDesign | null {
  const config = loadDesignConfig(workspaceRootPath, designSlug);
  if (!config) return null;

  return {
    config,
    folderPath: getDesignPath(workspaceRootPath, designSlug),
    contentPath: getDesignContentPath(workspaceRootPath, designSlug),
    dataPath: getDesignDataPath(workspaceRootPath, designSlug),
    snapshotPath: getDesignSnapshotPath(workspaceRootPath, designSlug),
    workspaceRootPath,
    workspaceId: basename(workspaceRootPath),
  };
}

/**
 * Load a design by id (scans workspace designs for a matching id).
 */
export function loadDesignById(
  workspaceRootPath: string,
  designId: string,
): LoadedDesign | null {
  const designs = loadWorkspaceDesigns(workspaceRootPath);
  return designs.find((p) => p.config.id === designId) ?? null;
}

/**
 * Load all designs for a workspace.
 */
export function loadWorkspaceDesigns(workspaceRootPath: string): LoadedDesign[] {
  const designs: LoadedDesign[] = [];
  const designsDir = getWorkspaceDesignsPath(workspaceRootPath);

  if (!existsSync(designsDir)) return designs;

  const entries = readdirSync(designsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const design = loadDesign(workspaceRootPath, entry.name);
    if (design) designs.push(design);
  }

  return designs;
}

/**
 * The designs bound to one project (`config.projectId`), sorted by slug.
 *
 * Sorted so the order is the same on every read: a stable prompt block must not churn
 * just because a directory listing came back differently.
 */
export function loadProjectDesigns(workspaceRootPath: string, projectId: string): LoadedDesign[] {
  return loadWorkspaceDesigns(workspaceRootPath)
    .filter((design) => design.config.projectId === projectId)
    .sort((a, b) => a.config.slug.localeCompare(b.config.slug));
}

/**
 * Check if a design exists in a workspace.
 */
export function designExists(workspaceRootPath: string, designSlug: string): boolean {
  if (!isValidDesignSlug(designSlug)) return false;
  return existsSync(getDesignConfigPath(workspaceRootPath, designSlug));
}

// ============================================================
// Create / Update / Delete
// ============================================================

/**
 * Generate a URL-safe, workspace-unique design slug.
 */
export function generateDesignSlug(workspaceRootPath: string, name: string): string {
  const designsDir = getWorkspaceDesignsPath(workspaceRootPath);
  const existingSlugs = new Set<string>();
  if (existsSync(designsDir)) {
    for (const entry of readdirSync(designsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) existingSlugs.add(entry.name);
    }
  }
  return generateUniqueSlug(name, existingSlugs, 'design');
}

/**
 * Create a new design in a workspace.
 *
 * The kind and its settings are resolved together (giving `deck` settings is
 * saying "this is a deck"; a kind that contradicts settings being written is
 * refused) — see designs/kind.ts.
 */
export function createDesign(
  workspaceRootPath: string,
  input: CreateDesignInput,
): DesignConfig {
  const slug = generateDesignSlug(workspaceRootPath, input.name);
  const now = Date.now();
  const state = resolveDesignKindState({ kind: input.kind, deck: input.deck, motion: input.motion });

  let config: DesignConfig = {
    schemaVersion: 1,
    id: `design_${randomUUID().slice(0, 8)}`,
    slug,
    name: input.name,
    description: input.description,
    kind: state.kind,
    projectId: input.projectId,
    refresh: input.refresh,
    deck: state.deck,
    motion: state.motion,
    createdAt: now,
    updatedAt: now,
  };

  saveDesignConfig(workspaceRootPath, config);
  ensureDesignDataDir(workspaceRootPath, slug);

  if (input.content !== undefined) {
    config = saveDesignContent(workspaceRootPath, slug, input.content);
  }

  return config;
}

/**
 * Patch shape for updateDesign. The optional fields additionally accept an
 * explicit `null` meaning "clear this field": `undefined` cannot cross a JSON
 * transport (the RPC layer drops it, so the key never reaches the merge) and
 * a bare missing key must keep meaning "leave unchanged".
 */
export type UpdateDesignPatch = Partial<
  // The null-clearable fields are OMITTED here and re-added below — an
  // intersection would intersect their property types ((string | undefined) &
  // (string | null) = string) and silently forbid the null again.
  Omit<
    DesignConfig,
    'schemaVersion' | 'id' | 'slug' | 'createdAt' | 'contentDigest' | 'lastRefresh' | 'grants' | 'share' | 'thumbnail' | 'projectId' | 'description' | 'refresh' | 'deck' | 'motion'
  >
> & {
  projectId?: string | null;
  description?: string | null;
  refresh?: DesignConfig['refresh'] | null;
  deck?: DesignConfig['deck'] | null;
  motion?: DesignConfig['motion'] | null;
};

/** Patch fields where an explicit null means "clear" (see UpdateDesignPatch) */
const NULL_CLEARABLE_DESIGN_FIELDS = ['projectId', 'description', 'refresh', 'deck', 'motion'] as const;

/**
 * Update a design's config with a partial patch.
 * `id`, `slug`, and the managed fields (`contentDigest`, `lastRefresh`,
 * `grants`, `share`, `thumbnail`) cannot be changed here — use saveDesignContent /
 * recordDesignRefresh / the grant operations / setDesignShareState /
 * recordDesignThumbnail instead.
 *
 * This is the single normalization point for null-clears — the designs:update
 * RPC and the update_design session tool both pass their patches through
 * verbatim, so "null clears" behaves identically from every caller.
 */
export function updateDesign(
  workspaceRootPath: string,
  designSlug: string,
  patch: UpdateDesignPatch,
): DesignConfig {
  const existing = loadDesignConfig(workspaceRootPath, designSlug);
  if (!existing) {
    throw new Error(`Design not found: ${designSlug}`);
  }

  // Null → PRESENT undefined key: the spread below then overrides the existing
  // value, and the validate-on-write schema sees a valid absent optional.
  // Keys not in the patch stay absent and leave the field unchanged.
  const normalized = { ...patch } as Partial<DesignConfig>;
  for (const field of NULL_CLEARABLE_DESIGN_FIELDS) {
    if (patch[field] === null) (normalized as Record<string, unknown>)[field] = undefined;
  }

  const updated: DesignConfig = {
    ...existing,
    ...normalized,
    schemaVersion: existing.schemaVersion,
    id: existing.id,
    slug: existing.slug,
    createdAt: existing.createdAt,
    contentDigest: existing.contentDigest,
    lastRefresh: existing.lastRefresh,
    grants: existing.grants,
    share: existing.share,
    thumbnail: existing.thumbnail,
    updatedAt: Date.now(),
  };

  // The kind and its settings move together: either one may be the thing the
  // patch names, and the result is stored as one coherent state (a kind change
  // drops the settings of the kind the design no longer is).
  const state = resolveDesignKindState({
    kind: patch.kind,
    deck: patch.deck,
    motion: patch.motion,
    current: { kind: existing.kind, deck: existing.deck, motion: existing.motion },
  });
  updated.kind = state.kind;
  updated.deck = state.deck;
  updated.motion = state.motion;

  saveDesignConfig(workspaceRootPath, updated);
  return updated;
}

/**
 * Delete a design (removes folder including content and data).
 * `force` rides over mid-tree races (a file vanishing between listing and
 * unlink, Windows EBUSY retries) instead of aborting half-deleted.
 */
export function deleteDesign(workspaceRootPath: string, designSlug: string): void {
  const dir = getDesignPath(workspaceRootPath, designSlug);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Unbind a project from all designs that reference it (project deletion).
 * Mirrors session unbinding. Returns the number of designs touched.
 */
export function unbindProjectFromDesigns(workspaceRootPath: string, projectId: string): number {
  let touched = 0;
  for (const design of loadWorkspaceDesigns(workspaceRootPath)) {
    if (design.config.projectId !== projectId) continue;
    const { projectId: _removed, ...rest } = design.config;
    saveDesignConfig(workspaceRootPath, rest);
    touched++;
  }
  return touched;
}

// ============================================================
// Content Operations
// ============================================================

/**
 * Compute the sha256 hex digest of design content.
 * Grants and render leases are bound to this digest.
 */
export function computeDesignContentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Load a design's index.html content.
 * Returns null if the file does not exist or cannot be read.
 */
export function loadDesignContent(workspaceRootPath: string, designSlug: string): string | null {
  if (!isValidDesignSlug(designSlug)) return null;
  const contentPath = getDesignContentPath(workspaceRootPath, designSlug);
  if (!existsSync(contentPath)) return null;

  try {
    return readFileSync(contentPath, 'utf-8');
  } catch (error) {
    debug('[loadDesignContent] Failed to read design content:', designSlug, error);
    return null;
  }
}

/**
 * Save a design's index.html content (atomic) and update contentDigest.
 *
 * Existing grants stay persisted but are bound to the previous digest, so
 * they stop validating until re-approved — that is the security model, not
 * an oversight.
 */
export function saveDesignContent(
  workspaceRootPath: string,
  designSlug: string,
  content: string,
): DesignConfig {
  const existing = loadDesignConfig(workspaceRootPath, designSlug);
  if (!existing) {
    throw new Error(`Design not found: ${designSlug}`);
  }

  atomicWriteFileSync(getDesignContentPath(workspaceRootPath, designSlug), content);

  const updated: DesignConfig = {
    ...existing,
    contentDigest: computeDesignContentDigest(content),
    updatedAt: Date.now(),
  };
  saveDesignConfig(workspaceRootPath, updated);
  return updated;
}

// ============================================================
// Data Operations
// ============================================================

/**
 * Read a design's data/snapshot.json.
 * Returns null when missing or malformed (a refresh may not have run yet).
 */
export function readDesignDataSnapshot(
  workspaceRootPath: string,
  designSlug: string,
): DesignDataSnapshot | null {
  if (!isValidDesignSlug(designSlug)) return null;
  const snapshotPath = getDesignSnapshotPath(workspaceRootPath, designSlug);
  if (!existsSync(snapshotPath)) return null;

  try {
    return readJsonFileSync<DesignDataSnapshot>(snapshotPath);
  } catch (error) {
    debug('[readDesignDataSnapshot] Failed to read snapshot:', designSlug, error);
    return null;
  }
}

/**
 * Record the outcome of a refresh run on design.json.
 *
 * This is deliberately the LAST write of a refresh flow: the config watcher
 * reacts to design.json (and only design.json) with a `designs:changed` push, so
 * observers never see a half-written data/ directory as complete.
 */
export function recordDesignRefresh(
  workspaceRootPath: string,
  designSlug: string,
  status: DesignRefreshStatus,
): DesignConfig {
  const existing = loadDesignConfig(workspaceRootPath, designSlug);
  if (!existing) {
    throw new Error(`Design not found: ${designSlug}`);
  }

  const updated: DesignConfig = {
    ...existing,
    lastRefresh: {
      ...status,
      error: status.error?.slice(0, REFRESH_ERROR_MAX_LENGTH),
    },
    updatedAt: Date.now(),
  };
  saveDesignConfig(workspaceRootPath, updated);
  return updated;
}

// ============================================================
// Grant Operations
// ============================================================

export interface AddDesignGrantInput {
  action: DesignActionDescriptor;
  description?: string;
  /** Grant lifetime in ms (default DEFAULT_DESIGN_GRANT_TTL_MS) */
  ttlMs?: number;
}

/**
 * Persist a user-approved grant on a design, bound to the current content
 * digest. Approval UX happens upstream — by the time this is called the
 * user has already consented.
 *
 * @throws Error if the design is missing or has no content yet (nothing to bind to)
 */
export function addDesignGrant(
  workspaceRootPath: string,
  designSlug: string,
  input: AddDesignGrantInput,
): DesignActionGrant {
  const existing = loadDesignConfig(workspaceRootPath, designSlug);
  if (!existing) {
    throw new Error(`Design not found: ${designSlug}`);
  }
  if (!existing.contentDigest) {
    throw new Error(`Design "${designSlug}" has no content yet, so access can't be approved. Add content to the design first.`);
  }

  const now = Date.now();
  const grant: DesignActionGrant = {
    id: `grant_${randomUUID().slice(0, 8)}`,
    description: input.description,
    action: input.action,
    contentDigest: existing.contentDigest,
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_DESIGN_GRANT_TTL_MS),
  };

  saveDesignConfig(workspaceRootPath, {
    ...existing,
    grants: [...(existing.grants ?? []), grant],
  });
  return grant;
}

// ============================================================
// Share State
// ============================================================

/**
 * A cached poster is fresh only when it was captured for the design's CURRENT
 * content digest. Data-only refreshes deliberately do not invalidate it (v1).
 * Single source of truth for the freshness check (RPC + capturer both use it).
 */
export function isThumbnailFresh(
  config: Pick<DesignConfig, 'contentDigest' | 'thumbnail'>,
): boolean {
  return (
    config.thumbnail !== undefined &&
    config.contentDigest !== undefined &&
    config.thumbnail.digest === config.contentDigest
  );
}

/**
 * Record (or clear) a design's cached-poster pointer (the managed `thumbnail`
 * field). Written only by the thumbnail capture flow after the .jpg is on disk;
 * stamping design.json last makes the config watcher emit `designs:changed` so open
 * grids pick up the fresh poster. Pass `undefined` to clear (e.g. capture
 * failed or content removed).
 */
export function recordDesignThumbnail(
  workspaceRootPath: string,
  designSlug: string,
  thumbnail: DesignThumbnailInfo | undefined,
): DesignConfig {
  const existing = loadDesignConfig(workspaceRootPath, designSlug);
  if (!existing) {
    throw new Error(`Design not found: ${designSlug}`);
  }

  const { thumbnail: _previous, ...rest } = existing;
  const updated: DesignConfig = {
    ...rest,
    ...(thumbnail ? { thumbnail } : {}),
    updatedAt: Date.now(),
  };
  saveDesignConfig(workspaceRootPath, updated);
  return updated;
}

/**
 * Set or clear a design's publication pointer (the managed `share` field).
 *
 * Written only by the publish/unpublish flow — the remote Cloudflare record
 * stays authoritative and the admin token never passes through here.
 */
export function setDesignShareState(
  workspaceRootPath: string,
  designSlug: string,
  share: DesignShareInfo | undefined,
): DesignConfig {
  const existing = loadDesignConfig(workspaceRootPath, designSlug);
  if (!existing) {
    throw new Error(`Design not found: ${designSlug}`);
  }

  const { share: _previous, ...rest } = existing;
  const updated: DesignConfig = {
    ...rest,
    ...(share ? { share } : {}),
    updatedAt: Date.now(),
  };
  saveDesignConfig(workspaceRootPath, updated);
  return updated;
}

/**
 * Remove a grant from a design. Returns false if the grant was not present.
 */
export function revokeDesignGrant(
  workspaceRootPath: string,
  designSlug: string,
  grantId: string,
): boolean {
  const existing = loadDesignConfig(workspaceRootPath, designSlug);
  if (!existing) {
    throw new Error(`Design not found: ${designSlug}`);
  }

  const grants = existing.grants ?? [];
  const remaining = grants.filter((g) => g.id !== grantId);
  if (remaining.length === grants.length) return false;

  saveDesignConfig(workspaceRootPath, { ...existing, grants: remaining });
  return true;
}
