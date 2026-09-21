import { describe, it, expect } from 'bun:test';
import {
  handleListWebsites,
  handleGetWebsite,
  handleCreateWebsite,
  handleUpdateWebsite,
  handleWriteWebsiteData,
  handleDeleteWebsite,
} from './websites.ts';
import type {
  SessionToolContext,
  WebsiteToolCallbacks,
  WebsiteToolSummary,
  WebsiteToolDetails,
} from '../context.ts';

const SUMMARY: WebsiteToolSummary = {
  slug: 'build-health',
  name: 'Build Health',
  kind: 'live',
  projectId: 'proj_1',
  createdAt: 1,
  updatedAt: 2,
  hasContent: true,
  shared: false,
  folderPath: '/ws/websites/build-health',
};

const DETAILS: WebsiteToolDetails = {
  ...SUMMARY,
  id: 'website_1a2b3c4d',
  contentDigest: 'abc',
  contentLength: 128,
  contentPath: '/ws/websites/build-health/index.html',
  data: null,
  grants: [],
};

function createCtx(overrides?: Partial<WebsiteToolCallbacks>): {
  ctx: SessionToolContext;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const websites: WebsiteToolCallbacks = {
    listWebsites: () => { record('listWebsites'); return [SUMMARY, { ...SUMMARY, slug: 'notes', projectId: undefined }]; },
    getWebsite: (slug, options) => { record('getWebsite', slug, options); return slug === 'build-health' ? DETAILS : null; },
    createWebsite: async (input) => { record('createWebsite', input); return DETAILS; },
    updateWebsite: async (slug, patch) => { record('updateWebsite', slug, patch); return DETAILS; },
    writeWebsiteData: async (slug, patch) => {
      record('writeWebsiteData', slug, patch);
      return { slug, kvCount: 2, seriesCount: 1, generatedAt: 3, snapshotPath: '/ws/websites/build-health/data/snapshot.json', durationMs: 42 };
    },
    deleteWebsite: async (slug) => { record('deleteWebsite', slug); return { deleted: true, publicCopyMayRemain: false }; },
    ...overrides,
  };
  return { ctx: { websites } as unknown as SessionToolContext, calls };
}

describe('websites handlers', () => {
  it('all handlers degrade gracefully without the websites callbacks', async () => {
    const ctx = {} as unknown as SessionToolContext;
    for (const result of [
      await handleListWebsites(ctx, {}),
      await handleGetWebsite(ctx, { slug: 's' }),
      await handleCreateWebsite(ctx, { name: 'n' }),
      await handleUpdateWebsite(ctx, { slug: 's', name: 'n' }),
      await handleWriteWebsiteData(ctx, { slug: 's', set: { a: 1 } }),
      await handleDeleteWebsite(ctx, { slug: 's' }),
    ]) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not available');
    }
  });

  it('list_websites returns totals and supports the projectId filter', async () => {
    const { ctx } = createCtx();
    const all = JSON.parse((await handleListWebsites(ctx, {})).content[0].text);
    expect(all.total).toBe(2);

    const filtered = JSON.parse((await handleListWebsites(ctx, { projectId: 'proj_1' })).content[0].text);
    expect(filtered.total).toBe(1);
    expect(filtered.websites[0].slug).toBe('build-health');
  });

  it('get_website passes includeContent through and 404s unknown slugs', async () => {
    const { ctx, calls } = createCtx();
    const ok = await handleGetWebsite(ctx, { slug: 'build-health', includeContent: true });
    expect(ok.isError).toBeFalsy();
    expect(calls[0]).toEqual({ method: 'getWebsite', args: ['build-health', { includeContent: true }] });

    const missing = await handleGetWebsite(ctx, { slug: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('list_websites');
  });

  it('create_website requires a name and returns the created details', async () => {
    const { ctx, calls } = createCtx();
    const noName = await handleCreateWebsite(ctx, { name: '  ' });
    expect(noName.isError).toBe(true);
    expect(calls).toHaveLength(0);

    const created = await handleCreateWebsite(ctx, { name: 'Build Health', kind: 'live', content: '<!doctype html>' });
    expect(created.isError).toBeFalsy();
    expect(JSON.parse(created.content[0].text).slug).toBe('build-health');
  });

  it('update_website rejects empty patches without calling the backend', async () => {
    const { ctx, calls } = createCtx();
    const empty = await handleUpdateWebsite(ctx, { slug: 'build-health' });
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text).toContain('Nothing to update');
    expect(calls).toHaveLength(0);

    const ok = await handleUpdateWebsite(ctx, { slug: 'build-health', projectId: null });
    expect(ok.isError).toBeFalsy();
    expect(calls[0]).toEqual({ method: 'updateWebsite', args: ['build-health', { projectId: null }] });
  });

  it('write_website_data separates slug from the patch and returns the summary', async () => {
    const { ctx, calls } = createCtx();
    const result = await handleWriteWebsiteData(ctx, {
      slug: 'build-health',
      set: { a: 1 },
      appendSeries: { m: [{ v: 2 }] },
    });
    expect(result.isError).toBeFalsy();
    expect(calls[0].args).toEqual(['build-health', { set: { a: 1 }, appendSeries: { m: [{ v: 2 }] } }]);
    expect(JSON.parse(result.content[0].text).kvCount).toBe(2);
  });

  it('delete_website reports the unpublish outcome and wraps backend failures', async () => {
    const { ctx } = createCtx();
    const ok = await handleDeleteWebsite(ctx, { slug: 'build-health' });
    expect(JSON.parse(ok.content[0].text)).toEqual({ deleted: true, publicCopyMayRemain: false });

    const { ctx: failingCtx } = createCtx({
      deleteWebsite: async () => { throw new Error('Website not found: nope'); },
    });
    const failed = await handleDeleteWebsite(failingCtx, { slug: 'nope' });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain('Website not found');
  });
});
