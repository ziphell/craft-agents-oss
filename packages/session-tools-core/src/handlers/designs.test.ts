import { describe, it, expect } from 'bun:test';
import {
  handleListDesigns,
  handleGetDesign,
  handleCreateDesign,
  handleUpdateDesign,
  handleWriteDesignData,
  handleDeleteDesign,
} from './designs.ts';
import type {
  SessionToolContext,
  DesignsToolCallbacks,
  DesignToolSummary,
  DesignToolDetails,
} from '../context.ts';

const SUMMARY: DesignToolSummary = {
  slug: 'build-health',
  name: 'Build Health',
  kind: 'prototype',
  projectId: 'proj_1',
  createdAt: 1,
  updatedAt: 2,
  hasContent: true,
  shared: false,
  folderPath: '/ws/designs/build-health',
};

const DETAILS: DesignToolDetails = {
  ...SUMMARY,
  id: 'design_1a2b3c4d',
  contentDigest: 'abc',
  contentLength: 128,
  contentPath: '/ws/designs/build-health/index.html',
  data: null,
  grants: [],
};

function createCtx(overrides?: Partial<DesignsToolCallbacks>): {
  ctx: SessionToolContext;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const designs: DesignsToolCallbacks = {
    listDesigns: () => { record('listDesigns'); return [SUMMARY, { ...SUMMARY, slug: 'notes', projectId: undefined }]; },
    getDesign: (slug, options) => { record('getDesign', slug, options); return slug === 'build-health' ? DETAILS : null; },
    createDesign: async (input) => { record('createDesign', input); return DETAILS; },
    updateDesign: async (slug, patch) => { record('updateDesign', slug, patch); return DETAILS; },
    writeDesignData: async (slug, patch) => {
      record('writeDesignData', slug, patch);
      return { slug, kvCount: 2, seriesCount: 1, generatedAt: 3, snapshotPath: '/ws/designs/build-health/data/snapshot.json', durationMs: 42 };
    },
    deleteDesign: async (slug) => { record('deleteDesign', slug); return { deleted: true, publicCopyMayRemain: false }; },
    ...overrides,
  };
  return { ctx: { designs } as unknown as SessionToolContext, calls };
}

describe('designs handlers', () => {
  it('all handlers degrade gracefully without the designs callbacks', async () => {
    const ctx = {} as unknown as SessionToolContext;
    for (const result of [
      await handleListDesigns(ctx, {}),
      await handleGetDesign(ctx, { slug: 's' }),
      await handleCreateDesign(ctx, { name: 'n' }),
      await handleUpdateDesign(ctx, { slug: 's', name: 'n' }),
      await handleWriteDesignData(ctx, { slug: 's', set: { a: 1 } }),
      await handleDeleteDesign(ctx, { slug: 's' }),
    ]) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not available');
    }
  });

  it('list_designs returns totals and supports the projectId filter', async () => {
    const { ctx } = createCtx();
    const all = JSON.parse((await handleListDesigns(ctx, {})).content[0].text);
    expect(all.total).toBe(2);

    const filtered = JSON.parse((await handleListDesigns(ctx, { projectId: 'proj_1' })).content[0].text);
    expect(filtered.total).toBe(1);
    expect(filtered.designs[0].slug).toBe('build-health');
  });

  it('get_design passes includeContent through and 404s unknown slugs', async () => {
    const { ctx, calls } = createCtx();
    const ok = await handleGetDesign(ctx, { slug: 'build-health', includeContent: true });
    expect(ok.isError).toBeFalsy();
    expect(calls[0]).toEqual({ method: 'getDesign', args: ['build-health', { includeContent: true }] });

    const missing = await handleGetDesign(ctx, { slug: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('list_designs');
  });

  it('create_design requires a name and returns the created details', async () => {
    const { ctx, calls } = createCtx();
    const noName = await handleCreateDesign(ctx, { name: '  ' });
    expect(noName.isError).toBe(true);
    expect(calls).toHaveLength(0);

    const created = await handleCreateDesign(ctx, { name: 'Build Health', content: '<!doctype html>' });
    expect(created.isError).toBeFalsy();
    expect(JSON.parse(created.content[0].text).slug).toBe('build-health');
  });

  it('update_design rejects empty patches without calling the backend', async () => {
    const { ctx, calls } = createCtx();
    const empty = await handleUpdateDesign(ctx, { slug: 'build-health' });
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text).toContain('Nothing to update');
    expect(calls).toHaveLength(0);

    const ok = await handleUpdateDesign(ctx, { slug: 'build-health', projectId: null });
    expect(ok.isError).toBeFalsy();
    expect(calls[0]).toEqual({ method: 'updateDesign', args: ['build-health', { projectId: null }] });
  });

  it('write_design_data separates slug from the patch and returns the summary', async () => {
    const { ctx, calls } = createCtx();
    const result = await handleWriteDesignData(ctx, {
      slug: 'build-health',
      set: { a: 1 },
      appendSeries: { m: [{ v: 2 }] },
    });
    expect(result.isError).toBeFalsy();
    expect(calls[0].args).toEqual(['build-health', { set: { a: 1 }, appendSeries: { m: [{ v: 2 }] } }]);
    expect(JSON.parse(result.content[0].text).kvCount).toBe(2);
  });

  it('delete_design reports the unpublish outcome and wraps backend failures', async () => {
    const { ctx } = createCtx();
    const ok = await handleDeleteDesign(ctx, { slug: 'build-health' });
    expect(JSON.parse(ok.content[0].text)).toEqual({ deleted: true, publicCopyMayRemain: false });

    const { ctx: failingCtx } = createCtx({
      deleteDesign: async () => { throw new Error('Design not found: nope'); },
    });
    const failed = await handleDeleteDesign(failingCtx, { slug: 'nope' });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain('Design not found');
  });
});
