/**
 * Website Share Bundle
 *
 * Builds the sanitized public bundle for Cloudflare publication. The bundle is
 * constructed field-by-field — never by spreading WebsiteConfig — so local-only
 * state (grants, refresh spec/script paths, store.sqlite, credential ids,
 * lastRefresh errors, project ids) cannot leak into the public copy by
 * accident. What ships is exactly:
 *
 *   - a public manifest (slug, title, description, kind, contentDigest)
 *   - the website's index.html content string
 *   - optionally the current data/snapshot.json (explicit opt-in, default off)
 *
 * "Sanitized" means field-allowlisted — index.html itself ships byte-for-byte,
 * NOT sanitized: XSS/egress containment for the public copy is the Worker's
 * CSP + iframe sandbox, never a transform here.
 *
 * A website with approved source-action grants publishes as a view-only copy:
 * the public shell answers bridge `action` messages with a disabled error and
 * never brokers into the publisher's local sources. Publishing such a website
 * requires an explicit acknowledgment flag.
 *
 * Script-action grants (host command execution) are the exception: such a website
 * cannot be published at all, even as an inert view-only copy. A host-exec
 * capability must never be associated with a public URL — we fail loud rather
 * than silently strip the grant.
 */

import { existsSync, readFileSync } from 'fs';
import type { WebsiteKind } from '@craft-agent/core';
import { isWebsiteGrantUsable } from './types.ts';
import { isSensitiveKeyName } from '../utils/redaction.ts';
import {
  computeWebsiteContentDigest,
  getWebsiteSnapshotPath,
  loadWebsiteConfig,
  loadWebsiteContent,
} from './storage.ts';

/** Hard cap on the total published bundle (content + snapshot + manifest) */
export const WEBSITE_SHARE_MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
/** Hard cap on published index.html */
export const WEBSITE_SHARE_MAX_CONTENT_BYTES = 5 * 1024 * 1024;
/** Hard cap on the published data snapshot */
export const WEBSITE_SHARE_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export type WebsiteShareErrorCode =
  | 'WEBSITE_NOT_FOUND'
  | 'WEBSITE_NO_CONTENT'
  | 'WEBSITE_SHARE_TOO_LARGE'
  | 'WEBSITE_SHARE_SNAPSHOT_INVALID'
  | 'WEBSITE_SHARE_ACTIONS_ACK_REQUIRED'
  | 'WEBSITE_SHARE_SCRIPT_GRANT'
  | 'WEBSITE_SHARING_DISABLED'
  | 'WEBSITE_SHARE_TOKEN_MISSING'
  | 'WEBSITE_SHARE_ALREADY_PUBLISHED'
  | 'WEBSITE_SHARE_NOT_PUBLISHED'
  | 'WEBSITE_SHARE_REMOTE_ERROR'
  | 'WEBSITE_SHARE_VAULT_ERROR';

/** Typed error for the publish pipeline (code survives transport as message prefix) */
export class WebsiteShareError extends Error {
  constructor(
    public readonly code: WebsiteShareErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'WebsiteShareError';
  }
}

/**
 * Sanitized manifest shipped inside the public bundle. Built exclusively from
 * the allowlisted fields below — extending it must stay a conscious decision.
 */
export interface WebsitePublicManifest {
  version: 1;
  slug: string;
  title: string;
  description?: string;
  kind: WebsiteKind;
  /** sha256 hex of the published index.html */
  contentDigest: string;
  includesData: boolean;
}

export interface WebsiteShareBundle {
  manifest: WebsitePublicManifest;
  /** Exact index.html string being published */
  content: string;
  /** Serialized snapshot JSON (present only when opted in and available) */
  snapshotJson?: string;
  /** sha256 hex of `content` (same digest family as WebsiteConfig.contentDigest) */
  contentDigest: string;
  totalBytes: number;
}

export interface BuildWebsiteShareBundleOptions {
  /** Publish the current data/snapshot.json alongside the HTML (default: false) */
  includeData: boolean;
  /**
   * Required when the website has approved source-action grants: the caller
   * confirms the user understands the public copy is view-only.
   */
  viewOnlyAcknowledged?: boolean;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf-8');
}

/** Human-readable size for user-facing limit errors ("2.3 MB"). */
function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/**
 * Build the sanitized public bundle for a website, enforcing exclusion and size
 * invariants. Throws WebsiteShareError on any violation.
 */
export function buildWebsiteShareBundle(
  workspaceRootPath: string,
  websiteSlug: string,
  options: BuildWebsiteShareBundleOptions,
): WebsiteShareBundle {
  const config = loadWebsiteConfig(workspaceRootPath, websiteSlug);
  if (!config) {
    throw new WebsiteShareError('WEBSITE_NOT_FOUND', `Website not found: ${websiteSlug}`);
  }

  const content = loadWebsiteContent(workspaceRootPath, websiteSlug);
  if (content === null) {
    throw new WebsiteShareError('WEBSITE_NO_CONTENT', `Website has no content to publish: ${websiteSlug}`);
  }

  // Host command execution must never reach a public URL — refuse outright,
  // ahead of the softer view-only acknowledgment path below.
  if (config.grants?.some((grant) => grant.action.kind === 'script')) {
    throw new WebsiteShareError(
      'WEBSITE_SHARE_SCRIPT_GRANT',
      'This website has permission to run a script on this computer, so it cannot be published — not even as a view-only copy.',
    );
  }

  // The ack explains a behavior difference: action buttons work locally but
  // not on the public copy. Stale/expired grants don't work locally either,
  // so only usable grants require it. (Script grants were refused above —
  // that check deliberately counts stale ones too.)
  const now = Date.now();
  const hasUsableGrants = (config.grants ?? []).some((grant) =>
    isWebsiteGrantUsable(grant, config.contentDigest, now),
  );
  if (hasUsableGrants && options.viewOnlyAcknowledged !== true) {
    throw new WebsiteShareError(
      'WEBSITE_SHARE_ACTIONS_ACK_REQUIRED',
      'This website has approved actions. Publishing needs confirmation that the public copy is view-only.',
    );
  }

  const contentBytes = byteLength(content);
  if (contentBytes > WEBSITE_SHARE_MAX_CONTENT_BYTES) {
    throw new WebsiteShareError(
      'WEBSITE_SHARE_TOO_LARGE',
      `The website content is too large to publish (${formatMb(contentBytes)}, limit ${formatMb(WEBSITE_SHARE_MAX_CONTENT_BYTES)}).`,
    );
  }

  let snapshotJson: string | undefined;
  if (options.includeData) {
    const snapshotPath = getWebsiteSnapshotPath(workspaceRootPath, websiteSlug);
    if (existsSync(snapshotPath)) {
      const raw = readFileSync(snapshotPath, 'utf-8');
      try {
        JSON.parse(raw);
      } catch {
        throw new WebsiteShareError(
          'WEBSITE_SHARE_SNAPSHOT_INVALID',
          "The website's data snapshot is damaged. Refresh the website's data, then publish again.",
        );
      }
      const snapshotBytes = byteLength(raw);
      if (snapshotBytes > WEBSITE_SHARE_MAX_SNAPSHOT_BYTES) {
        throw new WebsiteShareError(
          'WEBSITE_SHARE_TOO_LARGE',
          `The website's data is too large to publish (${formatMb(snapshotBytes)}, limit ${formatMb(WEBSITE_SHARE_MAX_SNAPSHOT_BYTES)}).`,
        );
      }
      snapshotJson = raw;
    }
  }

  const contentDigest = computeWebsiteContentDigest(content);
  const manifest: WebsitePublicManifest = {
    version: 1,
    slug: config.slug,
    title: config.name,
    ...(config.description ? { description: config.description } : {}),
    kind: config.kind,
    contentDigest,
    includesData: snapshotJson !== undefined,
  };

  const totalBytes =
    contentBytes + (snapshotJson ? byteLength(snapshotJson) : 0) + byteLength(JSON.stringify(manifest));
  if (totalBytes > WEBSITE_SHARE_MAX_BUNDLE_BYTES) {
    throw new WebsiteShareError(
      'WEBSITE_SHARE_TOO_LARGE',
      `The website and its data together are too large to publish (${formatMb(totalBytes)}, limit ${formatMb(WEBSITE_SHARE_MAX_BUNDLE_BYTES)}).`,
    );
  }

  return { manifest, content, snapshotJson, contentDigest, totalBytes };
}

/** Estimate the publishable snapshot size for UI display (null = no snapshot on disk) */
export function getShareSnapshotSizeBytes(workspaceRootPath: string, websiteSlug: string): number | null {
  const snapshotPath = getWebsiteSnapshotPath(workspaceRootPath, websiteSlug);
  if (!existsSync(snapshotPath)) return null;
  try {
    return byteLength(readFileSync(snapshotPath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Cap on reported secret-candidate paths (the UI shows a few + a count) */
const MAX_SECRET_CANDIDATES = 20;
const SECRET_SCAN_MAX_DEPTH = 8;

/**
 * Best-effort scan of a snapshot for values that LOOK like secrets, by key
 * name only (same deliberately-broad heuristic as redaction.ts — one source
 * of truth, over-flagging is fine for a warning). Walks `kv` keys and nested
 * object keys plus series names. Returns unique dot-paths, capped. Never
 * throws — a malformed snapshot simply reports no candidates (the publish
 * path itself rejects malformed snapshots separately).
 */
export function scanSnapshotForSecretCandidates(snapshotJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];

  const found = new Set<string>();
  const seen = new WeakSet<object>();

  const visit = (node: unknown, path: string, depth: number): void => {
    if (found.size >= MAX_SECRET_CANDIDATES) return;
    if (!node || typeof node !== 'object' || depth >= SECRET_SCAN_MAX_DEPTH) return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      // Array items keep the parent path — indices are noise in a warning.
      for (const item of node) visit(item, path, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const keyPath = path ? `${path}.${key}` : key;
      if (isSensitiveKeyName(key)) {
        found.add(keyPath);
        if (found.size >= MAX_SECRET_CANDIDATES) return;
      }
      visit(value, keyPath, depth + 1);
    }
  };

  const root = parsed as { kv?: unknown; series?: unknown };
  if (root.kv && typeof root.kv === 'object') visit(root.kv, 'kv', 1);
  if (root.series && typeof root.series === 'object' && !Array.isArray(root.series)) {
    for (const name of Object.keys(root.series)) {
      if (found.size >= MAX_SECRET_CANDIDATES) break;
      if (isSensitiveKeyName(name)) found.add(`series.${name}`);
    }
  }
  return [...found];
}

export interface WebsiteShareDataScan {
  /** Byte size of the snapshot that would publish, or null when none exists */
  snapshotBytes: number | null;
  /** Key paths in the snapshot that look credential-bearing (capped) */
  secretCandidates: string[];
}

/**
 * One-read convenience for the Share dialog: what would `includeData` publish,
 * and does any of it look like a secret?
 */
export function scanWebsiteShareData(workspaceRootPath: string, websiteSlug: string): WebsiteShareDataScan {
  const snapshotPath = getWebsiteSnapshotPath(workspaceRootPath, websiteSlug);
  if (!existsSync(snapshotPath)) return { snapshotBytes: null, secretCandidates: [] };
  let raw: string;
  try {
    raw = readFileSync(snapshotPath, 'utf-8');
  } catch {
    return { snapshotBytes: null, secretCandidates: [] };
  }
  return { snapshotBytes: byteLength(raw), secretCandidates: scanSnapshotForSecretCandidates(raw) };
}

/** Extract a WebsiteShareErrorCode from any thrown value (transport-safe) */
export function websiteShareErrorCode(err: unknown): WebsiteShareErrorCode | null {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const match = message.match(/^(WEBSITE_[A-Z_]+):/);
  return match ? (match[1] as WebsiteShareErrorCode) : null;
}
