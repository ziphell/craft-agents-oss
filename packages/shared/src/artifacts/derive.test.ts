import { describe, expect, it } from 'bun:test'
import {
  artifactKindOf,
  deriveArtifactEntries,
  deriveArtifactLinks,
  isArtifactPath,
} from './derive.ts'

describe('artifactKindOf', () => {
  it('names the drawio extension', () => {
    expect(artifactKindOf('flows/checkout.drawio')).toBe('drawio')
  })

  it('is case-insensitive on the extension', () => {
    expect(artifactKindOf('A.DRAWIO')).toBe('drawio')
  })

  it('is null for anything else', () => {
    expect(artifactKindOf('PRD.md')).toBeNull()
    expect(artifactKindOf('noext')).toBeNull()
    expect(artifactKindOf('.drawio')).toBeNull()
  })
})

describe('isArtifactPath', () => {
  it('accepts a drawio file anywhere in the workspace', () => {
    expect(isArtifactPath('flows/checkout.drawio')).toBe(true)
  })

  it('never walks node_modules or .git', () => {
    expect(isArtifactPath('node_modules/x/a.drawio')).toBe(false)
    expect(isArtifactPath('.git/a.drawio')).toBe(false)
  })

  it('reads a Windows path the same as a POSIX one', () => {
    expect(isArtifactPath('flows\\checkout.drawio')).toBe(true)
  })
})

describe('deriveArtifactEntries', () => {
  it('keeps only artifacts and sorts newest first', () => {
    const entries = deriveArtifactEntries([
      { path: 'a.drawio', mtimeMs: 10 },
      { path: 'PRD.md', mtimeMs: 99 },
      { path: 'nested/b.drawio', mtimeMs: 30 },
      { path: 'node_modules/c.drawio', mtimeMs: 50 },
    ])
    expect(entries.map((entry) => entry.path)).toEqual(['nested/b.drawio', 'a.drawio'])
    expect(entries.map((entry) => entry.mtimeMs)).toEqual([30, 10])
  })

  it('derives the title from the file name', () => {
    const [entry] = deriveArtifactEntries([{ path: 'flows/checkout.drawio', mtimeMs: 1 }])
    expect(entry?.title).toBe('checkout')
    expect(entry?.kind).toBe('drawio')
  })

  it('is a view of the input, not a mutation of it', () => {
    const files = [
      { path: 'b.drawio', mtimeMs: 1 },
      { path: 'a.drawio', mtimeMs: 2 },
    ]
    deriveArtifactEntries(files)
    expect(files.map((file) => file.path)).toEqual(['b.drawio', 'a.drawio'])
  })
})

describe('deriveArtifactLinks', () => {
  it('groups by path and keeps the latest write per conversation', () => {
    const links = deriveArtifactLinks([
      { sessionId: 's1', path: 'a.drawio', at: 1 },
      { sessionId: 's1', path: 'a.drawio', at: 5 },
      { sessionId: 's2', path: 'a.drawio', at: 3 },
    ])
    expect(links.get('a.drawio')).toEqual([
      { sessionId: 's1', at: 5 },
      { sessionId: 's2', at: 3 },
    ])
  })

  it('keeps every origin of a shared artifact', () => {
    const links = deriveArtifactLinks([
      { sessionId: 's1', path: 'a.drawio', at: 1 },
      { sessionId: 's2', path: 'a.drawio', at: 2 },
    ])
    expect(links.get('a.drawio')?.length).toBe(2)
  })

  it('reads a Windows path the same as a POSIX one', () => {
    const links = deriveArtifactLinks([
      { sessionId: 's1', path: 'flows\\a.drawio', at: 1 },
      { sessionId: 's2', path: 'flows/a.drawio', at: 2 },
    ])
    expect(links.get('flows/a.drawio')?.length).toBe(2)
  })

  it('has nothing for a path nobody wrote', () => {
    expect(deriveArtifactLinks([]).get('a.drawio')).toBeUndefined()
  })
})
