import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createPrototype,
  deletePrototype,
  getPrototypeDirPath,
  getPrototypePatchesPath,
  linkPrototypeReference,
  listPrototypePages,
  listPrototypeStatuses,
  readPrototypeConfig,
  writePrototypeConfig,
  writePrototypePage,
} from '..'

const PAGE = '<!doctype html><html><body><h1>Orders</h1></body></html>'

describe('deletePrototype', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-delete-prototype-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /** A prototype with a document of ours, or one whose only page is a live address. */
  function makePrototype(slug: string, kind: 'scratch' | 'overlay' = 'scratch'): string {
    createPrototype(workspaceRoot, { name: slug })
    if (kind === 'scratch') {
      writePrototypePage(workspaceRoot, slug, slug, PAGE)
    } else {
      writePrototypeConfig(workspaceRoot, slug, {
        pages: [{ name: 'cart', kind: 'overlay', url: 'https://app.example.com/checkout', entry: true }],
      })
    }
    return slug
  }

  it('removes the directory with everything in it', () => {
    const slug = makePrototype('orders')
    writeFileSync(join(getPrototypePatchesPath(workspaceRoot, slug), 'A-001-heading.css'), 'h1 { color: red; }', 'utf-8')

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

  // The relation lives in the *referring* prototype, so this reports it rather
  // than rewriting someone else's config behind their back.
  it('reports the prototypes left pointing at the deleted one, without touching them', () => {
    makePrototype('orders')
    makePrototype('quotes')
    linkPrototypeReference(workspaceRoot, 'quotes', 'orders')

    const deleted = deletePrototype(workspaceRoot, 'orders')

    expect(deleted.referencedBy).toEqual(['quotes'])
    expect(readPrototypeConfig(workspaceRoot, 'quotes').references ?? []).toEqual(['orders'])
  })

  it('reports nothing when no one references it', () => {
    makePrototype('orders')
    makePrototype('quotes')

    expect(deletePrototype(workspaceRoot, 'orders').referencedBy).toEqual([])
  })

  // A page that is a live address has no document to lose, but it is still a page:
  // deleting the prototype is what removes it.
  it('deletes a prototype whose only page is a live address', () => {
    const slug = makePrototype('rival', 'overlay')
    expect(listPrototypePages(workspaceRoot, slug).map((page) => page.kind)).toEqual(['overlay'])

    deletePrototype(workspaceRoot, slug)

    expect(existsSync(getPrototypeDirPath(workspaceRoot, slug))).toBe(false)
  })
})
