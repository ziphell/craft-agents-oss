/**
 * Website Storage
 *
 * CRUD operations for workspace-scoped websites.
 * Websites are stored at {workspaceRootPath}/websites/{websiteSlug}/
 *
 * Note: All functions take `workspaceRootPath` (absolute path to workspace
 * folder), NOT a workspace slug — same contract as projects/storage.ts.
 *
 * Cross-process contract: refresh scripts own data/store.sqlite (never read
 * it from here); the host only reads data/snapshot.json, and website.json is
 * always the last file touched (the watcher's completion marker).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import type {
  WebsiteConfig,
  WebsiteDataSnapshot,
  WebsiteRefreshStatus,
  WebsiteThumbnailInfo,
} from '@craft-agent/core';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { generateUniqueSlug } from '../utils/slug.ts';
import { debug } from '../utils/debug.ts';
import { validateWebsiteConfig, assertValidWebsiteSlug, isValidWebsiteSlug } from './validation.ts';
import type { CreateWebsiteInput, LoadedWebsite } from './types.ts';

/** Filename of a website's config (also the watcher's completion marker) */
export const WEBSITE_CONFIG_FILENAME = 'website.json';
/** Filename of a website's self-contained HTML content */
export const WEBSITE_CONTENT_FILENAME = 'index.html';
/** Filename of the atomically-written cross-process data snapshot */
export const WEBSITE_SNAPSHOT_FILENAME = 'snapshot.json';
/** Filename of the script-private SQLite working store */
export const WEBSITE_STORE_FILENAME = 'store.sqlite';
/**
 * Filename of the cached preview poster. JPEG, not WebP: Electron's
 * `nativeImage` can encode JPEG/PNG natively but not WebP, and adding a WebP
 * encoder dependency isn't worth it for a tile poster.
 */
export const WEBSITE_THUMBNAIL_FILENAME = 'thumbnail.jpg';

/** Max stored length for lastRefresh.error */
const REFRESH_ERROR_MAX_LENGTH = 2000;

// ============================================================
// Directory Utilities
// ============================================================

/**
 * Get path to workspace websites directory.
 */
export function getWorkspaceWebsitesPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'websites');
}

/**
 * Get path to a website folder within a workspace.
 */
export function getWebsitePath(workspaceRootPath: string, websiteSlug: string): string {
  // Single chokepoint: every website path (config/content/data/snapshot/store/
  // thumbnail, and thus delete/read/write) derives from here, so validating the
  // slug once guarantees no on-disk path can escape {workspaceRoot}/websites/.
  assertValidWebsiteSlug(websiteSlug);
  return join(getWorkspaceWebsitesPath(workspaceRootPath), websiteSlug);
}

/**
 * Get path to a website's website.json.
 */
export function getWebsiteConfigPath(workspaceRootPath: string, websiteSlug: string): string {
  return join(getWebsitePath(workspaceRootPath, websiteSlug), WEBSITE_CONFIG_FILENAME);
}

/**
 * Get path to a website's index.html content.
 */
export function getWebsiteContentPath(workspaceRootPath: string, websiteSlug: string): string {
  return join(getWebsitePath(workspaceRootPath, websiteSlug), WEBSITE_CONTENT_FILENAME);
}

/**
 * Get path to a website's data directory.
 */
export function getWebsiteDataPath(workspaceRootPath: string, websiteSlug: string): string {
  return join(getWebsitePath(workspaceRootPath, websiteSlug), 'data');
}

/**
 * Get path to a website's data/snapshot.json (cross-process data contract).
 */
export function getWebsiteSnapshotPath(workspaceRootPath: string, websiteSlug: string): string {
  return join(getWebsiteDataPath(workspaceRootPath, websiteSlug), WEBSITE_SNAPSHOT_FILENAME);
}

/**
 * Get path to a website's data/store.sqlite (script-private; see websites/data-store.ts).
 */
export function getWebsiteStorePath(workspaceRootPath: string, websiteSlug: string): string {
  return join(getWebsiteDataPath(workspaceRootPath, websiteSlug), WEBSITE_STORE_FILENAME);
}

/**
 * Get path to a website's cached preview poster (websites/{slug}/thumbnail.jpg).
 */
export function getWebsiteThumbnailPath(workspaceRootPath: string, websiteSlug: string): string {
  return join(getWebsitePath(workspaceRootPath, websiteSlug), WEBSITE_THUMBNAIL_FILENAME);
}

/**
 * Ensure websites directory exists for a workspace.
 */
export function ensureWebsitesDir(workspaceRootPath: string): void {
  const dir = getWorkspaceWebsitesPath(workspaceRootPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Ensure a website's data directory exists.
 */
export function ensureWebsiteDataDir(workspaceRootPath: string, websiteSlug: string): void {
  const dir = getWebsiteDataPath(workspaceRootPath, websiteSlug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================
// Config Operations
// ============================================================

/**
 * Load website.json.
 * Returns null if the config does not exist or fails to parse.
 */
export function loadWebsiteConfig(
  workspaceRootPath: string,
  websiteSlug: string,
): WebsiteConfig | null {
  // Lenient read: an unsafe slug is simply "not found" (never a thrown path
  // traversal). This also keeps loadWebsite/GET_ONE's id-or-slug fallback working
  // — an id like `website_ab12` isn't a valid slug, so it falls through to loadWebsiteById.
  if (!isValidWebsiteSlug(websiteSlug)) return null;
  const configPath = getWebsiteConfigPath(workspaceRootPath, websiteSlug);
  if (!existsSync(configPath)) return null;

  try {
    return readJsonFileSync<WebsiteConfig>(configPath);
  } catch (error) {
    debug('[loadWebsiteConfig] Failed to read website config:', websiteSlug, error);
    return null;
  }
}

/**
 * Save website.json (validated, atomic write).
 *
 * Bumps `updatedAt` by default: it is what the library orders by and what
 * "updated" means on a tile. A caller whose write is the app's own bookkeeping
 * rather than a change to the website passes `touch: false`, so the stamp it
 * carries is written as-is.
 *
 * @throws Error if the config fails schema validation
 */
export function saveWebsiteConfig(
  workspaceRootPath: string,
  config: WebsiteConfig,
  options?: { touch?: boolean },
): void {
  const storageConfig: WebsiteConfig =
    options?.touch === false ? config : { ...config, updatedAt: Date.now() };

  const validation = validateWebsiteConfig(storageConfig);
  if (!validation.valid) {
    const errorMessages = validation.errors.map((e) => `${e.path}: ${e.message}`).join(', ');
    debug('[saveWebsiteConfig] Validation failed:', errorMessages);
    throw new Error(`Invalid website config: ${errorMessages}`);
  }

  const dir = getWebsitePath(workspaceRootPath, config.slug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  atomicWriteFileSync(join(dir, WEBSITE_CONFIG_FILENAME), JSON.stringify(storageConfig, null, 2));
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Load a single website by slug.
 */
export function loadWebsite(
  workspaceRootPath: string,
  websiteSlug: string,
): LoadedWebsite | null {
  const config = loadWebsiteConfig(workspaceRootPath, websiteSlug);
  if (!config) return null;

  return {
    config,
    folderPath: getWebsitePath(workspaceRootPath, websiteSlug),
    contentPath: getWebsiteContentPath(workspaceRootPath, websiteSlug),
    dataPath: getWebsiteDataPath(workspaceRootPath, websiteSlug),
    snapshotPath: getWebsiteSnapshotPath(workspaceRootPath, websiteSlug),
    workspaceRootPath,
  };
}

/**
 * Load a website by id (scans workspace websites for a matching id).
 */
export function loadWebsiteById(
  workspaceRootPath: string,
  websiteId: string,
): LoadedWebsite | null {
  const websites = loadWorkspaceWebsites(workspaceRootPath);
  return websites.find((p) => p.config.id === websiteId) ?? null;
}

/**
 * Load all websites for a workspace.
 */
export function loadWorkspaceWebsites(workspaceRootPath: string): LoadedWebsite[] {
  const websites: LoadedWebsite[] = [];
  const websitesDir = getWorkspaceWebsitesPath(workspaceRootPath);

  if (!existsSync(websitesDir)) return websites;

  const entries = readdirSync(websitesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const website = loadWebsite(workspaceRootPath, entry.name);
    if (website) websites.push(website);
  }

  return websites;
}

/**
 * Check if a website exists in a workspace.
 */
export function websiteExists(workspaceRootPath: string, websiteSlug: string): boolean {
  if (!isValidWebsiteSlug(websiteSlug)) return false;
  return existsSync(getWebsiteConfigPath(workspaceRootPath, websiteSlug));
}

// ============================================================
// Create / Update / Delete
// ============================================================

/**
 * Generate a URL-safe, workspace-unique website slug.
 */
export function generateWebsiteSlug(workspaceRootPath: string, name: string): string {
  const websitesDir = getWorkspaceWebsitesPath(workspaceRootPath);
  const existingSlugs = new Set<string>();
  if (existsSync(websitesDir)) {
    for (const entry of readdirSync(websitesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) existingSlugs.add(entry.name);
    }
  }
  return generateUniqueSlug(name, existingSlugs, 'website');
}

/**
 * Create a new website in a workspace.
 */
export function createWebsite(
  workspaceRootPath: string,
  input: CreateWebsiteInput,
): WebsiteConfig {
  const slug = generateWebsiteSlug(workspaceRootPath, input.name);
  const now = Date.now();

  let config: WebsiteConfig = {
    schemaVersion: 1,
    id: `website_${randomUUID().slice(0, 8)}`,
    slug,
    name: input.name,
    description: input.description,
    projectId: input.projectId,
    originSessionId: input.originSessionId,
    refresh: input.refresh,
    createdAt: now,
    updatedAt: now,
  };

  saveWebsiteConfig(workspaceRootPath, config);
  ensureWebsiteDataDir(workspaceRootPath, slug);

  if (input.content !== undefined) {
    config = saveWebsiteContent(workspaceRootPath, slug, input.content);
  }

  return config;
}

/**
 * Patch shape for updateWebsite. The optional fields additionally accept an
 * explicit `null` meaning "clear this field": `undefined` cannot cross a JSON
 * transport (the RPC layer drops it, so the key never reaches the merge) and
 * a bare missing key must keep meaning "leave unchanged".
 */
export type UpdateWebsitePatch = Partial<
  // The null-clearable fields are OMITTED here and re-added below — an
  // intersection would intersect their property types ((string | undefined) &
  // (string | null) = string) and silently forbid the null again.
  Omit<
    WebsiteConfig,
    'schemaVersion' | 'id' | 'slug' | 'createdAt' | 'contentDigest' | 'lastRefresh' | 'thumbnail' | 'projectId' | 'description' | 'refresh' | 'originSessionId'
  >
> & {
  projectId?: string | null;
  description?: string | null;
  refresh?: WebsiteConfig['refresh'] | null;
};

/** Patch fields where an explicit null means "clear" (see UpdateWebsitePatch) */
const NULL_CLEARABLE_WEBSITE_FIELDS = ['projectId', 'description', 'refresh'] as const;

/**
 * Update a website's config with a partial patch.
 * `id`, `slug`, and the managed fields (`contentDigest`, `lastRefresh`,
 * `thumbnail`) cannot be changed here — use saveWebsiteContent /
 * recordWebsiteRefresh / recordWebsiteThumbnail instead.
 *
 * This is the single normalization point for null-clears — the websites:update
 * RPC and the update_website session tool both pass their patches through
 * verbatim, so "null clears" behaves identically from every caller.
 */
export function updateWebsite(
  workspaceRootPath: string,
  websiteSlug: string,
  patch: UpdateWebsitePatch,
): WebsiteConfig {
  const existing = loadWebsiteConfig(workspaceRootPath, websiteSlug);
  if (!existing) {
    throw new Error(`Website not found: ${websiteSlug}`);
  }

  // Null → PRESENT undefined key: the spread below then overrides the existing
  // value, and the validate-on-write schema sees a valid absent optional.
  // Keys not in the patch stay absent and leave the field unchanged.
  const normalized = { ...patch } as Partial<WebsiteConfig>;
  for (const field of NULL_CLEARABLE_WEBSITE_FIELDS) {
    if (patch[field] === null) (normalized as Record<string, unknown>)[field] = undefined;
  }

  const updated: WebsiteConfig = {
    ...existing,
    ...normalized,
    schemaVersion: existing.schemaVersion,
    id: existing.id,
    slug: existing.slug,
    createdAt: existing.createdAt,
    contentDigest: existing.contentDigest,
    lastRefresh: existing.lastRefresh,
    thumbnail: existing.thumbnail,
    originSessionId: existing.originSessionId,
    updatedAt: Date.now(),
  };

  saveWebsiteConfig(workspaceRootPath, updated);
  return updated;
}

/**
 * Delete a website (removes folder including content and data).
 * `force` rides over mid-tree races (a file vanishing between listing and
 * unlink, Windows EBUSY retries) instead of aborting half-deleted.
 */
export function deleteWebsite(workspaceRootPath: string, websiteSlug: string): void {
  const dir = getWebsitePath(workspaceRootPath, websiteSlug);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Unbind a project from all websites that reference it (project deletion).
 * Mirrors session unbinding. Returns the number of websites touched.
 */
export function unbindProjectFromWebsites(workspaceRootPath: string, projectId: string): number {
  let touched = 0;
  for (const website of loadWorkspaceWebsites(workspaceRootPath)) {
    if (website.config.projectId !== projectId) continue;
    const { projectId: _removed, ...rest } = website.config;
    saveWebsiteConfig(workspaceRootPath, rest);
    touched++;
  }
  return touched;
}

// ============================================================
// Content Operations
// ============================================================

/**
 * Compute the sha256 hex digest of website content.
 * Render leases are bound to this digest.
 */
export function computeWebsiteContentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Load a website's index.html content.
 * Returns null if the file does not exist or cannot be read.
 */
export function loadWebsiteContent(workspaceRootPath: string, websiteSlug: string): string | null {
  if (!isValidWebsiteSlug(websiteSlug)) return null;
  const contentPath = getWebsiteContentPath(workspaceRootPath, websiteSlug);
  if (!existsSync(contentPath)) return null;

  try {
    return readFileSync(contentPath, 'utf-8');
  } catch (error) {
    debug('[loadWebsiteContent] Failed to read website content:', websiteSlug, error);
    return null;
  }
}

/**
 * Save a website's index.html content (atomic) and update contentDigest.
 */
export function saveWebsiteContent(
  workspaceRootPath: string,
  websiteSlug: string,
  content: string,
): WebsiteConfig {
  const existing = loadWebsiteConfig(workspaceRootPath, websiteSlug);
  if (!existing) {
    throw new Error(`Website not found: ${websiteSlug}`);
  }

  atomicWriteFileSync(getWebsiteContentPath(workspaceRootPath, websiteSlug), content);

  const updated: WebsiteConfig = {
    ...existing,
    contentDigest: computeWebsiteContentDigest(content),
    updatedAt: Date.now(),
  };
  saveWebsiteConfig(workspaceRootPath, updated);
  return updated;
}

/**
 * Bring `website.json`'s derived fields back in line with `index.html` on disk.
 *
 * The website's files are the user's (and the agent's) — a website is edited with
 * file tools as often as through the session tools. The digest is not a second
 * copy of the content, it is what makes the content's *consequences* work: the
 * render lease and the cached poster are keyed by it. So an out-of-band edit has
 * to be noticed here, or a poster captured before the edit would keep claiming to
 * be the website's preview.
 *
 * Returns null when the website does not exist. `contentChanged` is true only when
 * the digest actually moved — callers use it to decide whether the poster needs
 * re-rendering (a data-only refresh must not).
 */
export function syncWebsiteContentDigest(
  workspaceRootPath: string,
  websiteSlug: string,
): { config: WebsiteConfig; contentChanged: boolean } | null {
  const existing = loadWebsiteConfig(workspaceRootPath, websiteSlug);
  if (!existing) return null;

  const content = loadWebsiteContent(workspaceRootPath, websiteSlug);
  const digest = content === null ? undefined : computeWebsiteContentDigest(content);
  if (digest === existing.contentDigest) {
    return { config: existing, contentChanged: false };
  }

  const updated: WebsiteConfig = { ...existing, contentDigest: digest, updatedAt: Date.now() };
  saveWebsiteConfig(workspaceRootPath, updated);
  return { config: updated, contentChanged: true };
}

// ============================================================
// Data Operations
// ============================================================

/**
 * Read a website's data/snapshot.json.
 * Returns null when missing or malformed (a refresh may not have run yet).
 */
export function readWebsiteDataSnapshot(
  workspaceRootPath: string,
  websiteSlug: string,
): WebsiteDataSnapshot | null {
  if (!isValidWebsiteSlug(websiteSlug)) return null;
  const snapshotPath = getWebsiteSnapshotPath(workspaceRootPath, websiteSlug);
  if (!existsSync(snapshotPath)) return null;

  try {
    return readJsonFileSync<WebsiteDataSnapshot>(snapshotPath);
  } catch (error) {
    debug('[readWebsiteDataSnapshot] Failed to read snapshot:', websiteSlug, error);
    return null;
  }
}

/**
 * Record the outcome of a refresh run on website.json.
 *
 * This is deliberately the LAST write of a refresh flow: the config watcher
 * reacts to website.json (and only website.json) with a `websites:changed` push, so
 * observers never see a half-written data/ directory as complete.
 */
export function recordWebsiteRefresh(
  workspaceRootPath: string,
  websiteSlug: string,
  status: WebsiteRefreshStatus,
): WebsiteConfig {
  const existing = loadWebsiteConfig(workspaceRootPath, websiteSlug);
  if (!existing) {
    throw new Error(`Website not found: ${websiteSlug}`);
  }

  const updated: WebsiteConfig = {
    ...existing,
    lastRefresh: {
      ...status,
      error: status.error?.slice(0, REFRESH_ERROR_MAX_LENGTH),
    },
    updatedAt: Date.now(),
  };
  saveWebsiteConfig(workspaceRootPath, updated);
  return updated;
}

// ============================================================
// Thumbnail (cached poster)
// ============================================================

/**
 * A cached poster is fresh only when it was captured for the website's CURRENT
 * content digest. Data-only refreshes deliberately do not invalidate it (v1).
 * Single source of truth for the freshness check (RPC + capturer both use it).
 */
export function isThumbnailFresh(
  config: Pick<WebsiteConfig, 'contentDigest' | 'thumbnail'>,
): boolean {
  return (
    config.thumbnail !== undefined &&
    config.contentDigest !== undefined &&
    config.thumbnail.digest === config.contentDigest
  );
}

/**
 * Record (or clear) a website's cached-poster pointer (the managed `thumbnail`
 * field). Written only by the thumbnail capture flow after the .jpg is on disk;
 * stamping website.json last makes the config watcher emit `websites:changed` so open
 * grids pick up the fresh poster. Pass `undefined` to clear (e.g. capture
 * failed or content removed).
 *
 * Written without touching `updatedAt`: the poster is the app's own bookkeeping,
 * and a re-shoot is not a change to the website — a capture (automatic or a
 * manual refresh) must not make the library look edited or reorder it. The
 * capture time travels in `thumbnail.capturedAt` for anyone who needs it.
 */
export function recordWebsiteThumbnail(
  workspaceRootPath: string,
  websiteSlug: string,
  thumbnail: WebsiteThumbnailInfo | undefined,
): WebsiteConfig {
  const existing = loadWebsiteConfig(workspaceRootPath, websiteSlug);
  if (!existing) {
    throw new Error(`Website not found: ${websiteSlug}`);
  }

  const { thumbnail: _previous, ...rest } = existing;
  const updated: WebsiteConfig = {
    ...rest,
    ...(thumbnail ? { thumbnail } : {}),
  };
  saveWebsiteConfig(workspaceRootPath, updated, { touch: false });
  return updated;
}
