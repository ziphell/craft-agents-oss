import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { listFiles } from '../files'

/**
 * A folder is a folder of the author's files, and the workbench lists it as
 * one: recursively, in any format, no extension rule, no ownership rule.
 */
describe('listFiles', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''
  let dir = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-project-files-'))
    dir = join(workspaceRoot, 'projects', slug)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('lists every file recursively in any format, with folder-relative names', () => {
    writeFileSync(join(dir, 'spec.md'), '# Checkout flow\n', 'utf-8')
    writeFileSync(join(dir, 'personas.md'), '# who this is for\n', 'utf-8')
    // Not prose: a format the workbench never reads is still a file of this folder.
    writeFileSync(join(dir, 'mock.png'), 'not really a png')
    writeFileSync(join(dir, 'flows.xlsx'), 'not really a workbook')
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'features.md'), '# Features\n', 'utf-8')

    const listed = listFiles(dir)

    expect(listed.map((file) => file.name)).toEqual([
      'docs/features.md',
      'flows.xlsx',
      'mock.png',
      'personas.md',
      'spec.md',
    ])
    expect(listed.find((file) => file.name === 'docs/features.md')?.path).toBe(
      join(dir, 'docs', 'features.md'),
    )
  })

  it('skips hidden entries and lists everything else', () => {
    writeFileSync(join(dir, 'spec.md'), '# Checkout flow\n', 'utf-8')
    writeFileSync(join(dir, '.DS_Store'), '')
    writeFileSync(join(dir, 'notes.txt'), 'scratch')
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'assets', 'app.css'), '.a{}')
    mkdirSync(join(dir, '.hidden'), { recursive: true })
    writeFileSync(join(dir, '.hidden', 'x.md'), 'nope')

    const listed = listFiles(dir)

    // No folder is set aside: whatever the author put there is listed.
    expect(listed.map((file) => file.name)).toEqual([
      'assets/app.css',
      'notes.txt',
      'spec.md',
    ])
  })

  it('answers an empty list rather than failing when the directory is gone', () => {
    expect(listFiles(join(tmpdir(), 'craft-does-not-exist', 'gone'))).toEqual([])
  })
})
