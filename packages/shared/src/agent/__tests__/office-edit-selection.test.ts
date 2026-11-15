import { beforeEach, describe, expect, it } from 'bun:test'
import { executeOfficeToolCommand } from '../office-commands'
import {
  clearOpenDocuments,
  isDocumentOpen,
  openDocument,
  setDocumentDirty,
} from '../../office/open-documents'

/**
 * `edit-selection` — the one command that changes a document **inside the editor showing it**.
 *
 * What is under test is the decision, not the frame: whether the command asks the editor, refuses
 * when the editor is holding unsaved work, or tells the agent to write the file because nothing is
 * showing it. The frame half is covered by `office-edits.test.ts`.
 */
const WS = '/ws'
const FILE = '/ws/report.docx'

function command(overrides = '') {
  return `edit-selection ${FILE} --from 4 --to 9 --expect "Hello" --text "Hi"${overrides}`
}

/** A stand-in for the client bridge, recording what it was asked. */
function editor(answer: { ok: boolean; message?: string } | null = { ok: true }) {
  const calls: Array<{ path: string; edit: unknown }> = []
  return {
    calls,
    applyEdit: (path: string, edit: unknown) => {
      calls.push({ path, edit })
      return Promise.resolve(answer)
    },
  }
}

beforeEach(() => clearOpenDocuments())

describe('office_tool edit-selection', () => {
  it('asks the editor showing the document, with the fingerprint', async () => {
    openDocument(FILE, 'client-1')
    const bridge = editor()
    const result = await executeOfficeToolCommand({
      command: command(),
      workspaceRootPath: WS,
      applyEdit: bridge.applyEdit,
    })
    expect(bridge.calls).toEqual([{ path: FILE, edit: { from: 4, to: 9, expectedText: 'Hello', text: 'Hi' } }])
    expect(result.output).toContain('unsaved change')
  })

  it('tells the agent to write the file when no editor is showing it', async () => {
    const bridge = editor(null)
    const result = await executeOfficeToolCommand({
      command: command(),
      workspaceRootPath: WS,
      applyEdit: bridge.applyEdit,
    })
    expect(bridge.calls).toHaveLength(1)
    expect(result.output).toContain('No editor is showing')
    expect(result.output).toContain('apply --ops')
  })

  it('refuses when the editor holds unsaved work, before touching it', async () => {
    openDocument(FILE, 'client-1')
    setDocumentDirty(FILE, true)
    const bridge = editor()
    const result = await executeOfficeToolCommand({
      command: command(),
      workspaceRootPath: WS,
      applyEdit: bridge.applyEdit,
    })
    expect(bridge.calls).toHaveLength(0)
    expect(result.output).toContain('unsaved changes')
  })

  it('passes the editor’s refusal back with what to do about it', async () => {
    openDocument(FILE, 'client-1')
    const bridge = editor({ ok: false, message: 'the selection no longer holds what it held' })
    const result = await executeOfficeToolCommand({
      command: command(),
      workspaceRootPath: WS,
      applyEdit: bridge.applyEdit,
    })
    expect(result.output).toContain('the selection no longer holds what it held')
    expect(result.output).toContain('Read the span again')
  })

  it('sends a workbook to the file path instead of to an editor that cannot address it', async () => {
    const bridge = editor()
    const result = await executeOfficeToolCommand({
      command: 'edit-selection /ws/book.xlsx --from 0 --to 3 --expect "1" --text "2"',
      workspaceRootPath: WS,
      applyEdit: bridge.applyEdit,
    })
    // No round trip: that editor has no anchor shape for it yet, and naming the door that works is
    // more useful than a client answering "refused" for a reason the agent cannot act on.
    expect(bridge.calls).toHaveLength(0)
    expect(result.output).toContain('Word document in place')
    expect(result.output).toContain('apply --ops')
  })

  it('says so plainly when the host has no bridge at all', async () => {
    const result = await executeOfficeToolCommand({ command: command(), workspaceRootPath: WS })
    expect(result.output).toContain('No editor here can take an anchored edit')
    expect(isDocumentOpen(FILE)).toBe(false)
  })

  it('needs the fingerprint and the offsets', async () => {
    const result = await executeOfficeToolCommand({
      command: `edit-selection ${FILE} --from 4 --to 9 --text "Hi"`,
      workspaceRootPath: WS,
      applyEdit: editor().applyEdit,
    })
    expect(result.output).toContain('--expect')
  })
})
