/**
 * Share-bundle invariants: exclusion-by-construction, explicit data opt-in,
 * size caps, grants acknowledgment, and the design_publish_token credential
 * key round-trip.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDesign, addDesignGrant, getDesignPath, recordDesignThumbnail, saveDesignContent } from './storage.ts';
import { isDesignGrantUsable } from './types.ts';
import {
  buildDesignShareBundle,
  getShareSnapshotSizeBytes,
  scanDesignShareData,
  scanSnapshotForSecretCandidates,
  designShareErrorCode,
  DESIGN_SHARE_MAX_CONTENT_BYTES,
} from './share-bundle.ts';
import { accountToCredentialId, credentialIdToAccount } from '../credentials/types.ts';

const HTML = '<!doctype html><html><body>bundle</body></html>';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-share-bundle-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSnapshot(slug: string, value: unknown): void {
  const dataDir = join(getDesignPath(root, slug), 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'snapshot.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

describe('buildDesignShareBundle', () => {
  test('manifest is built field-by-field — local-only state cannot leak', () => {
    const design = createDesign(root, {
      name: 'Leak Test',
      description: 'desc',
      projectId: 'proj_secret',
      content: HTML,
      refresh: { cron: '*/5 * * * *', script: 'designs/leak-test/scripts/refresh.ts' },
    });
    addDesignGrant(root, design.slug, {
      action: { kind: 'api', sourceSlug: 'gmail-secret-slug', method: 'GET', pathPattern: '/x' },
    });

    const bundle = buildDesignShareBundle(root, design.slug, {
      includeData: false,
      viewOnlyAcknowledged: true,
    });

    // Exactly the allowlisted manifest fields — nothing else.
    expect(Object.keys(bundle.manifest).sort()).toEqual(
      ['contentDigest', 'description', 'includesData', 'slug', 'title', 'version'].sort(),
    );
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('proj_secret');
    expect(serialized).not.toContain('gmail-secret-slug');
    expect(serialized).not.toContain('refresh.ts');
    expect(serialized).not.toContain(root); // no local paths
  });

  test('the cached-poster pointer never ships in the bundle', () => {
    const design = createDesign(root, { name: 'Poster Excluded', content: HTML });
    recordDesignThumbnail(root, design.slug, {
      digest: design.contentDigest!,
      capturedAt: 1,
      width: 800,
      height: 500,
    });

    const bundle = buildDesignShareBundle(root, design.slug, { includeData: false });
    expect(Object.keys(bundle.manifest)).not.toContain('thumbnail');
    expect(JSON.stringify(bundle)).not.toContain('thumbnail');
  });

  test('snapshot ships only on explicit opt-in and must be valid JSON', () => {
    const design = createDesign(root, { name: 'Data Opt In', content: HTML });
    writeSnapshot(design.slug, { version: 1, generatedAt: 1, kv: { k: 'v' }, series: {} });

    const withoutData = buildDesignShareBundle(root, design.slug, { includeData: false });
    expect(withoutData.snapshotJson).toBeUndefined();
    expect(withoutData.manifest.includesData).toBe(false);

    const withData = buildDesignShareBundle(root, design.slug, { includeData: true });
    expect(withData.snapshotJson).toContain('"k"');
    expect(withData.manifest.includesData).toBe(true);

    writeSnapshot(design.slug, '{not-json');
    expect(() => buildDesignShareBundle(root, design.slug, { includeData: true })).toThrow(
      /DESIGN_SHARE_SNAPSHOT_INVALID/,
    );
    // Broken snapshot is irrelevant when data is not included.
    expect(buildDesignShareBundle(root, design.slug, { includeData: false }).snapshotJson).toBeUndefined();
  });

  test('grants require the view-only acknowledgment', () => {
    const design = createDesign(root, { name: 'Grant Ack', content: HTML });
    addDesignGrant(root, design.slug, {
      action: { kind: 'mcp', sourceSlug: 'slack', toolName: 'post_message' },
    });
    expect(() => buildDesignShareBundle(root, design.slug, { includeData: false })).toThrow(
      /DESIGN_SHARE_ACTIONS_ACK_REQUIRED/,
    );
    expect(
      buildDesignShareBundle(root, design.slug, { includeData: false, viewOnlyAcknowledged: true }).manifest.title,
    ).toBe('Grant Ack');
  });

  test('stale grants (older content version) do not require the ack', () => {
    const design = createDesign(root, { name: 'Stale Grant', content: HTML });
    addDesignGrant(root, design.slug, {
      action: { kind: 'mcp', sourceSlug: 'slack', toolName: 'post_message' },
    });
    // Content change stales the grant — locally inert, so nothing to acknowledge.
    saveDesignContent(root, design.slug, HTML.replace('bundle', 'bundle v2'));
    expect(
      buildDesignShareBundle(root, design.slug, { includeData: false }).manifest.title,
    ).toBe('Stale Grant');
  });

  test('expired grants do not require the ack', () => {
    const design = createDesign(root, { name: 'Expired Grant', content: HTML });
    addDesignGrant(root, design.slug, {
      action: { kind: 'mcp', sourceSlug: 'slack', toolName: 'post_message' },
      ttlMs: -1000,
    });
    expect(
      buildDesignShareBundle(root, design.slug, { includeData: false }).manifest.title,
    ).toBe('Expired Grant');
  });

  test('a script grant blocks publishing outright — the ack cannot rescue it', () => {
    const design = createDesign(root, { name: 'Script Grant', content: HTML });
    addDesignGrant(root, design.slug, {
      action: { kind: 'script', script: 'designs/script-grant/run.sh', runtime: 'bun' },
    });
    expect(() => buildDesignShareBundle(root, design.slug, { includeData: false })).toThrow(
      /DESIGN_SHARE_SCRIPT_GRANT/,
    );
    // Host command execution must never reach a public URL, ack or not.
    expect(() =>
      buildDesignShareBundle(root, design.slug, { includeData: false, viewOnlyAcknowledged: true }),
    ).toThrow(/DESIGN_SHARE_SCRIPT_GRANT/);
  });

  test('even a STALE script grant blocks publishing — remove it, never bypass it', () => {
    const design = createDesign(root, { name: 'Stale Script Grant', content: HTML });
    addDesignGrant(root, design.slug, {
      action: { kind: 'script', script: 'designs/stale-script-grant/run.sh' },
      ttlMs: -1000, // expired
    });
    saveDesignContent(root, design.slug, HTML.replace('bundle', 'bundle v2')); // and digest-stale
    expect(() =>
      buildDesignShareBundle(root, design.slug, { includeData: false, viewOnlyAcknowledged: true }),
    ).toThrow(/DESIGN_SHARE_SCRIPT_GRANT/);
  });

  test('enforces content size cap and missing-content/design errors', () => {
    const design = createDesign(root, { name: 'Too Big' });
    expect(() => buildDesignShareBundle(root, design.slug, { includeData: false })).toThrow(/DESIGN_NO_CONTENT/);

    writeFileSync(join(getDesignPath(root, design.slug), 'index.html'), 'x'.repeat(DESIGN_SHARE_MAX_CONTENT_BYTES + 1));
    expect(() => buildDesignShareBundle(root, design.slug, { includeData: false })).toThrow(/DESIGN_SHARE_TOO_LARGE/);

    expect(() => buildDesignShareBundle(root, 'does-not-exist', { includeData: false })).toThrow(/DESIGN_NOT_FOUND/);
  });

  test('snapshot size helper and error-code extraction', () => {
    const design = createDesign(root, { name: 'Size Helper', content: HTML });
    expect(getShareSnapshotSizeBytes(root, design.slug)).toBeNull();
    writeSnapshot(design.slug, { version: 1, generatedAt: 1, kv: {}, series: {} });
    expect(getShareSnapshotSizeBytes(root, design.slug)).toBeGreaterThan(10);

    expect(designShareErrorCode(new Error('DESIGN_SHARING_DISABLED: nope'))).toBe('DESIGN_SHARING_DISABLED');
    expect(designShareErrorCode(new Error('random failure'))).toBeNull();
  });
});

describe('isDesignGrantUsable', () => {
  const grant = { contentDigest: 'digest-a', expiresAt: 1000 };

  test('usable only when digest matches and not expired', () => {
    expect(isDesignGrantUsable(grant, 'digest-a', 999)).toBe(true);
    expect(isDesignGrantUsable(grant, 'digest-b', 999)).toBe(false); // stale content
    expect(isDesignGrantUsable(grant, 'digest-a', 1000)).toBe(false); // expired (boundary)
    expect(isDesignGrantUsable(grant, 'digest-a', 1001)).toBe(false); // expired
  });

  test('a design without content makes nothing usable', () => {
    expect(isDesignGrantUsable(grant, undefined, 0)).toBe(false);
  });
});

describe('design_publish_token credential id', () => {
  test('round-trips through account string encoding', () => {
    const id = { type: 'design_publish_token' as const, workspaceId: 'ws-1', name: 'design_ab12cd34' };
    const account = credentialIdToAccount(id);
    expect(account).toBe('design_publish_token::ws-1::design_ab12cd34');
    expect(accountToCredentialId(account)).toEqual(id);
  });

  test('malformed accounts are rejected', () => {
    expect(accountToCredentialId('design_publish_token::only-workspace')).toBeNull();
    expect(accountToCredentialId('design_publish_token::a::b::c')).toBeNull();
  });
});

describe('scanSnapshotForSecretCandidates / scanDesignShareData', () => {
  test('flags credential-looking kv keys, nested keys, and series names', () => {
    const candidates = scanSnapshotForSecretCandidates(
      JSON.stringify({
        version: 1,
        generatedAt: 1,
        kv: {
          summary: { total: 42 },
          apiKey: 'sk-live-123',
          config: { nested: { authToken: 'abc' } },
          items: [{ password: 'x' }],
        },
        series: { 'token.usage': [{ t: 1, v: 2 }], 'ci.duration': [{ t: 1, v: 2 }] },
      }),
    );
    expect(candidates).toContain('kv.apiKey');
    expect(candidates).toContain('kv.config.nested.authToken');
    expect(candidates).toContain('kv.items.password'); // array items keep the parent path
    expect(candidates).toContain('series.token.usage');
    expect(candidates).not.toContain('kv.summary');
    expect(candidates.some((c) => c.includes('ci.duration'))).toBe(false);
  });

  test('clean snapshots, malformed JSON, and non-object roots report nothing', () => {
    expect(
      scanSnapshotForSecretCandidates(
        JSON.stringify({ version: 1, generatedAt: 1, kv: { total: 1 }, series: { revenue: [] } }),
      ),
    ).toEqual([]);
    expect(scanSnapshotForSecretCandidates('{not json')).toEqual([]);
    expect(scanSnapshotForSecretCandidates('"just a string"')).toEqual([]);
  });

  test('the candidate list is capped', () => {
    const kv: Record<string, string> = {};
    for (let i = 0; i < 50; i++) kv[`apiKey${i}`] = 'x';
    const candidates = scanSnapshotForSecretCandidates(JSON.stringify({ version: 1, generatedAt: 1, kv, series: {} }));
    expect(candidates.length).toBe(20);
  });

  test('scanDesignShareData reads the snapshot once and pairs size with candidates', () => {
    const design = createDesign(root, { name: 'Scan Me', content: HTML });
    expect(scanDesignShareData(root, design.slug)).toEqual({ snapshotBytes: null, secretCandidates: [] });

    writeSnapshot(design.slug, { version: 1, generatedAt: 1, kv: { webhookSecret: 'shh', safe: 1 }, series: {} });
    const scan = scanDesignShareData(root, design.slug);
    expect(scan.snapshotBytes).toBeGreaterThan(0);
    expect(scan.secretCandidates).toEqual(['kv.webhookSecret']);
  });
});
