import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDesignsToolCallbacks } from './tool-callbacks'

// Pin dev-mode runtime resolution: write_design_data spawns the real Bun runtime
// via resolveScriptRuntime; under a packaged Craft Agents host (agent Bash
// sessions inherit CRAFT_IS_PACKAGED=true) it would flip into packaged-mode
// hardening and block the PATH fallback this suite relies on.
const SAVED_IS_PACKAGED = process.env.CRAFT_IS_PACKAGED
beforeAll(() => {
  process.env.CRAFT_IS_PACKAGED = '0'
})
afterAll(() => {
  if (SAVED_IS_PACKAGED === undefined) delete process.env.CRAFT_IS_PACKAGED
  else process.env.CRAFT_IS_PACKAGED = SAVED_IS_PACKAGED
})

describe('designs tool callbacks (end-to-end against a temp workspace)', () => {
  let workspace: string
  const mutations: string[] = []
  let callbacks: ReturnType<typeof buildDesignsToolCallbacks>

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'craft-designs-tools-'))
    callbacks = buildDesignsToolCallbacks({
      workspaceId: 'test-ws',
      workspaceRootPath: workspace,
      onDesignsMutated: (slug) => { mutations.push(slug) },
    })
  })
  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('create → list → get round-trips through real storage', async () => {
    const created = await callbacks.createDesign({
      name: 'Build Health',
      description: 'CI dashboard',
      content: '<!doctype html><html><body>hi</body></html>',
    })
    expect(created.slug).toBe('build-health')
    expect(created.hasContent).toBe(true)
    expect(created.contentDigest).toBeDefined()
    expect(created.data).toBeNull()
    expect(mutations).toEqual(['build-health'])

    const listed = await callbacks.listDesigns()
    expect(listed.map(p => p.slug)).toEqual(['build-health'])

    const details = await callbacks.getDesign('build-health', { includeContent: true })
    expect(details?.content).toContain('hi')
    expect(details?.contentPath.endsWith('index.html')).toBe(true)

    expect(await callbacks.getDesign('missing')).toBeNull()
  })

  it('rejects path-traversal slugs at the tool boundary without escaping the workspace', async () => {
    const keep = await callbacks.createDesign({ name: 'Keep Safe', content: '<p>x</p>' })

    // Reads: an unsafe slug is simply "not found" — never a traversal read.
    expect(await callbacks.getDesign('..')).toBeNull()
    expect(await callbacks.getDesign('../../etc')).toBeNull()

    // Mutations: rejected as "Design not found" via the loadDesign/loadDesignConfig
    // guards, never reaching a filesystem path built from the bad slug.
    await expect(callbacks.writeDesignData('..', { set: { a: 1 } })).rejects.toThrow('Design not found')
    await expect(callbacks.updateDesign('../x', { name: 'x' })).rejects.toThrow('Design not found')
    await expect(callbacks.deleteDesign('../..')).rejects.toThrow('Design not found')

    // The real design and the workspace survive the rejected traversal attempts.
    expect(existsSync(workspace)).toBe(true)
    expect(await callbacks.getDesign(keep.slug)).not.toBeNull()
  })

  it('update patches metadata, clears via null, and replaces content', async () => {
    const updated = await callbacks.updateDesign('build-health', {
      name: 'Build Health v2',
      description: null,
      content: '<!doctype html><html><body>v2</body></html>',
    })
    expect(updated.name).toBe('Build Health v2')
    expect(updated.description).toBeUndefined()
    expect(updated.contentLength).toBeGreaterThan(0)

    await expect(callbacks.updateDesign('missing', { name: 'x' })).rejects.toThrow('Design not found')
  })

  it('writeDesignData spawns the writer, exports the snapshot, and stamps design.json', async () => {
    const summary = await callbacks.writeDesignData('build-health', {
      set: { total: 42 },
      appendSeries: { latency: [{ t: 1000, v: 1 }, { t: 2000, v: 2 }] },
    })
    expect(summary.kvCount).toBe(1)
    expect(summary.seriesCount).toBe(1)
    expect(existsSync(summary.snapshotPath)).toBe(true)

    const details = await callbacks.getDesign('build-health')
    expect(details?.lastRefresh?.ok).toBe(true)
    expect(details?.data?.kvKeys).toEqual(['total'])
    expect(details?.data?.series).toEqual([{ name: 'latency', points: 2, latest: { t: 2000, v: 2 } }])

    const snapshot = JSON.parse(readFileSync(summary.snapshotPath, 'utf-8'))
    expect(snapshot.kv.total).toBe(42)
  })

  it('round-trips a motion hint, clears it via null, and rejects invalid knobs', async () => {
    const set = await callbacks.updateDesign('build-health', {
      motion: { fps: 24, durationMs: 4000, aspect: '9:16' },
    })
    expect(set.motion).toEqual({ fps: 24, durationMs: 4000, aspect: '9:16' })

    const listed = await callbacks.getDesign('build-health')
    expect(listed?.motion).toEqual({ fps: 24, durationMs: 4000, aspect: '9:16' })

    // Invalid aspect / fps / duration are rejected at the tool boundary.
    await expect(callbacks.updateDesign('build-health', { motion: { aspect: '21:9' } }))
      .rejects.toThrow('Invalid motion aspect')
    await expect(callbacks.updateDesign('build-health', { motion: { fps: 999 } }))
      .rejects.toThrow('Invalid motion fps')
    await expect(callbacks.updateDesign('build-health', { motion: { durationMs: 1 } }))
      .rejects.toThrow('Invalid motion durationMs')

    const cleared = await callbacks.updateDesign('build-health', { motion: null })
    expect(cleared.motion).toBeUndefined()
  })

  it('delete removes the folder and reports the unpublish outcome', async () => {
    const result = await callbacks.deleteDesign('build-health')
    expect(result).toEqual({ deleted: true, publicCopyMayRemain: false })
    expect(await callbacks.getDesign('build-health')).toBeNull()
    expect(existsSync(join(workspace, 'designs', 'build-health'))).toBe(false)

    await expect(callbacks.deleteDesign('build-health')).rejects.toThrow('Design not found')
  })
})
