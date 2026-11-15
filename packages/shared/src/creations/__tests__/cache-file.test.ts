import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CREATIONS_CACHE_FILE, loadCache, saveCache } from '../cache-file'
import { createCreationsCache } from '../scan'
import { CREATIONS_INDEX_VERSION } from '../types'
import type { CreationsCache } from '../scan'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'creations-cache-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function cacheWithOne(): CreationsCache {
  const cache = createCreationsCache()
  cache.sessions.set('261101-ready-comet', {
    size: 4096,
    mtimeMs: 1000,
    name: 'a session',
    projectId: 'p1',
    toolRecords: 3,
    hits: [
      {
        path: '/workspace/sessions/261101-ready-comet/data/a.md',
        format: 'md',
        place: 'session',
        projectSlug: null,
        role: 'created',
        explicit: true,
        tool: 'Write',
        messageId: 'm1',
        turnId: 't1',
        at: 1000,
      },
    ],
  })
  return cache
}

describe('the remembered index', () => {
  it('comes back the same shape it was written', async () => {
    await saveCache(dir, cacheWithOne())
    const loaded = await loadCache(dir)

    expect(loaded).not.toBeNull()
    expect(loaded!.version).toBe(CREATIONS_INDEX_VERSION)
    expect([...loaded!.sessions.keys()]).toEqual(['261101-ready-comet'])
    expect(loaded!.sessions.get('261101-ready-comet')!.hits[0]!.path).toBe(
      '/workspace/sessions/261101-ready-comet/data/a.md',
    )
    expect(loaded!.sessions.get('261101-ready-comet')!.toolRecords).toBe(3)
  })

  it('leaves no temporary file behind', async () => {
    await saveCache(dir, cacheWithOne())
    expect(readdirSync(dir)).toEqual([CREATIONS_CACHE_FILE])
  })

  it('answers null when there is nothing written yet', async () => {
    expect(await loadCache(dir)).toBeNull()
  })

  it('answers null for a file that is not an index', async () => {
    writeFileSync(join(dir, CREATIONS_CACHE_FILE), 'not json at all')
    expect(await loadCache(dir)).toBeNull()

    writeFileSync(join(dir, CREATIONS_CACHE_FILE), JSON.stringify({ format: 1 }))
    expect(await loadCache(dir)).toBeNull()
  })

  it('discards an index a different parser wrote, and keeps one from this one', async () => {
    await saveCache(dir, cacheWithOne())
    const file = join(dir, CREATIONS_CACHE_FILE)
    const stored = JSON.parse(await Bun.file(file).text()) as Record<string, unknown>

    stored.indexVersion = CREATIONS_INDEX_VERSION - 1
    writeFileSync(file, JSON.stringify(stored))
    expect(await loadCache(dir)).toBeNull()

    stored.indexVersion = CREATIONS_INDEX_VERSION
    writeFileSync(file, JSON.stringify(stored))
    expect(await loadCache(dir)).not.toBeNull()
  })

  it('discards an index with one entry of the wrong shape rather than half-trusting it', async () => {
    await saveCache(dir, cacheWithOne())
    const file = join(dir, CREATIONS_CACHE_FILE)
    const stored = JSON.parse(await Bun.file(file).text()) as {
      sessions: Array<[string, Record<string, unknown>]>
    }
    stored.sessions[0]![1]!.hits = [{ path: 42 }]
    writeFileSync(file, JSON.stringify(stored))

    expect(await loadCache(dir)).toBeNull()
  })

  it('writes an empty index rather than failing on an empty workspace', async () => {
    await saveCache(dir, createCreationsCache())
    const loaded = await loadCache(dir)
    expect(loaded).not.toBeNull()
    expect(loaded!.sessions.size).toBe(0)
  })
})
