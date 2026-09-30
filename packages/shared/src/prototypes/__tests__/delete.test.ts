import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createPrototype, deletePrototype, getPrototypeDirPath, listPrototypeStatuses } from '..'

describe('deletePrototype', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-delete-prototype-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /** A prototype with a brief and some material beside it. */
  function makePrototype(slug: string): string {
    createPrototype(workspaceRoot, { name: slug })
    const dir = getPrototypeDirPath(workspaceRoot, slug)
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'notes.md'), '# notes\n', 'utf-8')
    return slug
  }

  it('removes the directory with everything in it', () => {
    const slug = makePrototype('orders')

    const deleted = deletePrototype(workspaceRoot, slug)

    expect(deleted.slug).toBe(slug)
    expect(deleted.dir).toBe(getPrototypeDirPath(workspaceRoot, slug))
    expect(existsSync(getPrototypeDirPath(workspaceRoot, slug))).toBe(false)
    expect(listPrototypeStatuses(workspaceRoot).map((status) => status.slug)).toEqual([])
  })

  it('leaves the other prototypes alone', () => {
    makePrototype('orders')
    makePrototype('quotes')

    deletePrototype(workspaceRoot, 'orders')

    expect(listPrototypeStatuses(workspaceRoot).map((status) => status.slug)).toEqual(['quotes'])
  })

  // A delete that silently does nothing would report success for a slug that was
  // never there.
  it('refuses an unknown prototype', () => {
    expect(() => deletePrototype(workspaceRoot, 'nope')).toThrow(/does not exist/)
  })
})
