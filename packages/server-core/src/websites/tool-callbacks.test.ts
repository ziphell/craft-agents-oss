import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWebsitesToolCallbacks } from './tool-callbacks'

// Pin dev-mode runtime resolution: write_website_data spawns the real Bun
// runtime via resolveScriptRuntime; under a packaged Craft Agents host (agent
// Bash sessions inherit CRAFT_IS_PACKAGED=true) it would flip into packaged-mode
// hardening and block the PATH fallback this suite relies on.
const SAVED_IS_PACKAGED = process.env.CRAFT_IS_PACKAGED
beforeAll(() => {
  process.env.CRAFT_IS_PACKAGED = '0'
})
afterAll(() => {
  if (SAVED_IS_PACKAGED === undefined) delete process.env.CRAFT_IS_PACKAGED
  else process.env.CRAFT_IS_PACKAGED = SAVED_IS_PACKAGED
})

describe('websites tool callbacks (end-to-end against a temp workspace)', () => {
  let workspace: string
  const mutations: string[] = []
  let callbacks: ReturnType<typeof buildWebsitesToolCallbacks>

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'craft-websites-tools-'))
    callbacks = buildWebsitesToolCallbacks({
      workspaceId: 'test-ws',
      workspaceRootPath: workspace,
      onWebsitesMutated: (slug) => { mutations.push(slug) },
    })
  })
  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('create → list → get round-trips through real storage', async () => {
    const created = await callbacks.createWebsite({
      name: 'Build Health',
      kind: 'live',
      description: 'CI dashboard',
      content: '<!doctype html><html><body>hi</body></html>',
    })
    expect(created.slug).toBe('build-health')
    expect(created.hasContent).toBe(true)
    expect(created.contentDigest).toBeDefined()
    expect(created.data).toBeNull()
    expect(mutations).toEqual(['build-health'])

    const listed = await callbacks.listWebsites()
    expect(listed.map(w => w.slug)).toEqual(['build-health'])

    const details = await callbacks.getWebsite('build-health', { includeContent: true })
    expect(details?.content).toContain('hi')
    expect(details?.contentPath.endsWith('index.html')).toBe(true)

    expect(await callbacks.getWebsite('missing')).toBeNull()
  })

  it('rejects path-traversal slugs at the tool boundary without escaping the workspace', async () => {
    const keep = await callbacks.createWebsite({ name: 'Keep Safe', content: '<p>x</p>' })

    // Reads: an unsafe slug is simply "not found" — never a traversal read.
    expect(await callbacks.getWebsite('..')).toBeNull()
    expect(await callbacks.getWebsite('../../etc')).toBeNull()

    // Mutations: rejected as "Website not found" via the loadWebsite/loadWebsiteConfig
    // guards, never reaching a filesystem path built from the bad slug.
    await expect(callbacks.writeWebsiteData('..', { set: { a: 1 } })).rejects.toThrow('Website not found')
    await expect(callbacks.updateWebsite('../x', { name: 'x' })).rejects.toThrow('Website not found')
    await expect(callbacks.deleteWebsite('../..')).rejects.toThrow('Website not found')

    // The real website and the workspace survive the rejected traversal attempts.
    expect(existsSync(workspace)).toBe(true)
    expect(await callbacks.getWebsite(keep.slug)).not.toBeNull()
  })

  it('update patches metadata, clears via null, and replaces content', async () => {
    const updated = await callbacks.updateWebsite('build-health', {
      name: 'Build Health v2',
      description: null,
      content: '<!doctype html><html><body>v2</body></html>',
    })
    expect(updated.name).toBe('Build Health v2')
    expect(updated.description).toBeUndefined()
    expect(updated.contentLength).toBeGreaterThan(0)

    await expect(callbacks.updateWebsite('missing', { name: 'x' })).rejects.toThrow('Website not found')
    await expect(callbacks.updateWebsite('build-health', { kind: 'wild' })).rejects.toThrow('Invalid website kind')
  })

  it('writeWebsiteData spawns the writer, exports the snapshot, and stamps website.json', async () => {
    const summary = await callbacks.writeWebsiteData('build-health', {
      set: { total: 42 },
      appendSeries: { latency: [{ t: 1000, v: 1 }, { t: 2000, v: 2 }] },
    })
    expect(summary.kvCount).toBe(1)
    expect(summary.seriesCount).toBe(1)
    expect(existsSync(summary.snapshotPath)).toBe(true)

    const details = await callbacks.getWebsite('build-health')
    expect(details?.lastRefresh?.ok).toBe(true)
    expect(details?.data?.kvKeys).toEqual(['total'])
    expect(details?.data?.series).toEqual([{ name: 'latency', points: 2, latest: { t: 2000, v: 2 } }])

    const snapshot = JSON.parse(readFileSync(summary.snapshotPath, 'utf-8'))
    expect(snapshot.kv.total).toBe(42)
  })

  it('delete removes the folder and reports the unpublish outcome', async () => {
    const result = await callbacks.deleteWebsite('build-health')
    expect(result).toEqual({ deleted: true, publicCopyMayRemain: false })
    expect(await callbacks.getWebsite('build-health')).toBeNull()
    expect(existsSync(join(workspace, 'websites', 'build-health'))).toBe(false)

    await expect(callbacks.deleteWebsite('build-health')).rejects.toThrow('Website not found')
  })
})
