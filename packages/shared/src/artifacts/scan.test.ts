import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { deriveArtifactEntries } from './derive.ts'
import { scanArtifactFiles } from './scan.ts'

describe('scanArtifactFiles', () => {
  it('walks a workspace, skips ignored directories, and reports POSIX-relative paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-artifacts-'))
    try {
      writeFileSync(join(root, 'a.drawio'), '<x/>')
      mkdirSync(join(root, 'flows'))
      writeFileSync(join(root, 'flows', 'b.drawio'), '<x/>')
      mkdirSync(join(root, 'node_modules'))
      writeFileSync(join(root, 'node_modules', 'c.drawio'), '<x/>')
      mkdirSync(join(root, '.git'))
      writeFileSync(join(root, '.git', 'd.drawio'), '<x/>')

      const entries = deriveArtifactEntries(scanArtifactFiles(root))
        .map((entry) => entry.path)
        .sort()
      expect(entries).toEqual(['a.drawio', 'flows/b.drawio'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
