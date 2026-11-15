import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  handleForPath,
  resolveContentRoots,
  resolveFilePath,
  type ContentRoots,
} from '../content-paths.ts'

let workspace = ''
let project = ''
let sessionDir = ''

function projectRoots(): ContentRoots {
  const resolved = resolveContentRoots({
    sessionId: 's-1',
    workspaceRootPath: workspace,
    projectId: 'proj_demo',
    workingDirectory: project,
  })
  if (!resolved.ok) throw new Error(resolved.error)
  return resolved.roots
}

function sessionRoots(): ContentRoots {
  const resolved = resolveContentRoots({
    sessionId: 's-1',
    workspaceRootPath: workspace,
    workingDirectory: workspace,
  })
  if (!resolved.ok) throw new Error(resolved.error)
  return resolved.roots
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'craft-assets-'))
  writeFileSync(join(workspace, 'config.json'), '{}')
  project = join(workspace, 'projects', 'demo')
  mkdirSync(project, { recursive: true })
  writeFileSync(
    join(project, 'config.json'),
    JSON.stringify({ id: 'proj_demo', slug: 'demo', name: 'Demo' }),
  )
  sessionDir = join(workspace, 'sessions', 's-1')
})

afterEach(() => rmSync(workspace, { recursive: true, force: true }))

describe('the content root', () => {
  it('is the project a conversation belongs to', () => {
    const roots = projectRoots()
    expect(roots.contentRoot).toBe(project)
    expect(roots.bareHandles).toBe(true)
  })

  it('is the session folder when the conversation is in no project', () => {
    const roots = sessionRoots()
    expect(roots.contentRoot).toBe(sessionDir)
    expect(roots.bareHandles).toBe(false)
  })

  it('refuses a project binding whose project is gone, rather than falling back', () => {
    const resolved = resolveContentRoots({
      sessionId: 's-1',
      workspaceRootPath: workspace,
      projectId: 'proj_missing',
    })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.error).toContain('no longer in this workspace')
  })

  it('does not treat a working directory inside a project as a binding', () => {
    const resolved = resolveContentRoots({
      sessionId: 's-1',
      workspaceRootPath: workspace,
      // The agent happens to stand in the project folder, but the conversation is attached to none.
      workingDirectory: project,
    })
    if (!resolved.ok) throw new Error(resolved.error)
    const roots = resolved.roots

    expect(roots.projectDir).toBeNull()
    expect(roots.contentRoot).toBe(sessionDir)
    expect(roots.bareHandles).toBe(false)
    expect(resolveFilePath('project:assets/a.png', roots).ok).toBe(false)

    // The same folder is still reachable by naming it as the working directory.
    const viaCwd = resolveFilePath('cwd:assets/a.png', roots)
    expect(viaCwd.ok && viaCwd.path).toBe(join(project, 'assets', 'a.png'))
  })
})

describe('handles', () => {
  it('anchors a bare path to the project and prints it bare', () => {
    const resolved = resolveFilePath('assets/a.png', projectRoots())
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.path).toBe(join(project, 'assets', 'a.png'))
      expect(resolved.handle).toBe('assets/a.png')
    }
  })

  it('anchors a bare path to the session folder outside a project, and says so', () => {
    const resolved = resolveFilePath('assets/a.png', sessionRoots())
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.path).toBe(join(sessionDir, 'assets', 'a.png'))
      expect(resolved.handle).toBe('session:assets/a.png')
    }
  })

  it('names the project, session, cwd and workspace explicitly', () => {
    const roots = projectRoots()
    const cases: Array<[string, string, string]> = [
      ['project:assets/a.png', join(project, 'assets', 'a.png'), 'assets/a.png'],
      ['session:assets/a.png', join(sessionDir, 'assets', 'a.png'), 'session:assets/a.png'],
      ['cwd:assets/a.png', join(project, 'assets', 'a.png'), 'assets/a.png'],
      ['workspace:notes/a.md', join(workspace, 'notes', 'a.md'), 'workspace:notes/a.md'],
    ]
    for (const [handle, path, printed] of cases) {
      const resolved = resolveFilePath(handle, roots)
      expect(resolved.ok).toBe(true)
      if (resolved.ok) {
        expect(resolved.path).toBe(path)
        expect(resolved.handle).toBe(printed)
      }
    }
  })

  it('refuses project: outside a project, by name', () => {
    const resolved = resolveFilePath('project:assets/a.png', sessionRoots())
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.error).toContain('not in one')
  })

  it('normalises an absolute path inside a root to the matching handle', () => {
    const roots = projectRoots()
    const inside = resolveFilePath(join(project, 'assets', 'a.png'), roots)
    expect(inside.ok).toBe(true)
    if (inside.ok) expect(inside.handle).toBe('assets/a.png')

    const inSession = resolveFilePath(join(sessionDir, 'assets', 'b.png'), roots)
    expect(inSession.ok).toBe(true)
    if (inSession.ok) expect(inSession.handle).toBe('session:assets/b.png')
  })

  it('refuses an absolute path outside every root', () => {
    const outside = join(tmpdir(), 'elsewhere', 'a.png')
    const resolved = resolveFilePath(outside, projectRoots())
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.error).toContain('outside')
  })

  it('refuses a URL rather than treating it as a file', () => {
    for (const value of ['https://example.com/a.png', 'data:image/png;base64,AAAA', 's3://bucket/a.png']) {
      const resolved = resolveFilePath(value, projectRoots())
      expect(resolved.ok).toBe(false)
      if (!resolved.ok) expect(resolved.error).toContain('URL')
    }
  })

  it('refuses a bare path that climbs out of the root', () => {
    const resolved = resolveFilePath('../outside.png', projectRoots())
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.error).toContain('outside')
  })

  it('prints the same handle for the same file, so the next command takes it', () => {
    const roots = projectRoots()
    const first = resolveFilePath('assets/a.png', roots)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const again = resolveFilePath(first.handle, roots)
    expect(again.ok).toBe(true)
    if (again.ok) {
      expect(again.path).toBe(first.path)
      expect(again.handle).toBe(first.handle)
    }
  })
})

describe('moving a conversation in and out of a project', () => {
  it('points the same bare handle at the project after the move, and at the session before it', () => {
    const before = resolveFilePath('assets/a.png', sessionRoots())
    const after = resolveFilePath('assets/a.png', projectRoots())
    expect(before.ok && before.path).toBe(join(sessionDir, 'assets', 'a.png'))
    expect(after.ok && after.path).toBe(join(project, 'assets', 'a.png'))

    // A file left in the session folder is still reachable after the move, by its own handle.
    if (before.ok) expect(handleForPath(before.path, projectRoots())).toBe('session:assets/a.png')
  })
})
