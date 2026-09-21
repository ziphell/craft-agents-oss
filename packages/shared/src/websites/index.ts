/**
 * Websites - Public API
 *
 * Workspace-scoped single-file sites: storage/CRUD, refresh-hook matchers, and
 * the mediated source-action bridge.
 *
 * NOT exported here: ./data-store.ts (bun:sqlite) — Bun-only by design, import
 * it via the '@craft-agent/shared/websites/data-store' subpath from Bun scripts.
 */

// Types (core website types re-exported plus storage-layer shapes)
export type {
  WebsiteKind,
  WebsiteScriptRuntime,
  WebsiteRefreshSpec,
  WebsiteRefreshStatus,
  WebsiteSeriesPoint,
  WebsiteDataSnapshot,
  WebsiteActionHttpMethod,
  WebsiteActionDescriptor,
  WebsiteActionGrant,
  WebsiteRenderLease,
  WebsiteActionInvocation,
  WebsiteActionRequest,
  WebsiteActionResult,
  WebsiteShareInfo,
  WebsiteThumbnailInfo,
  WebsiteConfig,
  CreateWebsiteInput,
  LoadedWebsite,
} from './types.ts';
export { isWebsiteGrantUsable } from './types.ts';

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
  // Grants
  addWebsiteGrant,
  revokeWebsiteGrant,
  type AddWebsiteGrantInput,
  // Share state
  setWebsiteShareState,
  // Thumbnail (cached poster)
  recordWebsiteThumbnail,
  isThumbnailFresh,
  // Constants
  WEBSITE_CONFIG_FILENAME,
  WEBSITE_CONTENT_FILENAME,
  WEBSITE_SNAPSHOT_FILENAME,
  WEBSITE_STORE_FILENAME,
  WEBSITE_THUMBNAIL_FILENAME,
  DEFAULT_WEBSITE_GRANT_TTL_MS,
} from './storage.ts';

// Validation
export {
  validateWebsiteConfig,
  WebsiteConfigSchema,
  WebsiteKindSchema,
  WebsiteRefreshSpecSchema,
  WebsiteActionDescriptorSchema,
  WebsiteActionGrantSchema,
  WebsiteShareInfoSchema,
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

// Mediated source-action bridge
export {
  WebsiteActionBroker,
  type WebsiteActionBrokerOptions,
  type WebsiteActionExecutors,
  type WebsiteActionValidationErrorCode,
  type CreateLeaseInput,
} from './action-bridge.ts';

// Sharing (Cloudflare publication)
export {
  buildWebsiteShareBundle,
  getShareSnapshotSizeBytes,
  scanSnapshotForSecretCandidates,
  scanWebsiteShareData,
  type WebsiteShareDataScan,
  websiteShareErrorCode,
  WebsiteShareError,
  WEBSITE_SHARE_MAX_BUNDLE_BYTES,
  WEBSITE_SHARE_MAX_CONTENT_BYTES,
  WEBSITE_SHARE_MAX_SNAPSHOT_BYTES,
  type WebsiteShareErrorCode,
  type WebsitePublicManifest,
  type WebsiteShareBundle,
  type BuildWebsiteShareBundleOptions,
} from './share-bundle.ts';
export {
  WebsitePublisher,
  createCredentialWebsitePublishTokenStore,
  resolveWebsitesShareApiBaseUrl,
  deleteWebsiteWithUnpublish,
  DEFAULT_PAGES_SHARE_API_BASE_URL,
  type WebsitePublisherOptions,
  type WebsitePublishTokenStore,
  type PublishWebsiteOptions,
  type UnpublishResult,
  type DeleteWebsiteOutcome,
} from './publisher.ts';
