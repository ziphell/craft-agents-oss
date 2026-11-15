import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acknowledgeDocument,
  checkDocument,
  clearRecords,
  hasRecord,
  recordDocument,
  recordFromDisk,
  writeDocument,
} from '../guard'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'craft-guard-'))
  clearRecords()
})

afterEach(async () => {
  clearRecords()
  await rm(dir, { recursive: true, force: true })
})

/** Write a file and report the bytes, the way `file:readBinary` would. */
async function put(path: string, text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  await writeFile(path, bytes)
  return bytes
}

describe('the save guard', () => {
  test('a file read and then saved is not a conflict', async () => {
    const path = join(dir, 'brief.docx')
    const bytes = await put(path, 'first')
    await recordDocument(path, bytes)

    expect(await checkDocument(path)).toBe('ok')
  })

  test("somebody else's write is a conflict, and the file is untouched", async () => {
    const path = join(dir, 'brief.docx')
    await recordDocument(path, await put(path, 'first'))
    // The agent, through the CLI, or another program: a different file, same path.
    await writeFile(path, new TextEncoder().encode('second — longer than the first'))

    expect(await checkDocument(path)).toBe('conflict')
    expect(await readFile(path, 'utf8')).toBe('second — longer than the first')
  })

  test('a touch without a content change is a save, not a conflict', async () => {
    const path = join(dir, 'brief.docx')
    const bytes = await put(path, 'same bytes')
    await recordDocument(path, bytes)
    // Same length, different mtime: the stamp moves, the hash settles it.
    await writeFile(path, bytes)

    expect(await checkDocument(path)).toBe('ok')
  })

  test('a deleted file is a save: the write recreates it', async () => {
    const path = join(dir, 'brief.docx')
    await recordDocument(path, await put(path, 'first'))
    await rm(path)

    expect(await checkDocument(path)).toBe('ok')
  })

  test('recording after a save makes the next save clean again', async () => {
    const path = join(dir, 'brief.docx')
    await recordDocument(path, await put(path, 'first'))
    const written = await put(path, 'second')
    await recordDocument(path, written)

    expect(await checkDocument(path)).toBe('ok')
  })

  test('a reload (acknowledge) adopts what is on disk now', async () => {
    const path = join(dir, 'brief.docx')
    await recordDocument(path, await put(path, 'first'))
    await put(path, 'somebody else wrote this')
    expect(await checkDocument(path)).toBe('conflict')

    await acknowledgeDocument(path)

    expect(await checkDocument(path)).toBe('ok')
  })

  test('an unguarded extension is not tracked at all', async () => {
    const path = join(dir, 'notes.txt')
    await recordDocument(path, await put(path, 'first'))

    expect(hasRecord(path)).toBe(false)
    expect(await checkDocument(path)).toBe('ok')
  })

  test('recordFromDisk reads what an engine wrote, for the formats that cannot hand bytes back', async () => {
    const path = join(dir, 'deck.pptx')
    await put(path, 'written by the engine')
    await recordFromDisk(path)

    expect(hasRecord(path)).toBe(true)
    expect(await checkDocument(path)).toBe('ok')
  })

  test('writeDocument refuses a conflict and leaves the file alone', async () => {
    const path = join(dir, 'brief.docx')
    await recordDocument(path, await put(path, 'first'))
    await writeFile(path, new TextEncoder().encode('the agent wrote this instead'))

    await expect(
      writeDocument(path, async () => writeFile(path, new TextEncoder().encode('my version'))),
    ).rejects.toThrow(/changed on disk/)
    expect(await readFile(path, 'utf8')).toBe('the agent wrote this instead')
  })

  test('writeDocument with overwrite is the person saying "save anyway"', async () => {
    const path = join(dir, 'brief.docx')
    await recordDocument(path, await put(path, 'first'))
    await writeFile(path, new TextEncoder().encode('the agent wrote this instead'))

    await writeDocument(path, async () => writeFile(path, new TextEncoder().encode('my version')), {
      overwrite: true,
    })

    expect(await readFile(path, 'utf8')).toBe('my version')
    expect(await checkDocument(path)).toBe('ok')
  })
})
