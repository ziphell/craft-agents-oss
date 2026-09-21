/**
 * Website Publisher
 *
 * Client for the Cloudflare websites-share Worker (workers/websites). Owns the
 * local half of the publish/update/unpublish flow:
 *
 *   publish    → POST bundle → store admin token in the credential vault →
 *                write the local share pointer (website.json, atomic)
 *   republish  → PUT new revision with the vault token
 *   password   → PUT metadata-only change (set/clear) with the vault token
 *   unpublish  → DELETE with the vault token → clear pointer + vault entry
 *
 * Trust boundaries:
 *   - The admin token is a 256-bit capability minted by the Worker and
 *     returned exactly once; it lives only in the credential vault under
 *     `website_publish_token::{workspaceId}::{websiteId}` and in the Authorization
 *     header of update/delete requests. It is never written to website.json,
 *     logs, or errors.
 *   - The password is forwarded once over HTTPS on set and never persisted,
 *     logged, or echoed back.
 *   - If the vault write fails right after a create, the remote publication
 *     is deleted immediately so no unmanageable public copy is left behind.
 *
 * Feature gating: publish/republish/password check `isWebsitesSharingEnabled()`;
 * unpublish deliberately does not, so disabling the flag never strands a
 * published website (design §12).
 */

import type { WebsiteConfig, WebsiteShareInfo } from '@craft-agent/core';
import { isWebsitesSharingEnabled } from '../feature-flags.ts';
import { deleteWebsite, loadWebsiteConfig, setWebsiteShareState } from './storage.ts';
import { buildWebsiteShareBundle, WebsiteShareError } from './share-bundle.ts';

/** Default publication API base (the agents-router forwards /p/* to the Worker) */
export const DEFAULT_PAGES_SHARE_API_BASE_URL = 'https://thecraftagents.com/p/api';

/**
 * Resolve the publication API base URL. `CRAFT_WEBSITES_SHARE_API_URL` overrides
 * for local Worker development (e.g. http://localhost:8787/p/api).
 */
export function resolveWebsitesShareApiBaseUrl(): string {
  const override =
    typeof process !== 'undefined' ? process.env?.CRAFT_WEBSITES_SHARE_API_URL : undefined;
  const base = override?.trim() || DEFAULT_PAGES_SHARE_API_BASE_URL;
  return base.replace(/\/+$/, '');
}

/** Minimal vault seam so tests can run without the real CredentialManager */
export interface WebsitePublishTokenStore {
  get(workspaceId: string, websiteId: string): Promise<string | null>;
  set(workspaceId: string, websiteId: string, token: string): Promise<void>;
  delete(workspaceId: string, websiteId: string): Promise<boolean>;
}

/**
 * Production token store backed by the encrypted credential vault
 * (`website_publish_token::{workspaceId}::{websiteId}`).
 */
export function createCredentialWebsitePublishTokenStore(): WebsitePublishTokenStore {
  const credentialId = (workspaceId: string, websiteId: string) =>
    ({ type: 'website_publish_token', workspaceId, name: websiteId }) as const;
  return {
    async get(workspaceId, websiteId) {
      const { getCredentialManager } = await import('../credentials/index.ts');
      const stored = await getCredentialManager().get(credentialId(workspaceId, websiteId));
      return stored?.value ?? null;
    },
    async set(workspaceId, websiteId, token) {
      const { getCredentialManager } = await import('../credentials/index.ts');
      await getCredentialManager().set(credentialId(workspaceId, websiteId), { value: token });
    },
    async delete(workspaceId, websiteId) {
      const { getCredentialManager } = await import('../credentials/index.ts');
      return getCredentialManager().delete(credentialId(workspaceId, websiteId));
    },
  };
}

export interface WebsitePublisherOptions {
  tokenStore: WebsitePublishTokenStore;
  /** Injectable for tests (defaults to global fetch) */
  fetchFn?: typeof fetch;
  /** Publication API base, e.g. https://thecraftagents.com/p/api */
  apiBaseUrl?: string;
  log?: (message: string) => void;
}

export interface PublishWebsiteOptions {
  /** Publish the current data snapshot alongside the HTML (default false) */
  includeData: boolean;
  /** Optional viewer password, applied at create time only */
  password?: string;
  /** Required when the website has approved source-action grants */
  viewOnlyAcknowledged?: boolean;
}

export interface UnpublishResult {
  config: WebsiteConfig;
  /**
   * Set when local state was cleared without remote confirmation (vault token
   * missing) — the public copy may still exist until it is garbage-collected.
   */
  warning?: 'remote-copy-may-remain';
}

interface WorkerPublicationResponse {
  id: string;
  url: string;
  revision: string;
  adminToken?: string;
  passwordProtected: boolean;
  status: 'published' | 'unpublished';
  updatedAt: number;
}

const ERROR_BODY_MAX_CHARS = 300;

export class WebsitePublisher {
  private readonly tokenStore: WebsitePublishTokenStore;
  private readonly fetchFn: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly log: (message: string) => void;

  constructor(options: WebsitePublisherOptions) {
    this.tokenStore = options.tokenStore;
    this.fetchFn = options.fetchFn ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? resolveWebsitesShareApiBaseUrl()).replace(/\/+$/, '');
    this.log = options.log ?? (() => {});
  }

  /**
   * Publish a website: create a new publication, or upload a new revision when
   * one already exists. Returns the updated WebsiteConfig (share pointer set).
   */
  async publish(
    workspaceRootPath: string,
    workspaceId: string,
    websiteSlug: string,
    options: PublishWebsiteOptions,
  ): Promise<WebsiteConfig> {
    this.assertSharingEnabled();

    const config = this.requireWebsite(workspaceRootPath, websiteSlug);
    const bundle = buildWebsiteShareBundle(workspaceRootPath, websiteSlug, {
      includeData: options.includeData,
      viewOnlyAcknowledged: options.viewOnlyAcknowledged,
    });

    const existingShare = config.share;
    if (existingShare) {
      const token = await this.tokenStore.get(workspaceId, config.id);
      if (!token) {
        throw new WebsiteShareError(
          'WEBSITE_SHARE_TOKEN_MISSING',
          'The key for managing this website\'s public copy is missing from secure storage. Unpublish the website, then publish it again.',
        );
      }
      return this.uploadRevision(workspaceRootPath, websiteSlug, config, existingShare, token, bundle);
    }

    // Create a fresh publication
    const form = new FormData();
    form.set('manifest', JSON.stringify(bundle.manifest));
    form.set('content', new Blob([bundle.content], { type: 'text/html' }), 'index.html');
    if (bundle.snapshotJson !== undefined) {
      form.set('snapshot', new Blob([bundle.snapshotJson], { type: 'application/json' }), 'snapshot.json');
    }
    if (options.password) form.set('password', options.password);

    const response = await this.request('POST', '/publications', { body: form });
    const dto = await this.parsePublication(response, 201);
    if (!dto.adminToken) {
      throw new WebsiteShareError('WEBSITE_SHARE_REMOTE_ERROR', 'Create response did not include an admin token');
    }

    // Vault write MUST succeed before we acknowledge the publication locally;
    // otherwise delete the remote copy so it never becomes unmanageable.
    try {
      await this.tokenStore.set(workspaceId, config.id, dto.adminToken);
    } catch (err) {
      this.log(`Vault write failed after publication create; rolling back remote ${dto.id}`);
      try {
        await this.request('DELETE', `/publications/${encodeURIComponent(dto.id)}`, {
          adminToken: dto.adminToken,
        });
      } catch {
        // Best effort — the create is reported failed either way.
      }
      throw new WebsiteShareError(
        'WEBSITE_SHARE_VAULT_ERROR',
        `Could not save the key for managing the public copy to secure storage: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const now = Date.now();
    const share: WebsiteShareInfo = {
      publicationId: dto.id,
      url: dto.url,
      publishedRevision: dto.revision,
      publishedContentDigest: bundle.contentDigest,
      includesData: bundle.manifest.includesData,
      publishedAt: now,
      updatedAt: now,
      passwordProtected: dto.passwordProtected,
    };
    const updated = setWebsiteShareState(workspaceRootPath, websiteSlug, share);
    this.log(`Published website ${websiteSlug} as ${dto.id}`);
    return updated;
  }

  /** Change or remove the viewer password (metadata-only; content untouched). */
  async setPassword(
    workspaceRootPath: string,
    workspaceId: string,
    websiteSlug: string,
    password: string | null,
  ): Promise<WebsiteConfig> {
    this.assertSharingEnabled();

    const config = this.requireWebsite(workspaceRootPath, websiteSlug);
    const share = this.requireShare(config);
    const token = await this.requireToken(workspaceId, config.id);

    const form = new FormData();
    form.set('passwordAction', password === null ? 'clear' : 'set');
    if (password !== null) form.set('password', password);

    const response = await this.request('PUT', `/publications/${encodeURIComponent(share.publicationId)}`, {
      body: form,
      adminToken: token,
    });
    const dto = await this.parsePublication(response, 200);

    const updated = setWebsiteShareState(workspaceRootPath, websiteSlug, {
      ...share,
      passwordProtected: dto.passwordProtected,
      updatedAt: Date.now(),
      lastPublishError: undefined,
    });
    this.log(`Updated publication password for ${websiteSlug} (${password === null ? 'cleared' : 'set'})`);
    return updated;
  }

  /**
   * Unpublish a website. Clears local state after remote 2xx or an idempotent
   * 404. When the vault token is missing, local state is still cleared but
   * the result carries a warning that the remote copy may remain.
   */
  async unpublish(
    workspaceRootPath: string,
    workspaceId: string,
    websiteSlug: string,
  ): Promise<UnpublishResult> {
    const config = this.requireWebsite(workspaceRootPath, websiteSlug);
    const share = this.requireShare(config);

    const token = await this.tokenStore.get(workspaceId, config.id);
    if (!token) {
      // Nothing we can do remotely without the capability; free the local website.
      const updated = setWebsiteShareState(workspaceRootPath, websiteSlug, undefined);
      this.log(`Unpublished ${websiteSlug} locally only — admin token missing from vault`);
      return { config: updated, warning: 'remote-copy-may-remain' };
    }

    const response = await this.request(
      'DELETE',
      `/publications/${encodeURIComponent(share.publicationId)}`,
      { adminToken: token },
    );
    if (!response.ok && response.status !== 404) {
      throw new WebsiteShareError(
        'WEBSITE_SHARE_REMOTE_ERROR',
        `Unpublish failed with status ${response.status}: ${await safeBodyExcerpt(response)}`,
      );
    }

    const updated = setWebsiteShareState(workspaceRootPath, websiteSlug, undefined);
    await this.tokenStore.delete(workspaceId, config.id);
    this.log(`Unpublished website ${websiteSlug} (${share.publicationId})`);
    return { config: updated };
  }

  // --------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------

  private async uploadRevision(
    workspaceRootPath: string,
    websiteSlug: string,
    config: WebsiteConfig,
    share: WebsiteShareInfo,
    token: string,
    bundle: ReturnType<typeof buildWebsiteShareBundle>,
  ): Promise<WebsiteConfig> {
    const form = new FormData();
    form.set('manifest', JSON.stringify(bundle.manifest));
    form.set('content', new Blob([bundle.content], { type: 'text/html' }), 'index.html');
    if (bundle.snapshotJson !== undefined) {
      form.set('snapshot', new Blob([bundle.snapshotJson], { type: 'application/json' }), 'snapshot.json');
    }

    let dto: WorkerPublicationResponse;
    try {
      const response = await this.request(
        'PUT',
        `/publications/${encodeURIComponent(share.publicationId)}`,
        { body: form, adminToken: token },
      );
      dto = await this.parsePublication(response, 200);
    } catch (err) {
      // Record the failure on the share pointer so the UI can surface it.
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      setWebsiteShareState(workspaceRootPath, websiteSlug, { ...share, lastPublishError: message });
      throw err;
    }

    const updated = setWebsiteShareState(workspaceRootPath, websiteSlug, {
      ...share,
      publishedRevision: dto.revision,
      publishedContentDigest: bundle.contentDigest,
      includesData: bundle.manifest.includesData,
      updatedAt: Date.now(),
      passwordProtected: dto.passwordProtected,
      lastPublishError: undefined,
    });
    this.log(`Republished website ${websiteSlug} (${share.publicationId} → ${dto.revision})`);
    return updated;
  }

  private assertSharingEnabled(): void {
    if (!isWebsitesSharingEnabled()) {
      throw new WebsiteShareError(
        'WEBSITE_SHARING_DISABLED',
        'Websites sharing is disabled (set CRAFT_FEATURE_WEBSITES_SHARING=1 to enable)',
      );
    }
  }

  private requireWebsite(workspaceRootPath: string, websiteSlug: string): WebsiteConfig {
    const config = loadWebsiteConfig(workspaceRootPath, websiteSlug);
    if (!config) throw new WebsiteShareError('WEBSITE_NOT_FOUND', `Website not found: ${websiteSlug}`);
    return config;
  }

  private requireShare(config: WebsiteConfig): WebsiteShareInfo {
    if (!config.share) {
      throw new WebsiteShareError('WEBSITE_SHARE_NOT_PUBLISHED', `Website is not published: ${config.slug}`);
    }
    return config.share;
  }

  private async requireToken(workspaceId: string, websiteId: string): Promise<string> {
    const token = await this.tokenStore.get(workspaceId, websiteId);
    if (!token) {
      throw new WebsiteShareError(
        'WEBSITE_SHARE_TOKEN_MISSING',
        'The key for managing this website\'s public copy is missing from secure storage. Unpublish the website, then publish it again.',
      );
    }
    return token;
  }

  private async request(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { body?: FormData; adminToken?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (options.adminToken) headers['Authorization'] = `Bearer ${options.adminToken}`;
    try {
      return await this.fetchFn(`${this.apiBaseUrl}${path}`, {
        method,
        headers,
        body: options.body,
      });
    } catch (err) {
      throw new WebsiteShareError(
        'WEBSITE_SHARE_REMOTE_ERROR',
        `Could not reach the publication service: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async parsePublication(response: Response, expectedStatus: number): Promise<WorkerPublicationResponse> {
    if (response.status !== expectedStatus) {
      throw new WebsiteShareError(
        'WEBSITE_SHARE_REMOTE_ERROR',
        `Publication service returned ${response.status}: ${await safeBodyExcerpt(response)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new WebsiteShareError('WEBSITE_SHARE_REMOTE_ERROR', 'Publication service returned invalid JSON');
    }
    const dto = parsed as Partial<WorkerPublicationResponse>;
    if (
      typeof dto.id !== 'string' ||
      typeof dto.url !== 'string' ||
      typeof dto.revision !== 'string' ||
      typeof dto.passwordProtected !== 'boolean'
    ) {
      throw new WebsiteShareError('WEBSITE_SHARE_REMOTE_ERROR', 'Publication service response is missing fields');
    }
    return dto as WorkerPublicationResponse;
  }
}

async function safeBodyExcerpt(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, ERROR_BODY_MAX_CHARS);
  } catch {
    return '<unreadable body>';
  }
}

// ============================================================================
// Delete with best-effort unpublish (shared flow)
// ============================================================================

export interface DeleteWebsiteOutcome {
  /** True when the website was published and the remote copy may still exist */
  publicCopyMayRemain: boolean;
}

/**
 * Delete a website, unpublishing it first when it has a share pointer.
 *
 * The single implementation behind BOTH the `websites:delete` RPC and the
 * `delete_website` session tool — keep it that way so the two paths cannot
 * drift (unpublish-before-delete is a policy, not a handler detail).
 * Unpublish failures are logged and folded into `publicCopyMayRemain`,
 * never blocking the local delete.
 */
export async function deleteWebsiteWithUnpublish(
  workspaceRootPath: string,
  workspaceId: string,
  websiteSlug: string,
  options?: { log?: (message: string) => void },
): Promise<DeleteWebsiteOutcome> {
  let publicCopyMayRemain = false;
  const wasShared = Boolean(loadWebsiteConfig(workspaceRootPath, websiteSlug)?.share);
  if (wasShared) {
    try {
      const publisher = new WebsitePublisher({
        tokenStore: createCredentialWebsitePublishTokenStore(),
        log: options?.log,
      });
      const result = await publisher.unpublish(workspaceRootPath, workspaceId, websiteSlug);
      publicCopyMayRemain = result.warning === 'remote-copy-may-remain';
    } catch (error) {
      publicCopyMayRemain = true;
      options?.log?.(
        `Unpublish before delete failed for ${websiteSlug}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    deleteWebsite(workspaceRootPath, websiteSlug);
  } catch (error) {
    // The unpublish (if any) already happened by now — a bare fs error would
    // misreport that state and send the user retrying the remote half too.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      wasShared
        ? `The website was unpublished, but deleting the local folder failed: ${detail}`
        : `Deleting the local website folder failed: ${detail}`,
    );
  }
  return { publicCopyMayRemain };
}
