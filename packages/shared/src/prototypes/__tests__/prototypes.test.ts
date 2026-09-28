import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  contentFingerprint,
  getPrototypeDirPath,
  getPrototypeResearchPath,
  getPrototypeReviewsPath,
  listPrototypeFiles,
} from '../storage'

describe('prototype paths', () => {
  const root = join('/workspace', 'prototypes')

  it('names the prototype directory and the directories inside it', () => {
    expect(getPrototypeDirPath('/workspace', 'checkout-flow')).toBe(join('/workspace', 'prototypes', 'checkout-flow'))
    expect(getPrototypeResearchPath('/workspace', 'checkout-flow')).toBe(
      join('/workspace', 'prototypes', 'checkout-flow', 'research'),
    )
    expect(getPrototypeReviewsPath('/workspace', 'checkout-flow')).toBe(
      join('/workspace', 'prototypes', 'checkout-flow', 'reviews'),
    )
    // The root is a workspace path, so the helper is what keeps the two apart.
    expect(root).toContain('prototypes')
  })
})

/**
 * The prototype's own directory is a folder of the author's files, and the workbench lists it as
 * one: recursively, in any format, no extension rule, no ownership rule.
 */
describe('listPrototypeFiles', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''
  let dir = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-files-'))
    dir = getPrototypeDirPath(workspaceRoot, slug)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('lists every file recursively in any format, with prototype-relative names', () => {
    writeFileSync(join(dir, 'PRD.md'), '## R-001 A cart holds its line\n', 'utf-8')
    writeFileSync(join(dir, 'personas.md'), '# who this is for\n', 'utf-8')
    // Not prose: a format the workbench never reads is still a file of this prototype.
    writeFileSync(join(dir, 'mock.png'), 'not really a png')
    writeFileSync(join(dir, 'flows.xlsx'), 'not really a workbook')
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'features.md'), '## R-002 x\n', 'utf-8')

    const listed = listPrototypeFiles(workspaceRoot, slug)

    expect(listed.map((file) => file.name)).toEqual([
      'PRD.md',
      'docs/features.md',
      'flows.xlsx',
      'mock.png',
      'personas.md',
    ])
    expect(listed.find((file) => file.name === 'docs/features.md')?.path).toBe(
      join(dir, 'docs', 'features.md'),
    )
  })

  it('skips hidden entries, and does not walk the record directories', () => {
    writeFileSync(join(dir, 'PRD.md'), '## R-001 x\n', 'utf-8')
    writeFileSync(join(dir, '.DS_Store'), '')
    writeFileSync(join(dir, 'notes.txt'), 'scratch')
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'assets', 'app.css'), '.a{}')
    mkdirSync(join(dir, '.hidden'), { recursive: true })
    writeFileSync(join(dir, '.hidden', 'x.md'), 'nope')
    mkdirSync(join(dir, 'research'), { recursive: true })
    writeFileSync(join(dir, 'research', 'F-001.md'), '# F-001 x\n')
    mkdirSync(join(dir, 'reviews'), { recursive: true })
    writeFileSync(join(dir, 'reviews', 'D-001.md'), '# D-001 x\n')

    const listed = listPrototypeFiles(workspaceRoot, slug)

    expect(listed.map((file) => file.name)).toEqual(['PRD.md', 'assets/app.css', 'notes.txt'])
  })

  it('answers an empty list rather than failing when the directory is gone', () => {
    expect(listPrototypeFiles(join(tmpdir(), 'craft-does-not-exist'), 'gone')).toEqual([])
  })
})

describe('contentFingerprint', () => {
  it('is stable for one source and different for another', () => {
    expect(contentFingerprint('a')).toBe(contentFingerprint('a'))
    expect(contentFingerprint('a')).not.toBe(contentFingerprint('b'))
  })

  it('is short enough to print beside a line and copy by hand', () => {
    expect(contentFingerprint('anything')).toMatch(/^[0-9a-f]{8}$/)
  })
})
