/**
 * Design Types (shared layer)
 *
 * The domain/protocol types live in @craft-agent/core (renderer-safe); this
 * module re-exports them and adds the storage-layer shapes that carry
 * absolute paths or creation inputs.
 *
 * File structure: see the docblock in @craft-agent/core types/design.ts.
 */

import type { DesignActionGrant, DesignConfig, DesignDeckAspect, DesignDeckSpec, DesignKind, DesignMotionSpec, DesignRefreshSpec } from '@craft-agent/core';

// Re-export the core design types so consumers can import everything from
// '@craft-agent/shared/designs' (mirrors how sources/projects expose types).
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
} from '@craft-agent/core';

/**
 * Whether a grant is currently usable: bound to the given content digest and
 * not expired. The single definition of "usable"/"stale" — the render frame,
 * the publish ack requirement, and the get_design stale flag must all agree.
 * Pure and browser-safe (this module is imported by the renderer).
 */
export function isDesignGrantUsable(
  grant: Pick<DesignActionGrant, 'contentDigest' | 'expiresAt'>,
  contentDigest: string | undefined,
  now: number,
): boolean {
  return contentDigest !== undefined && grant.contentDigest === contentDigest && grant.expiresAt > now;
}

/**
 * Whether a request path contains a directory-traversal segment. Design API
 * invocations are matched against an anchored grant pattern and then handed to
 * fetch, which normalizes `..` — so a grant for `/repos/.*` could otherwise be
 * abused to reach `/repos/../../admin`. Reject such paths before the match so
 * match and execution can never disagree. Decodes one percent-layer first so
 * encoded forms (`%2e%2e`, `..%2f`) are caught too; a malformed encoding is
 * treated as unsafe. Pure and browser-safe — the server-side DesignActionBroker
 * (authoritative) and the renderer design-bridge (defense-in-depth) both call it.
 */
export function hasPathTraversal(path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true; // malformed percent-encoding — treat as unsafe
  }
  return decoded.split(/[/\\]/).includes('..');
}

/**
 * Design creation input (without auto-generated fields)
 */
export interface CreateDesignInput {
  name: string;
  description?: string;
  /** What the design is (default: prototype); `deck`/`motion` settings imply it. */
  kind?: DesignKind;
  /** Stable Project ID to bind this design to */
  projectId?: string;
  /** Initial index.html content (sets contentDigest when provided) */
  content?: string;
  refresh?: DesignRefreshSpec;
  /** Deck presentation hint (present = this design is a deck) */
  deck?: DesignDeckSpec;
  /** Motion composition hint (present = this design renders to video) */
  motion?: DesignMotionSpec;
}

/**
 * Fully loaded design (config + folder paths)
 */
export interface LoadedDesign {
  config: DesignConfig;
  /** Absolute path to the design folder */
  folderPath: string;
  /** Absolute path to index.html (may not exist yet) */
  contentPath: string;
  /** Absolute path to the data/ folder */
  dataPath: string;
  /** Absolute path to data/snapshot.json (may not exist yet) */
  snapshotPath: string;
  /** Absolute path to workspace folder */
  workspaceRootPath: string;
  /**
   * The workspace FOLDER the design lives in (basename of workspaceRootPath) —
   * a label, not a workspace id. It does not resolve through
   * `getWorkspaceByNameOrId`, so never pass it to a workspace-scoped call: the
   * folder the app creates is a slug of the workspace name ("My Workspace"
   * lives in `my-workspace`). Use the screen's own active workspace id.
   */
  workspaceId: string;
}

/**
 * A design export format.
 *
 * `pptx` produces editable slides (real shapes/text) from the rendered DOM via
 * the vendored `dom-to-pptx` engine, so it shares the engine-backed path with
 * PDF/PNG rather than the file-only one. Markdown (an external CLI) is still
 * deliberately out of scope; it would join this union when added.
 * `video` renders a `motion` composition's own timeline to an MP4.
 */
export type DesignExportFormat = 'pdf' | 'png' | 'html' | 'zip' | 'video' | 'pptx';

/**
 * Motion settings resolved from a `DesignMotionSpec` (defaults applied,
 * values clamped). Passing the resolved numbers to the renderer keeps the
 * "what the config asked for" decision in one pure place (see export.ts).
 */
export interface DesignMotionSettings {
  fps: number;
  durationMs: number;
  aspect: DesignDeckAspect;
}

/** Outcome of a design export. */
export interface DesignExportResult {
  /** The person dismissed the picker — nothing was written. */
  canceled: boolean;
  /** Absolute paths written: one file, or many for the per-slide PNGs. */
  paths: string[];
}

/**
 * Request handed to a host's own renderer for the formats that need a real
 * engine (PDF, per-slide PNG, motion video, editable PPTX). The hidden-window
 * renderer lives in Electron main and is reached through the injected
 * `designExportRender` seam, so a headless/WebUI host simply has no
 * implementation and those formats are unavailable there.
 */
export interface DesignRenderExportRequest {
  format: 'pdf' | 'png' | 'video' | 'pptx';
  workspaceRootPath: string;
  slug: string;
  /** Destination file (`pdf`, `video`, `pptx`) or folder (`png`). */
  destPath: string;
  /** Deck aspect, when the design is a deck (drives paper size / slide framing). */
  aspect?: DesignDeckAspect;
  /** Motion settings, when `format` is `video` (resolved fps / duration). */
  motion?: DesignMotionSettings;
}
