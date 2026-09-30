import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createPrototype,
  getPrototypeDirPath,
  prototypeSlugFromName,
  readPrototypeSpecs,
} from '..'

describe('prototypeSlugFromName', () => {
  it('lowercases and collapses anything outside [a-z0-9] into a dash', () => {
    expect(prototypeSlugFromName('Checkout Flow v2')).toBe('checkout-flow-v2')
    expect(prototypeSlugFromName('  Quotes   &   Orders  ')).toBe('quotes-orders')
  })

  it('cannot produce a path-escaping slug, whatever the name', () => {
    // The point is not that these names are sensible — it is that none of them
    // can address something outside the prototypes directory.
    for (const name of ['../../etc/passwd', '..\\..\\windows', '/absolute/path', 'a/../b']) {
      const slug = prototypeSlugFromName(name)
      expect(slug).not.toContain('/')
      expect(slug).not.toContain('\\')
      expect(slug).not.toContain('..')
    }
  })

  it('produces an empty slug for a name with no usable characters', () => {
    expect(prototypeSlugFromName('!!!')).toBe('')
    expect(prototypeSlugFromName('中文名称')).toBe('')
  })
})

describe('createPrototype', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-create-prototype-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /**
   * The entry is an index, and a new prototype starts with **no spec**: the spec *is* the
   * deliverable now, so creation writes the index that says where a spec goes rather than
   * seeding an example the author would have to unlearn. Nothing else is seeded — the folder beside
   * it is the author's.
   */
  it('creates the directory and a starter spec.md, and nothing else', () => {
    const created = createPrototype(workspaceRoot, { name: 'Checkout Flow' })

    expect(created.slug).toBe('checkout-flow')
    expect(created.dir).toBe(getPrototypeDirPath(workspaceRoot, 'checkout-flow'))
    expect(created.entryPath).toBe(join(created.dir, 'spec.md'))
    expect(existsSync(created.entryPath)).toBe(true)

    // The whole directory, so the shape of a new prototype is checkable rather than assumed.
    expect(readdirSync(created.dir).sort()).toEqual(['spec.md'])
  })

  it('seeds an index that states no spec: a titled spec.md that names the *.spec.md rule', () => {
    const created = createPrototype(workspaceRoot, { name: 'Checkout Flow' })
    const entry = readFileSync(created.entryPath, 'utf-8')

    expect(entry).toContain('# Checkout Flow')
    expect(entry).toContain('.spec.md')

    // A new prototype starts with zero specs — the empty state the prompt and the page name.
    const read = readPrototypeSpecs(workspaceRoot, created.slug)
    expect(read.issues).toEqual([])
    expect(read.specs).toEqual([])
  })

  it('refuses to reuse an existing prototype rather than mixing two prototypes’ files', () => {
    createPrototype(workspaceRoot, { name: 'Checkout Flow' })

    expect(() => createPrototype(workspaceRoot, { name: 'checkout-flow' })).toThrow(/already exists/)
  })

  it('refuses a name that yields no usable slug', () => {
    expect(() => createPrototype(workspaceRoot, { name: '!!!' })).toThrow(/usable slug/)
    // …and leaves nothing behind.
    expect(existsSync(getPrototypeDirPath(workspaceRoot, ''))).toBe(false)
  })
})
