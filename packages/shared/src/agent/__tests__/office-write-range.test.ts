import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeOfficeToolCommand } from '../office-commands'
import { clearOpenDocuments, openDocument, setDocumentDirty } from '../../office/open-documents'

/**
 * `write-range` — a block of cells written inside the editor showing the workbook.
 *
 * What is under test is the decision: the fingerprint is mandatory, a document is not a workbook,
 * unsaved work is refused before the editor is touched, and the editor's own refusal is passed on
 * with what to do about it.
 */
let dir = ''
beforeEach(() => {
  clearOpenDocuments()
  dir = mkdtempSync(join(tmpdir(), 'write-range-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'rows.json'), '[[1,2],[3,4]]')
  writeFileSync(join(dir, 'empty.json'), '[["",""],["",""]]')
})

function run(command: string, applyEdit?: (path: string, edit: unknown) => Promise<{ ok: boolean; message?: string } | null>) {
  return executeOfficeToolCommand({ command, workspaceRootPath: dir, ...(applyEdit ? { applyEdit } : {}) })
}

function bridge(answer: { ok: boolean; message?: string } | null = { ok: true }) {
  const calls: Array<{ path: string; edit: unknown }> = []
  return {
    calls,
    applyEdit: (path: string, edit: unknown) => {
      calls.push({ path, edit })
      return Promise.resolve(answer)
    },
  }
}

describe('office_tool write-range', () => {
  it('writes the block with expect-empty', async () => {
    const editor = bridge()
    const result = await run('write-range book.xlsx --range B2:C3 --values rows.json --expect-empty --sheet 汇总', editor.applyEdit)
    const file = join(dir, 'book.xlsx')
    expect(editor.calls).toEqual([
      { path: file, edit: { range: 'B2:C3', values: [[1, 2], [3, 4]], sheet: '汇总', expectEmpty: true } },
    ])
    expect(result.output).toContain('unsaved change')
  })

  it('passes an explicit expected grid through', async () => {
    const editor = bridge()
    await run('write-range book.xlsx --range A1:B2 --values rows.json --expect empty.json', editor.applyEdit)
    expect(editor.calls[0]!.edit).toEqual({ range: 'A1:B2', values: [[1, 2], [3, 4]], expected: [['', ''], ['', '']] })
  })

  it('refuses without a fingerprint', async () => {
    const editor = bridge()
    const result = await run('write-range book.xlsx --range A1:B2 --values rows.json', editor.applyEdit)
    expect(editor.calls).toHaveLength(0)
    expect(result.output).toContain('fingerprint')
  })

  it('refuses a non-workbook before asking any editor', async () => {
    const editor = bridge()
    const result = await run('write-range report.docx --range A1:B2 --values rows.json --expect-empty', editor.applyEdit)
    expect(editor.calls).toHaveLength(0)
    expect(result.output).toContain('write-range writes a workbook')
  })

  it('refuses unsaved work in the editor', async () => {
    const editor = bridge()
    openDocument(join(dir, 'book.xlsx'), 'client-1')
    setDocumentDirty(join(dir, 'book.xlsx'), true)
    const result = await run('write-range book.xlsx --range A1:B2 --values rows.json --expect-empty', editor.applyEdit)
    expect(editor.calls).toHaveLength(0)
    expect(result.output).toContain('unsaved changes')
  })

  it('says what to do when no editor is showing the workbook', async () => {
    const result = await run('write-range book.xlsx --range A1:B2 --values rows.json --expect-empty', bridge(null).applyEdit)
    expect(result.output).toContain('No editor is showing')
    expect(result.output).toContain('apply --ops')
  })

  it('passes the editor’s refusal back with a next step', async () => {
    const result = await run(
      'write-range book.xlsx --range A1:B2 --values rows.json --expect-empty',
      bridge({ ok: false, message: 'A1:B2 is not empty any more' }).applyEdit,
    )
    expect(result.output).toContain('A1:B2 is not empty any more')
    expect(result.output).toContain('sheet read')
  })

  it('rejects a values file that is not a 2-D array', async () => {
    writeFileSync(join(dir, 'flat.json'), '{"a":1}')
    const editor = bridge()
    const result = await run('write-range book.xlsx --range A1:B2 --values flat.json --expect-empty', editor.applyEdit)
    expect(editor.calls).toHaveLength(0)
    expect(result.output).toContain('2-D JSON array')
  })
})
