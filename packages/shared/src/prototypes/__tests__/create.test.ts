import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createPrototype,
  getPrototypeDirPath,
  prototypeSlugFromName,
  readPrototypeRequirements,
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
   * The spec *is* the deliverable now, so creation writes one: the alternative is
   * an agent that has to discover the shape of a requirement from the documentation
   * instead of from the file in front of it. Nothing else is seeded — the folder
   * beside it is the author's.
   */
  it('creates the directory and a starter PRD.md, and nothing else', () => {
    const created = createPrototype(workspaceRoot, { name: 'Checkout Flow' })

    expect(created.slug).toBe('checkout-flow')
    expect(created.dir).toBe(getPrototypeDirPath(workspaceRoot, 'checkout-flow'))
    expect(created.prdPath).toBe(join(created.dir, 'PRD.md'))
    expect(existsSync(created.prdPath)).toBe(true)

    // The whole directory, so the shape of a new prototype is checkable rather than
    // assumed.
    expect(readdirSync(created.dir).sort()).toEqual(['PRD.md'])
  })

  it('writes a brief the parser can read: a titled document with one requirement', () => {
    const created = createPrototype(workspaceRoot, { name: 'Checkout Flow' })
    const prd = readFileSync(created.prdPath, 'utf-8')

    expect(prd).toContain('# Checkout Flow')
    expect(prd).toContain('## R-001')

    const read = readPrototypeRequirements(workspaceRoot, created.slug)
    expect(read.issues).toEqual([])
    expect(read.requirements.map((requirement) => requirement.id)).toEqual(['R-001'])
    // The entry is prose under the heading: `check:` is not a concept any more, so there is
    // nothing to parse out of the body.
    expect(read.requirements[0]?.body).toContain('what a person cannot do today')
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
