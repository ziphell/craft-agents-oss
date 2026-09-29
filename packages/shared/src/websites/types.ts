/**
 * Website Types (shared layer)
 *
 * The domain/protocol types live in @craft-agent/core (renderer-safe); this
 * module re-exports them and adds the storage-layer shapes that carry
 * absolute paths or creation inputs.
 *
 * File structure: see the docblock in @craft-agent/core types/website.ts.
 */

import type { WebsiteConfig, WebsiteRefreshSpec } from '@craft-agent/core';

// Re-export the core website types so consumers can import everything from
// '@craft-agent/shared/websites' (mirrors how sources/projects expose types).
export type {
  WebsiteScriptRuntime,
  WebsiteRefreshSpec,
  WebsiteRefreshStatus,
  WebsiteSeriesPoint,
  WebsiteDataSnapshot,
  WebsiteThumbnailInfo,
  WebsiteConfig,
} from '@craft-agent/core';

/**
 * Website creation input (without auto-generated fields)
 */
export interface CreateWebsiteInput {
  name: string;
  description?: string;
  /** Stable Project ID to bind this website to */
  projectId?: string;
  /** The conversation that asked for this website (weak reference, set at create) */
  originSessionId?: string;
  /** Initial index.html content (sets contentDigest when provided) */
  content?: string;
  refresh?: WebsiteRefreshSpec;
}

/**
 * Fully loaded website (config + folder paths)
 *
 * No workspace id here on purpose: a website is addressed as
 * `(workspaceId, slug)` and the workspace is the caller's to name — the path
 * this record carries is the workspace root, not an identifier for it.
 */
export interface LoadedWebsite {
  config: WebsiteConfig;
  /** Absolute path to the website folder */
  folderPath: string;
  /** Absolute path to index.html (may not exist yet) */
  contentPath: string;
  /** Absolute path to the data/ folder */
  dataPath: string;
  /** Absolute path to data/snapshot.json (may not exist yet) */
  snapshotPath: string;
  /** Absolute path to workspace folder */
  workspaceRootPath: string;
}
