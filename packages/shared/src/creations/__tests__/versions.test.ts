import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listVersions,
  readVersion,
  recordVersion,
  suggestedVersionName,
  VERSIONS_KEPT,
} from '../versions'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'creation-versions-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const bytesOf = (text: string) => new TextEncoder().encode(text)

describe('creation versions', () => {
  it('records the first version and lists it newest first', async () => {
    const path = 'C:/work/report.md'
    await recordVersion(root, path, { bytes: bytesOf('one'), mtimeMs: 1000 })
    await recordVersion(root, path, { bytes: bytesOf('two'), mtimeMs: 2000 })

    const versions = await listVersions(root, path)
    expect(versions.map((version) => version.at)).toEqual([2000, 1000])
    expect(versions[0]?.id).toStartWith(versionIdOf('two'))
  })

  it('treats the same bytes as the same version, whatever the clock says', async () => {
    const path = 'C:/work/report.md'
    await recordVersion(root, path, { bytes: bytesOf('same'), mtimeMs: 1000 })
    await recordVersion(root, path, { bytes: bytesOf('same'), mtimeMs: 5000 })

    const versions = await listVersions(root, path)
    // A save that changed nothing adds nothing: the bytes are the identity, and the time on the
    // version is when that content first appeared (1000), not when it was last touched.
    expect(versions).toHaveLength(1)
    expect(versions[0]?.at).toBe(1000)
  })

  it('keeps a bounded window and drops the oldest', async () => {
    const path = 'C:/work/report.md'
    for (let index = 0; index < VERSIONS_KEPT + 3; index += 1) {
      await recordVersion(root, path, { bytes: bytesOf(`v${index}`), mtimeMs: 1000 + index * 10 })
    }
    const versions = await listVersions(root, path)
    expect(versions).toHaveLength(VERSIONS_KEPT)
    expect(versions[0]?.at).toBe(1000 + (VERSIONS_KEPT + 2) * 10)
    // the three oldest are gone
    expect(versions.some((version) => version.at === 1000)).toBe(false)
  })

  it('reads a version back byte for byte', async () => {
    const path = 'C:/work/report.md'
    const id = (await recordVersion(root, path, { bytes: bytesOf('hello 世界'), mtimeMs: 1 })) as string
    const read = await readVersion(root, path, id)
    expect(read && new TextDecoder().decode(read)).toBe('hello 世界')
  })

  it('refuses to read a name it could not have written', async () => {
    const path = 'C:/work/report.md'
    await recordVersion(root, path, { bytes: bytesOf('x'), mtimeMs: 1 })
    expect(await readVersion(root, path, '../../etc/passwd')).toBeNull()
    expect(await readVersion(root, path, 'not-a-version.md')).toBeNull()
  })

  it('has no versions for a work it never saw', async () => {
    expect(await listVersions(root, 'C:/work/never.md')).toEqual([])
  })

  it('names a version after the work and the minute it changed', () => {
    const name = suggestedVersionName('C:/work/report.md', { id: 'x', at: new Date(2026, 9, 31, 13, 42).getTime(), bytes: 1 })
    expect(name).toBe('report (2026-10-31 13-42).md')
  })
})

/** The hash half of a version's name, so the test can name what it expects without repeating it. */
function versionIdOf(text: string): string {
  // Mirrors `versionName` in versions.ts: sha256 of the bytes, first 12 hex characters.
  const hash = new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 12)
  return hash
}
