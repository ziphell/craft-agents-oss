/**
 * Tests for website storage/CRUD.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deleteWebsiteWithUnpublish } from './publisher.ts';
import {
  createWebsite,
  updateWebsite,
  deleteWebsite,
  loadWebsite,
  loadWebsiteById,
  loadWorkspaceWebsites,
  loadWebsiteConfig,
  saveWebsiteConfig,
  websiteExists,
  generateWebsiteSlug,
  getWebsitePath,
  loadWebsiteContent,
  saveWebsiteContent,
  computeWebsiteContentDigest,
  syncWebsiteContentDigest,
  readWebsiteDataSnapshot,
  recordWebsiteRefresh,
  addWebsiteGrant,
  revokeWebsiteGrant,
  getWebsiteSnapshotPath,
  ensureWebsiteDataDir,
  recordWebsiteThumbnail,
  isThumbnailFresh,
} from './storage.ts';
import { isValidWebsiteSlug, InvalidWebsiteSlugError } from './validation.ts';
import { isWebsiteGrantUsable } from './types.ts';
import { atomicWriteFileSync } from '../utils/files.ts';

describe('websites/storage', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'websites-storage-test-'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  describe('slug validation (path traversal safety)', () => {
    const BAD_SLUGS = ['..', '../x', '../../etc', '/abs', 'a/b', 'a\\b', '', '.', 'UPPER', 'under_score', 'space bar'];

    it('isValidWebsiteSlug accepts safe slugs and rejects unsafe ones', () => {
      expect(isValidWebsiteSlug('my-website-1')).toBe(true);
      expect(isValidWebsiteSlug('website')).toBe(true);
      for (const bad of BAD_SLUGS) expect(isValidWebsiteSlug(bad)).toBe(false);
      expect(isValidWebsiteSlug(undefined)).toBe(false);
      expect(isValidWebsiteSlug(null)).toBe(false);
    });

    it('getWebsitePath throws on an unsafe slug (the single chokepoint)', () => {
      for (const bad of BAD_SLUGS) {
        expect(() => getWebsitePath(workspaceDir, bad)).toThrow(InvalidWebsiteSlugError);
      }
      // A valid slug resolves under websites/ — the guard is not over-broad.
      expect(getWebsitePath(workspaceDir, 'ok')).toBe(join(workspaceDir, 'websites', 'ok'));
    });

    it('deleteWebsite refuses a traversal slug and never touches the workspace tree', () => {
      const website = createWebsite(workspaceDir, { name: 'Keep Me', content: '<p>x</p>' });
      expect(() => deleteWebsite(workspaceDir, '..')).toThrow(InvalidWebsiteSlugError);
      expect(() => deleteWebsite(workspaceDir, '../..')).toThrow(InvalidWebsiteSlugError);
      // The workspace and the real website survive the rejected deletes.
      expect(existsSync(workspaceDir)).toBe(true);
      expect(websiteExists(workspaceDir, website.slug)).toBe(true);
    });

    it('lenient readers treat an unsafe slug as not-found (no throw)', () => {
      for (const bad of BAD_SLUGS) {
        expect(loadWebsiteConfig(workspaceDir, bad)).toBeNull();
        expect(loadWebsiteContent(workspaceDir, bad)).toBeNull();
        expect(readWebsiteDataSnapshot(workspaceDir, bad)).toBeNull();
        expect(websiteExists(workspaceDir, bad)).toBe(false);
      }
    });
  });

  describe('thumbnail pointer (cached poster)', () => {
    it('records the pointer, freshness tracks contentDigest, and updateWebsite cannot touch it', () => {
      const website = createWebsite(workspaceDir, { name: 'Poster', kind: 'static', content: '<p>a</p>' });
      expect(website.contentDigest).toBeDefined();
      expect(isThumbnailFresh(website)).toBe(false); // none captured yet

      const stamped = recordWebsiteThumbnail(workspaceDir, website.slug, {
        digest: website.contentDigest!,
        capturedAt: 123,
        width: 800,
        height: 500,
      });
      expect(stamped.thumbnail).toEqual({ digest: website.contentDigest!, capturedAt: 123, width: 800, height: 500 });
      expect(isThumbnailFresh(stamped)).toBe(true);

      // updateWebsite must not be able to set/clear the managed thumbnail field.
      const afterUpdate = updateWebsite(workspaceDir, website.slug, {
        // @ts-expect-error thumbnail is excluded from the updateWebsite patch type
        thumbnail: undefined,
        name: 'Renamed',
      });
      expect(afterUpdate.name).toBe('Renamed');
      expect(afterUpdate.thumbnail).toEqual(stamped.thumbnail);

      // A content change makes the existing poster stale (digest mismatch).
      const afterContent = saveWebsiteContent(workspaceDir, website.slug, '<p>changed</p>');
      expect(afterContent.thumbnail).toEqual(stamped.thumbnail); // pointer retained…
      expect(isThumbnailFresh(afterContent)).toBe(false); // …but now stale

      // Clearing the pointer.
      const cleared = recordWebsiteThumbnail(workspaceDir, website.slug, undefined);
      expect(cleared.thumbnail).toBeUndefined();
    });
  });

  describe('create / load / update / delete', () => {
    it('creates a website with config, data dir, and optional content', () => {
      const config = createWebsite(workspaceDir, {
        name: 'Revenue Dashboard',
        description: 'KPIs',
        content: '<html><body>hi</body></html>',
        refresh: { cron: '*/5 * * * *', script: 'scripts/refresh.ts' },
      });

      expect(config.slug).toBe('revenue-dashboard');
      expect(config.id).toMatch(/^website_[0-9a-f-]{8}$/);
      expect(config.contentDigest).toBe(computeWebsiteContentDigest('<html><body>hi</body></html>'));
      expect(websiteExists(workspaceDir, 'revenue-dashboard')).toBe(true);
      expect(existsSync(join(workspaceDir, 'websites', 'revenue-dashboard', 'data'))).toBe(true);
      expect(loadWebsiteContent(workspaceDir, 'revenue-dashboard')).toBe('<html><body>hi</body></html>');

      const loaded = loadWebsite(workspaceDir, 'revenue-dashboard');
      expect(loaded?.config.name).toBe('Revenue Dashboard');
      expect(loaded?.dataPath).toBe(join(workspaceDir, 'websites', 'revenue-dashboard', 'data'));

      expect(loadWebsiteById(workspaceDir, config.id)?.config.slug).toBe('revenue-dashboard');
    });

    it('generates unique slugs', () => {
      createWebsite(workspaceDir, { name: 'My Website' });
      createWebsite(workspaceDir, { name: 'My Website' });
      const slugs = loadWorkspaceWebsites(workspaceDir).map((p) => p.config.slug).sort();
      expect(slugs).toEqual(['my-website', 'my-website-2']);
      expect(generateWebsiteSlug(workspaceDir, 'My Website')).toBe('my-website-3');
    });

    it('updates metadata but never managed fields', () => {
      const created = createWebsite(workspaceDir, { name: 'Dash', content: 'v1' });
      const updated = updateWebsite(workspaceDir, created.slug, {
        name: 'Renamed',
        // @ts-expect-error managed field is excluded from the patch type
        contentDigest: 'ffff',
      });
      expect(updated.name).toBe('Renamed');
      expect(updated.contentDigest).toBe(computeWebsiteContentDigest('v1'));
    });

    it('updateWebsite: explicit null clears optional fields; absent keys leave them unchanged', () => {
      const created = createWebsite(workspaceDir, {
        name: 'Null Clears',
        kind: 'live',
        description: 'desc',
        projectId: 'proj_1',
        refresh: { cron: '*/10 * * * *', script: 'scripts/refresh.ts' },
      });

      // A patch WITHOUT the keys must not touch them.
      updateWebsite(workspaceDir, created.slug, { name: 'Renamed' });
      let cfg = loadWebsiteConfig(workspaceDir, created.slug)!;
      expect(cfg.name).toBe('Renamed');
      expect(cfg.projectId).toBe('proj_1');
      expect(cfg.description).toBe('desc');
      expect(cfg.refresh?.cron).toBe('*/10 * * * *');

      // Explicit null clears — the literal value the websites:update RPC and the
      // update_website tool forward over JSON (undefined never survives transport).
      updateWebsite(workspaceDir, created.slug, { projectId: null });
      cfg = loadWebsiteConfig(workspaceDir, created.slug)!;
      expect(cfg.projectId).toBeUndefined();
      expect(cfg.description).toBe('desc');

      updateWebsite(workspaceDir, created.slug, { description: null, refresh: null });
      cfg = loadWebsiteConfig(workspaceDir, created.slug)!;
      expect(cfg.description).toBeUndefined();
      expect(cfg.refresh).toBeUndefined();
      // Truly absent on disk (valid optional), not stored as null.
      expect('projectId' in cfg).toBe(false);
      expect('refresh' in cfg).toBe(false);
    });

    it('rejects invalid configs on save', () => {
      expect(() =>
        saveWebsiteConfig(workspaceDir, {
          schemaVersion: 1,
          id: 'website_x',
          slug: 'Bad Slug!',
          name: 'x',
          kind: 'interactive',
          createdAt: 1,
          updatedAt: 1,
        }),
      ).toThrow(/Invalid website config/);
    });

    it('deletes the whole website folder', () => {
      const created = createWebsite(workspaceDir, { name: 'Gone', content: 'x' });
      deleteWebsite(workspaceDir, created.slug);
      expect(websiteExists(workspaceDir, created.slug)).toBe(false);
      expect(existsSync(join(workspaceDir, 'websites', created.slug))).toBe(false);
    });
  });

  describe('deleteWebsiteWithUnpublish local-delete failure', () => {
    // Fault injection via a read-only parent dir: meaningless as root (rm
    // succeeds anyway) and different semantics on win32 — skip there so the
    // test cannot false-fail in CI (it verifies the error message contract,
    // not platform chmod behavior).
    const canInjectFsFailure =
      process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

    (canInjectFsFailure ? it : it.skip)(
      'surfaces a contextual error when the local folder cannot be removed, then succeeds once it can',
      async () => {
        const created = createWebsite(workspaceDir, { name: 'Sticky', kind: 'static', content: '<p>x</p>' });
        const websitesDir = join(workspaceDir, 'websites');

        chmodSync(websitesDir, 0o555); // removing an entry needs write perm on the parent
        try {
          await expect(deleteWebsiteWithUnpublish(workspaceDir, 'ws-test', created.slug)).rejects.toThrow(
            /Deleting the local website folder failed/,
          );
        } finally {
          chmodSync(websitesDir, 0o755);
        }

        // Unshared website → no publisher involved; delete now completes cleanly.
        const outcome = await deleteWebsiteWithUnpublish(workspaceDir, 'ws-test', created.slug);
        expect(outcome.publicCopyMayRemain).toBe(false);
        expect(websiteExists(workspaceDir, created.slug)).toBe(false);
      },
    );

    it('is a clean no-op outcome for a website that does not exist', async () => {
      const outcome = await deleteWebsiteWithUnpublish(workspaceDir, 'ws-test', 'never-existed');
      expect(outcome.publicCopyMayRemain).toBe(false);
    });
  });

  describe('content and digest', () => {
    it('saveWebsiteContent updates the digest (staling grants)', () => {
      const created = createWebsite(workspaceDir, { name: 'Dash', content: 'v1' });
      const grant = addWebsiteGrant(workspaceDir, created.slug, {
        action: { kind: 'api', sourceSlug: 'github', method: 'GET', pathPattern: '/repos/.*' },
      });
      const updated = saveWebsiteContent(workspaceDir, created.slug, 'v2');

      expect(updated.contentDigest).toBe(computeWebsiteContentDigest('v2'));
      // Grant persists but is bound to the v1 digest — stale by design
      const persisted = loadWebsiteConfig(workspaceDir, created.slug)!;
      expect(persisted.grants?.[0]?.id).toBe(grant.id);
      expect(persisted.grants?.[0]?.contentDigest).toBe(computeWebsiteContentDigest('v1'));
    });
  });

  describe('syncWebsiteContentDigest (the file is the truth)', () => {
    const writeWebsiteFile = (slug: string, content: string) =>
      atomicWriteFileSync(join(getWebsitePath(workspaceDir, slug), 'index.html'), content);

    it('realigns the digest after an out-of-band edit', () => {
      const created = createWebsite(workspaceDir, { name: 'Dash', content: 'v1' });
      writeWebsiteFile(created.slug, 'v2');

      const synced = syncWebsiteContentDigest(workspaceDir, created.slug)!;

      expect(synced.contentChanged).toBe(true);
      expect(synced.config.contentDigest).toBe(computeWebsiteContentDigest('v2'));
      // Persisted, not only returned: WebsiteActionBroker reads the config from disk.
      expect(loadWebsiteConfig(workspaceDir, created.slug)!.contentDigest).toBe(computeWebsiteContentDigest('v2'));
    });

    it('retires the previous version approvals (grants are digest-bound)', () => {
      const created = createWebsite(workspaceDir, { name: 'Dash', content: 'v1' });
      const grant = addWebsiteGrant(workspaceDir, created.slug, {
        action: { kind: 'api', sourceSlug: 'github', method: 'GET', pathPattern: '/repos/.*' },
      });
      writeWebsiteFile(created.slug, 'v2');
      syncWebsiteContentDigest(workspaceDir, created.slug);

      const persisted = loadWebsiteConfig(workspaceDir, created.slug)!;
      // The approval survives on disk but stops validating — the security model,
      // now enforced by the facts rather than by who was allowed to write.
      expect(persisted.grants?.[0]?.id).toBe(grant.id);
      expect(isWebsiteGrantUsable(persisted.grants![0]!, persisted.contentDigest, Date.now())).toBe(false);
    });

    it('is a no-op when the file still matches, so nothing re-renders', () => {
      const created = createWebsite(workspaceDir, { name: 'Dash', content: 'v1' });

      const synced = syncWebsiteContentDigest(workspaceDir, created.slug)!;

      expect(synced.contentChanged).toBe(false);
      expect(synced.config.updatedAt).toBe(created.updatedAt);
    });

    it('clears the digest when the content is deleted outside the tools', () => {
      const created = createWebsite(workspaceDir, { name: 'Dash', content: 'v1' });
      rmSync(join(getWebsitePath(workspaceDir, created.slug), 'index.html'));

      const synced = syncWebsiteContentDigest(workspaceDir, created.slug)!;

      expect(synced.contentChanged).toBe(true);
      expect(synced.config.contentDigest).toBeUndefined();
      expect(loadWebsiteConfig(workspaceDir, created.slug)!.contentDigest).toBeUndefined();
    });

    it('returns null for a website that does not exist', () => {
      expect(syncWebsiteContentDigest(workspaceDir, 'missing-website')).toBeNull();
    });
  });

  describe('data snapshot + refresh recording', () => {
    it('reads a snapshot written to data/snapshot.json', () => {
      const created = createWebsite(workspaceDir, { name: 'Dash' });
      ensureWebsiteDataDir(workspaceDir, created.slug);
      atomicWriteFileSync(
        getWebsiteSnapshotPath(workspaceDir, created.slug),
        JSON.stringify({ version: 1, generatedAt: 123, kv: { total: 42 }, series: {} }),
      );
      const snapshot = readWebsiteDataSnapshot(workspaceDir, created.slug);
      expect(snapshot?.kv.total).toBe(42);
      expect(readWebsiteDataSnapshot(workspaceDir, 'missing')).toBeNull();
    });

    it('recordWebsiteRefresh writes lastRefresh with capped error', () => {
      const created = createWebsite(workspaceDir, { name: 'Dash' });
      recordWebsiteRefresh(workspaceDir, created.slug, {
        at: 111,
        ok: false,
        durationMs: 5,
        error: 'x'.repeat(5000),
      });
      const config = loadWebsiteConfig(workspaceDir, created.slug)!;
      expect(config.lastRefresh?.ok).toBe(false);
      expect(config.lastRefresh?.error?.length).toBe(2000);
    });
  });

  describe('grants', () => {
    it('requires content before issuing a grant', () => {
      const created = createWebsite(workspaceDir, { name: 'NoContent' });
      expect(() =>
        addWebsiteGrant(workspaceDir, created.slug, {
          action: { kind: 'mcp', sourceSlug: 'linear', toolName: 'create_issue' },
        }),
      ).toThrow(/no content/);
    });

    it('issues digest-bound expiring grants and revokes them', () => {
      const created = createWebsite(workspaceDir, { name: 'Dash', content: 'v1' });
      const grant = addWebsiteGrant(workspaceDir, created.slug, {
        action: { kind: 'api', sourceSlug: 'github', method: 'POST', pathPattern: '/issues' },
        description: 'File issues',
        ttlMs: 60_000,
      });
      expect(grant.contentDigest).toBe(computeWebsiteContentDigest('v1'));
      expect(grant.expiresAt - grant.createdAt).toBe(60_000);

      expect(revokeWebsiteGrant(workspaceDir, created.slug, grant.id)).toBe(true);
      expect(revokeWebsiteGrant(workspaceDir, created.slug, grant.id)).toBe(false);
      expect(loadWebsiteConfig(workspaceDir, created.slug)?.grants).toEqual([]);
    });
  });

  describe('atomicity marker', () => {
    it('website.json writes go through the .tmp+rename pattern', () => {
      // Indirect check: after a save there is no lingering .tmp file
      createWebsite(workspaceDir, { name: 'Dash' });
      const dir = join(workspaceDir, 'websites', 'dash');
      expect(existsSync(join(dir, 'website.json'))).toBe(true);
      expect(existsSync(join(dir, 'website.json.tmp'))).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, 'website.json'), 'utf-8')).slug).toBe('dash');
    });
  });
});
