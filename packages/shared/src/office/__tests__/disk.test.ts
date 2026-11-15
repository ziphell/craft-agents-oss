import { describe, expect, test } from 'bun:test'
import {
  digestOf,
  isGuardedDocument,
  sameStamp,
  saveVerdict,
  stampIsGone,
  type DiskRecord,
} from '../disk'

const record = (over: Partial<DiskRecord> = {}): DiskRecord => ({
  mtimeMs: 1000,
  size: 10,
  hash: 'aaa',
  ...over,
})

const stamp = (over: { mtimeMs?: number; size?: number; nlink?: number } = {}) => ({
  mtimeMs: 1000,
  size: 10,
  ...over,
})

describe('saveVerdict', () => {
  test('a file never recorded is not a conflict', async () => {
    expect(await saveVerdict(undefined, stamp(), () => 'zzz')).toBe('ok')
  })

  test('the same stamp is a save, without reading a hash', async () => {
    let asked = false
    const verdict = await saveVerdict(record(), stamp(), () => {
      asked = true
      return 'zzz'
    })
    expect(verdict).toBe('ok')
    // The fast path is the whole design: an ordinary save must not re-read the file.
    expect(asked).toBe(false)
  })

  test('a new mtime with the same content is a save (a touch is not an edit)', async () => {
    expect(await saveVerdict(record(), stamp({ mtimeMs: 2000 }), () => 'aaa')).toBe('ok')
  })

  test('a new size with different content is a conflict', async () => {
    expect(await saveVerdict(record(), stamp({ size: 99 }), () => 'bbb')).toBe('conflict')
  })

  test('a vanished file is a save: the write recreates it', async () => {
    expect(await saveVerdict(record(), null, () => 'bbb')).toBe('ok')
  })

  test('a replaced-by-rename file (nlink 0) is a save', async () => {
    expect(await saveVerdict(record(), stamp({ mtimeMs: 0, size: 0, nlink: 0 }), () => 'bbb')).toBe('ok')
  })

  test('when the hash cannot be read, a moved stamp is a conflict', async () => {
    expect(await saveVerdict(record(), stamp({ mtimeMs: 2000 }), () => null)).toBe('conflict')
  })
})

describe('stamps', () => {
  test('mtime and size decide, nlink does not', () => {
    expect(sameStamp({ mtimeMs: 1, size: 2, nlink: 1 }, { mtimeMs: 1, size: 2, nlink: 9 })).toBe(true)
    expect(sameStamp({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 3 })).toBe(false)
    expect(sameStamp(null, { mtimeMs: 1, size: 2 })).toBe(false)
  })

  test('gone means gone', () => {
    expect(stampIsGone(null)).toBe(true)
    expect(stampIsGone({ mtimeMs: 0, size: 0 })).toBe(true)
    expect(stampIsGone({ mtimeMs: 1, size: 0, nlink: 0 })).toBe(true)
    expect(stampIsGone({ mtimeMs: 1, size: 2, nlink: 1 })).toBe(false)
  })
})

describe('digestOf', () => {
  test('is SHA-256 in hex, over exactly the bytes given', async () => {
    expect(await digestOf(new Uint8Array([]))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(await digestOf(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('isGuardedDocument', () => {
  test('covers what an editor can hold open', () => {
    for (const name of ['a.docx', 'b.xlsx', 'c.pptx', 'd.pdf', 'e.md', 'f.html', 'g.DOCX']) {
      expect(isGuardedDocument(name)).toBe(true)
    }
  })

  test('leaves the rest alone', () => {
    for (const name of ['a.txt', 'b.json', 'c.ts', 'd.png', 'no-extension']) {
      expect(isGuardedDocument(name)).toBe(false)
    }
  })
})
