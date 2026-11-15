import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeOfficeToolCommand } from '../office-commands'
import { clearOpenDocuments, openDocument, setDocumentDirty } from '../../office/open-documents'

/**
 * `replace-slide-text` — a phrase replaced on one slide, inside the editor showing the deck.
 *
 * The anchor is the phrase **and how many times it occurs**, which is the fingerprint the deck can
 * check before changing anything. What these cases pin is the decision, not the deck.
 */
let dir = ''
beforeEach(() => {
  clearOpenDocuments()
  dir = mkdtempSync(join(tmpdir(), 'deck-'))
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

const CMD = 'replace-slide-text deck.pptx --slide 2 --find "Q3 revenue" --replace "Q4 revenue"'

describe('office_tool replace-slide-text', () => {
  it('defaults the count to one and passes the anchor through', async () => {
    const editor = bridge()
    await run(CMD, editor.applyEdit)
    expect(editor.calls).toEqual([
      { path: join(dir, 'deck.pptx'), edit: { slide: 2, find: 'Q3 revenue', replace: 'Q4 revenue', expectCount: 1 } },
    ])
  })

  it('carries an explicit count and an element id', async () => {
    const editor = bridge()
    await run(`${CMD} --count 3 --element el_7`, editor.applyEdit)
    expect(editor.calls[0]!.edit).toEqual({
      slide: 2,
      find: 'Q3 revenue',
      replace: 'Q4 revenue',
      expectCount: 3,
      elementId: 'el_7',
    })
  })

  it('refuses a file that is not a deck', async () => {
    const editor = bridge()
    const result = await run('replace-slide-text notes.md --slide 1 --find a --replace b', editor.applyEdit)
    expect(editor.calls).toHaveLength(0)
    expect(result.output).toContain('not a .pptx')
  })

  it('refuses unsaved work in the editor', async () => {
    const editor = bridge()
    openDocument(join(dir, 'deck.pptx'), 'client-1')
    setDocumentDirty(join(dir, 'deck.pptx'), true)
    const result = await run(CMD, editor.applyEdit)
    expect(editor.calls).toHaveLength(0)
    expect(result.output).toContain('unsaved changes')
  })

  it('says what to do when no editor is showing the deck', async () => {
    const result = await run(CMD, bridge(null).applyEdit)
    expect(result.output).toContain('No editor is showing')
    expect(result.output).toContain('apply --ops')
  })

  it('passes the deck’s own count mismatch back', async () => {
    const result = await run(
      CMD,
      bridge({ ok: false, message: '“Q3 revenue” occurs 2 time(s) on slide 2, not 1' }).applyEdit,
    )
    expect(result.output).toContain('occurs 2 time(s)')
    expect(result.output).toContain('slides read')
  })

  it('needs a slide number and the phrase', async () => {
    const result = await run('replace-slide-text deck.pptx --find a --replace b', bridge().applyEdit)
    expect(result.output).toContain('--slide N')
  })
})
