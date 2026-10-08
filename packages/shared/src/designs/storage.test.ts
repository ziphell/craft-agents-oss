/**
 * Tests for design storage/CRUD.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deleteDesignWithUnpublish } from './publisher.ts';
import {
  createDesign,
  updateDesign,
  deleteDesign,
  loadDesign,
  loadDesignById,
  loadWorkspaceDesigns,
  loadDesignConfig,
  saveDesignConfig,
  designExists,
  generateDesignSlug,
  getDesignPath,
  loadDesignContent,
  saveDesignContent,
  computeDesignContentDigest,
  readDesignDataSnapshot,
  recordDesignRefresh,
  addDesignGrant,
  revokeDesignGrant,
  getDesignSnapshotPath,
  getDesignConfigRelativePath,
  ensureDesignDataDir,
  recordDesignThumbnail,
  isThumbnailFresh,
} from './storage.ts';
import { isValidDesignSlug, InvalidDesignSlugError } from './validation.ts';
import { atomicWriteFileSync } from '../utils/files.ts';

describe('designs/storage', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'designs-storage-test-'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  describe('slug validation (path traversal safety)', () => {
    const BAD_SLUGS = ['..', '../x', '../../etc', '/abs', 'a/b', 'a\\b', '', '.', 'UPPER', 'under_score', 'space bar'];

    it('isValidDesignSlug accepts safe slugs and rejects unsafe ones', () => {
      expect(isValidDesignSlug('my-design-1')).toBe(true);
      expect(isValidDesignSlug('design')).toBe(true);
      for (const bad of BAD_SLUGS) expect(isValidDesignSlug(bad)).toBe(false);
      expect(isValidDesignSlug(undefined)).toBe(false);
      expect(isValidDesignSlug(null)).toBe(false);
    });

    it('getDesignPath throws on an unsafe slug (the single chokepoint)', () => {
      for (const bad of BAD_SLUGS) {
        expect(() => getDesignPath(workspaceDir, bad)).toThrow(InvalidDesignSlugError);
      }
      // A valid slug resolves under designs/ — the guard is not over-broad.
      expect(getDesignPath(workspaceDir, 'ok')).toBe(join(workspaceDir, 'designs', 'ok'));
    });

    it('deleteDesign refuses a traversal slug and never touches the workspace tree', () => {
      const design = createDesign(workspaceDir, { name: 'Keep Me', content: '<p>x</p>' });
      expect(() => deleteDesign(workspaceDir, '..')).toThrow(InvalidDesignSlugError);
      expect(() => deleteDesign(workspaceDir, '../..')).toThrow(InvalidDesignSlugError);
      // The workspace and the real design survive the rejected deletes.
      expect(existsSync(workspaceDir)).toBe(true);
      expect(designExists(workspaceDir, design.slug)).toBe(true);
    });

    it('lenient readers treat an unsafe slug as not-found (no throw)', () => {
      for (const bad of BAD_SLUGS) {
        expect(loadDesignConfig(workspaceDir, bad)).toBeNull();
        expect(loadDesignContent(workspaceDir, bad)).toBeNull();
        expect(readDesignDataSnapshot(workspaceDir, bad)).toBeNull();
        expect(designExists(workspaceDir, bad)).toBe(false);
      }
    });
  });

  describe('thumbnail pointer (cached poster)', () => {
    it('records the pointer, freshness tracks contentDigest, and updateDesign cannot touch it', () => {
      const design = createDesign(workspaceDir, { name: 'Poster', content: '<p>a</p>' });
      expect(design.contentDigest).toBeDefined();
      expect(isThumbnailFresh(design)).toBe(false); // none captured yet

      const stamped = recordDesignThumbnail(workspaceDir, design.slug, {
        digest: design.contentDigest!,
        capturedAt: 123,
        width: 800,
        height: 500,
      });
      expect(stamped.thumbnail).toEqual({ digest: design.contentDigest!, capturedAt: 123, width: 800, height: 500 });
      expect(isThumbnailFresh(stamped)).toBe(true);

      // updateDesign must not be able to set/clear the managed thumbnail field.
      const afterUpdate = updateDesign(workspaceDir, design.slug, {
        // @ts-expect-error thumbnail is excluded from the updateDesign patch type
        thumbnail: undefined,
        name: 'Renamed',
      });
      expect(afterUpdate.name).toBe('Renamed');
      expect(afterUpdate.thumbnail).toEqual(stamped.thumbnail);

      // A content change makes the existing poster stale (digest mismatch).
      const afterContent = saveDesignContent(workspaceDir, design.slug, '<p>changed</p>');
      expect(afterContent.thumbnail).toEqual(stamped.thumbnail); // pointer retained…
      expect(isThumbnailFresh(afterContent)).toBe(false); // …but now stale

      // Clearing the pointer.
      const cleared = recordDesignThumbnail(workspaceDir, design.slug, undefined);
      expect(cleared.thumbnail).toBeUndefined();
    });
  });

  describe('create / load / update / delete', () => {
    it('creates a design with config, data dir, and optional content', () => {
      const config = createDesign(workspaceDir, {
        name: 'Revenue Dashboard',
        description: 'KPIs',
        content: '<html><body>hi</body></html>',
        refresh: { cron: '*/5 * * * *', script: 'scripts/refresh.ts' },
      });

      expect(config.slug).toBe('revenue-dashboard');
      expect(config.id).toMatch(/^design_[0-9a-f-]{8}$/);
      expect(config.contentDigest).toBe(computeDesignContentDigest('<html><body>hi</body></html>'));
      expect(designExists(workspaceDir, 'revenue-dashboard')).toBe(true);
      expect(existsSync(join(workspaceDir, 'designs', 'revenue-dashboard', 'data'))).toBe(true);
      expect(loadDesignContent(workspaceDir, 'revenue-dashboard')).toBe('<html><body>hi</body></html>');

      const loaded = loadDesign(workspaceDir, 'revenue-dashboard');
      expect(loaded?.config.name).toBe('Revenue Dashboard');
      expect(loaded?.dataPath).toBe(join(workspaceDir, 'designs', 'revenue-dashboard', 'data'));

      expect(loadDesignById(workspaceDir, config.id)?.config.slug).toBe('revenue-dashboard');
    });

    it('generates unique slugs', () => {
      createDesign(workspaceDir, { name: 'My Design' });
      createDesign(workspaceDir, { name: 'My Design' });
      const slugs = loadWorkspaceDesigns(workspaceDir).map((p) => p.config.slug).sort();
      expect(slugs).toEqual(['my-design', 'my-design-2']);
      expect(generateDesignSlug(workspaceDir, 'My Design')).toBe('my-design-3');
    });

    it('updates metadata but never managed fields', () => {
      const created = createDesign(workspaceDir, { name: 'Dash', content: 'v1' });
      const updated = updateDesign(workspaceDir, created.slug, {
        name: 'Renamed',
        // @ts-expect-error managed field is excluded from the patch type
        contentDigest: 'ffff',
      });
      expect(updated.name).toBe('Renamed');
      expect(updated.contentDigest).toBe(computeDesignContentDigest('v1'));
    });

    it('updateDesign: explicit null clears optional fields; absent keys leave them unchanged', () => {
      const created = createDesign(workspaceDir, {
        name: 'Null Clears',
        description: 'desc',
        projectId: 'proj_1',
        refresh: { cron: '*/10 * * * *', script: 'scripts/refresh.ts' },
      });

      // A patch WITHOUT the keys must not touch them.
      updateDesign(workspaceDir, created.slug, { name: 'Renamed' });
      let cfg = loadDesignConfig(workspaceDir, created.slug)!;
      expect(cfg.name).toBe('Renamed');
      expect(cfg.projectId).toBe('proj_1');
      expect(cfg.description).toBe('desc');
      expect(cfg.refresh?.cron).toBe('*/10 * * * *');

      // Explicit null clears — the literal value the designs:update RPC and the
      // update_design tool forward over JSON (undefined never survives transport).
      updateDesign(workspaceDir, created.slug, { projectId: null });
      cfg = loadDesignConfig(workspaceDir, created.slug)!;
      expect(cfg.projectId).toBeUndefined();
      expect(cfg.description).toBe('desc');

      updateDesign(workspaceDir, created.slug, { description: null, refresh: null });
      cfg = loadDesignConfig(workspaceDir, created.slug)!;
      expect(cfg.description).toBeUndefined();
      expect(cfg.refresh).toBeUndefined();
      // Truly absent on disk (valid optional), not stored as null.
      expect('projectId' in cfg).toBe(false);
      expect('refresh' in cfg).toBe(false);
    });

    it('rejects invalid configs on save', () => {
      expect(() =>
        saveDesignConfig(workspaceDir, {
          schemaVersion: 1,
          id: 'design_x',
          slug: 'Bad Slug!',
          name: 'x',
kind: 'prototype',
          createdAt: 1,
          updatedAt: 1,
        }),
      ).toThrow(/Invalid design config/);
    });

    it('deletes the whole design folder', () => {
      const created = createDesign(workspaceDir, { name: 'Gone', content: 'x' });
      deleteDesign(workspaceDir, created.slug);
      expect(designExists(workspaceDir, created.slug)).toBe(false);
      expect(existsSync(join(workspaceDir, 'designs', created.slug))).toBe(false);
    });
  });

  describe('deleteDesignWithUnpublish local-delete failure', () => {
    // Fault injection via a read-only parent dir: meaningless as root (rm
    // succeeds anyway) and different semantics on win32 — skip there so the
    // test cannot false-fail in CI (it verifies the error message contract,
    // not platform chmod behavior).
    const canInjectFsFailure =
      process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

    (canInjectFsFailure ? it : it.skip)(
      'surfaces a contextual error when the local folder cannot be removed, then succeeds once it can',
      async () => {
        const created = createDesign(workspaceDir, { name: 'Sticky', content: '<p>x</p>' });
        const designsDir = join(workspaceDir, 'designs');

        chmodSync(designsDir, 0o555); // removing an entry needs write perm on the parent
        try {
          await expect(deleteDesignWithUnpublish(workspaceDir, 'ws-test', created.slug)).rejects.toThrow(
            /Deleting the local design folder failed/,
          );
        } finally {
          chmodSync(designsDir, 0o755);
        }

        // Unshared design → no publisher involved; delete now completes cleanly.
        const outcome = await deleteDesignWithUnpublish(workspaceDir, 'ws-test', created.slug);
        expect(outcome.publicCopyMayRemain).toBe(false);
        expect(designExists(workspaceDir, created.slug)).toBe(false);
      },
    );

    it('is a clean no-op outcome for a design that does not exist', async () => {
      const outcome = await deleteDesignWithUnpublish(workspaceDir, 'ws-test', 'never-existed');
      expect(outcome.publicCopyMayRemain).toBe(false);
    });
  });

  describe('content and digest', () => {
    it('saveDesignContent updates the digest (staling grants)', () => {
      const created = createDesign(workspaceDir, { name: 'Dash', content: 'v1' });
      const grant = addDesignGrant(workspaceDir, created.slug, {
        action: { kind: 'api', sourceSlug: 'github', method: 'GET', pathPattern: '/repos/.*' },
      });
      const updated = saveDesignContent(workspaceDir, created.slug, 'v2');

      expect(updated.contentDigest).toBe(computeDesignContentDigest('v2'));
      // Grant persists but is bound to the v1 digest — stale by design
      const persisted = loadDesignConfig(workspaceDir, created.slug)!;
      expect(persisted.grants?.[0]?.id).toBe(grant.id);
      expect(persisted.grants?.[0]?.contentDigest).toBe(computeDesignContentDigest('v1'));
    });
  });

  describe('data snapshot + refresh recording', () => {
    it('reads a snapshot written to data/snapshot.json', () => {
      const created = createDesign(workspaceDir, { name: 'Dash' });
      ensureDesignDataDir(workspaceDir, created.slug);
      atomicWriteFileSync(
        getDesignSnapshotPath(workspaceDir, created.slug),
        JSON.stringify({ version: 1, generatedAt: 123, kv: { total: 42 }, series: {} }),
      );
      const snapshot = readDesignDataSnapshot(workspaceDir, created.slug);
      expect(snapshot?.kv.total).toBe(42);
      expect(readDesignDataSnapshot(workspaceDir, 'missing')).toBeNull();
    });

    it('recordDesignRefresh writes lastRefresh with capped error', () => {
      const created = createDesign(workspaceDir, { name: 'Dash' });
      recordDesignRefresh(workspaceDir, created.slug, {
        at: 111,
        ok: false,
        durationMs: 5,
        error: 'x'.repeat(5000),
      });
      const config = loadDesignConfig(workspaceDir, created.slug)!;
      expect(config.lastRefresh?.ok).toBe(false);
      expect(config.lastRefresh?.error?.length).toBe(2000);
    });
  });

  describe('grants', () => {
    it('requires content before issuing a grant', () => {
      const created = createDesign(workspaceDir, { name: 'NoContent' });
      expect(() =>
        addDesignGrant(workspaceDir, created.slug, {
          action: { kind: 'mcp', sourceSlug: 'linear', toolName: 'create_issue' },
        }),
      ).toThrow(/no content/);
    });

    it('issues digest-bound expiring grants and revokes them', () => {
      const created = createDesign(workspaceDir, { name: 'Dash', content: 'v1' });
      const grant = addDesignGrant(workspaceDir, created.slug, {
        action: { kind: 'api', sourceSlug: 'github', method: 'POST', pathPattern: '/issues' },
        description: 'File issues',
        ttlMs: 60_000,
      });
      expect(grant.contentDigest).toBe(computeDesignContentDigest('v1'));
      expect(grant.expiresAt - grant.createdAt).toBe(60_000);

      expect(revokeDesignGrant(workspaceDir, created.slug, grant.id)).toBe(true);
      expect(revokeDesignGrant(workspaceDir, created.slug, grant.id)).toBe(false);
      expect(loadDesignConfig(workspaceDir, created.slug)?.grants).toEqual([]);
    });
  });

  describe('atomicity marker', () => {
    it('design.json writes go through the .tmp+rename pattern', () => {
      // Indirect check: after a save there is no lingering .tmp file
      createDesign(workspaceDir, { name: 'Dash' });
      const dir = join(workspaceDir, 'designs', 'dash');
      expect(existsSync(join(dir, 'design.json'))).toBe(true);
      expect(existsSync(join(dir, 'design.json.tmp'))).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, 'design.json'), 'utf-8')).slug).toBe('dash');
    });
  });
});

describe('designs/storage > config trigger path', () => {
  it('names design.json under designs/ — the watcher\'s only designs trigger', () => {
    // The host pokes the config watcher with this after a poster is captured;
    // watcher.ts only fires on `designs/.../design.json`, so a wrong prefix here
    // silently strands the fresh poster (it was `pages/...` once).
    expect(getDesignConfigRelativePath('build-health')).toBe('designs/build-health/design.json');
  });

  it('refuses a slug that would escape the designs directory', () => {
    expect(() => getDesignConfigRelativePath('../config')).toThrow(InvalidDesignSlugError);
  });
});

describe('designs/storage > retired kind', () => {
  it('settles the kind of a file written before kinds were stored, so it can be saved again', () => {
    const root = mkdtempSync(join(tmpdir(), 'design-kind-'));
    try {
      const dir = join(root, 'designs', 'legacy-poster');
      mkdirSync(dir, { recursive: true });
      // A workspace written when `kind` meant a runtime class (and this one is a
      // deck by its settings) — exactly what the migration has to settle.
      writeFileSync(join(dir, 'design.json'), JSON.stringify({
        schemaVersion: 1,
        id: 'design_legacy',
        slug: 'legacy-poster',
        name: 'Legacy Poster',
        kind: 'live',
        deck: { aspect: '16:9' },
        createdAt: 1,
        updatedAt: 1,
        contentDigest: 'a'.repeat(64),
      }, null, 2));

      const loaded = loadDesignConfig(root, 'legacy-poster');
      expect(loaded?.kind).toBe('deck');

      // Before the migration this threw: the schema wants a settled kind.
      expect(() => saveDesignConfig(root, loaded!)).not.toThrow();
      const onDisk = JSON.parse(readFileSync(join(dir, 'design.json'), 'utf-8'))
      expect(onDisk.kind).toBe('deck')
      expect(onDisk.deck).toEqual({ aspect: '16:9' })
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
