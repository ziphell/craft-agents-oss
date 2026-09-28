/**
 * Websites - Public API
 *
 * Workspace-scoped sites: storage/CRUD, refresh-hook matchers, and what their own
 * origin serves (`./host.ts`).
 *
 * NOT exported here: ./data-store.ts (bun:sqlite) — Bun-only by design, import
 * it via the '@craft-agent/shared/websites/data-store' subpath from Bun scripts.
 */

// Types (core website types re-exported plus storage-layer shapes)
export type {
  WebsiteScriptRuntime,
  WebsiteRefreshSpec,
  WebsiteRefreshStatus,
  WebsiteSeriesPoint,
  WebsiteDataSnapshot,
  WebsiteThumbnailInfo,
  WebsiteConfig,
  CreateWebsiteInput,
  LoadedWebsite,
} from './types.ts';

// Storage
export {
  // Path utilities
  getWorkspaceWebsitesPath,
  getWebsitePath,
  getWebsiteConfigPath,
  getWebsiteContentPath,
  getWebsiteDataPath,
  getWebsiteSnapshotPath,
  getWebsiteStorePath,
  getWebsiteThumbnailPath,
  ensureWebsitesDir,
  ensureWebsiteDataDir,
  // Config operations
  loadWebsiteConfig,
  saveWebsiteConfig,
  loadWebsite,
  loadWebsiteById,
  loadWorkspaceWebsites,
  websiteExists,
  // Create/update/delete
  generateWebsiteSlug,
  createWebsite,
  updateWebsite,
  type UpdateWebsitePatch,
  deleteWebsite,
  unbindProjectFromWebsites,
  // Content
  computeWebsiteContentDigest,
  loadWebsiteContent,
  saveWebsiteContent,
  syncWebsiteContentDigest,
  // Data
  readWebsiteDataSnapshot,
  recordWebsiteRefresh,
  // Thumbnail (cached poster)
  recordWebsiteThumbnail,
  isThumbnailFresh,
  // Constants
  WEBSITE_CONFIG_FILENAME,
  WEBSITE_CONTENT_FILENAME,
  WEBSITE_SNAPSHOT_FILENAME,
  WEBSITE_STORE_FILENAME,
  WEBSITE_THUMBNAIL_FILENAME,
} from './storage.ts';

// Validation
export {
  validateWebsiteConfig,
  WebsiteConfigSchema,
  WebsiteRefreshSpecSchema,
  WebsiteThumbnailInfoSchema,
  WEBSITE_SLUG_REGEX,
  WEBSITE_REFRESH_MIN_INTERVAL_MS,
  isValidWebsiteSlug,
  assertValidWebsiteSlug,
  InvalidWebsiteSlugError,
} from './validation.ts';

// Refresh hook (synthetic cron matchers)
export {
  buildWebsiteRefreshMatchers,
  websiteRefreshMatcherId,
  isWebsiteRefreshMatcherId,
  WEBSITE_REFRESH_MATCHER_PREFIX,
} from './refresh.ts';

// Data writes (Node-safe: the SQLite work happens in a spawned Bun one-shot)
export {
  applyWebsiteDataPatch,
  writeWebsiteData,
  validateWebsiteDataPatch,
  buildWebsiteDataWriterScript,
  WEBSITE_DATA_PATCH_MAX_BYTES,
  type WebsiteDataPatch,
  type WebsiteDataWriteResult,
} from './data-write.ts';
export {
  DEFAULT_SNAPSHOT_MAX_POINTS_PER_SERIES,
  WEBSITE_DATA_MAX_KV_KEYS,
  WEBSITE_DATA_MAX_SERIES,
} from './data-store-constants.ts';

// What a website's own origin serves
export {
  resolveWebsiteRequest,
  isWebsiteHostOwned,
  WEBSITE_INDEX_FILE,
  type ServedWebsite,
  type WebsiteResolution,
} from './host.ts';

// Handing one to someone else: the directory is the artifact
export {
  buildWebsiteExportReadme,
  EXPORT_README_FILENAME,
  exportWebsite,
  isWebsiteExportPath,
  listWebsiteExportFiles,
  type WebsiteExportResult,
} from './export.ts';
