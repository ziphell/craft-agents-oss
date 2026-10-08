import { describe, it, expect, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDesignTarget } from '../design-preview-host'

function request(url: string, accept?: string): Request {
  return new Request(url, { headers: accept ? { accept } : {} })
}

describe('design-preview-host > resolveDesignTarget', () => {
  const root = mkdtempSync(join(tmpdir(), 'design-preview-'))
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>d</title>')
  writeFileSync(join(root, 'assets', 'panel.js'), 'export const x = 1\n')

  it('serves the document at the folder root and at its own name', async () => {
    expect(await resolveDesignTarget(root, '/', request('craft-local://l/', 'text/html'))).toBe(
      join(root, 'index.html'),
    )
    expect(await resolveDesignTarget(root, '/index.html', request('craft-local://l/index.html'))).toBe(
      join(root, 'index.html'),
    )
  })

  it('serves a sibling asset (the reason a design is a folder now)', async () => {
    expect(await resolveDesignTarget(root, '/assets/panel.js', request('craft-local://l/assets/panel.js'))).toBe(
      join(root, 'assets', 'panel.js'),
    )
  })

  it('serves the snapshot and nothing else inside data/', async () => {
    // `snapshot.json` is the artifact a design reads (and what a refresh script
    // regenerates); the store is the script-private working file.
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'snapshot.json'), '{"kv":{}}')
    writeFileSync(join(root, 'data', 'store.sqlite'), 'SQLite format 3\u0000')
    writeFileSync(join(root, 'data', 'store.sqlite-wal'), 'x')
    const get = (p: string) => resolveDesignTarget(root, p, request(`craft-local://l${p}`))
    expect(await get('/data/snapshot.json')).toBe(join(root, 'data', 'snapshot.json'))
    expect((await get('/DATA/snapshot.json'))?.toLowerCase()).toBe(join(root, 'data', 'snapshot.json').toLowerCase())
    expect(await get('/data/store.sqlite')).toBeNull()
    expect(await get('/data/store.sqlite-wal')).toBeNull()
    expect(await get('/data/')).toBeNull()
  })

  it('keeps every request inside the folder', async () => {
    expect(await resolveDesignTarget(root, '/../secret.txt', request('craft-local://l/../secret.txt'))).toBeNull()
    expect(await resolveDesignTarget(root, '/..%2fsecret.txt', request('craft-local://l/..%2fsecret.txt'))).toBeNull()
    expect(await resolveDesignTarget(root, '/assets/../../secret', request('craft-local://l/'))).toBeNull()
  })

  it('answers a route with the document, but a missing file with nothing', async () => {
    // A design's own history-style path still renders the document…
    expect(await resolveDesignTarget(root, '/settings', request('craft-local://l/settings', 'text/html'))).toBe(
      join(root, 'index.html'),
    )
    // …while a missing script must stay missing: an HTML answer would be a parse
    // error dressed up as a 200.
    expect(await resolveDesignTarget(root, '/assets/nope.js', request('craft-local://l/assets/nope.js'))).toBeNull()
    expect(await resolveDesignTarget(root, '/nothing', request('craft-local://l/nothing'))).toBeNull()
  })

  // The fixture has to outlive the `describe` body: this runs after the tests.
  afterAll(() => rmSync(root, { recursive: true, force: true }))
})
