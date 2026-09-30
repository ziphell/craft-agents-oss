import { describe, expect, it } from 'bun:test'
import type { StoredMessage } from '@craft-agent/core/types'
import { artifactWriteEventsFromMessages } from './from-session.ts'

/** A stored tool-call message, the shape the JSONL keeps for a tool. */
function toolMessage(
  toolName: string,
  toolInput: Record<string, unknown>,
  timestamp?: number,
): StoredMessage {
  return { id: 'm', type: 'tool', content: '', toolName, toolInput, timestamp }
}

const POSIX_ROOT = '/home/ryan/ws'
const WINDOWS_ROOT = 'C:\\Users\\Ryan\\code\\ws'

describe('artifactWriteEventsFromMessages', () => {
  it('reads a Write with a workspace-relative path', () => {
    const events = artifactWriteEventsFromMessages(
      's1',
      [toolMessage('Write', { file_path: 'flows/checkout.drawio' }, 42)],
      POSIX_ROOT,
    )
    expect(events).toEqual([{ sessionId: 's1', path: 'flows/checkout.drawio', at: 42 }])
  })

  it('reads Edit, MultiEdit and NotebookEdit the same way', () => {
    const events = artifactWriteEventsFromMessages(
      's1',
      [
        toolMessage('Edit', { file_path: 'a.drawio' }, 1),
        toolMessage('MultiEdit', { file_path: 'b.drawio' }, 2),
        toolMessage('NotebookEdit', { notebook_path: 'c.drawio' }, 3),
      ],
      POSIX_ROOT,
    )
    expect(events.map((event) => event.path)).toEqual(['a.drawio', 'b.drawio', 'c.drawio'])
  })

  it('ignores tools that do not write a file', () => {
    const events = artifactWriteEventsFromMessages(
      's1',
      [
        toolMessage('Read', { file_path: 'a.drawio' }, 1),
        toolMessage('Bash', { command: 'cp a.drawio b.drawio' }, 2),
        toolMessage('Grep', { path: 'a.drawio' }, 3),
        toolMessage('drawio_tool', { command: 'create' }, 4),
      ],
      POSIX_ROOT,
    )
    expect(events).toEqual([])
  })

  it('ignores paths that are not artifacts', () => {
    const events = artifactWriteEventsFromMessages(
      's1',
      [
        toolMessage('Write', { file_path: 'PRD.md' }, 1),
        toolMessage('Write', { file_path: 'src/index.ts' }, 2),
      ],
      POSIX_ROOT,
    )
    expect(events).toEqual([])
  })

  it('ignores an artifact under an ignored directory', () => {
    const events = artifactWriteEventsFromMessages(
      's1',
      [toolMessage('Write', { file_path: 'node_modules/pkg/a.drawio' }, 1)],
      POSIX_ROOT,
    )
    expect(events).toEqual([])
  })

  it('ignores an absolute path outside the workspace', () => {
    const events = artifactWriteEventsFromMessages(
      's1',
      [toolMessage('Write', { file_path: '/home/ryan/other/a.drawio' }, 1)],
      POSIX_ROOT,
    )
    expect(events).toEqual([])
  })

  it('ignores a relative path that climbs out of the workspace', () => {
    const events = artifactWriteEventsFromMessages(
      's1',
      [
        toolMessage('Write', { file_path: '../other/a.drawio' }, 1),
        toolMessage('Write', { file_path: '..\\other\\b.drawio' }, 2),
      ],
      POSIX_ROOT,
    )
    expect(events).toEqual([])
  })

  it('makes an absolute POSIX path workspace-relative', () => {
    const events = artifactWriteEventsFromMessages(
      's1',
      [toolMessage('Write', { file_path: '/home/ryan/ws/flows/a.drawio' }, 1)],
      POSIX_ROOT,
    )
    expect(events.map((event) => event.path)).toEqual(['flows/a.drawio'])
  })

  it('normalizes a Windows path the same as a POSIX one', () => {
    const events = artifactWriteEventsFromMessages(
      's1',
      [
        toolMessage('Write', { file_path: 'C:\\Users\\Ryan\\code\\ws\\flows\\a.drawio' }, 1),
        toolMessage('Edit', { file_path: 'flows\\b.drawio' }, 2),
        toolMessage('Write', { file_path: '.\\flows\\c.drawio' }, 3),
      ],
      WINDOWS_ROOT,
    )
    expect(events.map((event) => event.path)).toEqual([
      'flows/a.drawio',
      'flows/b.drawio',
      'flows/c.drawio',
    ])
  })

  it('ignores a Windows absolute path outside the workspace', () => {
    const events = artifactWriteEventsFromMessages(
      's1',
      [toolMessage('Write', { file_path: 'D:\\elsewhere\\a.drawio' }, 1)],
      WINDOWS_ROOT,
    )
    expect(events).toEqual([])
  })

  it('falls back to 0 when a record carries no timestamp', () => {
    const events = artifactWriteEventsFromMessages(
      's1',
      [toolMessage('Write', { file_path: 'a.drawio' })],
      POSIX_ROOT,
    )
    expect(events).toEqual([{ sessionId: 's1', path: 'a.drawio', at: 0 }])
  })

  it('has nothing for a message without a target path', () => {
    const events = artifactWriteEventsFromMessages(
      's1',
      [
        { id: 'm', type: 'tool', content: '', toolName: 'Write' },
        { id: 'm', type: 'assistant', content: 'writing', toolName: 'Write' },
      ],
      POSIX_ROOT,
    )
    expect(events).toEqual([])
  })
})
