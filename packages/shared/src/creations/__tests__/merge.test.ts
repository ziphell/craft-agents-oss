import { describe, expect, it } from 'bun:test'
import { mergeSnapshot } from '../merge'
import type { Creation, CreationsSnapshot } from '../types'

const ROOT = '/workspace'

function origin(overrides: Partial<Creation['last']> = {}): Creation['last'] {
  return {
    sessionId: 's1',
    sessionName: 'a session',
    messageId: 'm1',
    turnId: 't1',
    at: 1000,
    tool: 'Write',
    role: 'created',
    ...overrides,
  }
}

function creation(overrides: Partial<Creation> = {}): Creation {
  const last = overrides.last ?? origin()
  return {
    id: overrides.path ?? '/workspace/a.md',
    path: '/workspace/a.md',
    title: 'a.md',
    format: 'md',
    place: 'session',
    projectSlug: null,
    projectSlugs: [],
    bytes: 100,
    mtimeMs: 1000,
    exists: true,
    explicit: true,
    origins: [last],
    ...overrides,
    last,
  }
}

function snapshot(creations: Creation[], root = ROOT): CreationsSnapshot {
  return {
    generatedAt: Date.now(),
    workspaceRootPath: root,
    stats: { sessions: 1, parsed: 1, toolRecords: 1, hits: 1, shown: creations.length, hidden: 0, discovered: 0 },
    creations,
  }
}

describe('merging a snapshot', () => {
  it('answers with the first snapshot when there is nothing to merge into', () => {
    const next = snapshot([creation()])
    expect(mergeSnapshot(null, next)).toBe(next)
    expect(mergeSnapshot(undefined, next)).toBe(next)
  })

  it('keeps the previous snapshot itself when every work is unchanged', () => {
    const previous = snapshot([creation(), creation({ id: '/workspace/b.docx', path: '/workspace/b.docx', title: 'b.docx', format: 'docx' })])
    const next = snapshot(previous.creations.map((c) => ({ ...c })))

    expect(mergeSnapshot(previous, next)).toBe(previous)
  })

  it('keeps the instance of a work that did not change and replaces the one that did', () => {
    const before = creation()
    const untouched = creation({ id: '/workspace/b.md', path: '/workspace/b.md', title: 'b.md' })
    const previous = snapshot([before, untouched])

    const changed = { ...before, bytes: 200, mtimeMs: 2000 }
    const next = snapshot([{ ...changed }, { ...untouched }])
    const merged = mergeSnapshot(previous, next)

    expect(merged).not.toBe(previous)
    expect(merged.creations[0]).toEqual(changed)
    expect(merged.creations[0]).not.toBe(before)
    expect(merged.creations[1]).toBe(untouched)
  })

  it('treats a change a person can see as a change — a new origin, a new name, a deleted file', () => {
    const cases: Array<Partial<Creation>> = [
      { last: origin({ at: 2000 }), origins: [origin({ at: 2000 })] },
      { last: origin({ sessionName: 'renamed' }), origins: [origin({ sessionName: 'renamed' })] },
      { projectSlugs: ['somewhere'] },
      { exists: false },
      { title: 'renamed.md' },
    ]
    for (const change of cases) {
      const before = creation()
      const previous = snapshot([before])
      const next = snapshot([{ ...before, ...change } as Creation])
      expect(mergeSnapshot(previous, next).creations[0]).not.toBe(before)
    }
  })

  it('never lends objects across workspaces', () => {
    const before = creation()
    const previous = snapshot([before], '/one')
    const next = snapshot([{ ...before }], '/two')
    expect(mergeSnapshot(previous, next)).toBe(next)
  })

  it('hands back the previous answer — header and all — only when nothing at all changed', () => {
    const before = creation()
    const previous = snapshot([before])
    const next = snapshot([{ ...before }])
    next.generatedAt = 42

    // Deliberate: the client compares the answer by identity, so an equal answer that is a new
    // object still notifies every subscriber. Nothing changed → nothing to say.
    expect(mergeSnapshot(previous, next)).toBe(previous)
    expect(mergeSnapshot(previous, next).generatedAt).toBe(previous.generatedAt)
  })

  it('keeps the new header as soon as one work changed', () => {
    const before = creation()
    const previous = snapshot([before])
    const next = snapshot([{ ...before, bytes: 200 }])
    next.generatedAt = 42

    const merged = mergeSnapshot(previous, next)
    expect(merged.generatedAt).toBe(42)
  })
})
