import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createPrototype,
  duplicatePrototype,
  getPrototypeDirPath,
} from '..'

describe('duplicatePrototype', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-duplicate-prototype-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /** A prototype with a brief and some material — something worth copying. */
  function makeSource(slug = 'orders'): string {
    createPrototype(workspaceRoot, { name: slug })
    const dir = getPrototypeDirPath(workspaceRoot, slug)
    writeFileSync(join(dir, 'personas.md'), '# who this is for\n', 'utf-8')
    writeFileSync(join(dir, 'mock.png'), 'not really a png')
    return slug
  }

  it('brings the whole folder over, under a new slug', () => {
    makeSource()

    const copied = duplicatePrototype(workspaceRoot, 'orders')
    const dir = getPrototypeDirPath(workspaceRoot, copied.slug)

    expect(copied.sourceSlug).toBe('orders')
    expect(copied.slug).toBe('orders-copy')
    expect(readFileSync(join(dir, 'spec.md'), 'utf-8')).toContain('.spec.md')
    expect(readFileSync(join(dir, 'personas.md'), 'utf-8')).toBe('# who this is for\n')
    expect(readFileSync(join(dir, 'mock.png'), 'utf-8')).toBe('not really a png')
  })

  // The two prototypes stop sharing anything the moment the copy exists: a copy
  // that read through to the source would be a link, not a copy.
  it('copies the material rather than pointing at it', () => {
    const source = makeSource()
    duplicatePrototype(workspaceRoot, source)

    writeFileSync(join(getPrototypeDirPath(workspaceRoot, source), 'personas.md'), '# changed\n', 'utf-8')

    expect(readFileSync(join(getPrototypeDirPath(workspaceRoot, 'orders-copy'), 'personas.md'), 'utf-8')).toBe(
      '# who this is for\n',
    )
  })

  it('carries a nested directory along', () => {
    const source = makeSource()
    const assetsDir = join(getPrototypeDirPath(workspaceRoot, source), 'assets', 'pages')
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(join(assetsDir, 'cart.js'), 'export const x = 1\n', 'utf-8')

    const copied = duplicatePrototype(workspaceRoot, source)

    expect(readFileSync(join(getPrototypeDirPath(workspaceRoot, copied.slug), 'assets', 'pages', 'cart.js'), 'utf-8'))
      .toBe('export const x = 1\n')
  })

  it('names the second copy differently, so copying twice in a row does not collide', () => {
    makeSource()

    expect(duplicatePrototype(workspaceRoot, 'orders').slug).toBe('orders-copy')
    expect(duplicatePrototype(workspaceRoot, 'orders').slug).toBe('orders-copy-2')
    expect(duplicatePrototype(workspaceRoot, 'orders-copy').slug).toBe('orders-copy-copy')
  })

  it('uses a requested name for the new slug', () => {
    makeSource()
    expect(duplicatePrototype(workspaceRoot, 'orders', { name: 'Checkout v2' }).slug).toBe('checkout-v2')
  })

  it('refuses a requested name that is already taken', () => {
    makeSource()
    expect(() => duplicatePrototype(workspaceRoot, 'orders', { name: 'orders' })).toThrow(/already exists/)
  })

  it('refuses an unknown prototype rather than creating one', () => {
    expect(() => duplicatePrototype(workspaceRoot, 'nope')).toThrow(/does not exist/)
  })
})
