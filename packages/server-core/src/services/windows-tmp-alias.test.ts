import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureWindowsTmpAlias } from './windows-tmp-alias'

const isWindows = process.platform === 'win32'

describe('ensureWindowsTmpAlias', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tmp-alias-test-'))
  })

  afterEach(() => {
    // A junction is removed as the link it is; the target directory stays.
    rmSync(root, { recursive: true, force: true })
  })

  it('does nothing on other platforms', () => {
    const linkPath = join(root, 'tmp')
    const result = ensureWindowsTmpAlias(linkPath, join(root, 'target'), 'darwin')

    expect(result.status).toBe('unsupported')
    expect(existsSync(linkPath)).toBe(false)
  })

  it('links the drive-root spelling to the temp directory', () => {
    if (!isWindows) return

    const target = join(root, 'target')
    mkdirSync(target)
    const linkPath = join(root, 'tmp')

    expect(ensureWindowsTmpAlias(linkPath, target, 'win32').status).toBe('linked')
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)

    // The whole point: the same bytes are visible through either name.
    writeFileSync(join(linkPath, 'a.txt'), 'x')
    expect(readFileSync(join(target, 'a.txt'), 'utf-8')).toBe('x')

    expect(ensureWindowsTmpAlias(linkPath, target, 'win32').status).toBe('already-linked')
  })

  it('leaves a real directory untouched', () => {
    if (!isWindows) return

    const linkPath = join(root, 'tmp')
    mkdirSync(linkPath)
    writeFileSync(join(linkPath, 'keep.txt'), 'y')

    const result = ensureWindowsTmpAlias(linkPath, join(root, 'target'), 'win32')

    expect(result.status).toBe('skipped')
    expect(existsSync(join(linkPath, 'keep.txt'))).toBe(true)
  })

  it('leaves a link that points somewhere else untouched', () => {
    if (!isWindows) return

    const other = join(root, 'other')
    mkdirSync(other)
    const linkPath = join(root, 'tmp')
    ensureWindowsTmpAlias(linkPath, other, 'win32')

    const result = ensureWindowsTmpAlias(linkPath, join(root, 'target'), 'win32')

    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('already linked')
  })
})
