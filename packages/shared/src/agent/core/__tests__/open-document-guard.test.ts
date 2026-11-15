import { beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { runPreToolUseChecks, type PreToolUseInput } from '../pre-tool-use'
import {
  clearOpenDocuments,
  closeDocument,
  openDocument,
  setDocumentDirty,
} from '../../../office/open-documents'

/**
 * The guard that keeps `Edit`/`Write` off a file somebody is looking at.
 *
 * `office_tool` refuses this for itself; these built-in tools never pass through it, and an agent's
 * `Edit` under an open editor is the case that costs a person their unsaved work. The pipeline is
 * the one place both backends share, so it is where the check lives — and this is the test that
 * says it is wired.
 */
/** The guard compares resolved paths — the editor registers what the file system calls the file. */
const OPEN_FILE = resolve('/ws/report.md')

function input(overrides: Partial<PreToolUseInput> = {}): PreToolUseInput {
  return {
    toolName: 'Edit',
    input: { file_path: '/ws/report.md', old_string: 'a', new_string: 'b' },
    sessionId: 'test-session',
    permissionMode: 'allow-all',
    workspaceRootPath: '/ws',
    workspaceId: 'test-ws',
    workingDirectory: '/ws',
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: true,
    permissionManager: {
      isCommandWhitelisted: () => false,
      isDangerousCommand: () => false,
      getBaseCommand: (cmd: string) => cmd.split(/\s+/)[0] || cmd,
      extractDomainFromNetworkCommand: () => null,
      isDomainWhitelisted: () => false,
    },
    ...overrides,
  } as PreToolUseInput
}

beforeEach(() => clearOpenDocuments())

describe('writing a document an editor is showing', () => {
  it('refuses an Edit over unsaved work and says who to ask', () => {
    openDocument(OPEN_FILE)
    setDocumentDirty(OPEN_FILE, true)
    const result = runPreToolUseChecks(input())
    expect(result.type).toBe('block')
    if (result.type === 'block') {
      expect(result.reason).toContain('unsaved changes')
      // The reason has to name the way out, or it is only a wall.
      expect(result.reason).toContain('save or close')
    }
  })

  it('refuses Write and MultiEdit the same way', () => {
    openDocument(OPEN_FILE)
    setDocumentDirty(OPEN_FILE, true)
    expect(runPreToolUseChecks(input({ toolName: 'Write' })).type).toBe('block')
    expect(runPreToolUseChecks(input({ toolName: 'MultiEdit' })).type).toBe('block')
  })

  it('lets a different file through', () => {
    openDocument(OPEN_FILE)
    setDocumentDirty(OPEN_FILE, true)
    const result = runPreToolUseChecks(input({ input: { file_path: resolve('/ws/other.md') } }))
    expect(result.type).not.toBe('block')
  })

  it('lets the same file through once the work is saved or the editor closes', () => {
    openDocument(OPEN_FILE)
    setDocumentDirty(OPEN_FILE, true)
    expect(runPreToolUseChecks(input()).type).toBe('block')
    // Saved: the editor still shows it, but nothing is at stake.
    setDocumentDirty(OPEN_FILE, false)
    expect(runPreToolUseChecks(input()).type).not.toBe('block')
    // Closed: not even a candidate.
    closeDocument(OPEN_FILE)
    expect(runPreToolUseChecks(input()).type).not.toBe('block')
  })

  it('allows a write under an editor that has typed nothing', () => {
    // The ordinary case, and the reason this guard is about work rather than about windows: the
    // editor holds exactly what the disk holds, so the write is a version bump it can reload.
    openDocument(OPEN_FILE)
    expect(runPreToolUseChecks(input()).type).not.toBe('block')
  })

  it('does not block reads of an open document', () => {
    openDocument(OPEN_FILE)
    const read = runPreToolUseChecks(input({ toolName: 'Read', input: { file_path: OPEN_FILE } }))
    expect(read.type).not.toBe('block')
  })
})

describe('the way out it offers', () => {
  /** What the guard says for a dirty document, given its path. */
  const refusalFor = (path: string) => {
    clearOpenDocuments()
    openDocument(path)
    setDocumentDirty(path, true)
    const result = runPreToolUseChecks(input({ input: { file_path: path, old_string: 'a', new_string: 'b' } }))
    return result.type === 'block' ? result.reason : null
  }

  it('names markdown_tool for a markdown file, because that edit can land in the editor', () => {
    const reason = refusalFor(OPEN_FILE)
    expect(reason).toContain('unsaved changes')
    expect(reason).toContain('markdown_tool edit')
    expect(reason).toContain('one step the person can undo')
  })

  it('says nothing about it for a file no tool can edit in place', () => {
    const reason = refusalFor(resolve('/ws/notes.txt'))
    expect(reason).toContain('unsaved changes')
    expect(reason).not.toContain('markdown_tool')
  })

  it('does not get in the way of a clean document', () => {
    clearOpenDocuments()
    openDocument(OPEN_FILE)
    // Whatever else the pipeline says about the call, this guard says nothing: a file nobody has typed in holds
    // exactly what the disk holds, and writing there is ordinary.
    expect(runPreToolUseChecks(input()).type).not.toBe('block')
  })
})
