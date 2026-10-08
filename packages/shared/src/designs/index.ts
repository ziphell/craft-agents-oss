/**
 * Designs - Public API
 *
 * Workspace-scoped mini dashboards: storage/CRUD, refresh-hook matchers, and
 * the mediated source-action bridge.
 *
 * NOT exported here: ./data-store.ts (bun:sqlite) — Bun-only by design, import
 * it via the '@craft-agent/shared/designs/data-store' subpath from Bun scripts.
 */

// Types (core design types re-exported plus storage-layer shapes)
export type {
  DesignKind,
  DesignScriptRuntime,
  DesignRefreshSpec,
  DesignRefreshStatus,
  DesignSeriesPoint,
  DesignDataSnapshot,
  DesignActionHttpMethod,
  DesignActionDescriptor,
  DesignActionGrant,
  DesignRenderLease,
  DesignActionInvocation,
  DesignActionRequest,
  DesignActionResult,
  DesignShareInfo,
  DesignThumbnailInfo,
  DesignConfig,
  DesignDeckAspect,
  DesignDeckSpec,
  DesignMotionSpec,
  CreateDesignInput,
  LoadedDesign,
  DesignExportFormat,
  DesignExportResult,
  DesignMotionSettings,
  DesignRenderExportRequest,
} from './types.ts';
export { isDesignGrantUsable } from './types.ts';
export { DESIGN_FRAME_SANDBOX } from './sandbox.ts';
export {
  designPreviewLabel,
  designPreviewUrl,
  designDirForLabel,
} from './preview.ts';
export {
  DESIGN_KINDS,
  isDesignKind,
  kindFromSettings,
  migrateDesignKind,
  resolveDesignKindState,
  type DesignKindMigration,
  type DesignKindState,
  type ResolveDesignKindInput,
} from './kind.ts';

// Storage
export {
  // Path utilities
  getWorkspaceDesignsPath,
  getDesignPath,
  getDesignConfigPath,
  getDesignConfigRelativePath,
  getDesignContentPath,
  getDesignDataPath,
  getDesignSnapshotPath,
  getDesignStorePath,
  getDesignThumbnailPath,
  ensureDesignsDir,
  ensureDesignDataDir,
  // Config operations
  loadDesignConfig,
  saveDesignConfig,
  loadDesign,
  loadDesignById,
  loadWorkspaceDesigns,
  loadProjectDesigns,
  designExists,
  // Create/update/delete
  generateDesignSlug,
  createDesign,
  updateDesign,
  type UpdateDesignPatch,
  deleteDesign,
  unbindProjectFromDesigns,
  // Content
  computeDesignContentDigest,
  loadDesignContent,
  saveDesignContent,
  // Data
  readDesignDataSnapshot,
  recordDesignRefresh,
  // Grants
  addDesignGrant,
  revokeDesignGrant,
  type AddDesignGrantInput,
  // Share state
  setDesignShareState,
  // Thumbnail (cached poster)
  recordDesignThumbnail,
  isThumbnailFresh,
  // Constants
  DESIGN_CONFIG_FILENAME,
  DESIGN_CONTENT_FILENAME,
  DESIGN_SNAPSHOT_FILENAME,
  DESIGN_STORE_FILENAME,
  DESIGN_THUMBNAIL_FILENAME,
  DEFAULT_DESIGN_GRANT_TTL_MS,
} from './storage.ts';

// Validation
export {
  validateDesignConfig,
  DesignConfigSchema,
  DesignKindSchema,
  DesignRefreshSpecSchema,
  DesignActionDescriptorSchema,
  DesignActionGrantSchema,
  DesignShareInfoSchema,
  DesignThumbnailInfoSchema,
  DesignDeckAspectSchema,
  DesignDeckSpecSchema,
  DesignMotionSpecSchema,
  MOTION_FPS_MIN,
  MOTION_FPS_MAX,
  MOTION_DURATION_MS_MIN,
  MOTION_DURATION_MS_MAX,
  DESIGN_SLUG_REGEX,
  DESIGN_REFRESH_MIN_INTERVAL_MS,
  isValidDesignSlug,
  assertValidDesignSlug,
  InvalidDesignSlugError,
} from './validation.ts';

// Refresh hook (synthetic cron matchers)
export {
  buildDesignRefreshMatchers,
  designRefreshMatcherId,
  isDesignRefreshMatcherId,
  DESIGN_REFRESH_MATCHER_PREFIX,
} from './refresh.ts';

// Export — HTML/ZIP are written here; PDF/PNG/PPTX come from the host's own renderer
export {
  writeDesignHtmlExport,
  writeDesignZipExport,
  createZipArchive,
  crc32,
  designExportFileName,
  designExportFilters,
  deckSlideSize,
  deckPageSizeInches,
  buildActivateDeckSlideScript,
  buildShowAllDeckSlidesScript,
  buildParkArtboardScript,
  buildShowAllArtboardsScript,
  buildExportPptxScript,
  DECK_SLIDE_SELECTOR,
  DESIGN_PAGE_SELECTOR,
  ARTBOARD_SELECTOR,
  COUNT_DECK_SLIDES_SCRIPT,
  COUNT_ARTBOARDS_SCRIPT,
  DEFAULT_DECK_ASPECT,
  MAX_DECK_SLIDES,
  resolveMotionSettings,
  motionFrameCount,
  designMotionFileName,
  designMotionFilters,
  DEFAULT_MOTION_FPS,
  DEFAULT_MOTION_DURATION_MS,
} from './export.ts';

// Data writes (Node-safe: the SQLite work happens in a spawned Bun one-shot)
export {
  applyDesignDataPatch,
  writeDesignData,
  validateDesignDataPatch,
  buildDesignDataWriterScript,
  DESIGN_DATA_PATCH_MAX_BYTES,
  type DesignDataPatch,
  type DesignDataWriteResult,
} from './data-write.ts';
export {
  DEFAULT_SNAPSHOT_MAX_POINTS_PER_SERIES,
  DESIGN_DATA_MAX_KV_KEYS,
  DESIGN_DATA_MAX_SERIES,
} from './data-store-constants.ts';

// Mediated source-action bridge
export {
  DesignActionBroker,
  type DesignActionBrokerOptions,
  type DesignActionExecutors,
  type DesignActionValidationErrorCode,
  type CreateLeaseInput,
} from './action-bridge.ts';

// Sharing (Cloudflare publication)
export {
  buildDesignShareBundle,
  getShareSnapshotSizeBytes,
  scanSnapshotForSecretCandidates,
  scanDesignShareData,
  type DesignShareDataScan,
  designShareErrorCode,
  DesignShareError,
  DESIGN_SHARE_MAX_BUNDLE_BYTES,
  DESIGN_SHARE_MAX_CONTENT_BYTES,
  DESIGN_SHARE_MAX_SNAPSHOT_BYTES,
  type DesignShareErrorCode,
  type DesignPublicManifest,
  type DesignShareBundle,
  type BuildDesignShareBundleOptions,
} from './share-bundle.ts';
export {
  DesignPublisher,
  createCredentialDesignPublishTokenStore,
  resolveDesignsShareApiBaseUrl,
  deleteDesignWithUnpublish,
  DEFAULT_PAGES_SHARE_API_BASE_URL,
  type DesignPublisherOptions,
  type DesignPublishTokenStore,
  type PublishDesignOptions,
  type UnpublishResult,
  type DeleteDesignOutcome,
} from './publisher.ts';
