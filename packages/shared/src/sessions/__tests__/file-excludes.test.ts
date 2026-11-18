import { describe, expect, it } from 'bun:test'
import {
  isExcluded,
  normalizeRelativePath,
  SESSION_EXPLORER_EXCLUDES,
  SESSION_WATCHER_EXCLUDES,
} from '../file-excludes.ts'

describe('normalizeRelativePath', () => {
  it('spells a watcher path the way the patterns do', () => {
    expect(normalizeRelativePath(String.raw`data\.tmp\a.ts`)).toBe('data/.tmp/a.ts')
    expect(normalizeRelativePath('./notes.md')).toBe('notes.md')
    expect(normalizeRelativePath('notes.md')).toBe('notes.md')
  })
})

describe('what the tree leaves out', () => {
  it('is version-control metadata and OS droppings — not dotfiles', () => {
    expect(isExcluded('.git', SESSION_EXPLORER_EXCLUDES)).toBe(true)
    expect(isExcluded('nested/.svn', SESSION_EXPLORER_EXCLUDES)).toBe(true)
    expect(isExcluded('.DS_Store', SESSION_EXPLORER_EXCLUDES)).toBe(true)
    expect(isExcluded('data/Thumbs.db', SESSION_EXPLORER_EXCLUDES)).toBe(true)
  })

  it('need only name the directory it prunes — the scan never looks inside', () => {
    // The watcher is handed file paths and so its list carries `**/.git/**`; the scan stops at the
    // directory entry itself, where `**/.git` is the whole story.
    expect(isExcluded('.git/config', SESSION_EXPLORER_EXCLUDES)).toBe(false)
    expect(isExcluded('.git/config', SESSION_WATCHER_EXCLUDES)).toBe(true)
  })

  it('still lists the person’s own hidden files', () => {
    // The whole point of not excluding by dot-prefix.
    expect(isExcluded('.env', SESSION_EXPLORER_EXCLUDES)).toBe(false)
    expect(isExcluded('.gitignore', SESSION_EXPLORER_EXCLUDES)).toBe(false)
    expect(isExcluded('data/.craft-notes.md', SESSION_EXPLORER_EXCLUDES)).toBe(false)
    expect(isExcluded('session.jsonl', SESSION_EXPLORER_EXCLUDES)).toBe(false)
  })

  it('leaves ordinary files alone', () => {
    expect(isExcluded('notes.md', SESSION_EXPLORER_EXCLUDES)).toBe(false)
    expect(isExcluded('data/out.csv', SESSION_EXPLORER_EXCLUDES)).toBe(false)
  })
})

describe('what does not wake the panel', () => {
  it('is everything the tree leaves out, plus what churns without changing it', () => {
    expect(isExcluded('.git/objects/ab/cdef', SESSION_WATCHER_EXCLUDES)).toBe(true)
    expect(isExcluded('node_modules/react/index.js', SESSION_WATCHER_EXCLUDES)).toBe(true)
    expect(isExcluded('data/.tmp/craft-sandbox-1.ts', SESSION_WATCHER_EXCLUDES)).toBe(true)
    expect(isExcluded('session.jsonl', SESSION_WATCHER_EXCLUDES)).toBe(true)
  })

  it('covers the scratch directory itself, not only its contents', () => {
    expect(isExcluded('data/.tmp', SESSION_WATCHER_EXCLUDES)).toBe(true)
    expect(isExcluded('data/.tmp/', SESSION_WATCHER_EXCLUDES)).toBe(true)
  })

  it('still wakes for what the panel shows', () => {
    expect(isExcluded('.hidden', SESSION_WATCHER_EXCLUDES)).toBe(false)
    expect(isExcluded('.env', SESSION_WATCHER_EXCLUDES)).toBe(false)
    expect(isExcluded('data/out.csv', SESSION_WATCHER_EXCLUDES)).toBe(false)
    // A folder merely *named* tmp is not the app's scratch: the pattern names the path.
    expect(isExcluded('tmp/a.txt', SESSION_WATCHER_EXCLUDES)).toBe(false)
    expect(isExcluded('data/tmp/a.txt', SESSION_WATCHER_EXCLUDES)).toBe(false)
  })
})
